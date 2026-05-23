package providers

import (
	"context"
	"fmt"
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
			fmt.Printf("[provider:%s] failed — %v\n", name, err)
			errs = append(errs, fmt.Sprintf("%s: %v", name, err))
			continue
		}
		return reply, nil
	}

	return "", fmt.Errorf("all providers failed:\n%s", strings.Join(errs, "\n"))
}
