package providers

import (
	"context"
	"fmt"
	"os"

	anthropic "github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

type claudeProvider struct {
	client anthropic.Client
	model  string
}

func NewClaudeProvider() Provider {
	model := os.Getenv("ANTHROPIC_MODEL")
	if model == "" {
		model = "claude-opus-4-7"
	}
	client := anthropic.NewClient(option.WithAPIKey(os.Getenv("ANTHROPIC_API_KEY")))
	return &claudeProvider{client: client, model: model}
}

func (p *claudeProvider) Name() string       { return "claude" }
func (p *claudeProvider) ContextWindow() int { return 200_000 }

func (p *claudeProvider) Chat(ctx context.Context, messages []Message) (string, error) {
	// Anthropic requires system as a top-level field, not inside the messages array.
	var system string
	var turns []anthropic.MessageParam

	for _, m := range messages {
		switch m.Role {
		case "system":
			system = m.Content
		case "user":
			turns = append(turns, anthropic.NewUserMessage(
				anthropic.NewTextBlock(m.Content),
			))
		case "assistant":
			turns = append(turns, anthropic.NewAssistantMessage(
				anthropic.NewTextBlock(m.Content),
			))
		}
	}

	resp, err := p.client.Messages.New(ctx, anthropic.MessageNewParams{
		Model:     anthropic.Model(p.model),
		MaxTokens: 8096,
		System: []anthropic.TextBlockParam{
			{Text: system},
		},
		Messages: turns,
	})
	if err != nil {
		return "", err
	}

	if len(resp.Content) == 0 {
		return "", fmt.Errorf("claude returned empty content")
	}
	block := resp.Content[0]
	if block.Type != "text" {
		return "", fmt.Errorf("unexpected content type: %s", block.Type)
	}
	return block.Text, nil
}
