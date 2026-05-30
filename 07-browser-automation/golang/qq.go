package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	qqTokenURL = "https://bots.qq.com/app/getAppAccessToken"
	qqAPIBase  = "https://api.sgroup.qq.com"
	qqIntents  = 1 << 25 // GROUP_AND_C2C: private C2C + group @ messages
)

var reMention = regexp.MustCompile(`<@!\d+>`)

type qqReplyCtx struct {
	kind     string // "c2c" | "group"
	targetID string
	msgID    string
}

type qqAdapter struct {
	appID   string
	secret  string
	handler func(ACPMessage)

	replyMu  sync.RWMutex
	replyCtx map[string]qqReplyCtx

	tokenMu sync.Mutex
	token   string
	tokenExp time.Time
}

func newQQAdapter() *qqAdapter {
	return &qqAdapter{
		appID:    os.Getenv("QQ_APP_ID"),
		secret:   os.Getenv("QQ_CLIENT_SECRET"),
		replyCtx: make(map[string]qqReplyCtx),
	}
}

func (q *qqAdapter) name() string { return "qq" }

func (q *qqAdapter) onMessage(h func(ACPMessage)) { q.handler = h }

// ── OAuth2 token ──────────────────────────────────────────────────────────────

func (q *qqAdapter) getAccessToken() (string, error) {
	q.tokenMu.Lock()
	defer q.tokenMu.Unlock()

	if q.token != "" && time.Now().Before(q.tokenExp.Add(-60*time.Second)) {
		return q.token, nil
	}

	body, _ := json.Marshal(map[string]string{"appId": q.appID, "clientSecret": q.secret})
	resp, err := http.Post(qqTokenURL, "application/json", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var data struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   string `json:"expires_in"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", err
	}
	expiresIn, _ := strconv.Atoi(data.ExpiresIn)
	q.token = data.AccessToken
	q.tokenExp = time.Now().Add(time.Duration(expiresIn) * time.Second)
	return q.token, nil
}

func (q *qqAdapter) getGatewayURL(token string) (string, error) {
	req, _ := http.NewRequest("GET", qqAPIBase+"/gateway", nil)
	req.Header.Set("Authorization", "QQBot "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var data struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return "", err
	}
	return data.URL, nil
}

// ── Send message back to QQ ───────────────────────────────────────────────────

func (q *qqAdapter) postJSON(token, url string, payload any) {
	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Authorization", "QQBot "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[qq] POST %s error: %v\n", url, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		fmt.Fprintf(os.Stderr, "[qq] POST %s failed: %d %s\n", url, resp.StatusCode, b)
	}
}

func (q *qqAdapter) send(reply AgentReply) {
	if reply.Type != "reply" {
		return
	}

	q.replyMu.RLock()
	ctx, ok := q.replyCtx[reply.SessionID]
	q.replyMu.RUnlock()
	if !ok {
		return
	}

	q.replyMu.Lock()
	delete(q.replyCtx, reply.SessionID)
	q.replyMu.Unlock()

	go func() {
		token, err := q.getAccessToken()
		if err != nil {
			fmt.Fprintf(os.Stderr, "[qq] getAccessToken: %v\n", err)
			return
		}
		msgSeq := time.Now().UnixMilli() % 65536
		payload := map[string]any{
			"content":  reply.Content,
			"msg_type": 0,
			"msg_id":   ctx.msgID,
			"msg_seq":  msgSeq,
		}
		var url string
		if ctx.kind == "c2c" {
			url = qqAPIBase + "/v2/users/" + ctx.targetID + "/messages"
		} else {
			url = qqAPIBase + "/v2/groups/" + ctx.targetID + "/messages"
		}
		q.postJSON(token, url, payload)
	}()
}

// ── QQ Gateway WebSocket ──────────────────────────────────────────────────────

func (q *qqAdapter) start() error {
	if q.appID == "" || q.secret == "" {
		fmt.Fprintln(os.Stderr, "[qq] QQ_APP_ID/QQ_CLIENT_SECRET not set, skipping QQ channel")
		return nil
	}
	go func() {
		for {
			if err := q.tryConnect(); err != nil {
				fmt.Fprintf(os.Stderr, "[qq] disconnected: %v — retry in 5s\n", err)
				time.Sleep(5 * time.Second)
			}
		}
	}()
	return nil
}

func (q *qqAdapter) tryConnect() error {
	token, err := q.getAccessToken()
	if err != nil {
		return fmt.Errorf("getAccessToken: %w", err)
	}
	gatewayURL, err := q.getGatewayURL(token)
	if err != nil {
		return fmt.Errorf("getGatewayURL: %w", err)
	}

	fmt.Fprintf(os.Stderr, "[qq] connecting to %s\n", gatewayURL)
	conn, _, err := websocket.DefaultDialer.Dial(gatewayURL, nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()
	fmt.Fprintln(os.Stderr, "[qq] WebSocket connected")

	// Serialize concurrent writes (heartbeat goroutine + main loop both write).
	var writeMu sync.Mutex
	write := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.WriteJSON(v)
	}

	stopHB := make(chan struct{})
	defer close(stopHB)

	var lastSeq *int64

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}

		var payload struct {
			Op int             `json:"op"`
			T  string          `json:"t"`
			D  json.RawMessage `json:"d"`
			S  *int64          `json:"s"`
		}
		if json.Unmarshal(raw, &payload) != nil {
			continue
		}
		if payload.S != nil {
			lastSeq = payload.S
		}

		switch payload.Op {
		case 10: // HELLO — start heartbeat then IDENTIFY
			var hello struct {
				HeartbeatInterval int `json:"heartbeat_interval"`
			}
			json.Unmarshal(payload.D, &hello)

			interval := time.Duration(hello.HeartbeatInterval) * time.Millisecond
			go func() {
				ticker := time.NewTicker(interval)
				defer ticker.Stop()
				for {
					select {
					case <-stopHB:
						return
					case <-ticker.C:
						write(map[string]any{"op": 1, "d": lastSeq}) //nolint:errcheck
					}
				}
			}()

			write(map[string]any{ //nolint:errcheck
				"op": 2,
				"d": map[string]any{
					"token":   "QQBot " + token,
					"intents": qqIntents,
					"shard":   []int{0, 1},
				},
			})

		case 0: // DISPATCH
			go q.handleEvent(payload.T, payload.D)

		case 9: // Invalid session
			fmt.Fprintln(os.Stderr, "[qq] invalid session, reconnecting")
			return fmt.Errorf("invalid session")

		case 7: // Reconnect
			fmt.Fprintln(os.Stderr, "[qq] server requested reconnect")
			return fmt.Errorf("server reconnect request")
		}
	}
}

func (q *qqAdapter) handleEvent(t string, d json.RawMessage) {
	switch t {
	case "C2C_MESSAGE_CREATE":
		var msg struct {
			Author struct {
				UserOpenid string `json:"user_openid"`
				ID         string `json:"id"`
			} `json:"author"`
			Content string `json:"content"`
			ID      string `json:"id"`
		}
		if json.Unmarshal(d, &msg) != nil {
			return
		}
		openid := msg.Author.UserOpenid
		if openid == "" {
			openid = msg.Author.ID
		}
		text := strings.TrimSpace(reMention.ReplaceAllString(msg.Content, ""))
		if text == "" {
			return
		}

		sessionID := "qq-c2c-" + openid
		q.replyMu.Lock()
		q.replyCtx[sessionID] = qqReplyCtx{kind: "c2c", targetID: openid, msgID: msg.ID}
		q.replyMu.Unlock()

		fmt.Fprintf(os.Stderr, "[qq] c2c from %s: %s\n", openid, text)
		q.handler(ACPMessage{
			ID:        newUUID(),
			SessionID: sessionID,
			Channel:   "qq",
			Content:   text,
			Timestamp: time.Now().UnixMilli(),
		})

	case "GROUP_AT_MESSAGE_CREATE":
		var msg struct {
			Author struct {
				MemberOpenid string `json:"member_openid"`
				ID           string `json:"id"`
			} `json:"author"`
			GroupOpenid string `json:"group_openid"`
			Content     string `json:"content"`
			ID          string `json:"id"`
		}
		if json.Unmarshal(d, &msg) != nil {
			return
		}
		openid := msg.Author.MemberOpenid
		if openid == "" {
			openid = msg.Author.ID
		}
		text := strings.TrimSpace(reMention.ReplaceAllString(msg.Content, ""))
		if text == "" {
			return
		}

		sessionID := "qq-group-" + msg.GroupOpenid
		q.replyMu.Lock()
		q.replyCtx[sessionID] = qqReplyCtx{kind: "group", targetID: msg.GroupOpenid, msgID: msg.ID}
		q.replyMu.Unlock()

		fmt.Fprintf(os.Stderr, "[qq] group %s from %s: %s\n", msg.GroupOpenid, openid, text)
		q.handler(ACPMessage{
			ID:        newUUID(),
			SessionID: sessionID,
			Channel:   "qq",
			Content:   text,
			Timestamp: time.Now().UnixMilli(),
		})
	}
}
