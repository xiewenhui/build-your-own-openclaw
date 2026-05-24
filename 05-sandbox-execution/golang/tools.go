package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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

type ToolExecutor func(sessionID string, params map[string]string) (string, error)

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

// ── Host Mode: application-layer sandbox guards ───────────────────────────────
//
// Defense 1 — Path canonicalization & traversal prevention
// Defense 2 — Human-in-the-Loop interceptor (destructive ops block for y/n)
// Defense 3 — Atomic tools + extension/size circuit breakers
// Defense 4 — Least-privilege child process execution (via dropPrivileges)

// allowedReadExts, allowedWriteExts, maxReadBytes, maxWriteBytes are populated
// from xclaw.yaml at startup via initToolLimits(). They are not hardcoded here.
var allowedReadExts map[string]bool
var allowedWriteExts map[string]bool
var maxReadBytes int
var maxWriteBytes int

// initToolLimits wires the config values into the package-level variables
// used by the host-mode tool guards.
func initToolLimits(cfg ToolsConfig) {
	allowedReadExts = extSet(cfg.File.Read.AllowedExtensions)
	allowedWriteExts = extSet(cfg.File.Write.AllowedExtensions)
	maxReadBytes = cfg.File.Read.MaxBytes
	maxWriteBytes = cfg.File.Write.MaxBytes
}

// canonicalize resolves path to an absolute path and verifies it is inside workDir.
// Defense 1: filepath.Abs removes all ".." components; the prefix check blocks traversal.
func canonicalize(path, workDir string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	// Ensure workDir itself is absolute.
	workAbs, err := filepath.Abs(workDir)
	if err != nil {
		return "", err
	}
	// Add a path separator to prevent prefix collision (e.g. /work vs /workspace).
	if !strings.HasPrefix(abs, workAbs+string(filepath.Separator)) && abs != workAbs {
		return "", fmt.Errorf("path not allowed: %q is outside workspace %q", abs, workAbs)
	}
	return abs, nil
}

func isReadExtAllowed(path string) bool {
	return allowedReadExts[strings.ToLower(filepath.Ext(path))]
}

func isWriteExtAllowed(path string) bool {
	return allowedWriteExts[strings.ToLower(filepath.Ext(path))]
}

// sandboxWorkDir returns the configured workspace root (SANDBOX_WORK_DIR, default ./workspace).
func sandboxWorkDir() string {
	d := os.Getenv("SANDBOX_WORK_DIR")
	if d == "" {
		d = "./workspace"
	}
	return d
}

// ── Mode-based tool registration ─────────────────────────────────────────────

// registerToolsForMode registers the appropriate tool set based on sandbox mode.
// hitl is only used in host mode; pass nil for full mode.
func registerToolsForMode(mode string, pool *SandboxPool, hitl HITLConfirmer) {
	switch mode {
	case "full":
		registerFullSandboxTools(pool)
	default:
		registerHostModeTools(hitl)
	}
}

// registerHostModeTools registers the restricted host-mode tool set.
// No shell or arbitrary code execution tools are registered.
func registerHostModeTools(hitl HITLConfirmer) {
	workDir := sandboxWorkDir()

	// view_file — Defense 1 + 3 (canonicalize + ext/size check), auto-approved read
	registerTool(ToolDefinition{
		Name:        "view_file",
		Description: "Read the content of a file inside the workspace. Only safe text formats are allowed.",
		Properties: map[string]ToolParam{
			"path": {Type: "string", Description: "File path (must be inside SANDBOX_WORK_DIR)"},
		},
		Required: []string{"path"},
	}, func(_ string, params map[string]string) (string, error) {
		abs, err := canonicalize(params["path"], workDir)
		if err != nil {
			return "", err
		}
		// Defense 3: extension circuit breaker
		if !isReadExtAllowed(abs) {
			return "", fmt.Errorf("file type not allowed: %s", filepath.Ext(abs))
		}
		// Defense 2: HITL (non-destructive → auto-approved when HITL_AUTO_READS=true)
		if !hitl.Confirm("view_file "+abs, "", false) {
			return "", fmt.Errorf("user denied")
		}
		// Defense 3: size circuit breaker
		info, err := os.Stat(abs)
		if err != nil {
			return "", err
		}
		if info.Size() > int64(maxReadBytes) {
			return "", fmt.Errorf("file too large (%d bytes, limit %d)", info.Size(), maxReadBytes)
		}
		data, err := os.ReadFile(abs)
		return string(data), err
	})

	// edit_file — Defense 1 + 2 + 3 (canonicalize + HITL block + ext/size check)
	registerTool(ToolDefinition{
		Name:        "edit_file",
		Description: "Write content to a file inside the workspace. Requires user approval. Only safe text formats allowed.",
		Properties: map[string]ToolParam{
			"path":    {Type: "string", Description: "File path (must be inside SANDBOX_WORK_DIR)"},
			"content": {Type: "string", Description: "Full file content to write"},
		},
		Required: []string{"path", "content"},
	}, func(_ string, params map[string]string) (string, error) {
		// Defense 1: path canonicalization
		abs, err := canonicalize(params["path"], workDir)
		if err != nil {
			return "", err
		}
		// Defense 3: extension circuit breaker
		if !isWriteExtAllowed(abs) {
			return "", fmt.Errorf("file type not allowed: %s", filepath.Ext(abs))
		}
		content := params["content"]
		// Defense 3: size circuit breaker
		if len(content) > maxWriteBytes {
			return "", fmt.Errorf("content too large (%d bytes, limit %d)", len(content), maxWriteBytes)
		}
		// Defense 2: HITL block — destructive=true, must wait for y/n
		detail := fmt.Sprintf("path: %s\nbytes: %d", abs, len(content))
		if !hitl.Confirm("edit_file "+abs, detail, true) {
			return "", fmt.Errorf("user denied")
		}
		// Ensure parent directory exists inside workspace
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			return "", err
		}
		return fmt.Sprintf("wrote %d bytes to %s", len(content), abs), nil
	})

	// list_dir — Defense 1 + 3, uses os.ReadDir (no shell subprocess)
	registerTool(ToolDefinition{
		Name:        "list_dir",
		Description: "List files and directories inside the workspace.",
		Properties: map[string]ToolParam{
			"path": {Type: "string", Description: "Directory path (must be inside SANDBOX_WORK_DIR)"},
		},
		Required: []string{"path"},
	}, func(_ string, params map[string]string) (string, error) {
		abs, err := canonicalize(params["path"], workDir)
		if err != nil {
			return "", err
		}
		// Defense 2: non-destructive read, auto-approved
		if !hitl.Confirm("list_dir "+abs, "", false) {
			return "", fmt.Errorf("user denied")
		}
		entries, err := os.ReadDir(abs)
		if err != nil {
			return "", err
		}
		var sb strings.Builder
		for _, e := range entries {
			if e.IsDir() {
				fmt.Fprintf(&sb, "%s/\n", e.Name())
			} else {
				info, _ := e.Info()
				size := int64(0)
				if info != nil {
					size = info.Size()
				}
				fmt.Fprintf(&sb, "%s (%d bytes)\n", e.Name(), size)
			}
		}
		return sb.String(), nil
	})
}

// registerFullSandboxTools registers the full tool set; all execution is delegated
// to CubeSandbox. Each session gets its own sandbox via pool.GetOrCreate(sessionID).
func registerFullSandboxTools(pool *SandboxPool) {
	// shell — arbitrary commands inside the session's KVM microVM
	registerTool(ToolDefinition{
		Name:        "shell",
		Description: "Execute a shell command inside the isolated sandbox VM and return stdout+stderr.",
		Properties: map[string]ToolParam{
			"command": {Type: "string", Description: "The shell command to execute"},
		},
		Required: []string{"command"},
	}, func(sessionID string, params map[string]string) (string, error) {
		sb, err := pool.GetOrCreate(sessionID)
		if err != nil {
			return "", err
		}
		return sb.RunCommand(params["command"])
	})

	// run_python_code — arbitrary Python inside the session's KVM microVM
	registerTool(ToolDefinition{
		Name:        "run_python_code",
		Description: "Execute Python code inside the isolated sandbox VM and return stdout + result.",
		Properties: map[string]ToolParam{
			"code": {Type: "string", Description: "Python source code to execute"},
		},
		Required: []string{"code"},
	}, func(sessionID string, params map[string]string) (string, error) {
		sb, err := pool.GetOrCreate(sessionID)
		if err != nil {
			return "", err
		}
		return sb.RunCode(params["code"])
	})

	// view_file — read via sandbox shell (no host-side path restrictions needed)
	registerTool(ToolDefinition{
		Name:        "view_file",
		Description: "Read the content of a file inside the sandbox.",
		Properties: map[string]ToolParam{
			"path": {Type: "string", Description: "Absolute or relative file path inside the sandbox"},
		},
		Required: []string{"path"},
	}, func(sessionID string, params map[string]string) (string, error) {
		sb, err := pool.GetOrCreate(sessionID)
		if err != nil {
			return "", err
		}
		return sb.RunCommand("cat " + params["path"])
	})

	// list_dir — via sandbox shell
	registerTool(ToolDefinition{
		Name:        "list_dir",
		Description: "List files in a directory inside the sandbox.",
		Properties: map[string]ToolParam{
			"path": {Type: "string", Description: "Directory path inside the sandbox"},
		},
		Required: []string{"path"},
	}, func(sessionID string, params map[string]string) (string, error) {
		sb, err := pool.GetOrCreate(sessionID)
		if err != nil {
			return "", err
		}
		return sb.RunCommand("ls -la " + params["path"])
	})
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
	return buildProviderChainFromConfig(primary, fallback)
}

func buildProviderChainFromConfig(primary, fallback string) []string {
	if primary == "" {
		primary = "claude"
	}
	if fallback == "" || fallback == primary {
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

// runCommand executes a command on the host (used only in test helpers, never by tools).
func runCommand(cmd string) (string, error) {
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.Command("cmd", "/C", cmd)
	} else {
		c = exec.Command("sh", "-c", cmd)
	}
	// Defense 4: attempt privilege drop for any host-side child process
	dropPrivileges(c)
	out, err := c.CombinedOutput()
	return string(out), err
}
