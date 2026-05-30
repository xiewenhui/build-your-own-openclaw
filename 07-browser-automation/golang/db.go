package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"byoo/xclaw/providers"
	_ "modernc.org/sqlite"
)

// SessionStatus represents the lifecycle state of an Agent session.
type SessionStatus = string

const (
	StatusInit    SessionStatus = "Init"
	StatusRunning SessionStatus = "Running"
	StatusPaused  SessionStatus = "Paused"
	StatusSuccess SessionStatus = "Success"
	StatusFailed  SessionStatus = "Failed"
)

// HistoryEntry is one displayable message returned to the frontend on reconnect.
type HistoryEntry struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// DB wraps a SQLite connection and exposes the four state management operations:
// persist sessions, append traces, handle reconnect, rollback/fork.
type DB struct {
	db *sql.DB
}

func (d *DB) Close() { _ = d.db.Close() }

// initDB opens (or creates) the SQLite file at path, applies migrations, and
// returns a ready-to-use *DB. WAL mode is enabled for concurrent read/write.
func initDB(path string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", path, err)
	}
	sqlDB.Exec("PRAGMA journal_mode=WAL")
	sqlDB.Exec("PRAGMA foreign_keys=ON")
	d := &DB{db: sqlDB}
	if err := d.migrate(); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return d, nil
}

func (d *DB) migrate() error {
	_, err := d.db.Exec(`
CREATE TABLE IF NOT EXISTS sessions (
    session_id        TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    current_status    TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    metadata          TEXT,
    is_forked         INTEGER DEFAULT 0,
    parent_session_id TEXT,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS traces (
    step_id                TEXT PRIMARY KEY,
    session_id             TEXT NOT NULL,
    parent_step_id         TEXT,
    step_type              TEXT NOT NULL,
    name                   TEXT NOT NULL,
    status                 TEXT NOT NULL,
    input_data             TEXT,
    output_data            TEXT,
    error_message          TEXT,
    start_time             INTEGER NOT NULL,
    end_time               INTEGER,
    token_usage_prompt     INTEGER DEFAULT 0,
    token_usage_completion INTEGER DEFAULT 0,
    FOREIGN KEY (session_id)     REFERENCES sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_step_id) REFERENCES traces(step_id)      ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_traces_session_time ON traces(session_id, start_time ASC);
CREATE INDEX IF NOT EXISTS idx_traces_parent       ON traces(parent_step_id);
`)
	return err
}

// ── Session ───────────────────────────────────────────────────────────────────

// ensureSession creates the session record if it does not yet exist.
func (d *DB) ensureSession(sessionID, title string) error {
	now := time.Now().UnixMilli()
	_, err := d.db.Exec(`
INSERT OR IGNORE INTO sessions (session_id, title, current_status, created_at, updated_at)
VALUES (?, ?, ?, ?, ?)`, sessionID, title, StatusInit, now, now)
	return err
}

// setStatus atomically updates current_status + updated_at for a session.
func (d *DB) setStatus(sessionID string, status SessionStatus) error {
	_, err := d.db.Exec(
		`UPDATE sessions SET current_status=?, updated_at=? WHERE session_id=?`,
		status, time.Now().UnixMilli(), sessionID,
	)
	return err
}

// getStatus returns the current_status of a session, or "" if not found.
func (d *DB) getStatus(sessionID string) string {
	var s string
	d.db.QueryRow(`SELECT current_status FROM sessions WHERE session_id=?`, sessionID).Scan(&s)
	return s
}

// ── Trace ─────────────────────────────────────────────────────────────────────

// beginTrace opens a new trace record with status "running" and returns its stepID.
// The state is committed BEFORE the actual work begins — this is the atomic-order guarantee.
// parentStepID may be empty (root step).
func (d *DB) beginTrace(sessionID, parentStepID, stepType, name string, inputData any) (string, error) {
	stepID := d.newStepID(sessionID)
	inputJSON, _ := json.Marshal(inputData)
	_, err := d.db.Exec(`
INSERT INTO traces (step_id, session_id, parent_step_id, step_type, name, status, input_data, start_time)
VALUES (?, ?, NULLIF(?, ''), ?, ?, 'running', ?, ?)`,
		stepID, sessionID, parentStepID, stepType, name, string(inputJSON), time.Now().UnixMilli(),
	)
	return stepID, err
}

// completeTrace marks a trace completed and stores its output.
func (d *DB) completeTrace(stepID string, outputData any, tokenPrompt, tokenCompletion int) error {
	outputJSON, _ := json.Marshal(outputData)
	_, err := d.db.Exec(`
UPDATE traces
SET status='completed', output_data=?, end_time=?,
    token_usage_prompt=?, token_usage_completion=?
WHERE step_id=?`,
		string(outputJSON), time.Now().UnixMilli(), tokenPrompt, tokenCompletion, stepID,
	)
	return err
}

// failTrace marks a trace failed and records the error message.
func (d *DB) failTrace(stepID, errMsg string) error {
	_, err := d.db.Exec(`
UPDATE traces SET status='failed', error_message=?, end_time=? WHERE step_id=?`,
		errMsg, time.Now().UnixMilli(), stepID,
	)
	return err
}

// ── History reconstruction ────────────────────────────────────────────────────

// loadMessages reconstructs the providers.Message slice from completed traces,
// in the exact format the agent loop expects. Used on reconnect / server restart.
func (d *DB) loadMessages(sessionID string) ([]providers.Message, error) {
	rows, err := d.db.Query(`
SELECT step_type, input_data, output_data, error_message
FROM traces
WHERE session_id=? AND step_type IN ('user_input','llm_call','tool_call')
ORDER BY start_time ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	msgs := []providers.Message{{Role: "system", Content: buildSystemPrompt()}}
	for rows.Next() {
		var stepType, inputRaw, outputRaw, errMsg string
		rows.Scan(&stepType, &inputRaw, &outputRaw, &errMsg)

		switch stepType {
		case "user_input":
			var content string
			json.Unmarshal([]byte(inputRaw), &content)
			msgs = append(msgs, providers.Message{Role: "user", Content: content})

		case "llm_call":
			// Every LLM reply (tool-call JSON or plain text) was the assistant turn.
			var content string
			json.Unmarshal([]byte(outputRaw), &content)
			if content != "" {
				msgs = append(msgs, providers.Message{Role: "assistant", Content: content})
			}

		case "tool_call":
			// Tool result: completed → "tool output:\n...", failed → "tool error:\n..."
			if errMsg != "" {
				msgs = append(msgs, providers.Message{Role: "user", Content: "tool error:\n" + errMsg})
			} else {
				var output string
				json.Unmarshal([]byte(outputRaw), &output)
				msgs = append(msgs, providers.Message{Role: "user", Content: "tool output:\n" + output})
			}
		}
	}
	return msgs, rows.Err()
}

// loadHistory returns display-ready (user + agent) messages for the frontend.
// System messages and tool-call JSON are excluded.
func (d *DB) loadHistory(sessionID string) ([]HistoryEntry, error) {
	rows, err := d.db.Query(`
SELECT step_type, input_data, output_data
FROM traces
WHERE session_id=? AND status='completed'
  AND step_type IN ('user_input','llm_call')
ORDER BY start_time ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var history []HistoryEntry
	for rows.Next() {
		var stepType, inputRaw, outputRaw string
		rows.Scan(&stepType, &inputRaw, &outputRaw)

		switch stepType {
		case "user_input":
			var content string
			json.Unmarshal([]byte(inputRaw), &content)
			history = append(history, HistoryEntry{Role: "user", Content: content})

		case "llm_call":
			var content string
			json.Unmarshal([]byte(outputRaw), &content)
			// Skip tool-call JSON — users should only see plain text replies.
			if content != "" && extractJSON(content) == nil {
				history = append(history, HistoryEntry{Role: "assistant", Content: content})
			}
		}
	}
	return history, rows.Err()
}

// ── Rollback ──────────────────────────────────────────────────────────────────

// Rollback deletes all traces with start_time >= the target step's start_time
// and resets the session status to Running. The original session is modified in place.
// Note: only in-DB "memory" is rolled back — real-world side effects (file writes,
// API calls) that happened in those steps cannot be undone without sandbox snapshots.
func (d *DB) Rollback(sessionID, targetStepID string) error {
	var targetTime int64
	err := d.db.QueryRow(
		`SELECT start_time FROM traces WHERE step_id=? AND session_id=?`,
		targetStepID, sessionID,
	).Scan(&targetTime)
	if err != nil {
		return fmt.Errorf("step %q not found in session %q", targetStepID, sessionID)
	}

	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	tx.Exec(`DELETE FROM traces WHERE session_id=? AND start_time >= ?`, sessionID, targetTime)
	tx.Exec(`UPDATE sessions SET current_status=?, updated_at=? WHERE session_id=?`,
		StatusRunning, time.Now().UnixMilli(), sessionID)

	return tx.Commit()
}

// ── Fork ──────────────────────────────────────────────────────────────────────

// Fork clones traces up to and including targetStepID into a new session.
// The original session is NOT touched — the failure scene is preserved for comparison.
// is_forked=1 and parent_session_id record the provenance of the clone.
func (d *DB) Fork(originalSessionID, newSessionID, newTitle, targetStepID string) error {
	var targetTime int64
	err := d.db.QueryRow(
		`SELECT start_time FROM traces WHERE step_id=? AND session_id=?`,
		targetStepID, originalSessionID,
	).Scan(&targetTime)
	if err != nil {
		return fmt.Errorf("step %q not found in session %q", targetStepID, originalSessionID)
	}

	now := time.Now().UnixMilli()
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Clone the session record; mark as forked with provenance pointer.
	tx.Exec(`
INSERT INTO sessions (session_id, title, current_status, created_at, updated_at, is_forked, parent_session_id)
VALUES (?, ?, ?, ?, ?, 1, ?)`,
		newSessionID, newTitle, StatusInit, now, now, originalSessionID,
	)

	// Clone traces up to the target step; prefix step IDs with "fork_" to avoid collisions.
	tx.Exec(`
INSERT INTO traces (step_id, session_id, parent_step_id, step_type, name, status,
                    input_data, output_data, error_message, start_time, end_time,
                    token_usage_prompt, token_usage_completion)
SELECT 'fork_'||step_id, ?, parent_step_id, step_type, name, status,
       input_data, output_data, error_message, start_time, end_time,
       token_usage_prompt, token_usage_completion
FROM traces
WHERE session_id=? AND start_time <= ?`,
		newSessionID, originalSessionID, targetTime,
	)

	return tx.Commit()
}

// ── Steps listing ────────────────────────────────────────────────────────────

// StepSummary is one row in the /steps command output.
type StepSummary struct {
	StepID    string
	StepType  string
	Name      string
	Status    string
	Snippet   string // first 60 chars of input_data
	StartTime int64
}

// loadSteps returns the most recent `limit` steps for a session, newest first.
func (d *DB) loadSteps(sessionID string, limit int) ([]StepSummary, error) {
	rows, err := d.db.Query(`
SELECT step_id, step_type, name, status, COALESCE(input_data,''), start_time
FROM traces WHERE session_id=?
ORDER BY start_time DESC LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var steps []StepSummary
	for rows.Next() {
		var s StepSummary
		rows.Scan(&s.StepID, &s.StepType, &s.Name, &s.Status, &s.Snippet, &s.StartTime)
		s.StepID = shortStepID(s.StepID) // display "s0001" not "cli-abc_s0001"
		if len(s.Snippet) > 60 {
			s.Snippet = s.Snippet[:60] + "…"
		}
		steps = append(steps, s)
	}
	return steps, rows.Err()
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// newStepID generates a globally-unique step ID like "cli-abc_s0001".
// The s-sequence is per-session; the sessionID prefix ensures PRIMARY KEY uniqueness.
func (d *DB) newStepID(sessionID string) string {
	var count int
	d.db.QueryRow(`SELECT COUNT(*) FROM traces WHERE session_id=?`, sessionID).Scan(&count)
	return fmt.Sprintf("%s_s%04d", sessionID, count+1)
}

// shortStepID returns the display form "s0001" from a full step ID like "cli-abc_s0001".
func shortStepID(fullID string) string {
	if i := strings.LastIndex(fullID, "_s"); i >= 0 {
		return fullID[i+1:]
	}
	return fullID
}

// expandStepID converts a user-typed short ID "s0001" to the full DB key "cli-abc_s0001".
func expandStepID(sessionID, short string) string {
	// Already a full ID (contains the session prefix).
	if strings.HasPrefix(short, sessionID+"_") {
		return short
	}
	return sessionID + "_" + short
}
