package providers

import "context"

// Message is the unified internal message format shared across all providers.
// When ImageURL is non-empty (data:image/png;base64,...) the message is sent as
// a multimodal vision turn; Content holds the accompanying text prompt.
type Message struct {
	Role     string // "system" | "user" | "assistant"
	Content  string
	ImageURL string // optional: "data:image/png;base64,..."
}

// Provider is the interface every LLM backend must implement.
type Provider interface {
	Name() string
	ContextWindow() int
	Chat(ctx context.Context, messages []Message) (string, error)
	// Stream calls onToken for each streamed token and returns the full reply.
	Stream(ctx context.Context, messages []Message, onToken func(string)) (string, error)
}
