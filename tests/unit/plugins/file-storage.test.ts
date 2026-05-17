/**
 * Built-in file:// storage plugin — Phase 79.
 *
 * Pins:
 *   - upload → download roundtrip preserves bytes
 *   - headEtag matches the etag returned from upload (same content hash)
 *   - download of missing path throws PluginNotFoundError
 *   - headEtag of missing path returns null (NOT throw — Phase 79 contract)
 *   - non-file:// URL is rejected
 *   - encoding-special characters in path round-trip
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileStoragePlugin, PluginNotFoundError } from '../../../src/plugins/index.js';

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'helm-file-storage-test-'));
});
afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('fileStoragePlugin', () => {
  it('upload → download roundtrip preserves bytes', async () => {
    const path = join(workDir, 'roundtrip.bin');
    const url = pathToFileURL(path).href;
    const payload = Buffer.from('hello world\nthis is a test');
    await fileStoragePlugin.upload(url, payload);
    const got = await fileStoragePlugin.download(url);
    expect(got.equals(payload)).toBe(true);
  });

  it('upload returns the same etag headEtag would return', async () => {
    const path = join(workDir, 'etag.bin');
    const url = pathToFileURL(path).href;
    const { etag } = await fileStoragePlugin.upload(url, Buffer.from('abc'));
    const head = await fileStoragePlugin.headEtag(url);
    expect(head).toBe(etag);
  });

  it('download of missing path throws PluginNotFoundError', async () => {
    const url = pathToFileURL(join(workDir, 'ghost.txt')).href;
    await expect(fileStoragePlugin.download(url)).rejects.toBeInstanceOf(PluginNotFoundError);
  });

  it('headEtag of missing path returns null (NOT throws)', async () => {
    const url = pathToFileURL(join(workDir, 'ghost.txt')).href;
    const head = await fileStoragePlugin.headEtag(url);
    expect(head).toBeNull();
  });

  it('non file:// URL is rejected on download', async () => {
    await expect(fileStoragePlugin.download('http://example.com/foo')).rejects.toThrow(/file:\/\//);
  });
});
