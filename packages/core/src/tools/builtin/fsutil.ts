import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { TrackedFile } from '../tracker.ts';

/**
 * Atomic write: temp file in the SAME directory (rename atomicity requires
 * one filesystem), then rename over the target. An interrupt or crash
 * mid-write leaves the original file intact — only the temp can be partial,
 * and it is unlinked on failure.
 */
export async function atomicWrite(absolutePath: string, content: string): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  const tempPath = join(dirname(absolutePath), `.harness-tmp-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, absolutePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function sha256Of(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Current on-disk state for tracker comparison/recording. */
export async function statTracked(absolutePath: string, content: string): Promise<TrackedFile> {
  const info = await stat(absolutePath);
  return { mtimeMs: info.mtimeMs, sha256: sha256Of(content) };
}
