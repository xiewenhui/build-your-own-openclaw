package providers

import "context"

// Message is the unified internal message format shared across all providers.
type Message struct {
	Role    string // "system" | "user" | "assistant"
	Content string
}

// Provider is the interface every LLM backend must implement.
type Provider interface {
	Name() string
	ContextWindow() int
	Chat(ctx context.Context, messages []Message) (string, error)
	// Stream calls onToken for each streamed token and returns the full reply.
	Stream(ctx context.Context, messages []Message, onToken func(string)) (string, error)
}
