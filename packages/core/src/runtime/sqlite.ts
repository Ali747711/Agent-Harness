import { HarnessError } from '../errors/index.ts';

/**
 * SQLite adapter (ADR-0002, boundary rule 2): `bun:sqlite` under Bun,
 * `node:sqlite` under Node — the CLI ships on Bun while vitest workers run on
 * Node, so both paths must work. The surface is deliberately tiny; the index
 * is derived data (ADR-0004) and never needs more than this.
 */
export type SqlParam = string | number | null;

export interface SqliteDb {
  exec(sql: string): void;
  run(sql: string, params?: SqlParam[]): void;
  all<T>(sql: string, params?: SqlParam[]): T[];
  get<T>(sql: string, params?: SqlParam[]): T | undefined;
  close(): void;
}

interface LooseStatement {
  all: (...params: SqlParam[]) => unknown[];
  get: (...params: SqlParam[]) => unknown;
  run: (...params: SqlParam[]) => unknown;
}

export async function openDatabase(path: string): Promise<SqliteDb> {
  try {
    if ('Bun' in globalThis) {
      const { Database } = await import('bun:sqlite');
      const db = new Database(path, { create: true });
      const stmt = (sql: string): LooseStatement => db.query(sql) as unknown as LooseStatement;
      return {
        exec: (sql) => {
          db.exec(sql);
        },
        run: (sql, params = []) => {
          stmt(sql).run(...params);
        },
        all: <T>(sql: string, params: SqlParam[] = []) => stmt(sql).all(...params) as T[],
        get: <T>(sql: string, params: SqlParam[] = []) =>
          (stmt(sql).get(...params) ?? undefined) as T | undefined,
        close: () => {
          db.close();
        }
      };
    }

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path);
    const stmt = (sql: string): LooseStatement => db.prepare(sql) as unknown as LooseStatement;
    return {
      exec: (sql) => {
        db.exec(sql);
      },
      run: (sql, params = []) => {
        stmt(sql).run(...params);
      },
      all: <T>(sql: string, params: SqlParam[] = []) => stmt(sql).all(...params) as T[],
      get: <T>(sql: string, params: SqlParam[] = []) =>
        (stmt(sql).get(...params) ?? undefined) as T | undefined,
      close: () => {
        db.close();
      }
    };
  } catch (cause) {
    throw new HarnessError('internal', `cannot open the session index at ${path}`, { cause });
  }
}
