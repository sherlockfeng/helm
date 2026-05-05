/**
 * Log file rotation — see PROJECT_BLUEPRINT.md §19.5.5.
 *
 * Two thresholds:
 *   1. Per-file: when a log file exceeds `fileMaxBytes` (default 10MB), rename
 *      it into `<rootDir>/archive/<basename>.<ts>` and let the next write open
 *      a fresh file.
 *   2. Total archive: when `<rootDir>/archive/` exceeds `archiveMaxBytes`
 *      (default 500MB), delete oldest files until under the cap.
 *
 * The check runs synchronously, lazily — `maybeRotate(path)` is called
 * before each append. Cost is one `statSync` per write; cheap enough that
 * we don't need a watcher process.
 *
 * Sessions/<id>.jsonl files rotate the same way as main.log / error.log —
 * a noisy single chat won't blow out the disk.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface RotateOptions {
  /** Files larger than this get rotated out. Default 10 MB. */
  fileMaxBytes?: number;
  /** Total archive directory size cap. Oldest archives pruned. Default 500 MB. */
  archiveMaxBytes?: number;
  /** Override archive directory. Default `<dirname(filePath)>/archive`. */
  archiveDir?: string;
  /** Test seam — provide a deterministic timestamp suffix. */
  now?: () => Date;
  /** Optional callback for unexpected IO errors. Defaults to no-op. */
  onError?: (err: Error, ctx: { phase: string; path: string }) => void;
}

const DEFAULT_FILE_MAX = 10 * 1024 * 1024;
const DEFAULT_ARCHIVE_MAX = 500 * 1024 * 1024;

function timestampSuffix(now: Date): string {
  // ISO-ish but filename-safe: 2026-05-04T093015.123
  const iso = now.toISOString();
  return iso.replace(/[:]/g, '').replace(/\.\d+Z$/, (m) => m.replace('Z', ''));
}

function defaultArchiveDir(filePath: string): string {
  return join(dirname(filePath), 'archive');
}

/**
 * Inspect `filePath` and rotate it into `<archiveDir>/<basename>.<ts>` if it
 * exceeds the file-size threshold. After rotation, prune `archiveDir` so the
 * total stays under `archiveMaxBytes`.
 *
 * Returns `true` when a rotation actually happened, `false` when the file
 * was small / missing.
 */
export function maybeRotate(filePath: string, options: RotateOptions = {}): boolean {
  const fileMaxBytes = options.fileMaxBytes ?? DEFAULT_FILE_MAX;
  const archiveMaxBytes = options.archiveMaxBytes ?? DEFAULT_ARCHIVE_MAX;
  const archiveDir = options.archiveDir ?? defaultArchiveDir(filePath);
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => {});

  if (!existsSync(filePath)) return false;

  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch (err) {
    onError(err as Error, { phase: 'stat', path: filePath });
    return false;
  }
  if (size <= fileMaxBytes) return false;

  try {
    mkdirSync(archiveDir, { recursive: true });
    const archived = join(archiveDir, `${basename(filePath)}.${timestampSuffix(now())}`);
    renameSync(filePath, archived);
  } catch (err) {
    onError(err as Error, { phase: 'rename', path: filePath });
    return false;
  }

  pruneArchive(archiveDir, archiveMaxBytes, onError);
  return true;
}

/**
 * Drop oldest archives until the directory total falls below `maxBytes`.
 * "Oldest" = lowest `mtimeMs` so a recently rotated file with the same
 * name beats an ancient one. Symlinks and non-files are skipped.
 */
export function pruneArchive(
  archiveDir: string,
  maxBytes: number,
  onError: (err: Error, ctx: { phase: string; path: string }) => void = () => {},
): { pruned: string[]; bytesAfter: number } {
  if (!existsSync(archiveDir)) return { pruned: [], bytesAfter: 0 };

  let entries: Array<{ path: string; mtimeMs: number; size: number }> = [];
  try {
    entries = readdirSync(archiveDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const p = join(archiveDir, e.name);
        const st = statSync(p);
        return { path: p, mtimeMs: st.mtimeMs, size: st.size };
      });
  } catch (err) {
    onError(err as Error, { phase: 'scan_archive', path: archiveDir });
    return { pruned: [], bytesAfter: 0 };
  }

  let total = entries.reduce((acc, e) => acc + e.size, 0);
  const pruned: string[] = [];
  if (total <= maxBytes) return { pruned, bytesAfter: total };

  // Oldest first.
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const e of entries) {
    if (total <= maxBytes) break;
    try {
      unlinkSync(e.path);
      pruned.push(e.path);
      total -= e.size;
    } catch (err) {
      onError(err as Error, { phase: 'unlink_archive', path: e.path });
    }
  }
  return { pruned, bytesAfter: total };
}
