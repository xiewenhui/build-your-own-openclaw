package main

import (
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
// or an error notification ("error") back to the originating channel.
type AgentReply struct {
	Type      string // "delta" | "reply" | "error"
	ID        string
	SessionID string
	Channel   string
	Content   string
}

// ── Gateway ───────────────────────────────────────────────────────────────────

type Gateway struct {
	adapters map[string]ChannelAdapter
	agent    *Agent
}

func newGateway(agent *Agent) *Gateway {
	return &Gateway{adapters: make(map[string]ChannelAdapter), agent: agent}
}

func (g *Gateway) register(adapter ChannelAdapter) {
	g.adapters[adapter.name()] = adapter
	adapter.onMessage(func(raw ACPMessage) {
		go g.dispatch(raw)
	})
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

// resolveSessionID guarantees every message has a stable sessionID.
// CLI gets a fixed "cli" key; QQ adapters pass their own per-user IDs;
// Web clients supply a browser-generated UUID.
func resolveSessionID(channel, clientSessionID string) string {
	if channel == "cli" {
		return "cli"
	}
	if clientSessionID != "" {
		return clientSessionID
	}
	return fmt.Sprintf("web-%d", time.Now().UnixMilli())
}
