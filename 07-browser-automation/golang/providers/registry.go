package providers

import (
	"context"
	"fmt"
	"os"
	"strings"
)

var registry = map[string]Provider{}

func Register(p Provider) {
	registry[p.Name()] = p
}

// ChatWithFallback tries each provider in chain order; moves to the next on any error.
func ChatWithFallback(ctx context.Context, messages []Message, chain []string, assemble func([]Message, Provider) ([]Message, error)) (string, error) {
	var errs []string
	for _, name := range chain {
		p, ok := registry[name]
		if !ok {
			errs = append(errs, name+": not registered")
			continue
		}
		assembled, err := assemble(messages, p)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s (context assembly): %v", name, err))
			continue
		}
		reply, err := p.Chat(ctx, assembled)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[provider:%s] failed — %v\n", name, err)
			errs = append(errs, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		return reply, nil
	}
	return "", fmt.Errorf("all providers failed:\n%s", strings.Join(errs, "\n"))
}

// StreamWithFallback calls provider.Stream(); on error moves to next provider.
func StreamWithFallback(ctx context.Context, messages []Message, chain []string, assemble func([]Message, Provider) ([]Message, error), onToken func(string)) (string, error) {
	var errs []string
	for _, name := range chain {
		p, ok := registry[name]
		if !ok {
			errs = append(errs, name+": not registered")
			continue
		}
		assembled, err := assemble(messages, p)
		if err != nil {
			errs = append(errs, fmt.Sprintf("%s (context assembly): %v", name, err))
			continue
		}
		reply, err := p.Stream(ctx, assembled, onToken)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[provider:%s] failed — %v\n", name, err)
			errs = append(errs, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		return reply, nil
	}
	return "", fmt.Errorf("all providers failed:\n%s", strings.Join(errs, "\n"))
}
