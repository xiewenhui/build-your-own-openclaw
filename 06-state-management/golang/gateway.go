package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// ── ACP types ─────────────────────────────────────────────────────────────────

// ACPMessage is the unified in-process message from any channel to the Agent.
type ACPMessage struct {
	ID        string
	SessionID string
	Channel   string
	Content   string
	Timestamp int64
}

// AgentReply carries one streaming token ("delta"), the final text ("reply"),
// history on reconnect ("history"), or an error ("error") back to the channel.
type AgentReply struct {
	Type      string // "delta" | "reply" | "history" | "error"
	ID        string
	SessionID string
	Channel   string
	Content   string
}

// ── Gateway ───────────────────────────────────────────────────────────────────

type Gateway struct {
	adapters map[string]ChannelAdapter
	agent    *Agent
	db       *DB
}

func newGateway(agent *Agent, db *DB) *Gateway {
	return &Gateway{adapters: make(map[string]ChannelAdapter), agent: agent, db: db}
}

func (g *Gateway) register(adapter ChannelAdapter) {
	g.adapters[adapter.name()] = adapter
	adapter.onMessage(func(raw ACPMessage) {
		go g.dispatch(raw)
	})
	// Wire up history loader for web adapter so reconnecting browsers get history.
	if wa, ok := adapter.(*webAdapter); ok {
		wa.historyLoader = func(sessionID string) []HistoryEntry {
			if g.db == nil {
				return nil
			}
			history, _ := g.db.loadHistory(sessionID)
			return history
		}
	}
}

func (g *Gateway) dispatch(raw ACPMessage) {
	msg := ACPMessage{
		ID:        raw.ID,
		SessionID: resolveSessionID(raw.Channel, raw.SessionID),
		Channel:   raw.Channel,
		Content:   raw.Content,
		Timestamp: raw.Timestamp,
	}

	adapter, ok := g.adapters[msg.Channel]
	if !ok {
		fmt.Fprintf(os.Stderr, "[gateway] unknown channel: %s\n", msg.Channel)
		return
	}

	full, err := g.agent.handle(msg, func(token string) {
		adapter.send(AgentReply{
			Type: "delta", ID: msg.ID, SessionID: msg.SessionID,
			Channel: msg.Channel, Content: token,
		})
	})
	if err != nil {
		adapter.send(AgentReply{
			Type: "error", ID: msg.ID, SessionID: msg.SessionID,
			Channel: msg.Channel, Content: err.Error(),
		})
		return
	}
	adapter.send(AgentReply{
		Type: "reply", ID: msg.ID, SessionID: msg.SessionID,
		Channel: msg.Channel, Content: full,
	})
}

func (g *Gateway) start() error {
	for _, a := range g.adapters {
		if err := a.start(); err != nil {
			return err
		}
	}
	return nil
}

// ── Router ────────────────────────────────────────────────────────────────────

func resolveSessionID(channel, clientSessionID string) string {
	if channel == "cli" {
		return "cli"
	}
	if clientSessionID != "" {
		return clientSessionID
	}
	return fmt.Sprintf("web-%d", time.Now().UnixMilli())
}

// ── History serialisation helper ──────────────────────────────────────────────

func marshalHistory(history []HistoryEntry) string {
	b, _ := json.Marshal(history)
	return string(b)
}
