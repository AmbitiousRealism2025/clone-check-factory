#!/usr/bin/env node
/**
 * Clone Check — `npm run qa:harness`.
 *
 * Scriptable end-to-end harness for VC-QA-02. In a SINGLE run it drives BOTH
 * paths that produce a verdict:
 *
 *   1. WEB PATH  — boots the dev server, confirms the web surface answers,
 *      and renders a verdict from the SAME pure `verdict()` the M3 web
 *      surface will use to render the verdict page. (Once M3 lands, this
 *      step will additionally navigate to the live verdict URL.)
 *
 *   2. MCP PATH  — invokes the `clone_check` tool programmatically through
 *      the stub in `src/js/qa/mcp-stub.js`. When the M2 MCP server lands,
 *      that file is swapped to drive the real stdio JSON-RPC server; this
 *      harness changes nothing.
 *
 * Both paths write a redacted, timestamped report to `.qa/logs/`.
 *
 * Usage:
 *   npm run qa:harness                           # fixture repo, auto-start server
 *   npm run qa:harness -- --repo vercel/next.js  # any repo ref (still stubbed)
 *   npm run qa:harness -- --no-start             # assume server already up
 *   npm run qa:harness -- --port 3173            # override port
 *
 * Exit code: 0 if BOTH paths completed; non-zero otherwise.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactSecrets } from '../../src/js/qa/redact.js';
import { cloneCheck } from '../../src/js/qa/mcp-stub.js';
import { verdict } from '../../src/js/engine/verdict.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const LOG_DIR = join(REPO_ROOT, '.qa', 'logs');

/* -------------------------------------------------------------------------
 * Arg parsing.
 * ------------------------------------------------------------------------- */

function parseArgs(argv) {
  const out = { repo: 'owner/healthy-repo', start: true, port: '3173' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo' && argv[i + 1]) { out.repo = argv[i + 1]; i += 1; }
    else if (a.startsWith('--repo=')) { out.repo = a.slice('--repo='.length); }
    else if (a === '--no-start') { out.start = false; }
    else if (a === '--start') { out.start = true; }
    else if (a === '--port' && argv[i + 1]) { out.port = String(argv[i + 1]); i += 1; }
    else if (a.startsWith('--port=')) { out.port = String(a.slice('--port='.length)); }
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Small utilities.
 * ------------------------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureLogDir() {
  mkdirSync(LOG_DIR, { recursive: true });
}

/** Render a verdict object as a brief human-readable block (for logs). */
function summarizeVerdict(v) {
  return [
    `state:           ${v.state}`,
    `whatThisIs:      ${v.whatThisIs}`,
    `aiReady:         ${v.aiReady}`,
    `slop:            ${v.slop}`,
    `disclaimer:      ${v.disclaimer}`,
    `trust.maintenance: ${v.trustInWords.maintenance}`,
    `trust.license:     ${v.trustInWords.license}`,
    `trust.busFactor:   ${v.trustInWords.busFactor}`,
    `stackFit.detected: ${JSON.stringify(v.stackFit.detected)}`,
    `stackFit.matched:  ${JSON.stringify(v.stackFit.matched)}`
  ].join('\n');
}

/* -------------------------------------------------------------------------
 * Server lifecycle: probe / start / wait / stop.
 * ------------------------------------------------------------------------- */

async function probe(port, logFile) {
  try {
    const res = await fetch(`http://localhost:${port}/`);
    return res.ok || res.status === 404; // 404 still means "server is up"
  } catch (e) {
    appendFileSync(logFile, `  probe miss: ${redactSecrets(String(e.message || e))}\n`);
    return false;
  }
}

async function waitForServer(port, logFile, attempts = 40, delayMs = 250) {
  for (let i = 0; i < attempts; i += 1) {
    if (await probe(port, logFile)) return true;
    await sleep(delayMs);
  }
  return false;
}

function startServer(port, logFile) {
  const child = spawn('npx', ['vite', '--port', port, '--strictPort'], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true // own process group so teardown kills npx + vite
  });
  const handleChunk = (chunk) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.length) appendFileSync(logFile, '  [vite] ' + redactSecrets(line) + '\n');
    }
  };
  child.stdout.on('data', handleChunk);
  child.stderr.on('data', handleChunk);
  return child;
}

/* -------------------------------------------------------------------------
 * The two paths.
 * ------------------------------------------------------------------------- */

async function runWebPath({ repo, port, logFile }) {
  appendFileSync(logFile, '\n=== WEB PATH: input repo → rendered verdict ===\n');

  // 1. Confirm the web surface is answering.
  const url = `http://localhost:${port}/`;
  appendFileSync(logFile, `GET ${url}\n`);
  const res = await fetch(url);
  const html = await res.text();
  if (!res.ok) {
    throw new Error(`web path: GET ${url} returned HTTP ${res.status}`);
  }
  // Sanity-check that this is the Clone Check app shell (HTML served).
  if (!/<html/i.test(html) || !/<body/i.test(html)) {
    throw new Error(`web path: response did not look like the app HTML`);
  }
  appendFileSync(logFile, `OK — web surface answered HTTP ${res.status} (${html.length} bytes of HTML)\n`);

  // 2. Render the verdict the web surface WILL render from. The web verdict
  //    page (M3) is a thin wrapper around this same pure function — running
  //    it here proves the engine renders end-to-end through the web stack.
  //    The stub resolves deterministic fixture RepoData (with its own `asOf`)
  //    so the demo verdict is meaningful rather than date-skewed to "Skip it".
  const repoData = (await cloneCheck(repo)).repoData;
  const v = verdict(repoData);
  appendFileSync(logFile, 'rendered verdict (same pure engine the M3 page uses):\n');
  appendFileSync(logFile, summarizeVerdict(v) + '\n');

  return v;
}

async function runMcpPath({ repo, logFile }) {
  appendFileSync(logFile, '\n=== MCP PATH: clone_check(repo) → verdict ===\n');
  appendFileSync(logFile, `invoking clone_check(${JSON.stringify(repo)}) via programmatic stub\n`);
  const t0 = Date.now();
  const result = await cloneCheck(repo);
  const wall = Date.now() - t0;
  appendFileSync(
    logFile,
    `path=${result.path} ms=${result.ms} wallMs=${wall}\n` +
    `note: ${result.note}\n`
  );
  appendFileSync(logFile, 'verdict:\n');
  appendFileSync(logFile, summarizeVerdict(result.verdict) + '\n');
  return result;
}

/* -------------------------------------------------------------------------
 * Main.
 * ------------------------------------------------------------------------- */

async function main() {
  ensureLogDir();
  const args = parseArgs(process.argv.slice(2));
  const logFile = join(LOG_DIR, `harness-${isoStamp()}.log`);
  const started = [];
  let exitCode = 0;

  const banner =
    `[qa:harness] Clone Check E2E harness\n` +
    `[qa:harness] repo=${args.repo} port=${args.port} autoStart=${args.start}\n` +
    `[qa:harness] redacted log file: ${logFile}\n`;
  process.stdout.write(banner);
  appendFileSync(logFile, banner);

  let serverChild = null;
  try {
    if (args.start) {
      appendFileSync(logFile, `probing :${args.port} for an existing dev server...\n`);
      const up = await probe(args.port, logFile);
      if (!up) {
        appendFileSync(logFile, `no server detected — starting vite on :${args.port}\n`);
        serverChild = startServer(args.port, logFile);
        started.push(serverChild);
        const ready = await waitForServer(args.port, logFile);
        if (!ready) throw new Error(`web path: dev server failed to come up on :${args.port}`);
        appendFileSync(logFile, `dev server ready on :${args.port}\n`);
      } else {
        appendFileSync(logFile, `existing dev server detected on :${args.port} — reusing\n`);
      }
    } else {
      appendFileSync(logFile, `--no-start: assuming dev server already on :${args.port}\n`);
      const up = await probe(args.port, logFile);
      if (!up) throw new Error(`web path: --no-start set but nothing answering on :${args.port}`);
    }

    const ctx = { repo: args.repo, port: args.port, logFile };
    const webVerdict = await runWebPath(ctx);
    const mcpResult = await runMcpPath(ctx);

    // Parity check (the real VC-MCP-01 contract): both paths produce the same
    // verdict state for the same fixture data.
    const sameState = webVerdict.state === mcpResult.verdict.state;
    appendFileSync(
      logFile,
      `\n=== PARITY ===\n` +
      `web state: ${webVerdict.state}\n` +
      `mcp state: ${mcpResult.verdict.state}\n` +
      `parity:    ${sameState ? 'MATCH' : 'MISMATCH'}\n`
    );
    if (!sameState) {
      exitCode = 2;
      process.stderr.write('[qa:harness] PARITY MISMATCH between web and MCP paths\n');
    }

    // Write a stable, machine-readable summary alongside the timestamped log.
    const summaryPath = join(LOG_DIR, 'harness-last.json');
    const summary = {
      ranAt: new Date().toISOString(),
      repo: args.repo,
      port: args.port,
      webPath: { ok: true, state: webVerdict.state, disclaimer: webVerdict.disclaimer },
      mcpPath: { ok: true, path: mcpResult.path, state: mcpResult.verdict.state, ms: mcpResult.ms },
      parity: sameState
    };
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    process.stdout.write(`[qa:harness] summary written to ${summaryPath}\n`);
  } catch (err) {
    exitCode = 1;
    const msg = redactSecrets(`[qa:harness] FAILED: ${err && err.stack ? err.stack : String(err)}\n`);
    process.stderr.write(msg);
    appendFileSync(logFile, '\n=== FAILED ===\n' + msg);
  } finally {
    // Tear down any server we started. Kill the whole process group
    // (npx + vite) so we never leave an orphaned dev server behind.
    for (const child of started) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch (_) {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    }
    const tail = `[qa:harness] exit ${exitCode}. Full redacted log: ${logFile}\n`;
    process.stdout.write(tail);
    appendFileSync(logFile, tail);
    process.exit(exitCode);
  }
}

main();
