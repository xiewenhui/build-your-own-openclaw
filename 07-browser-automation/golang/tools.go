package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"
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
	reSpuriousObj   = regexp.MustCompile(`("action"\s*:\s*"[^"]+")\s*:\s*\{[^}]*\}`)
)

func repairJSON(s string) string {
	r := reInvalidEscape.ReplaceAllString(s, `\\$1`)
	// Fix {"action": "name": {}} malformed output from LLMs.
	r = reSpuriousObj.ReplaceAllString(r, `$1`)
	return r
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
	today := time.Now().Format("2006-01-02")
	return `You are an AI assistant named xclaw.
Today's date: ` + today + `

To use a tool, output ONLY a JSON object — no text before or after it:
  With parameters:    {"action": "browser_navigate", "url": "https://example.com"}
  No parameters:      {"action": "browser_screenshot_annotated"}

Rules:
- Never mix explanatory text with a tool call in the same response.
- Never write {"action": "name": {}} — the empty object is wrong; use {"action": "name"}.
- To answer directly, output plain text — do NOT use JSON.

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

// ── Browser: HTML distillation ────────────────────────────────────────────────

var (
	reScript    = regexp.MustCompile(`(?is)<script\b[^>]*>[\s\S]*?</script>`)
	reStyle     = regexp.MustCompile(`(?is)<style\b[^>]*>[\s\S]*?</style>`)
	reNoscript  = regexp.MustCompile(`(?is)<noscript\b[^>]*>[\s\S]*?</noscript>`)
	reHead      = regexp.MustCompile(`(?is)<head\b[^>]*>[\s\S]*?</head>`)
	reComment   = regexp.MustCompile(`(?s)<!--[\s\S]*?-->`)
	reSelfClose = regexp.MustCompile(`(?i)<(meta|link|svg|path|polygon|circle|rect|use|defs)\b[^>]*/?>`)
	reAnchor    = regexp.MustCompile(`(?i)<a\b([^>]*)>`)
	reInputTag  = regexp.MustCompile(`(?i)<input\b([^>]*)>`)
	reButtonTag = regexp.MustCompile(`(?i)<button\b([^>]*)>`)
	reSelectTag = regexp.MustCompile(`(?i)<select\b([^>]*)>`)
	// anyTag matches any HTML tag; we filter out non-semantic ones in stripOtherTags.
	reAnyTag   = regexp.MustCompile(`(?i)</?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>`)
	reSpaces   = regexp.MustCompile(`[ \t]{2,}`)
	reNewlines = regexp.MustCompile(`\n{3,}`)
)

// keepTags is the set of tags that survive distillHTML (all others are stripped).
var keepTags = map[string]bool{
	"a": true, "button": true, "input": true, "select": true, "option": true,
	"h1": true, "h2": true, "h3": true, "h4": true, "h5": true, "h6": true,
	"p": true, "li": true, "ul": true, "ol": true,
	"td": true, "th": true, "tr": true, "table": true,
	"label": true, "form": true,
	"main": true, "article": true, "section": true,
	"nav": true, "header": true, "footer": true,
	"title": true, "head": true, "html": true, "body": true,
}

func stripOtherTags(html string) string {
	return reAnyTag.ReplaceAllStringFunc(html, func(m string) string {
		sub := reAnyTag.FindStringSubmatch(m)
		if sub == nil {
			return ""
		}
		tag := strings.ToLower(sub[1])
		if keepTags[tag] {
			return m
		}
		return ""
	})
}

func attrVal(attrs, name string) string {
	re := regexp.MustCompile(`(?i)` + name + `="([^"]*)"`)
	m := re.FindStringSubmatch(attrs)
	if m != nil {
		return m[1]
	}
	return ""
}

func distillHTML(html string, maxChars, offsetChars int) string {
	r := html
	r = reHead.ReplaceAllString(r, "")
	r = reScript.ReplaceAllString(r, "")
	r = reStyle.ReplaceAllString(r, "")
	r = reNoscript.ReplaceAllString(r, "")
	r = reComment.ReplaceAllString(r, "")
	r = reSelfClose.ReplaceAllString(r, "")

	r = reAnchor.ReplaceAllStringFunc(r, func(m string) string {
		sub := reAnchor.FindStringSubmatch(m)
		attrs := sub[1]
		href := attrVal(attrs, "href")
		aid := attrVal(attrs, "data-agent-id")
		res := "<a"
		if aid != "" {
			res += ` data-agent-id="` + aid + `"`
		}
		if href != "" {
			res += ` href="` + href + `"`
		}
		return res + ">"
	})
	r = reInputTag.ReplaceAllStringFunc(r, func(m string) string {
		sub := reInputTag.FindStringSubmatch(m)
		attrs := sub[1]
		aid := attrVal(attrs, "data-agent-id")
		var parts []string
		if aid != "" {
			parts = append(parts, `data-agent-id="`+aid+`"`)
		}
		for _, a := range []string{"name", "type", "placeholder", "value"} {
			if v := attrVal(attrs, a); v != "" {
				parts = append(parts, a+`="`+v+`"`)
			}
		}
		if len(parts) == 0 {
			return "<input>"
		}
		return "<input " + strings.Join(parts, " ") + ">"
	})
	r = reButtonTag.ReplaceAllStringFunc(r, func(m string) string {
		sub := reButtonTag.FindStringSubmatch(m)
		attrs := sub[1]
		aid := attrVal(attrs, "data-agent-id")
		if aid != "" {
			return `<button data-agent-id="` + aid + `">`
		}
		return "<button>"
	})
	r = reSelectTag.ReplaceAllStringFunc(r, func(m string) string {
		sub := reSelectTag.FindStringSubmatch(m)
		attrs := sub[1]
		aid := attrVal(attrs, "data-agent-id")
		if aid != "" {
			return `<select data-agent-id="` + aid + `">`
		}
		return "<select>"
	})
	r = stripOtherTags(r)
	r = reSpaces.ReplaceAllString(r, " ")
	r = reNewlines.ReplaceAllString(r, "\n\n")
	r = strings.TrimSpace(r)

	if offsetChars > 0 {
		if offsetChars >= len(r) {
			return "[offset 超出内容长度]"
		}
		r = r[offsetChars:]
	}
	if len(r) > maxChars {
		total := offsetChars + len(r)
		r = r[:maxChars] + fmt.Sprintf("\n[内容已截断，共约 %d 字符；如需继续请使用 browser_content 并设置 offset=%d]",
			total, offsetChars+maxChars)
	}
	return r
}

// injectLocatorIdsScript is the JS injected into the page to assign data-agent-id.
const injectLocatorIdsScript = `() => {
	let id = 0;
	document.querySelectorAll('a, button, input, select, td[role="gridcell"], li[role="option"]').forEach(el => {
		el.setAttribute('data-agent-id', String(++id));
	});
}`

func injectLocatorIds(page *rod.Page) error {
	_, err := page.Eval(injectLocatorIdsScript)
	return err
}

// dismissPopupsScript closes common cookie/consent overlays.
const dismissPopupsScript = `() => {
	const sels = [
		'[aria-label*="close" i]', '[aria-label*="关闭"]',
		'button[class*="accept"]', 'button[class*="consent"]',
	];
	for (const s of sels) {
		try {
			const el = document.querySelector(s);
			if (el) el.click();
		} catch {}
	}
}`

var destructivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)submit`),
	regexp.MustCompile(`(?i)pay`),
	regexp.MustCompile(`(?i)purchase`),
	regexp.MustCompile(`(?i)buy`),
	regexp.MustCompile(`(?i)checkout`),
	regexp.MustCompile(`(?i)delete`),
	regexp.MustCompile(`(?i)remove`),
	regexp.MustCompile(`(?i)confirm`),
	regexp.MustCompile(`(?i)\bsend\b`),
}

func isDestructiveSelector(sel string) bool {
	for _, p := range destructivePatterns {
		if p.MatchString(sel) {
			return true
		}
	}
	return false
}

// navigateAndWait navigates to url, waits for network idle, then dismisses popups.
func navigateAndWait(page *rod.Page, url string) error {
	fmt.Fprintf(os.Stderr, "[navigate] → %s\n", url)
	wait := page.WaitNavigation(proto.PageLifecycleEventNameNetworkIdle)
	if err := page.Navigate(url); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "[navigate] waiting for networkidle (15s timeout)…\n")
	done := make(chan struct{})
	go func() { wait(); close(done) }()
	select {
	case <-done:
		fmt.Fprintf(os.Stderr, "[navigate] networkidle\n")
	case <-time.After(15 * time.Second):
		fmt.Fprintf(os.Stderr, "[navigate] timeout (15s), continuing anyway\n")
	}
	_, _ = page.Eval(dismissPopupsScript)
	return nil
}

// keyMap maps string key names from the LLM to go-rod input.Key constants.
var keyMap = map[string]input.Key{
	"Enter":      input.Enter,
	"Return":     input.Enter,
	"Escape":     input.Escape,
	"Tab":        input.Tab,
	"Backspace":  input.Backspace,
	"Space":      input.Space,
	"ArrowDown":  input.ArrowDown,
	"ArrowUp":    input.ArrowUp,
	"ArrowLeft":  input.ArrowLeft,
	"ArrowRight": input.ArrowRight,
}

// ── Browser: tool registration ─────────────────────────────────────────────────

func registerBrowserTools(pool *BrowserPool, hitl HITLConfirmer, cfg BrowserConfig) {
	maxChars := cfg.MaxContentChars

	// browser_navigate
	registerTool(ToolDefinition{
		Name:        "browser_navigate",
		Description: "Navigate to a URL and wait for the page to fully load (including JavaScript-rendered content).",
		Properties: map[string]ToolParam{
			"url": {Type: "string", Description: "The URL to navigate to"},
		},
		Required: []string{"url"},
	}, func(sessionID string, params map[string]string) (string, error) {
		page, err := pool.GetPage(sessionID)
		if err != nil {
			return "", err
		}
		if err := navigateAndWait(page, params["url"]); err != nil {
			return "", err
		}
		if err := injectLocatorIds(page); err != nil {
			return "", err
		}
		html, err := page.HTML()
		if err != nil {
			return "", err
		}
		info, _ := page.Info()
		title, currentURL := "", ""
		if info != nil {
			title = info.Title
			currentURL = info.URL
		}
		preview := distillHTML(html, 3000, 0)
		return fmt.Sprintf("navigated to: %s\nurl: %s\n\n%s", title, currentURL, preview), nil
	})

	// browser_content
	registerTool(ToolDefinition{
		Name:        "browser_content",
		Description: "Get the current page content. Returns distilled HTML with data-agent-id attributes on interactive elements so you can reference them by number in browser_click / browser_type. If the result is truncated, call again with a higher offset to read the next section.",
		Properties: map[string]ToolParam{
			"mode":   {Type: "string", Description: `Output mode: "text" strips all tags; "html" (default) returns simplified HTML with locator IDs`},
			"offset": {Type: "string", Description: "Character offset into the distilled content (default 0). Use the offset value shown in the truncation message to read the next chunk of the page."},
		},
		Required: []string{},
	}, func(sessionID string, params map[string]string) (string, error) {
		page, err := pool.GetPage(sessionID)
		if err != nil {
			return "", err
		}
		mode := params["mode"]
		if mode == "" {
			mode = "html"
		}
		offset := 0
		if s := params["offset"]; s != "" {
			fmt.Sscanf(s, "%d", &offset)
		}
		if mode != "text" {
			if err := injectLocatorIds(page); err != nil {
				return "", err
			}
		}
		html, err := page.HTML()
		if err != nil {
			return "", err
		}
		result := distillHTML(html, maxChars, offset)
		if mode == "text" {
			result = reAnyTag.ReplaceAllString(result, " ")
			result = reSpaces.ReplaceAllString(result, " ")
			result = strings.TrimSpace(result)
		}
		return result, nil
	})

	// browser_screenshot
	registerTool(ToolDefinition{
		Name:        "browser_screenshot",
		Description: "Take a screenshot of the current viewport. The image will be attached to the next LLM message for visual analysis.",
		Properties:  map[string]ToolParam{},
		Required:    []string{},
	}, func(sessionID string, _ map[string]string) (string, error) {
		page, err := pool.GetPage(sessionID)
		if err != nil {
			return "", err
		}
		buf, err := page.Screenshot(false, nil)
		if err != nil {
			return "", err
		}
		return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf), nil
	})

	// browser_screenshot_annotated
	registerTool(ToolDefinition{
		Name:        "browser_screenshot_annotated",
		Description: "Take a screenshot with numbered red bounding boxes drawn around all interactive elements. Use the element numbers with browser_click/browser_type agent_id parameter.",
		Properties:  map[string]ToolParam{},
		Required:    []string{},
	}, func(sessionID string, _ map[string]string) (string, error) {
		page, err := pool.GetPage(sessionID)
		if err != nil {
			return "", err
		}
		if err := injectLocatorIds(page); err != nil {
			return "", err
		}

		type elemInfo struct {
			ID    int     `json:"id"`
			X     float64 `json:"x"`
			Y     float64 `json:"y"`
			W     float64 `json:"w"`
			H     float64 `json:"h"`
		}
		const collectScript = `() => {
			return [...document.querySelectorAll('a, button, input, select, td[role="gridcell"], li[role="option"]')]
				.map(el => {
					const aid = el.getAttribute('data-agent-id');
					if (!aid) return null;
					const r = el.getBoundingClientRect();
					return { id: parseInt(aid), x: r.x, y: r.y, w: r.width, h: r.height };
				})
				.filter(e => e !== null && e.w > 0 && e.h > 0);
		}`
		val, err := page.Eval(collectScript)
		if err != nil {
			return "", err
		}
		var elems []elemInfo
		if err := val.Value.Unmarshal(&elems); err != nil {
			return "", fmt.Errorf("unmarshal elems: %w", err)
		}

		// Build canvas overlay JS
		elemsJSON, _ := json.Marshal(elems)
		overlayScript := `(elems) => {
			const canvas = document.createElement('canvas');
			canvas.id = '__xclaw_overlay__';
			canvas.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none';
			canvas.width = window.innerWidth;
			canvas.height = window.innerHeight;
			document.body.appendChild(canvas);
			const ctx = canvas.getContext('2d');
			for (const e of elems) {
				ctx.strokeStyle = 'red'; ctx.lineWidth = 2;
				ctx.strokeRect(e.x, e.y, e.w, e.h);
				ctx.fillStyle = 'red';
				ctx.fillRect(e.x, e.y - 16, 22, 16);
				ctx.fillStyle = 'white';
				ctx.font = 'bold 11px sans-serif';
				ctx.fillText(String(e.id), e.x + 3, e.y - 3);
			}
		}`
		if _, err := page.Eval(overlayScript, string(elemsJSON)); err != nil {
			return "", err
		}

		buf, err := page.Screenshot(false, nil)
		// Remove overlay regardless of screenshot result.
		_, _ = page.Eval(`() => { document.getElementById('__xclaw_overlay__')?.remove(); }`)
		if err != nil {
			return "", err
		}
		return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf), nil
	})

	// browser_click
	registerTool(ToolDefinition{
		Name:        "browser_click",
		Description: "Click an element. Prefer agent_id (the number from browser_content / browser_screenshot_annotated) over selector.",
		Properties: map[string]ToolParam{
			"agent_id": {Type: "string", Description: "Element number from browser_content or annotated screenshot"},
			"selector": {Type: "string", Description: "CSS selector (fallback when agent_id is unavailable)"},
		},
		Required: []string{},
	}, func(sessionID string, params map[string]string) (string, error) {
		page, err := pool.GetPage(sessionID)
		if err != nil {
			return "", err
		}
		sel := params["selector"]
		if aid := params["agent_id"]; aid != "" {
			sel = `[data-agent-id="` + aid + `"]`
		}
		if sel == "" {
			return "error: provide agent_id or selector", nil
		}

		destructive := isDestructiveSelector(sel)
		info, _ := page.Info()
		currentURL := ""
		if info != nil {
			currentURL = info.URL
		}
		if !hitl.Confirm("browser_click "+sel, "url: "+currentURL, destructive) {
			return "action denied by user", nil
		}

		urlBefore := currentURL

		// Navigate-aware click: arm navigation listener BEFORE clicking.
		fmt.Fprintf(os.Stderr, "[browser_click] clicking %s (url: %s)\n", sel, urlBefore)
		wait := page.WaitNavigation(proto.PageLifecycleEventNameNetworkIdle)
		el, elErr := page.Timeout(3 * time.Second).Element(sel)
		if elErr != nil {
			// Element not found via Playwright — fall back to JS querySelector.
			fmt.Fprintf(os.Stderr, "[browser_click] element not found via rod, trying JS click\n")
			_, _ = page.Eval(`(sel) => { const el = document.querySelector(sel); if (el) el.click(); }`, sel)
		} else if clickErr := el.Click(proto.InputMouseButtonLeft, 1); clickErr != nil {
			fmt.Fprintf(os.Stderr, "[browser_click] pointer click failed (%v), trying JS click\n", clickErr)
			_, _ = page.Eval(`(sel) => { const el = document.querySelector(sel); if (el) el.click(); }`, sel)
		}
		fmt.Fprintf(os.Stderr, "[browser_click] waiting for navigation (8s timeout)…\n")
		done := make(chan struct{})
		go func() { wait(); close(done) }()
		select {
		case <-done:
			fmt.Fprintf(os.Stderr, "[browser_click] navigation settled\n")
		case <-time.After(8 * time.Second):
			fmt.Fprintf(os.Stderr, "[browser_click] navigation timeout (no networkidle in 8s)\n")
		}

		info, _ = page.Info()
		urlAfter := ""
		if info != nil {
			urlAfter = info.URL
		}
		if urlBefore != urlAfter {
			_, _ = page.Eval(dismissPopupsScript)
			_ = injectLocatorIds(page)
			navInfo, _ := page.Info()
			navTitle := ""
			if navInfo != nil {
				navTitle = navInfo.Title
			}
			return fmt.Sprintf("clicked: %s\nnavigated to: %s\nurl: %s", sel, navTitle, urlAfter), nil
		}
		_ = injectLocatorIds(page)
		return fmt.Sprintf("clicked: %s\nurl: %s", sel, urlAfter), nil
	})

	// browser_type
	registerTool(ToolDefinition{
		Name:        "browser_type",
		Description: "Clear an input element and type text into it. Prefer agent_id over selector.",
		Properties: map[string]ToolParam{
			"agent_id": {Type: "string", Description: "Element number from browser_content or annotated screenshot"},
			"selector": {Type: "string", Description: "CSS selector (fallback)"},
			"text":     {Type: "string", Description: "Text to type"},
		},
		Required: []string{"text"},
	}, func(sessionID string, params map[string]string) (string, error) {
		page, err := pool.GetPage(sessionID)
		if err != nil {
			return "", err
		}
		sel := params["selector"]
		if aid := params["agent_id"]; aid != "" {
			sel = `[data-agent-id="` + aid + `"]`
		}
		if sel == "" {
			return "error: provide agent_id or selector", nil
		}
		el, err := page.Timeout(3 * time.Second).Element(sel)
		if err != nil {
			return "", fmt.Errorf("element not found: %s", sel)
		}
		if err := el.SelectAllText(); err != nil {
			return "", err
		}
		if err := el.Input(params["text"]); err != nil {
			return "", err
		}
		// Autocomplete dropdowns appear after typing — refresh IDs.
		_ = injectLocatorIds(page)
		return fmt.Sprintf(`typed "%s" into: %s`, params["text"], sel), nil
	})

	// browser_key
	registerTool(ToolDefinition{
		Name:        "browser_key",
		Description: "Press a keyboard key. Use for: Enter (confirm autocomplete selection or submit form), Escape (close popup/dropdown), ArrowDown/ArrowUp (navigate dropdown options), Tab (move focus to next field).",
		Properties: map[string]ToolParam{
			"key": {Type: "string", Description: "Key name: Enter, Escape, Tab, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, Backspace, Space"},
		},
		Required: []string{"key"},
	}, func(sessionID string, params map[string]string) (string, error) {
		page, err := pool.GetPage(sessionID)
		if err != nil {
			return "", err
		}
		info, _ := page.Info()
		urlBefore := ""
		if info != nil {
			urlBefore = info.URL
		}

		wait := page.WaitNavigation(proto.PageLifecycleEventNameNetworkIdle)
		// Map string key name to input.Key constant.
		keyVal, ok := keyMap[params["key"]]
		if !ok {
			return "", fmt.Errorf("unsupported key %q; supported: Enter, Escape, Tab, Backspace, Space, ArrowDown, ArrowUp, ArrowLeft, ArrowRight", params["key"])
		}
		if err := page.Keyboard.Press(keyVal); err != nil {
			return "", fmt.Errorf("key press failed: %w", err)
		}
		done := make(chan struct{})
		go func() { wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(8 * time.Second):
		}

		info, _ = page.Info()
		urlAfter := ""
		if info != nil {
			urlAfter = info.URL
		}
		if urlBefore != urlAfter {
			_, _ = page.Eval(dismissPopupsScript)
			_ = injectLocatorIds(page)
			keyInfo, _ := page.Info()
			keyTitle := ""
			if keyInfo != nil {
				keyTitle = keyInfo.Title
			}
			return fmt.Sprintf("pressed %s\nnavigated to: %s\nurl: %s", params["key"], keyTitle, urlAfter), nil
		}
		_ = injectLocatorIds(page)
		return fmt.Sprintf("pressed %s\nurl: %s", params["key"], urlAfter), nil
	})

	// browser_scroll
	registerTool(ToolDefinition{
		Name:        "browser_scroll",
		Description: "Scroll the page up or down to reveal more content (e.g. for infinite scroll pages).",
		Properties: map[string]ToolParam{
			"direction": {Type: "string", Description: `"up" or "down"`},
			"pixels":    {Type: "string", Description: "Pixels to scroll (default 500)"},
		},
		Required: []string{"direction"},
	}, func(sessionID string, params map[string]string) (string, error) {
		page, err := pool.GetPage(sessionID)
		if err != nil {
			return "", err
		}
		px := 500
		if s := params["pixels"]; s != "" {
			fmt.Sscanf(s, "%d", &px)
		}
		if params["direction"] == "up" {
			px = -px
		}
		_, err = page.Eval(fmt.Sprintf("() => window.scrollBy(0, %d)", px))
		if err != nil {
			return "", err
		}
		val, _ := page.Eval("() => window.scrollY")
		scrollY := 0
		if val != nil {
			scrollY = val.Value.Int()
		}
		dir := params["direction"]
		if px < 0 {
			px = -px
		}
		return fmt.Sprintf("scrolled %s %dpx — current scroll position: %dpx", dir, px, scrollY), nil
	})
}
