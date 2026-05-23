package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

// ── Tool types ───────────────────────────────────────────────────────────────

type ToolParam struct {
	Type        string
	Description string
}

type ToolDefinition struct {
	Name        string
	Description string
	Properties  map[string]ToolParam
	Required    []string
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
		for k, v := range d.Properties {
			fmt.Fprintf(&sb, "\n  - %s (%s): %s", k, v.Type, v.Description)
		}
	}
	return sb.String()
}

func init() {
	registerTool(ToolDefinition{
		Name:        "shell",
		Description: "Execute a bash shell command and return stdout",
		Properties: map[string]ToolParam{
			"command": {Type: "string", Description: "The bash command to execute"},
		},
		Required: []string{"command"},
	}, func(params map[string]string) (string, error) {
		return runCommand(params["command"])
	})

	registerTool(ToolDefinition{
		Name:        "read_file",
		Description: "Read the content of a file",
		Properties: map[string]ToolParam{
			"path": {Type: "string", Description: "Absolute or relative file path"},
		},
		Required: []string{"path"},
	}, func(params map[string]string) (string, error) {
		data, err := os.ReadFile(params["path"])
		return string(data), err
	})
}

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

// ── JSON parsing helpers ─────────────────────────────────────────────────────

var (
	reJSONBlock     = regexp.MustCompile("(?s)```json\\s*(.*?)```")
	reRawBlock      = regexp.MustCompile("(?s)```\\s*(.*?)```")
	reInlineJSON    = regexp.MustCompile(`(?s)\{.*\}`)
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

	if r := tryParse(s); r != nil {
		return r
	}
	if m := reJSONBlock.FindStringSubmatch(s); m != nil {
		if r := tryParse(m[1]); r != nil {
			return r
		}
	}
	if m := reRawBlock.FindStringSubmatch(s); m != nil {
		if r := tryParse(m[1]); r != nil {
			return r
		}
	}
	if m := reInlineJSON.FindString(s); m != "" {
		if r := tryParse(m); r != nil {
			return r
		}
	}
	return nil
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func buildProviderChain() []string {
	primary := os.Getenv("PRIMARY_PROVIDER")
	if primary == "" {
		primary = "claude"
	}
	fallback := os.Getenv("FALLBACK_PROVIDER")
	if fallback == "" {
		fallback = "openai"
	}
	if primary == fallback {
		return []string{primary}
	}
	return []string{primary, fallback}
}

func buildSystemPrompt() string {
	return `You are an AI assistant named xclaw.

To use a tool, output a JSON object (bare or in a markdown code block):
{"action": "<tool_name>", "<param1>": "<value1>", ...}

To answer directly, output plain text — do NOT use JSON.

Available tools:
` + buildToolsPrompt()
}

func availableTools() string {
	keys := make([]string, 0, len(toolRegistry))
	for k := range toolRegistry {
		keys = append(keys, k)
	}
	return strings.Join(keys, ", ")
}
