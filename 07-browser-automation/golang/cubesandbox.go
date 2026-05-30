package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// SandboxPool manages one CubeSandbox per session.
// Sandboxes are created lazily on first use and destroyed when the session ends
// or when KillAll is called on process exit.
type SandboxPool struct {
	mu   sync.Mutex
	pool map[string]*CubeSandbox
}

func NewSandboxPool() *SandboxPool {
	return &SandboxPool{pool: make(map[string]*CubeSandbox)}
}

// GetOrCreate returns the sandbox for sessionID, creating one if it doesn't exist.
func (p *SandboxPool) GetOrCreate(sessionID string) (*CubeSandbox, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if sb, ok := p.pool[sessionID]; ok {
		return sb, nil
	}
	sb, err := NewCubeSandbox()
	if err != nil {
		return nil, err
	}
	p.pool[sessionID] = sb
	fmt.Fprintf(os.Stderr, "[pool] session %s → sandbox %s\n", sessionID, sb.sandboxID)
	return sb, nil
}

// Kill destroys the sandbox for sessionID and removes it from the pool.
func (p *SandboxPool) Kill(sessionID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if sb, ok := p.pool[sessionID]; ok {
		sb.Kill()
		delete(p.pool, sessionID)
	}
}

// KillAll destroys every sandbox in the pool. Call on process exit.
func (p *SandboxPool) KillAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, sb := range p.pool {
		sb.Kill()
		delete(p.pool, id)
	}
}
// It creates one KVM microVM sandbox and routes all tool executions into it.
type CubeSandbox struct {
	apiURL     string
	apiKey     string
	templateID string
	sandboxID  string
	domain     string // virtual hostname suffix for the proxy, e.g. "cube.app" or "localhost"
	httpClient *http.Client
}

// NewCubeSandbox creates a sandbox via POST /sandboxes and returns a connected client.
// Reads E2B_API_URL, E2B_API_KEY, CUBE_TEMPLATE_ID, CUBE_SANDBOX_DOMAIN from the environment.
func NewCubeSandbox() (*CubeSandbox, error) {
	apiURL := os.Getenv("E2B_API_URL")
	if apiURL == "" {
		return nil, fmt.Errorf("E2B_API_URL is not set")
	}
	templateID := os.Getenv("CUBE_TEMPLATE_ID")
	if templateID == "" {
		return nil, fmt.Errorf("CUBE_TEMPLATE_ID is not set")
	}

	// Derive domain from API URL host (e.g. "127.0.0.1" or "cube.app").
	domain := os.Getenv("CUBE_SANDBOX_DOMAIN")
	if domain == "" {
		u, err := url.Parse(apiURL)
		if err != nil {
			return nil, fmt.Errorf("invalid E2B_API_URL: %w", err)
		}
		domain = u.Hostname()
	}

	sb := &CubeSandbox{
		apiURL:     strings.TrimRight(apiURL, "/"),
		apiKey:     os.Getenv("E2B_API_KEY"),
		templateID: templateID,
		domain:     domain,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}

	if err := sb.create(); err != nil {
		return nil, err
	}
	return sb, nil
}

func (s *CubeSandbox) create() error {
	payload := map[string]any{
		"templateID": s.templateID,
		"timeout":    300,
	}
	body, _ := json.Marshal(payload)

	req, _ := http.NewRequest("POST", s.apiURL+"/sandboxes", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if s.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+s.apiKey)
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("create sandbox: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("create sandbox HTTP %d: %s", resp.StatusCode, string(b))
	}

	var data map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return fmt.Errorf("decode sandbox response: %w", err)
	}
	id, _ := data["sandboxID"].(string)
	if id == "" {
		return fmt.Errorf("sandboxID missing in create response")
	}
	s.sandboxID = id
	fmt.Fprintf(os.Stderr, "[cubesandbox] created sandbox %s\n", s.sandboxID)
	return nil
}

// RunCode executes Python code inside the sandbox via the Jupyter kernel endpoint.
// It streams ndjson lines and collects stdout + result text.
func (s *CubeSandbox) RunCode(code string) (string, error) {
	execURL := fmt.Sprintf("http://%d-%s.%s/execute", 49999, s.sandboxID, s.domain)
	payload := map[string]any{
		"code":     code,
		"language": "python",
	}
	body, _ := json.Marshal(payload)

	// Use a client without global timeout for streaming responses.
	streamClient := &http.Client{}
	req, _ := http.NewRequest("POST", execURL, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	resp, err := streamClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("execute: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		b, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("execute HTTP %d: %s", resp.StatusCode, string(b))
	}

	return s.collectNDJSON(resp.Body)
}

// collectNDJSON parses the ndjson event stream from the Jupyter execute endpoint.
// Each line is a JSON object with a "type" field: "stdout", "stderr", "result", "error".
func (s *CubeSandbox) collectNDJSON(r io.Reader) (string, error) {
	var out strings.Builder
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			continue
		}
		switch event["type"] {
		case "stdout":
			if text, ok := event["text"].(string); ok {
				out.WriteString(text)
			}
		case "result":
			if text, ok := event["text"].(string); ok {
				out.WriteString(text)
			}
		case "error":
			name, _ := event["ename"].(string)
			value, _ := event["evalue"].(string)
			return out.String(), fmt.Errorf("%s: %s", name, value)
		}
	}
	return out.String(), scanner.Err()
}

// RunCommand executes a shell command inside the sandbox by wrapping it in Python subprocess.
func (s *CubeSandbox) RunCommand(cmd string) (string, error) {
	// Escape the command string for safe embedding in Python source.
	escaped := strings.ReplaceAll(cmd, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)

	code := fmt.Sprintf(`
import subprocess as _sp, sys as _sys
_r = _sp.run("%s", shell=True, capture_output=True, text=True)
_sys.stdout.write(_r.stdout)
if _r.stderr:
    _sys.stdout.write(_r.stderr)
if _r.returncode != 0:
    raise SystemExit(_r.returncode)
`, escaped)

	return s.RunCode(code)
}

// Kill destroys the sandbox via DELETE /sandboxes/{id}.
func (s *CubeSandbox) Kill() error {
	if s.sandboxID == "" {
		return nil
	}
	req, _ := http.NewRequest("DELETE", s.apiURL+"/sandboxes/"+s.sandboxID, nil)
	if s.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+s.apiKey)
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	fmt.Fprintf(os.Stderr, "[cubesandbox] killed sandbox %s\n", s.sandboxID)
	s.sandboxID = ""
	return nil
}
