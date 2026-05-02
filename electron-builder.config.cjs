/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'app.helm.desktop',
  productName: 'Helm',
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  files: [
    'dist/**/*',
    'web/dist/**/*',
    'package.json',
    'bin/**/*',
    '!**/*.map',
    '!**/*.test.*',
  ],
  electronLanguages: ['en', 'zh_CN'],
  asar: true,
  asarUnpack: ['**/*.node'],
  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    identity: null,
  },
  dmg: {
    sign: false,
  },
  publish: null,
};
