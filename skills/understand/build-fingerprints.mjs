#!/usr/bin/env node
/**
 * build-fingerprints.mjs
 *
 * Builds the structural-fingerprint baseline used by auto-update's
 * incremental change detection. Runs once per /understand full rebuild
 * (Phase 7 step 2.5), generating <graphRoot>/fingerprints.json.
 *
 * Replaces the LLM-written fingerprint script that previously sat in
 * SKILL.md as a code example — that example had the wrong signature
 * for buildFingerprintStore() and never successfully produced a baseline,
 * which silently broke auto-update for every install (see issue #152).
 *
 * Usage:
 *   node build-fingerprints.mjs <input.json> [--graph-root=<path>]
 *
 * Input JSON:
 *   { projectRoot: string, graphRoot?: string, sourceFilePaths: string[], gitCommitHash: string }
 *
 * Writes: <graphRoot>/fingerprints.json
 * Exit code: 0 on success; non-zero on invalid or incomplete baseline input.
 */

import { createRequire } from 'node:module';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// skills/understand/ -> AstrBot plugin root is two dirs up; the bundled
// Understand Anything runtime lives under understand-anything/.
const pluginRoot = resolve(__dirname, '../..');
const runtimeRoot = resolve(pluginRoot, 'understand-anything');
const require = createRequire(resolve(runtimeRoot, 'package.json'));

// ---------------------------------------------------------------------------
// Resolve @understand-anything/core (matches extract-structure.mjs).
// pathToFileURL() is required for Windows: dynamic import() of a raw
// "C:\..." path throws ERR_UNSUPPORTED_ESM_URL_SCHEME.
// ---------------------------------------------------------------------------
let core;
try {
  core = await import(pathToFileURL(require.resolve('@understand-anything/core')).href);
} catch {
  core = await import(pathToFileURL(resolve(runtimeRoot, 'packages/core/dist/index.js')).href);
}

const {
  TreeSitterPlugin,
  PluginRegistry,
  builtinLanguageConfigs,
  registerAllParsers,
  buildFingerprintStore,
  saveFingerprints,
  loadFingerprints,
} = core;

function normalizeSourceFilePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Invalid sourceFilePaths: every entry must be a non-empty string');
  }
  if (value.includes('\0')) {
    throw new Error(`Invalid sourceFilePaths entry contains NUL byte: ${value}`);
  }
  if (posix.isAbsolute(value) || win32.isAbsolute(value)) {
    throw new Error(`Invalid sourceFilePaths entry is absolute: ${value}`);
  }

  const withPosixSeparators = value.replace(/\\/g, '/');
  const segments = withPosixSeparators.split('/');
  if (segments.includes('..')) {
    throw new Error(`Invalid sourceFilePaths entry escapes project root: ${value}`);
  }

  const normalized = posix.normalize(withPosixSeparators);
  if (!normalized || normalized === '.') {
    throw new Error(`Invalid sourceFilePaths entry is empty after normalization: ${value}`);
  }
  return normalized;
}

function uniqueSourceFilePaths(sourceFilePaths) {
  if (!Array.isArray(sourceFilePaths)) {
    throw new Error('Invalid input: sourceFilePaths must be an array');
  }
  const seen = new Set();
  const paths = [];
  for (const value of sourceFilePaths) {
    const normalized = normalizeSourceFilePath(value);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      paths.push(normalized);
    }
  }
  if (paths.length === 0) {
    throw new Error('Invalid input: sourceFilePaths must contain at least one file');
  }
  return paths;
}

function previewPaths(paths) {
  const preview = paths.slice(0, 5).join(', ');
  const suffix = paths.length > 5 ? ` (+${paths.length - 5} more)` : '';
  return `${preview}${suffix}`;
}

async function main() {
  const [, , inputPath] = process.argv;
  if (!inputPath) {
    process.stderr.write('Usage: node build-fingerprints.mjs <input.json> [--graph-root=<path>]\n');
    process.exit(1);
  }

  const input = JSON.parse(
    readFileSync(inputPath, 'utf-8'),
  );
  const { projectRoot, sourceFilePaths, gitCommitHash } = input;
  const graphRootArg = process.argv
    .slice(3)
    .find((arg) => arg.startsWith('--graph-root='))
    ?.slice('--graph-root='.length);
  const graphRoot = graphRootArg || input.graphRoot || join(projectRoot || '.', '.understand-anything');

  if (!projectRoot || !Array.isArray(sourceFilePaths) || typeof gitCommitHash !== 'string') {
    throw new Error(
      'Invalid input: requires { projectRoot: string, sourceFilePaths: string[], gitCommitHash: string }',
    );
  }
  if (!existsSync(projectRoot)) {
    throw new Error(`Invalid input: projectRoot does not exist: ${projectRoot}`);
  }

  const normalizedSourceFilePaths = uniqueSourceFilePaths(sourceFilePaths);
  const missingPaths = normalizedSourceFilePaths.filter(
    (filePath) => !existsSync(join(projectRoot, filePath)),
  );
  if (missingPaths.length > 0) {
    throw new Error(
      `Invalid input: ${missingPaths.length} sourceFilePaths do not exist under projectRoot: `
        + previewPaths(missingPaths),
    );
  }

  // Create tree-sitter plugin with all configs that have WASM grammars,
  // mirroring extract-structure.mjs so the baseline matches the comparison
  // logic used during auto-updates.
  const tsConfigs = builtinLanguageConfigs.filter((c) => c.treeSitter);
  const tsPlugin = new TreeSitterPlugin(tsConfigs);
  await tsPlugin.init();

  const registry = new PluginRegistry();
  registry.register(tsPlugin);
  registerAllParsers(registry);

  const store = buildFingerprintStore(
    projectRoot,
    normalizedSourceFilePaths,
    registry,
    gitCommitHash,
  );
  const fileCount = Object.keys(store.files).length;
  if (fileCount === 0) {
    throw new Error('Fingerprint baseline is empty; refusing to save fingerprints.json');
  }
  if (fileCount < normalizedSourceFilePaths.length) {
    const skipped = normalizedSourceFilePaths.filter((filePath) => !(filePath in store.files));
    throw new Error(
      `Fingerprint baseline skipped ${skipped.length} input path(s): ${previewPaths(skipped)}`,
    );
  }

  saveFingerprints(projectRoot, store, { graphRoot });
  const loaded = loadFingerprints(projectRoot, { graphRoot });
  if (!loaded || Object.keys(loaded.files || {}).length !== fileCount) {
    throw new Error(`fingerprints.json was not readable after save under: ${graphRoot}`);
  }

  process.stdout.write(`Fingerprints baseline: ${fileCount} files\n`);
}

await main();
