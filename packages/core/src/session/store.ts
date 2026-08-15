import { type FileHandle, mkdir, open, readFile } from 'node:fs/promises';

import { HarnessError } from '../errors/index.ts';
import { makeEntry, parseSessionEntry, type SessionEntry } from './entries.ts';
import { sessionFilePath } from './paths.ts';

/**
 * JSONL session store (ADR-0004). Append-only writer with explicit
 * turn-boundary flush; reader tolerates exactly one truncated TRAILING line
 * (crash mid-write) and treats corruption anywhere else as an error.
 * SQLite indexing is derived and lands in step 14 — never authoritative.
 */
export interface SessionSink {
  append(entry: SessionEntry): Promise<void>;
  /** fsync — called at turn boundaries, not per line. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenedSession {
  sessionId: string;
  filePath: string;
  entries: SessionEntry[];
  sink: SessionSink;
}

export interface CreateSessionMeta {
  workspaceRoot: string;
  model: string;
  sessionId?: string;
}

export class JsonlSessionStore {
  constructor(private readonly sessionsDir: string) {}

  async create(meta: CreateSessionMeta): Promise<OpenedSession> {
    const sessionId = meta.sessionId ?? crypto.randomUUID();
    const filePath = sessionFilePath(this.sessionsDir, sessionId);
    await mkdir(this.sessionsDir, { recursive: true });

    const head = makeEntry(
      { parentId: null },
      {
        type: 'meta',
        data: {
          sessionId,
          workspaceRoot: meta.workspaceRoot,
          model: meta.model,
          createdAt: new Date().toISOString()
        }
      }
    );

    const sink = await this.openSink(filePath, 'ax');
    await sink.append(head);
    await sink.flush();
    return { sessionId, filePath, entries: [head], sink };
  }

  async open(sessionId: string): Promise<OpenedSession> {
    const filePath = sessionFilePath(this.sessionsDir, sessionId);
    const entries = await this.readEntries(filePath);
    const sink = await this.openSink(filePath, 'a');
    return { sessionId, filePath, entries, sink };
  }

  async readEntries(filePath: string): Promise<SessionEntry[]> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
        throw new HarnessError('session_not_found', `no session transcript at ${filePath}`, {
          cause
        });
      }
      throw new HarnessError('session_corrupt', `cannot read transcript ${filePath}`, { cause });
    }

    const lines = raw.split('\n');
    // A trailing '' after the final newline is normal; drop it.
    if (lines.at(-1) === '') {
      lines.pop();
    }

    const entries: SessionEntry[] = [];
    for (const [index, line] of lines.entries()) {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (cause) {
        if (index === lines.length - 1) {
          // Crash mid-write: tolerate and drop the partial trailing line.
          break;
        }
        throw new HarnessError('session_corrupt', `malformed JSONL at line ${index + 1}`, {
          cause,
          details: { filePath }
        });
      }
      entries.push(parseSessionEntry(json));
    }
    return entries;
  }

  private async openSink(filePath: string, flags: 'a' | 'ax'): Promise<SessionSink> {
    let handle: FileHandle;
    try {
      handle = await open(filePath, flags);
    } catch (cause) {
      throw new HarnessError('session_write_failed', `cannot open transcript ${filePath}`, {
        cause
      });
    }
    let closed = false;
    return {
      async append(entry: SessionEntry): Promise<void> {
        try {
          await handle.write(`${JSON.stringify(entry)}\n`);
        } catch (cause) {
          throw new HarnessError('session_write_failed', 'transcript append failed', { cause });
        }
      },
      async flush(): Promise<void> {
        try {
          await handle.sync();
        } catch (cause) {
          throw new HarnessError('session_write_failed', 'transcript fsync failed', { cause });
        }
      },
      async close(): Promise<void> {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      }
    };
  }
}
