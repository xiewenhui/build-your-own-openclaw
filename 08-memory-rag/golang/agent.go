package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"

	"byoo/xclaw/providers"
)

const defaultMaxIterations = 10

// Agent manages per-session conversation history and drives the agent loop.
// db may be nil (in-memory only mode); when set, all sessions and traces are
// persisted to SQLite for crash recovery, reconnect, rollback and fork.
type Agent struct {
	mu            sync.Mutex
	sessions      map[string][]providers.Message // in-memory cache, write-through to db
	db            *DB
	providerChain []string
	maxIterations int
	memoryStore   MemoryStore // nil = memory disabled
	memoryTopK    int
}

func newAgent(providerChain []string, maxIterations int, db *DB) *Agent {
	if maxIterations <= 0 {
		maxIterations = defaultMaxIterations
	}
	return &Agent{
		sessions:      make(map[string][]providers.Message),
		db:            db,
		providerChain: providerChain,
		maxIterations: maxIterations,
		memoryTopK:    5,
	}
}

func newAgentWithMemory(providerChain []string, maxIterations int, db *DB, store MemoryStore, topK int) *Agent {
	a := newAgent(providerChain, maxIterations, db)
	a.memoryStore = store
	a.memoryTopK = topK
	return a
}

// handle processes one user message for the given session.
// onDelta is called for each streamed token once we confirm the reply is plain text.
//
// Special commands (handled before the LLM loop):
//   /rollback <stepID>          — delete traces after stepID, reset session
//   /fork <stepID> [new title]  — clone session up to stepID into a new session
func (a *Agent) handle(msg ACPMessage, onDelta func(string)) (string, error) {
	// ── Special commands ──────────────────────────────────────────────────────
	if a.db != nil {
		if reply, handled := a.handleCommand(msg); handled {
			onDelta(reply)
			return reply, nil
		}
	}

	// ── Load or initialise session ────────────────────────────────────────────
	a.mu.Lock()
	if _, ok := a.sessions[msg.SessionID]; !ok {
		// Cache miss: try to restore from DB (server-restart / reconnect case).
		if a.db != nil {
			if status := a.db.getStatus(msg.SessionID); status != "" {
				loaded, err := a.db.loadMessages(msg.SessionID)
				if err == nil {
					a.sessions[msg.SessionID] = loaded
					fmt.Fprintf(os.Stderr, "[agent] [%s] restored %d messages from DB (status: %s)\n",
						msg.SessionID, len(loaded), status)
				}
			}
		}
		// Still empty → brand-new session.
		if _, ok := a.sessions[msg.SessionID]; !ok {
			a.sessions[msg.SessionID] = []providers.Message{
				{Role: "system", Content: buildSystemPrompt()},
			}
		}
	}
	messages := make([]providers.Message, len(a.sessions[msg.SessionID]))
	copy(messages, a.sessions[msg.SessionID])
	a.mu.Unlock()

	// ── Dual-path memory recall (agent memory + KB) ───────────────────────────
	if a.memoryStore != nil {
		if queryEmb, err := Embed(context.Background(), msg.Content); err == nil {
			halfK := a.memoryTopK / 2
			if halfK < 1 {
				halfK = 1
			}
			// Parallel recall: agent memories and KB chunks concurrently.
			type result struct {
				entries []MemoryEntry
				err     error
			}
			agentCh := make(chan result, 1)
			kbCh    := make(chan result, 1)
			go func() {
				e, err := a.memoryStore.Search(context.Background(), queryEmb, a.memoryTopK, SearchFilter{Source: SourceAgent})
				agentCh <- result{e, err}
			}()
			go func() {
				e, err := a.memoryStore.Search(context.Background(), queryEmb, halfK, SearchFilter{Source: SourceKB})
				kbCh <- result{e, err}
			}()
			agentRes := <-agentCh
			kbRes    := <-kbCh

			var memLines, kbLines []string
			for _, m := range agentRes.entries {
				memLines = append(memLines, "- "+m.Content)
			}
			for i, m := range kbRes.entries {
				kbLines = append(kbLines, fmt.Sprintf("[%d] (doc: %s)\n%s", i+1, m.DocID, m.Content))
			}
			sysPrompt := buildSystemPromptWithMemory(
				strings.Join(memLines, "\n"),
				strings.Join(kbLines, "\n\n"),
			)
			if len(messages) > 0 && messages[0].Role == "system" {
				messages[0].Content = sysPrompt
			}
		} else {
			fmt.Fprintf(os.Stderr, "[agent] memory recall failed (non-fatal): %v\n", err)
		}
	}

	// ── Persist session + set Running ─────────────────────────────────────────
	// State is committed to DB BEFORE any action is taken.
	// On crash, the DB shows Running so reconnect can resume instead of replaying.
	if a.db != nil {
		a.db.ensureSession(msg.SessionID, "Session "+msg.SessionID)
		a.db.setStatus(msg.SessionID, StatusRunning)
	}

	// ── Record user_input trace ───────────────────────────────────────────────
	var lastStepID string
	if a.db != nil {
		sid, _ := a.db.beginTrace(msg.SessionID, "", "user_input", "user", msg.Content)
		a.db.completeTrace(sid, msg.Content, 0, 0)
		lastStepID = sid
	}

	messages = append(messages, providers.Message{Role: "user", Content: msg.Content})

	// ── Agent loop ────────────────────────────────────────────────────────────
	for iterations := 0; iterations < a.maxIterations; iterations++ {
		// Begin llm_call trace BEFORE calling the LLM (state-before-action).
		var llmStepID string
		if a.db != nil {
			llmStepID, _ = a.db.beginTrace(msg.SessionID, lastStepID, "llm_call", "llm", nil)
		}

		var buffer []string
		reply, err := providers.StreamWithFallback(
			context.Background(), messages, a.providerChain, assemble,
			func(token string) { buffer = append(buffer, token) },
		)
		if err != nil {
			if a.db != nil && llmStepID != "" {
				a.db.failTrace(llmStepID, err.Error())
				a.db.setStatus(msg.SessionID, StatusFailed)
			}
			return "", err
		}

		// Complete llm_call trace with the raw reply.
		if a.db != nil && llmStepID != "" {
			a.db.completeTrace(llmStepID, reply, 0, 0)
		}
		messages = append(messages, providers.Message{Role: "assistant", Content: reply})
		lastStepID = llmStepID

		toolCall := extractJSON(reply)
		action, isToolCall := "", false
		if toolCall != nil {
			if act, ok := toolCall["action"].(string); ok && act != "" {
				action = act
				isToolCall = true
			}
		}

		if !isToolCall {
			// Plain text reply — flush buffered tokens to the channel adapter.
			for _, t := range buffer {
				onDelta(t)
			}
			if a.db != nil {
				a.db.setStatus(msg.SessionID, StatusSuccess)
			}
			a.mu.Lock()
			a.sessions[msg.SessionID] = messages
			a.mu.Unlock()

			// Async memory extraction — do not block the reply.
			if a.memoryStore != nil {
				store := a.memoryStore
				snap := make([]providers.Message, len(messages))
				copy(snap, messages)
				sid := msg.SessionID
				p, _ := providers.Get(a.providerChain[0])
				if p != nil {
					go extractAndSaveMemories(context.Background(), snap, sid, p, store)
				}
			}

			return reply, nil
		}

		tool, found := toolRegistry[action]
		if !found {
			errMsg := fmt.Sprintf(`error: unknown tool "%s". Available: %s`, action, availableTools())
			messages = append(messages, providers.Message{Role: "user", Content: errMsg})
			continue
		}

		params := make(map[string]string)
		for k, v := range toolCall {
			if k != "action" {
				if s, ok := v.(string); ok {
					params[k] = s
				}
			}
		}

		// Begin tool_call trace BEFORE executing the tool (state-before-action).
		// If the process crashes here, DB shows a "running" tool_call with no output —
		// reconnect can detect this and retry or skip it.
		var toolStepID string
		if a.db != nil {
			toolStepID, _ = a.db.beginTrace(msg.SessionID, llmStepID, "tool_call", action, params)
		}

		// Push tool-call progress to the client so the user sees the agent working.
		paramsJSON, _ := json.Marshal(params)
		paramsStr := ""
		if len(params) > 0 {
			paramsStr = ": " + string(paramsJSON)
		}
		onDelta(fmt.Sprintf("\n[uses %s%s]\n", action, paramsStr))
		fmt.Fprintf(os.Stderr, "[agent] [%s] [%s] uses [%s]%s\n", msg.SessionID, toolStepID, action, paramsStr)
		output, execErr := tool.Execute(msg.SessionID, params)
		if execErr != nil {
			fmt.Fprintf(os.Stderr, "[agent] tool error: %v\n", execErr)
			if a.db != nil && toolStepID != "" {
				a.db.failTrace(toolStepID, execErr.Error())
			}
			onDelta(fmt.Sprintf("→ error: %s\n", execErr.Error()))
			messages = append(messages, providers.Message{Role: "user", Content: "tool error:\n" + execErr.Error()})
		} else {
			// Screenshots: store [screenshot] placeholder in DB (not full base64).
			dbOutput := output
			if strings.HasPrefix(output, "data:image/") {
				dbOutput = "[screenshot]"
			}
			if a.db != nil && toolStepID != "" {
				a.db.completeTrace(toolStepID, dbOutput, 0, 0)
			}
			// Show a short preview (first line or 120 chars) so the user knows what came back.
			preview := toolOutputPreview(output)
			onDelta(fmt.Sprintf("→ %s\n", preview))
			// Screenshots are sent as vision messages; base64 is NOT stored in
			// history to prevent context overflow on subsequent turns.
			if strings.HasPrefix(output, "data:image/") {
				messages = append(messages, providers.Message{
					Role:     "user",
					Content:  "tool output: [screenshot]",
					ImageURL: output,
				})
			} else {
				messages = append(messages, providers.Message{Role: "user", Content: "tool output:\n" + output})
			}
		}
		lastStepID = toolStepID
	}

	notice := fmt.Sprintf("[xclaw] reached max iterations (%d), stopping", a.maxIterations)
	if a.db != nil {
		a.db.setStatus(msg.SessionID, StatusFailed)
	}
	a.mu.Lock()
	a.sessions[msg.SessionID] = messages
	a.mu.Unlock()
	return notice, nil
}

// formatParams formats tool params for display, omitting large values like base64.
func formatParams(params map[string]string) string {
	if len(params) == 0 {
		return ""
	}
	var parts []string
	for k, v := range params {
		if len(v) > 80 {
			v = v[:80] + "…"
		}
		parts = append(parts, fmt.Sprintf("%s=%q", k, v))
	}
	return ": {" + strings.Join(parts, ", ") + "}"
}

// toolOutputPreview returns the first line (up to 120 chars) of tool output.
// Screenshots (data:image/...) are replaced with a short placeholder.
func toolOutputPreview(output string) string {
	if strings.HasPrefix(output, "data:image/") {
		return "[screenshot]"
	}
	line := output
	if i := strings.IndexByte(output, '\n'); i >= 0 {
		line = output[:i]
	}
	if len(line) > 120 {
		line = line[:120] + "…"
	}
	return line
}

// handleCommand processes /steps, /rollback and /fork slash commands.
// Returns (reply, true) when a command was handled; ("", false) otherwise.
func (a *Agent) handleCommand(msg ACPMessage) (string, bool) {
	content := strings.TrimSpace(msg.Content)

	// /steps [n] — list the most recent n steps (default 10)
	if content == "/steps" || strings.HasPrefix(content, "/steps ") {
		n := 10
		if after, ok := strings.CutPrefix(content, "/steps "); ok {
			if v, err := strconv.Atoi(strings.TrimSpace(after)); err == nil && v > 0 {
				n = v
			}
		}
		steps, err := a.db.loadSteps(msg.SessionID, n)
		if err != nil {
			return "steps failed: " + err.Error(), true
		}
		if len(steps) == 0 {
			return "no steps recorded yet in this session.", true
		}
		// Reverse to show oldest first (loadSteps returns newest first).
		for i, j := 0, len(steps)-1; i < j; i, j = i+1, j-1 {
			steps[i], steps[j] = steps[j], steps[i]
		}
		var sb strings.Builder
		fmt.Fprintf(&sb, "步骤列表 (session: %s):\n", msg.SessionID)
		for _, s := range steps {
			fmt.Fprintf(&sb, "  %-6s  %-12s  %-10s  %s\n", s.StepID, s.StepType, s.Name, s.Snippet)
		}
		sb.WriteString("\n用法:\n")
		sb.WriteString("  /rollback <stepID>        回到该步骤之前重新执行\n")
		sb.WriteString("  /fork <stepID> [title]    从该步骤分叉新会话（原会话保留）\n")
		return sb.String(), true
	}

	// /rollback <stepID>
	// Deletes all traces from stepID onwards and resets session to Running.
	// Clears the in-memory cache so the next message reloads from DB.
	if after, ok := strings.CutPrefix(content, "/rollback "); ok {
		stepID := expandStepID(msg.SessionID, strings.TrimSpace(after))
		if err := a.db.Rollback(msg.SessionID, stepID); err != nil {
			return "rollback failed: " + err.Error(), true
		}
		a.mu.Lock()
		delete(a.sessions, msg.SessionID) // force reload from DB on next handle()
		a.mu.Unlock()
		return fmt.Sprintf("[rollback] session reset to before step %s — send your new instruction", stepID), true
	}

	// /fork <stepID> [new title]
	// Clones session up to stepID into a new session ID. Original is untouched.
	if after, ok := strings.CutPrefix(content, "/fork "); ok {
		parts := strings.SplitN(strings.TrimSpace(after), " ", 2)
		stepID := expandStepID(msg.SessionID, parts[0])
		title := "fork from " + stepID
		if len(parts) > 1 {
			title = strings.TrimSpace(parts[1])
		}
		newSessionID := "fork_" + randomHex(6)
		if err := a.db.Fork(msg.SessionID, newSessionID, title, stepID); err != nil {
			return "fork failed: " + err.Error(), true
		}
		return fmt.Sprintf(
			"[fork] new session created: %s\n"+
				"connect with this session ID to continue on the forked branch.\n"+
				"original session %s is unchanged.",
			newSessionID, msg.SessionID,
		), true
	}

	return "", false
}
