'use strict';

// Build the native single-file launcher executables (Go, ~2.6MB each, with
// all five patch files embedded), so users get one binary per platform
// instead of a scripts/ directory that must sit on a real path:
//
//   node scripts/build-launcher.js            # windows targets (the ones
//                                             # that need an .exe)
//   node scripts/build-launcher.js --all      # + macOS / Linux launchers
//   node scripts/build-launcher.js --host     # host platform only (testing)
//
// Requires a Go toolchain. Copies the five files from scripts/ into
// launcher/ (they are go:embed'd there), so editing scripts/* then re-running
// this keeps the binary in sync.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LAUNCHER = path.join(ROOT, 'launcher');
const DIST = path.join(ROOT, 'dist');

// Fall back to a patcher version constant when package.json is absent; it is
// only embedded as a cache marker via -ldflags.
let VERSION = '0.1.0';
try {
  VERSION = require(path.join(ROOT, 'package.json')).version;
} catch (_) {}

// (field) files zcode-patcher.js reads with path.join(__dirname, …)
const EMBED_FILES = [
  'zcode-patcher.js',
  'zcode-tui.js',
  'zcode-tps.js',
  'zcode-enhance.js',
  'zcode-continue.js',
  'modelhub_payload.json',
];

const TARGETS = {
  default: [
    ['windows', 'amd64', 'zcode-patch-win-x64.exe'],
    ['windows', 'arm64', 'zcode-patch-win-arm64.exe'],
  ],
  extra: [
    ['darwin', 'arm64', 'zcode-patch-macos-arm64'],
    ['darwin', 'amd64', 'zcode-patch-macos-x64'],
    ['linux', 'amd64', 'zcode-patch-linux-x64'],
    ['linux', 'arm64', 'zcode-patch-linux-arm64'],
  ],
};

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${res.status})`);
  }
}

function hostTarget() {
  const goos = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform];
  const goarch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!goos || !goarch) throw new Error(`unsupported host: ${process.platform}/${process.arch}`);
  const osName = { darwin: 'macos', windows: 'win', linux: 'linux' }[goos];
  const archName = goarch === 'amd64' ? 'x64' : goarch;
  const ext = goos === 'windows' ? '.exe' : '';
  return [goos, goarch, `zcode-patch-${osName}-${archName}${ext}`];
}

function main() {
  const mode = process.argv[2];

  // Sync embedded copies so the launcher carries current scripts/.
  fs.mkdirSync(LAUNCHER, { recursive: true });
  for (const f of EMBED_FILES) {
    fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(LAUNCHER, f));
  }

  const targets = mode === '--host'
    ? [hostTarget()]
    : (mode === '--all' ? [...TARGETS.default, ...TARGETS.extra] : TARGETS.default);

  for (const [goos, goarch, outName] of targets) {
    const out = path.join(DIST, outName);
    const env = { ...process.env, CGO_ENABLED: '0' };
    if (goos) { env.GOOS = goos; env.GOARCH = goarch; }
    run('go', [
      'build',
      '-trimpath',
      '-buildvcs=false',
      '-ldflags', `-s -w -X main.version=${VERSION}`,
      '-o', out,
      '.',
    ], { cwd: LAUNCHER, env });
    const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(2);
    console.log(`${path.relative(ROOT, out)}: ${mb}MB`);
  }
}

main();