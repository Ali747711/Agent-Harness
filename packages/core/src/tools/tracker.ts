/**
 * Read-before-write invariant state (PHASE1-PLAN.md step 9). One instance per
 * AgentSession, keyed by canonical absolute path. Mutating tools require the
 * file to have been read THIS session and unchanged since (mtime + sha256);
 * successful mutations re-record so consecutive edits need no re-read.
 */
export interface TrackedFile {
  mtimeMs: number;
  sha256: string;
}

export class FileTracker {
  private readonly seen = new Map<string, TrackedFile>();

  recordRead(absolutePath: string, entry: TrackedFile): void {
    this.seen.set(absolutePath, entry);
  }

  get(absolutePath: string): TrackedFile | undefined {
    return this.seen.get(absolutePath);
  }
}
