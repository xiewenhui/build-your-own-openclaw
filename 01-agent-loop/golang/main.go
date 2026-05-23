package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/sashabaranov/go-openai"
)

const systemPrompt = `You are an AI assistant named xclaw. You can either respond with text or request a shell command to be executed.

You MUST always reply in one of these two exact formats:
- text: <your response>
- command: <bash command to execute>

Use "command:" when the user asks you to do something that requires running a shell command (e.g. list files, check git status, create a file).
Use "text:" for all other responses.
Never mix formats. Never include explanation outside the prefix.`

func runCommand(cmd string) (string, error) {
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("cmd", "/C", cmd)
	} else {
		c = exec.Command("sh", "-c", cmd)
	}
	out, err := c.CombinedOutput()
	return string(out), err
}

func main() {
	config := openai.DefaultConfig(os.Getenv("OPENAI_API_KEY"))
	if baseURL := os.Getenv("OPENAI_API_BASE_URL"); baseURL != "" {
		config.BaseURL = baseURL
	}
	client := openai.NewClientWithConfig(config)

	model := os.Getenv("OPENAI_MODEL")
	if model == "" {
		model = "GLM-5"
	}

	messages := []openai.ChatCompletionMessage{
		{Role: openai.ChatMessageRoleSystem, Content: systemPrompt},
	}

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

		messages = append(messages, openai.ChatCompletionMessage{
			Role:    openai.ChatMessageRoleUser,
			Content: userInput,
		})

		for {
			resp, err := client.CreateChatCompletion(context.Background(), openai.ChatCompletionRequest{
				Model:    model,
				Messages: messages,
			})
			if err != nil {
				fmt.Fprintf(os.Stderr, "error: %v\n", err)
				break
			}

			reply := resp.Choices[0].Message.Content
			messages = append(messages, openai.ChatCompletionMessage{
				Role:    openai.ChatMessageRoleAssistant,
				Content: reply,
			})

			if strings.HasPrefix(reply, "command: ") {
				cmd := strings.TrimSpace(reply[len("command: "):])
				fmt.Printf("xclaw runs: %s\n", cmd)
				output, err := runCommand(cmd)
				if err != nil {
					fmt.Fprintf(os.Stderr, "error: %v\n", err)
					messages = append(messages, openai.ChatCompletionMessage{
						Role:    openai.ChatMessageRoleUser,
						Content: "command error:\n" + err.Error(),
					})
				} else {
					fmt.Print(output)
					messages = append(messages, openai.ChatCompletionMessage{
						Role:    openai.ChatMessageRoleUser,
						Content: "command output:\n" + output,
					})
				}
			} else if strings.HasPrefix(reply, "text: ") {
				fmt.Printf("xclaw: %s\n", reply[len("text: "):])
				break
			} else {
				fmt.Printf("xclaw: %s\n", reply)
				break
			}
		}
	}
}
