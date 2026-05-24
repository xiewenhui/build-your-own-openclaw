package providers

import (
	"context"
	"errors"
	"io"
	"strings"

	openai "github.com/sashabaranov/go-openai"
	"os"
)

type openAIProvider struct {
	client *openai.Client
	model  string
}

func NewOpenAIProvider() Provider {
	config := openai.DefaultConfig(os.Getenv("OPENAI_API_KEY"))
	if base := os.Getenv("OPENAI_API_BASE_URL"); base != "" {
		config.BaseURL = base
	}
	model := os.Getenv("OPENAI_MODEL")
	if model == "" {
		model = "gpt-4o"
	}
	return &openAIProvider{client: openai.NewClientWithConfig(config), model: model}
}

func (p *openAIProvider) Name() string       { return "openai" }
func (p *openAIProvider) ContextWindow() int { return 128_000 }

func (p *openAIProvider) Chat(ctx context.Context, messages []Message) (string, error) {
	msgs := make([]openai.ChatCompletionMessage, len(messages))
	for i, m := range messages {
		msgs[i] = openai.ChatCompletionMessage{Role: m.Role, Content: m.Content}
	}
	resp, err := p.client.CreateChatCompletion(ctx, openai.ChatCompletionRequest{
		Model:    p.model,
		Messages: msgs,
	})
	if err != nil {
		return "", err
	}
	return resp.Choices[0].Message.Content, nil
}

func (p *openAIProvider) Stream(ctx context.Context, messages []Message, onToken func(string)) (string, error) {
	msgs := make([]openai.ChatCompletionMessage, len(messages))
	for i, m := range messages {
		msgs[i] = openai.ChatCompletionMessage{Role: m.Role, Content: m.Content}
	}
	stream, err := p.client.CreateChatCompletionStream(ctx, openai.ChatCompletionRequest{
		Model:    p.model,
		Messages: msgs,
	})
	if err != nil {
		return "", err
	}
	defer stream.Close()

	var sb strings.Builder
	for {
		resp, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", err
		}
		if len(resp.Choices) > 0 {
			token := resp.Choices[0].Delta.Content
			if token != "" {
				onToken(token)
				sb.WriteString(token)
			}
		}
	}
	return sb.String(), nil
}
