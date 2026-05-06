/**
 * electron-builder config — produces a macOS DMG (and zip) with the helm
 * Electron main + renderer + bin scripts.
 *
 * Signing: ad-hoc only (`identity: null`). Notarization NOT performed —
 * Gatekeeper will warn on first launch; the user right-clicks → Open the
 * first time. PROJECT_BLUEPRINT.md §23 punts notarization to post-MVP.
 *
 * Entitlements: build/entitlements.mac.plist allows JIT, unsigned mem
 * (better-sqlite3 native module), library validation disabled, network
 * client + server (HTTP API on 127.0.0.1).
 *
 * Targets:
 *   - dmg arm64 + x64 (universal-bundle is a future improvement)
 *   - zip arm64 + x64 (for auto-update channels later)
 *
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  appId: 'app.helm.desktop',
  productName: 'Helm',
  copyright: 'Copyright © 2026',

  directories: {
    output: 'release',
    buildResources: 'build',
  },

  // Inclusion list — keep the bundle lean. We rely on tsup's bundling so
  // node_modules/ doesn't need to ship except for native modules.
  files: [
    'dist/**/*',
    'web/dist/**/*',
    'bin/**/*',
    'package.json',
    '!**/*.map',
    '!**/*.test.*',
    '!**/__tests__/**',
    '!node_modules/**/*.d.ts',
    '!node_modules/**/*.md',
    '!node_modules/**/test/**',
    '!node_modules/**/tests/**',
  ],

  // Native modules ship un-asar'd so dlopen works at runtime.
  asar: true,
  asarUnpack: [
    '**/*.node',
    'node_modules/better-sqlite3/**',
  ],

  // Force npm rebuild for the target Electron ABI; without this,
  // better-sqlite3 ships compiled for the system Node ABI and fails to
  // load inside Electron.
  npmRebuild: true,

  electronLanguages: ['en', 'zh_CN'],

  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    identity: null, // ad-hoc sign — see build/entitlements.mac.plist
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      LSUIElement: false,
      NSHumanReadableCopyright: 'Copyright © 2026 Helm contributors',
    },
  },

  dmg: {
    sign: false,
    title: 'Helm ${version}',
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },

  publish: null,
};
