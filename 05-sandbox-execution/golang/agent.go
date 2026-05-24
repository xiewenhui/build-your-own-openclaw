package main

import (
	"context"
	"fmt"
	"os"
	"sync"

	"byoo/xclaw/providers"
)

const defaultMaxIterations = 10

// Agent manages per-session conversation history and drives the agent loop.
type Agent struct {
	mu            sync.Mutex
	sessions      map[string][]providers.Message
	providerChain []string
	maxIterations int
}

func newAgent(providerChain []string, maxIterations int) *Agent {
	if maxIterations <= 0 {
		maxIterations = defaultMaxIterations
	}
	return &Agent{
		sessions:      make(map[string][]providers.Message),
		providerChain: providerChain,
		maxIterations: maxIterations,
	}
}

// handle processes one user message. onDelta is called for each streamed token
// once we confirm the response is a plain text reply (not a tool call).
func (a *Agent) handle(msg ACPMessage, onDelta func(string)) (string, error) {
	a.mu.Lock()
	if _, ok := a.sessions[msg.SessionID]; !ok {
		a.sessions[msg.SessionID] = []providers.Message{
			{Role: "system", Content: buildSystemPrompt()},
		}
	}
	messages := make([]providers.Message, len(a.sessions[msg.SessionID]))
	copy(messages, a.sessions[msg.SessionID])
	a.mu.Unlock()

	messages = append(messages, providers.Message{Role: "user", Content: msg.Content})

	for iterations := 0; iterations < a.maxIterations; iterations++ {
		// Buffer tokens — only flush to onDelta when confirmed as a text reply.
		var buffer []string
		reply, err := providers.StreamWithFallback(
			context.Background(), messages, a.providerChain, assemble,
			func(token string) { buffer = append(buffer, token) },
		)
		if err != nil {
			return "", err
		}
		messages = append(messages, providers.Message{Role: "assistant", Content: reply})

		toolCall := extractJSON(reply)
		action, isToolCall := "", false
		if toolCall != nil {
			if a, ok := toolCall["action"].(string); ok && a != "" {
				action = a
				isToolCall = true
			}
		}

		if !isToolCall {
			// Plain text reply — flush buffered tokens to the channel.
			for _, t := range buffer {
				onDelta(t)
			}
			a.mu.Lock()
			a.sessions[msg.SessionID] = messages
			a.mu.Unlock()
			return reply, nil
		}

		tool, found := toolRegistry[action]
		if !found {
			errMsg := fmt.Sprintf(`error: unknown tool "%s". Available: %s`, action, availableTools())
			messages = append(messages, providers.Message{Role: "user", Content: errMsg})
			continue
		}

		params := make(map[string]string)
		for k, v := range toolCall {
			if k == "action" {
				continue
			}
			if s, ok := v.(string); ok {
				params[k] = s
			}
		}

		fmt.Fprintf(os.Stderr, "[agent] [%s] uses [%s]: %v\n", msg.SessionID, action, params)
		output, execErr := tool.Execute(msg.SessionID, params)
		if execErr != nil {
			fmt.Fprintf(os.Stderr, "[agent] tool error: %v\n", execErr)
			messages = append(messages, providers.Message{Role: "user", Content: "tool error:\n" + execErr.Error()})
		} else {
			messages = append(messages, providers.Message{Role: "user", Content: "tool output:\n" + output})
		}
	}

	notice := fmt.Sprintf("[xclaw] reached max iterations (%d), stopping", a.maxIterations)
	a.mu.Lock()
	a.sessions[msg.SessionID] = messages
	a.mu.Unlock()
	return notice, nil
}
