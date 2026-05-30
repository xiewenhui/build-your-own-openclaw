package main

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"

	"github.com/gorilla/websocket"
)

const sessionFile = ".cli_session"

func main() {
	port := os.Getenv("WEB_PORT")
	if port == "" {
		port = "3000"
	}
	url := "ws://127.0.0.1:" + port + "/ws"
	sessionID := loadOrCreateSession()

	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		log.Fatalf("[cli] connect error: %v", err)
	}
	defer conn.Close()
	fmt.Fprintf(os.Stderr, "[cli] connected to %s (session: %s)\n", url, sessionID)

	// Send reconnect first so the server can push back history.
	reconnect, _ := json.Marshal(map[string]string{
		"type":      "reconnect",
		"sessionId": sessionID,
	})
	if err := conn.WriteMessage(websocket.TextMessage, reconnect); err != nil {
		log.Fatalf("[cli] reconnect error: %v", err)
	}

	// ready signals that the terminal is free to prompt again
	ready := make(chan struct{}, 1)
	ready <- struct{}{}

	// recv goroutine: print agent output and signal when a turn completes
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				fmt.Fprintln(os.Stderr, "[cli] disconnected")
				os.Exit(0)
			}
			var pkt struct {
				Type    string `json:"type"`
				Content string `json:"content"`
			}
			if json.Unmarshal(msg, &pkt) != nil {
				continue
			}
			switch pkt.Type {
			case "history":
				// Restore previous conversation as greyed-out context.
				var messages []struct {
					Role    string `json:"role"`
					Content string `json:"content"`
				}
				if json.Unmarshal([]byte(pkt.Content), &messages) == nil && len(messages) > 0 {
					fmt.Fprintln(os.Stderr, "[history] ── 以下为历史消息 ──")
					for _, m := range messages {
						label := "xclaw"
						if m.Role == "user" {
							label = "You"
						}
						fmt.Fprintf(os.Stderr, "[history] %s: %s\n", label, m.Content)
					}
					fmt.Fprintln(os.Stderr, "[history] ── 以上为历史消息 ──")
				}
			case "delta":
				fmt.Print(pkt.Content)
			case "reply":
				fmt.Println()
				ready <- struct{}{}
			case "error":
				fmt.Fprintf(os.Stderr, "error: %s\n", pkt.Content)
				ready <- struct{}{}
			}
		}
	}()

	scanner := bufio.NewScanner(os.Stdin)
	for {
		<-ready
		fmt.Print("You: ")
		if !scanner.Scan() {
			break
		}
		text := strings.TrimSpace(scanner.Text())
		if strings.ToLower(text) == "exit" {
			break
		}
		if text == "" {
			ready <- struct{}{}
			continue
		}
		payload, _ := json.Marshal(map[string]string{
			"type":      "message",
			"sessionId": sessionID,
			"content":   text,
		})
		if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
			fmt.Fprintf(os.Stderr, "[cli] send error: %v\n", err)
			break
		}
	}
}

// loadOrCreateSession reads the session ID from .cli_session, creating it if absent.
// This ensures the same session is resumed across CLI restarts.
func loadOrCreateSession() string {
	if data, err := os.ReadFile(sessionFile); err == nil {
		if id := strings.TrimSpace(string(data)); id != "" {
			return id
		}
	}
	id := "cli-" + shortID()
	_ = os.WriteFile(sessionFile, []byte(id), 0o600)
	return id
}

func shortID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%08x", b)
}
