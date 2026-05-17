/**
 * Built-in `file://` storage backend — Phase 79.
 *
 * Always registered without `plugins.enabled` config (it's not a plugin
 * in the loader sense). Two uses:
 *
 *   1. **Local development** — a user can subscribe to
 *      `file:///Users/me/team-roles/goofy.helmrole`, and helm treats
 *      filesystem changes the same way it treats TOS updates. Useful
 *      for iterating on a role bundle before shipping to a real remote.
 *
 *   2. **Test surface** — every plugin-system / subscription test in
 *      the suite can use file:// without spinning up TOS / mocking SDKs.
 *
 * etag scheme: sha256 of the file's bytes. Cheap enough for small
 * bundles; matches how object storage backends behave (etag is a hash
 * of content for single-part uploads).
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_API_VERSION_CURRENT,
  PluginNotFoundError,
  type StoragePlugin,
} from '../types.js';

function urlToPath(url: string): string {
  if (!url.startsWith('file://')) {
    throw new Error(`file-storage: expected file:// URL, got ${url}`);
  }
  try {
    return fileURLToPath(url);
  } catch (err) {
    throw new Error(`file-storage: invalid URL ${url}: ${(err as Error).message}`);
  }
}

function hashBytes(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export const fileStoragePlugin: StoragePlugin = {
  id: 'helm-storage-file',
  scheme: 'file',
  version: '0.1.0',
  apiVersion: PLUGIN_API_VERSION_CURRENT,

  init() {
    // Nothing to do — no auth, no daemon, no shared state.
  },

  async download(url: string): Promise<Buffer> {
    const path = urlToPath(url);
    try {
      return await fs.readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PluginNotFoundError(url);
      }
      throw err;
    }
  },

  async upload(url: string, data: Buffer): Promise<{ etag: string }> {
    const path = urlToPath(url);
    await fs.writeFile(path, data);
    return { etag: hashBytes(data) };
  },

  async headEtag(url: string): Promise<string | null> {
    const path = urlToPath(url);
    try {
      const buf = await fs.readFile(path);
      return hashBytes(buf);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
};
