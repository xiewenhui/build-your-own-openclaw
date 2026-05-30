import { DatabaseSync } from 'node:sqlite';
import type { Message } from './providers/types.ts';

export type SessionStatus = 'Init' | 'Running' | 'Paused' | 'Success' | 'Failed';

export interface HistoryEntry {
  role: string;
  content: string;
}

export interface StepSummary {
  stepId: string;
  stepType: string;
  name: string;
  status: string;
  snippet: string;
  startTime: number;
}

export class DB {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
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
`);
  }

  // ── Session ──────────────────────────────────────────────────────────────────

  ensureSession(sessionId: string, title: string): void {
    const now = Date.now();
    this.db.prepare(
      `INSERT OR IGNORE INTO sessions (session_id, title, current_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, title, 'Init', now, now);
  }

  setStatus(sessionId: string, status: SessionStatus): void {
    this.db.prepare(
      `UPDATE sessions SET current_status=?, updated_at=? WHERE session_id=?`,
    ).run(status, Date.now(), sessionId);
  }

  getStatus(sessionId: string): SessionStatus | null {
    const row = this.db.prepare(
      `SELECT current_status FROM sessions WHERE session_id=?`,
    ).get(sessionId) as { current_status: string } | undefined;
    return row ? (row.current_status as SessionStatus) : null;
  }

  // ── Trace ────────────────────────────────────────────────────────────────────

  // Inserts a trace record with status='running' BEFORE the action executes.
  // This is the state-before-action guarantee: crash after INSERT but before action
  // leaves a clean 'running' record that reconnect logic can detect and skip/retry.
  beginTrace(
    sessionId: string,
    parentStepId: string,
    stepType: string,
    name: string,
    inputData: unknown,
  ): string {
    const stepId = this.newStepId(sessionId);
    const inputJSON = JSON.stringify(inputData);
    this.db.prepare(
      `INSERT INTO traces (step_id, session_id, parent_step_id, step_type, name, status, input_data, start_time)
       VALUES (?, ?, NULLIF(?,''), ?, ?, 'running', ?, ?)`,
    ).run(stepId, sessionId, parentStepId, stepType, name, inputJSON, Date.now());
    return stepId;
  }

  completeTrace(stepId: string, outputData: unknown, tokenPrompt = 0, tokenCompletion = 0): void {
    this.db.prepare(
      `UPDATE traces SET status='completed', output_data=?, end_time=?,
       token_usage_prompt=?, token_usage_completion=? WHERE step_id=?`,
    ).run(JSON.stringify(outputData), Date.now(), tokenPrompt, tokenCompletion, stepId);
  }

  failTrace(stepId: string, errMsg: string): void {
    this.db.prepare(
      `UPDATE traces SET status='failed', error_message=?, end_time=? WHERE step_id=?`,
    ).run(errMsg, Date.now(), stepId);
  }

  // ── History reconstruction ───────────────────────────────────────────────────

  // Reconstructs the providers.Message[] for the LLM context (used on reconnect).
  // systemPrompt is passed in to avoid a circular import with agent.ts.
  // Dangling 'running' traces (crash mid-execution) are skipped; the resume prompt
  // will trigger the LLM to re-decide whether to re-issue the tool call.
  loadMessages(sessionId: string, systemPrompt: string): Message[] {
    const rows = this.db.prepare(
      `SELECT step_type, input_data, output_data, error_message, status
       FROM traces
       WHERE session_id=? AND step_type IN ('user_input','llm_call','tool_call')
       ORDER BY start_time ASC`,
    ).all(sessionId) as Array<{
      step_type: string; input_data: string; output_data: string;
      error_message: string; status: string;
    }>;

    const msgs: Message[] = [{ role: 'system', content: systemPrompt }];
    for (const row of rows) {
      if (row.status === 'running') continue; // dangling step — skip

      switch (row.step_type) {
        case 'user_input': {
          const content = JSON.parse(row.input_data ?? '""') as string;
          msgs.push({ role: 'user', content });
          break;
        }
        case 'llm_call': {
          const content = JSON.parse(row.output_data ?? '""') as string;
          if (content) msgs.push({ role: 'assistant', content });
          break;
        }
        case 'tool_call': {
          if (row.error_message) {
            msgs.push({ role: 'user', content: `tool error:\n${row.error_message}` });
          } else {
            const output = JSON.parse(row.output_data ?? '""') as string;
            msgs.push({ role: 'user', content: `tool output:\n${output}` });
          }
          break;
        }
      }
    }
    return msgs;
  }

  // Returns display-ready history (user + agent plain text only) for the frontend.
  loadHistory(sessionId: string): HistoryEntry[] {
    const rows = this.db.prepare(
      `SELECT step_type, input_data, output_data
       FROM traces
       WHERE session_id=? AND status='completed'
         AND step_type IN ('user_input','llm_call')
       ORDER BY start_time ASC`,
    ).all(sessionId) as Array<{ step_type: string; input_data: string; output_data: string }>;

    const history: HistoryEntry[] = [];
    for (const row of rows) {
      if (row.step_type === 'user_input') {
        const content = JSON.parse(row.input_data ?? '""') as string;
        history.push({ role: 'user', content });
      } else if (row.step_type === 'llm_call') {
        const content = JSON.parse(row.output_data ?? '""') as string;
        // Skip tool-call JSON — users should only see plain text replies.
        if (content && !looksLikeToolCall(content)) {
          history.push({ role: 'assistant', content });
        }
      }
    }
    return history;
  }

  // ── Rollback ─────────────────────────────────────────────────────────────────

  rollback(sessionId: string, targetStepId: string): void {
    const row = this.db.prepare(
      `SELECT start_time FROM traces WHERE step_id=? AND session_id=?`,
    ).get(targetStepId, sessionId) as { start_time: number } | undefined;
    if (!row) throw new Error(`step "${targetStepId}" not found in session "${sessionId}"`);

    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        `DELETE FROM traces WHERE session_id=? AND start_time >= ?`,
      ).run(sessionId, row.start_time);
      this.db.prepare(
        `UPDATE sessions SET current_status=?, updated_at=? WHERE session_id=?`,
      ).run('Running', Date.now(), sessionId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── Fork ─────────────────────────────────────────────────────────────────────

  fork(originalSessionId: string, newSessionId: string, newTitle: string, targetStepId: string): void {
    const row = this.db.prepare(
      `SELECT start_time FROM traces WHERE step_id=? AND session_id=?`,
    ).get(targetStepId, originalSessionId) as { start_time: number } | undefined;
    if (!row) throw new Error(`step "${targetStepId}" not found in session "${originalSessionId}"`);

    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare(
        `INSERT INTO sessions (session_id, title, current_status, created_at, updated_at, is_forked, parent_session_id)
         VALUES (?, ?, 'Init', ?, ?, 1, ?)`,
      ).run(newSessionId, newTitle, now, now, originalSessionId);
      this.db.prepare(
        `INSERT INTO traces (step_id, session_id, parent_step_id, step_type, name, status,
                             input_data, output_data, error_message, start_time, end_time,
                             token_usage_prompt, token_usage_completion)
         SELECT 'fork_'||step_id, ?, parent_step_id, step_type, name, status,
                input_data, output_data, error_message, start_time, end_time,
                token_usage_prompt, token_usage_completion
         FROM traces
         WHERE session_id=? AND start_time <= ?`,
      ).run(newSessionId, originalSessionId, row.start_time);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── Steps listing ─────────────────────────────────────────────────────────────

  loadSteps(sessionId: string, limit: number): StepSummary[] {
    const rows = this.db.prepare(
      `SELECT step_id, step_type, name, status, COALESCE(input_data,'') as input_data, start_time
       FROM traces WHERE session_id=?
       ORDER BY start_time DESC LIMIT ?`,
    ).all(sessionId, limit) as Array<{
      step_id: string; step_type: string; name: string;
      status: string; input_data: string; start_time: number;
    }>;

    return rows.map((r) => {
      let snippet = r.input_data;
      if (snippet.length > 60) snippet = snippet.slice(0, 60) + '…';
      return {
        stepId: shortStepId(r.step_id),
        stepType: r.step_type,
        name: r.name,
        status: r.status,
        snippet,
        startTime: r.start_time,
      };
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private newStepId(sessionId: string): string {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM traces WHERE session_id=?`,
    ).get(sessionId) as { cnt: number };
    const n = (row?.cnt ?? 0) + 1;
    return `${sessionId}_s${String(n).padStart(4, '0')}`;
  }

  close(): void {
    this.db.close();
  }
}

// shortStepId strips the session prefix: "cli-abc_s0001" → "s0001"
export function shortStepId(fullId: string): string {
  const i = fullId.lastIndexOf('_s');
  return i >= 0 ? fullId.slice(i + 1) : fullId;
}

// expandStepId converts user-typed "s0001" back to the full DB key.
export function expandStepId(sessionId: string, short: string): string {
  if (short.startsWith(sessionId + '_')) return short;
  return `${sessionId}_${short}`;
}

function looksLikeToolCall(content: string): boolean {
  const trimmed = content.trim();
  // bare JSON or fenced code block containing JSON with "action" key
  if (trimmed.startsWith('{') && trimmed.includes('"action"')) return true;
  if (trimmed.includes('```') && trimmed.includes('"action"')) return true;
  return false;
}
