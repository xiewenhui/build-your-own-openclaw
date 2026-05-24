package main

import (
	"context"
	"fmt"
	"strings"

	"byoo/xclaw/providers"
)

// estimateTokens is a rough approximation: ~4 chars per token.
// Works for English; Chinese is ~2 chars/token so this may undercount,
// but the 10% headroom in AssembleContext compensates.
func estimateTokens(text string) int {
	return (len([]rune(text)) + 3) / 4
}

func messagesTokens(messages []providers.Message) int {
	total := 0
	for _, m := range messages {
		total += estimateTokens(m.Content) + 4
	}
	return total
}

// truncate keeps the system message and as many recent turns as fit within limit.
func truncate(messages []providers.Message, limit int) []providers.Message {
	var system, turns []providers.Message
	for _, m := range messages {
		if m.Role == "system" {
			system = append(system, m)
		} else {
			turns = append(turns, m)
		}
	}

	budget := limit - messagesTokens(system)
	kept := 0
	for i := len(turns) - 1; i >= 0; i-- {
		cost := estimateTokens(turns[i].Content) + 4
		if budget-cost < 0 {
			break
		}
		budget -= cost
		kept++
	}

	result := make([]providers.Message, 0, len(system)+kept)
	result = append(result, system...)
	result = append(result, turns[len(turns)-kept:]...)
	return result
}

// compress summarizes the oldest turns via the provider, then reattaches recent ones.
func compress(ctx context.Context, messages []providers.Message, p providers.Provider) ([]providers.Message, error) {
	const keepRecent = 4

	var system, turns []providers.Message
	for _, m := range messages {
		if m.Role == "system" {
			system = append(system, m)
		} else {
			turns = append(turns, m)
		}
	}

	if len(turns) <= keepRecent {
		return messages, nil
	}

	toSummarize := turns[:len(turns)-keepRecent]
	recent := turns[len(turns)-keepRecent:]

	var sb strings.Builder
	sb.WriteString("Summarize the following conversation history concisely, preserving key facts and decisions:\n\n")
	for _, m := range toSummarize {
		fmt.Fprintf(&sb, "%s: %s\n", m.Role, m.Content)
	}

	summary, err := p.Chat(ctx, []providers.Message{{Role: "user", Content: sb.String()}})
	if err != nil {
		return nil, err
	}

	result := make([]providers.Message, 0, len(system)+1+len(recent))
	result = append(result, system...)
	result = append(result, providers.Message{Role: "user", Content: "[Conversation summary]\n" + summary})
	result = append(result, recent...)
	return result, nil
}

// AssembleContext truncates messages to fit the provider's context window,
// compressing only if truncation alone is insufficient.
func AssembleContext(ctx context.Context, messages []providers.Message, p providers.Provider) ([]providers.Message, error) {
	limit := int(float64(p.ContextWindow()) * 0.9)

	result := truncate(messages, limit)

	if messagesTokens(result) > limit {
		var err error
		result, err = compress(ctx, result, p)
		if err != nil {
			return nil, err
		}
		result = truncate(result, limit)
	}

	return result, nil
}
