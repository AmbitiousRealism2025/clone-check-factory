#!/usr/bin/env node
/**
 * Clone Check — `npm run qa:start`.
 *
 * Starts the Vite dev server for black-box testing AND writes every line of
 * output to a redacted log file under `.qa/logs/`. This is the VC-QA-01
 * command: ONE documented command that brings the app up for testing and
 * keeps an auditable, secret-scrubbed log on disk.
 *
 * Usage:
 *   npm run qa:start                 # default: vite on port 3173
 *   npm run qa:start -- --port 4000  # override port (still redacted)
 *   QA_PORT=4173 npm run qa:start    # override port via env
 *
 * Behaviour:
 *   - Ensures `.qa/logs/` exists (git-ignored).
 *   - Spawns `vite --port <port>` as a child process.
 *   - Pipes the child's stdout + stderr through `redactSecrets()` and into:
 *       (a) the parent's stdout (so the operator sees live output), AND
 *       (b) a timestamped log file at `.qa/logs/qa-start-<ISO>.log`.
 *   - Forwards SIGINT/SIGTERM to the child for a clean shutdown.
 *
 * The redactor lives in `src/js/qa/redact.js` so it is unit-covered.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets } from '../../src/js/qa/redact.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const LOG_DIR = join(REPO_ROOT, '.qa', 'logs');

const DEFAULT_PORT = '3173';

function resolvePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port' && argv[i + 1]) return String(argv[i + 1]);
    const m = a.match(/^--port=(.+)$/);
    if (m) return String(m[1]);
  }
  if (process.env.QA_PORT) return String(process.env.QA_PORT);
  return DEFAULT_PORT;
}

function isoStamp() {
  // Filesystem-safe ISO timestamp (no colons).
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureLogDir() {
  mkdirSync(LOG_DIR, { recursive: true });
}

function logLine(file, line) {
  // Redact before anything touches disk.
  const safe = redactSecrets(line);
  appendFileSync(file, safe + '\n');
  // Mirror to operator console (also redacted, for safety in CI scrapers).
  process.stdout.write(safe + '\n');
}

function main() {
  ensureLogDir();
  const port = resolvePort(process.argv.slice(2));
  const logFile = join(LOG_DIR, `qa-start-${isoStamp()}.log`);

  const header =
    `[qa:start] Clone Check dev server booting on port ${port}\n` +
    `[qa:start] redacted log file: ${logFile}\n` +
    `[qa:start] log path is git-ignored (.qa/ in .gitignore)\n`;
  process.stdout.write(header);
  appendFileSync(logFile, header);

  // Spawn vite. We use `npx vite` so this works regardless of how the user
  // invoked npm. Forward only the port (and any user-provided flags after `--`).
  const userFlags = process.argv.slice(2).filter((a) => !a.startsWith('--port'));
  const args = ['vite', '--port', port, '--strictPort', ...userFlags];

  const child = spawn('npx', args, {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const writeLine = (chunk) => {
    const text = chunk.toString('utf8');
    // Preserve partial-line buffering by splitting on \n but keeping the
    // trailing newline. We chunk line-by-line so disk writes are tidy.
    const lines = text.split('\n');
    // If the chunk did not end with \n, the last element is a partial line —
    // hold it back so the next chunk continues it. We append a marker so
    // disk mirrors console exactly.
    for (let i = 0; i < lines.length - 1; i += 1) {
      logLine(logFile, lines[i]);
    }
    if (lines[lines.length - 1].length > 0) {
      logLine(logFile, lines[lines.length - 1]);
    }
  };

  child.stdout.on('data', writeLine);
  child.stderr.on('data', writeLine);

  const stop = (sig) => {
    if (!child.killed) {
      const tail = `[qa:start] received ${sig}, forwarding to vite (pid ${child.pid})`;
      appendFileSync(logFile, tail + '\n');
      process.stderr.write(tail + '\n');
      try { child.kill(sig); } catch { /* already gone */ }
    }
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  child.on('exit', (code, signal) => {
    const tail =
      `[qa:start] vite exited code=${code} signal=${signal}\n` +
      `[qa:start] full redacted log at: ${logFile}`;
    appendFileSync(logFile, tail + '\n');
    process.stderr.write(tail + '\n');
    process.exit(code ?? 0);
  });
}

main();
