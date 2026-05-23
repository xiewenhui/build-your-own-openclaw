package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"

	"byoo/provider-registry/providers"
)

const maxIterations = 10

// assemble adapts AssembleContext to the signature ChatWithFallback expects.
func assemble(messages []providers.Message, p providers.Provider) ([]providers.Message, error) {
	return AssembleContext(context.Background(), messages, p)
}

func main() {
	// ── Register providers ───────────────────────────────────────────────────
	providers.Register(providers.NewOpenAIProvider())
	providers.Register(providers.NewClaudeProvider())

	chain := buildProviderChain()

	// ── Messages ─────────────────────────────────────────────────────────────
	messages := []providers.Message{
		{Role: "system", Content: buildSystemPrompt()},
	}

	// ── Main loop ─────────────────────────────────────────────────────────────
	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("You: ")
		if !scanner.Scan() {
			break
		}
		userInput := strings.TrimSpace(scanner.Text())
		if strings.ToLower(userInput) == "exit" {
			break
		}

		messages = append(messages, providers.Message{Role: "user", Content: userInput})

		for iterations := 0; ; iterations++ {
			if iterations >= maxIterations {
				fmt.Printf("[xclaw] reached max iterations (%d), stopping\n", maxIterations)
				break
			}

			reply, err := providers.ChatWithFallback(context.Background(), messages, chain, assemble)
			if err != nil {
				fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
				break
			}

			messages = append(messages, providers.Message{Role: "assistant", Content: reply})

			toolCall := extractJSON(reply)
			if toolCall == nil {
				fmt.Printf("xclaw: %s\n", reply)
				break
			}

			action, ok := toolCall["action"].(string)
			if !ok {
				fmt.Printf("xclaw: %s\n", reply)
				break
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

			fmt.Printf("xclaw uses [%s]: %v\n", action, params)
			output, execErr := tool.Execute(params)
			if execErr != nil {
				fmt.Fprintf(os.Stderr, "error: %v\n", execErr)
				messages = append(messages, providers.Message{Role: "user", Content: "tool error:\n" + execErr.Error()})
			} else {
				fmt.Print(output)
				messages = append(messages, providers.Message{Role: "user", Content: "tool output:\n" + output})
			}
		}
	}
}
