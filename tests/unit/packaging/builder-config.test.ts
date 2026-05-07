/**
 * Smoke tests for `electron-builder.config.cjs` and `build/entitlements.mac.plist`.
 *
 * We can't actually run electron-builder in CI (slow, requires native
 * Electron + signing tools), so these tests just guarantee:
 *
 *   - The config file is valid JS and exports an object
 *   - Required fields for a Mac DMG are present and well-typed
 *   - Entitlements plist exists and contains the entitlements better-sqlite3
 *     and Electron renderers need
 *
 * If we accidentally regress one of these (e.g. drop hardenedRuntime), the
 * build would still succeed locally but the resulting DMG would crash on
 * launch — these tests catch that before merge.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, '..', '..', '..');
const configPath = join(repoRoot, 'electron-builder.config.cjs');
const entitlementsPath = join(repoRoot, 'build', 'entitlements.mac.plist');

interface BuilderConfig {
  appId: string;
  productName: string;
  files: string[];
  asar: boolean;
  asarUnpack: string[];
  npmRebuild: boolean;
  mac: {
    target: Array<{ target: string; arch: string[] }>;
    hardenedRuntime: boolean;
    identity: string | null;
    entitlements: string;
    entitlementsInherit: string;
  };
  dmg: { sign: boolean };
}

describe('electron-builder.config.cjs', () => {
  it('exists at repo root', () => {
    expect(existsSync(configPath)).toBe(true);
  });

  it('loads as a valid CJS module exporting an object', () => {
    const cfg = require(configPath) as unknown;
    expect(typeof cfg).toBe('object');
    expect(cfg).not.toBeNull();
  });

  it('declares appId + productName', () => {
    const cfg = require(configPath) as BuilderConfig;
    expect(cfg.appId).toBe('app.helm.desktop');
    expect(cfg.productName).toBe('Helm');
  });

  it('files list includes dist + web + bin + package.json', () => {
    const cfg = require(configPath) as BuilderConfig;
    expect(cfg.files).toContain('dist/**/*');
    expect(cfg.files).toContain('web/dist/**/*');
    expect(cfg.files).toContain('bin/**/*');
    expect(cfg.files).toContain('package.json');
  });

  it('better-sqlite3 native module is asarUnpacked', () => {
    const cfg = require(configPath) as BuilderConfig;
    expect(cfg.asarUnpack).toContain('node_modules/better-sqlite3/**');
    expect(cfg.asarUnpack).toContain('**/*.node');
  });

  it('npmRebuild is enabled (electron ABI alignment)', () => {
    const cfg = require(configPath) as BuilderConfig;
    expect(cfg.npmRebuild).toBe(true);
  });
});

describe('electron-builder.config.cjs — Mac', () => {
  it('targets dmg + zip for arm64 + x64', () => {
    const cfg = require(configPath) as BuilderConfig;
    const targets = cfg.mac.target;
    const dmg = targets.find((t) => t.target === 'dmg');
    const zip = targets.find((t) => t.target === 'zip');
    expect(dmg?.arch).toEqual(['arm64', 'x64']);
    expect(zip?.arch).toEqual(['arm64', 'x64']);
  });

  it('hardenedRuntime enabled with ad-hoc signing', () => {
    const cfg = require(configPath) as BuilderConfig;
    expect(cfg.mac.hardenedRuntime).toBe(true);
    expect(cfg.mac.identity).toBeNull();
  });

  it('entitlements file is referenced AND exists on disk', () => {
    const cfg = require(configPath) as BuilderConfig;
    expect(cfg.mac.entitlements).toBe('build/entitlements.mac.plist');
    expect(cfg.mac.entitlementsInherit).toBe('build/entitlements.mac.plist');
    expect(existsSync(entitlementsPath)).toBe(true);
  });

  it('dmg signing disabled (matches identity: null)', () => {
    const cfg = require(configPath) as BuilderConfig;
    expect(cfg.dmg.sign).toBe(false);
  });
});

describe('build/entitlements.mac.plist', () => {
  it('declares the entitlements native modules and renderer JIT need', () => {
    const xml = readFileSync(entitlementsPath, 'utf8');
    // JIT for the Chromium renderer (V8)
    expect(xml).toContain('com.apple.security.cs.allow-jit');
    // better-sqlite3 .node binary loads at runtime
    expect(xml).toContain('com.apple.security.cs.allow-unsigned-executable-memory');
    expect(xml).toContain('com.apple.security.cs.disable-library-validation');
    // HTTP API binds 127.0.0.1
    expect(xml).toContain('com.apple.security.network.server');
    // Lark-cli and other outbound calls
    expect(xml).toContain('com.apple.security.network.client');
  });

  it('does NOT request app-sandbox (helm-hook writes outside the bundle)', () => {
    const xml = readFileSync(entitlementsPath, 'utf8');
    expect(xml).not.toContain('com.apple.security.app-sandbox');
  });

  it('is well-formed XML (no obvious tag mismatch)', () => {
    const xml = readFileSync(entitlementsPath, 'utf8');
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<plist');
    expect(xml).toContain('</plist>');
    // Every <true/> should be self-closing; sanity check the count is even
    // wrt opening <key> tags.
    const keyOpens = (xml.match(/<key>/g) ?? []).length;
    const keyCloses = (xml.match(/<\/key>/g) ?? []).length;
    expect(keyOpens).toBe(keyCloses);
  });
});

describe('package.json packaging fields', () => {
  it('declares main entry pointing into dist/', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      main?: string;
      scripts: Record<string, string>;
    };
    // tsup outputs CJS as `.cjs` for the electron-main config slice; the
    // package's `main` and `dev:electron` script were both stuck on `.js`
    // before Phase 33 — Electron and electron-builder followed the truth.
    expect(pkg.main).toBe('dist/electron/main.cjs');
  });

  it('declares package + package:mac scripts', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['package']).toContain('electron-builder');
    expect(pkg.scripts['package:mac']).toContain('electron-builder --mac');
  });
});
