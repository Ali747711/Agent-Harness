import { mkdir, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { openDatabase, type SqliteDb } from '../runtime/sqlite.ts';
import type { SessionEntry } from './entries.ts';
import { JsonlSessionStore } from './store.ts';

/**
 * Derived session index (ADR-0004). JSONL transcripts remain the source of
 * truth; this exists only so `sessions list` and `--continue` do not have to
 * parse every transcript. `reindex()` rebuilds it from disk, and a test
 * asserts a deleted database reconstructs to identical rows.
 */
export interface SessionSummary {
  sessionId: string;
  filePath: string;
  workspaceRoot: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** First user prompt, trimmed to one line. */
  title: string;
  messageCount: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  title TEXT NOT NULL,
  message_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_workspace
  ON sessions (workspace_root, updated_at DESC);
`;

interface Row {
  session_id: string;
  file_path: string;
  workspace_root: string;
  model: string;
  created_at: string;
  updated_at: string;
  title: string;
  message_count: number;
}

function toSummary(row: Row): SessionSummary {
  return {
    sessionId: row.session_id,
    filePath: row.file_path,
    workspaceRoot: row.workspace_root,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    title: row.title,
    messageCount: row.message_count
  };
}

/** Derive a summary from a transcript. Returns null for an empty/meta-less file. */
export function summarize(
  entries: readonly SessionEntry[],
  filePath: string
): SessionSummary | null {
  const meta = entries.find((entry) => entry.type === 'meta');
  if (meta === undefined || meta.type !== 'meta') {
    return null;
  }
  const firstUser = entries.find((entry) => entry.type === 'user');
  let title = '(no prompt yet)';
  if (firstUser?.type === 'user') {
    const text = firstUser.data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 0) {
      title = text.length > 120 ? `${text.slice(0, 117)}…` : text;
    }
  }
  return {
    sessionId: meta.data.sessionId,
    filePath,
    workspaceRoot: meta.data.workspaceRoot,
    model: meta.data.model,
    createdAt: meta.data.createdAt,
    updatedAt: entries.at(-1)?.ts ?? meta.data.createdAt,
    title,
    messageCount: entries.filter((entry) => entry.type === 'user' || entry.type === 'assistant')
      .length
  };
}

export class SessionIndex {
  private constructor(private readonly db: SqliteDb) {}

  static async open(dbPath: string): Promise<SessionIndex> {
    await mkdir(dirname(dbPath), { recursive: true });
    const db = await openDatabase(dbPath);
    db.exec(SCHEMA);
    return new SessionIndex(db);
  }

  upsert(summary: SessionSummary): void {
    this.db.run(
      `INSERT INTO sessions
         (session_id, file_path, workspace_root, model, created_at, updated_at, title, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         file_path = excluded.file_path,
         model = excluded.model,
         updated_at = excluded.updated_at,
         title = excluded.title,
         message_count = excluded.message_count`,
      [
        summary.sessionId,
        summary.filePath,
        summary.workspaceRoot,
        summary.model,
        summary.createdAt,
        summary.updatedAt,
        summary.title,
        summary.messageCount
      ]
    );
  }

  /** Re-read a transcript and refresh its row. Safe to call after every run. */
  async refresh(filePath: string): Promise<SessionSummary | null> {
    const store = new JsonlSessionStore(dirname(filePath));
    const entries = await store.readEntries(filePath);
    const summary = summarize(entries, filePath);
    if (summary !== null) {
      this.upsert(summary);
    }
    return summary;
  }

  list(workspaceRoot?: string, limit = 50): SessionSummary[] {
    const rows =
      workspaceRoot === undefined
        ? this.db.all<Row>('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?', [limit])
        : this.db.all<Row>(
            'SELECT * FROM sessions WHERE workspace_root = ? ORDER BY updated_at DESC LIMIT ?',
            [workspaceRoot, limit]
          );
    return rows.map(toSummary);
  }

  latest(workspaceRoot: string): SessionSummary | undefined {
    const row = this.db.get<Row>(
      'SELECT * FROM sessions WHERE workspace_root = ? ORDER BY updated_at DESC LIMIT 1',
      [workspaceRoot]
    );
    return row === undefined ? undefined : toSummary(row);
  }

  find(sessionId: string): SessionSummary | undefined {
    const row = this.db.get<Row>('SELECT * FROM sessions WHERE session_id = ?', [sessionId]);
    return row === undefined ? undefined : toSummary(row);
  }

  /** Rebuild every row for a project directory from its JSONL files. */
  async reindex(sessionsDir: string): Promise<number> {
    let files: string[];
    try {
      files = (await readdir(sessionsDir)).filter((name) => name.endsWith('.jsonl'));
    } catch {
      return 0;
    }
    let indexed = 0;
    for (const file of files) {
      const summary = await this.refresh(join(sessionsDir, file));
      if (summary !== null) {
        indexed += 1;
      }
    }
    return indexed;
  }

  close(): void {
    this.db.close();
  }
}

export function sessionIdFromPath(filePath: string): string {
  return basename(filePath, '.jsonl');
}
