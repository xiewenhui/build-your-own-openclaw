package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"

	"github.com/sashabaranov/go-openai"
)

// ── Tool type definitions ────────────────────────────────────────────────────

type ToolParam struct {
	Type        string `json:"type"`
	Description string `json:"description"`
}

type ToolParameters struct {
	Type       string               `json:"type"`
	Properties map[string]ToolParam `json:"properties"`
	Required   []string             `json:"required"`
}

type ToolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  ToolParameters `json:"parameters"`
}

type ToolExecutor func(params map[string]string) (string, error)

type Tool struct {
	Definition ToolDefinition
	Execute    ToolExecutor
}

// ── Tool registry ────────────────────────────────────────────────────────────

var toolRegistry = map[string]Tool{}

func registerTool(def ToolDefinition, execute ToolExecutor) {
	toolRegistry[def.Name] = Tool{Definition: def, Execute: execute}
}

// ── Register tools ───────────────────────────────────────────────────────────

func init() {
	registerTool(ToolDefinition{
		Name:        "shell",
		Description: "Execute a bash shell command and return stdout",
		Parameters: ToolParameters{
			Type: "object",
			Properties: map[string]ToolParam{
				"command": {Type: "string", Description: "The bash command to execute"},
			},
			Required: []string{"command"},
		},
	}, func(params map[string]string) (string, error) {
		return runCommand(params["command"])
	})

	registerTool(ToolDefinition{
		Name:        "read_file",
		Description: "Read the content of a file",
		Parameters: ToolParameters{
			Type: "object",
			Properties: map[string]ToolParam{
				"path": {Type: "string", Description: "Absolute or relative file path"},
			},
			Required: []string{"path"},
		},
	}, func(params map[string]string) (string, error) {
		data, err := os.ReadFile(params["path"])
		return string(data), err
	})
}

// ── Auto-generate tool descriptions for the system prompt ────────────────────

func buildToolsPrompt() string {
	var sb strings.Builder
	first := true
	for _, tool := range toolRegistry {
		if !first {
			sb.WriteString("\n\n")
		}
		first = false
		d := tool.Definition
		fmt.Fprintf(&sb, "### %s\n%s\nParameters:", d.Name, d.Description)
		for k, v := range d.Parameters.Properties {
			fmt.Fprintf(&sb, "\n  - %s (%s): %s", k, v.Type, v.Description)
		}
	}
	return sb.String()
}

func buildSystemPrompt() string {
	return `You are an AI assistant named xclaw.

To use a tool, output a JSON object (bare or in a markdown code block):
{"action": "<tool_name>", "<param1>": "<value1>", ...}

To answer directly, output plain text — do NOT use JSON.

Available tools:
` + buildToolsPrompt()
}

// ── JSON parsing helpers ─────────────────────────────────────────────────────

var (
	reJSONBlock  = regexp.MustCompile("(?s)```json\\s*(.*?)```")
	reRawBlock   = regexp.MustCompile("(?s)```\\s*(.*?)```")
	reInlineJSON = regexp.MustCompile(`(?s)\{.*\}`)
	// Fix \X where X is not a valid JSON escape char
	reInvalidEscape = regexp.MustCompile(`\\([^"\\/bfnrtu0-9])`)
)

func repairJSON(s string) string {
	return reInvalidEscape.ReplaceAllString(s, `\\$1`)
}

func tryParse(candidate string) map[string]any {
	candidate = strings.TrimSpace(candidate)
	var result map[string]any
	if json.Unmarshal([]byte(candidate), &result) == nil {
		return result
	}
	if json.Unmarshal([]byte(repairJSON(candidate)), &result) == nil {
		return result
	}
	return nil
}

func extractJSON(text string) map[string]any {
	s := strings.TrimSpace(text)

	// 1. Bare JSON
	if r := tryParse(s); r != nil {
		return r
	}

	// 2. ```json ... ``` code block
	if m := reJSONBlock.FindStringSubmatch(s); m != nil {
		if r := tryParse(m[1]); r != nil {
			return r
		}
	}

	// 3. ``` ... ``` code block (no language tag)
	if m := reRawBlock.FindStringSubmatch(s); m != nil {
		if r := tryParse(m[1]); r != nil {
			return r
		}
	}

	// 4. First {...} found in text
	if m := reInlineJSON.FindString(s); m != "" {
		if r := tryParse(m); r != nil {
			return r
		}
	}

	return nil
}

// ── Shell helper ─────────────────────────────────────────────────────────────

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

// ── Main loop ────────────────────────────────────────────────────────────────

const maxIterations = 10

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
		{Role: openai.ChatMessageRoleSystem, Content: buildSystemPrompt()},
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

		for iterations := 0; ; iterations++ {
			if iterations >= maxIterations {
				fmt.Printf("[xclaw] reached max iterations (%d), stopping\n", maxIterations)
				break
			}

			resp, err := client.CreateChatCompletion(context.Background(), openai.ChatCompletionRequest{
				Model:    model,
				Messages: messages,
			})
			if err != nil {
				fmt.Fprintf(os.Stderr, "api error: %v\n", err)
				break
			}

			reply := resp.Choices[0].Message.Content
			messages = append(messages, openai.ChatCompletionMessage{
				Role:    openai.ChatMessageRoleAssistant,
				Content: reply,
			})

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
				available := make([]string, 0, len(toolRegistry))
				for k := range toolRegistry {
					available = append(available, k)
				}
				errMsg := fmt.Sprintf(`error: unknown tool "%s". Available: %s`, action, strings.Join(available, ", "))
				messages = append(messages, openai.ChatCompletionMessage{
					Role:    openai.ChatMessageRoleUser,
					Content: errMsg,
				})
				continue
			}

			// Build params (skip the "action" key)
			params := make(map[string]string)
			for k, v := range toolCall {
				if k == "action" {
					continue
				}
				if str, ok := v.(string); ok {
					params[k] = str
				}
			}

			fmt.Printf("xclaw uses [%s]: %v\n", action, params)
			output, execErr := tool.Execute(params)
			if execErr != nil {
				fmt.Fprintf(os.Stderr, "error: %v\n", execErr)
				messages = append(messages, openai.ChatCompletionMessage{
					Role:    openai.ChatMessageRoleUser,
					Content: "tool error:\n" + execErr.Error(),
				})
			} else {
				fmt.Print(output)
				messages = append(messages, openai.ChatCompletionMessage{
					Role:    openai.ChatMessageRoleUser,
					Content: "tool output:\n" + output,
				})
			}
		}
	}
}
