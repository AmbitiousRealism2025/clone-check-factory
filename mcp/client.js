/**
 * Clone Check — Programmatic MCP client / test harness.
 *
 * Spawns the stdio MCP server as a child process, performs the JSON-RPC
 * `initialize` → `tools/list` → `tools/call` handshake, and returns the
 * parsed verdict payload.
 *
 * Used by:
 *   - the Vitest suite (`mcp/__tests__/mcp.test.js`) for end-to-end parity
 *     and novel-repo tests,
 *   - `npm run qa:harness` (optional real-server mode),
 *   - anyone wanting a one-liner `node -e ...` MCP invocation.
 *
 * This module is the canonical "programmatic harness that invokes the tool
 * via JSON-RPC over stdio" required by F2.1.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve the server entry relative to this file. In a real Node run we use
// `import.meta.url`'s directory; under jsdom-based test runners that URL is
// not a file: scheme, so we fall back to probing a couple of well-known
// locations (vitest runs from the repo root, so `mcp/server.js` resolves
// correctly there too).
function resolveServerPath() {
  const candidates = [];
  try {
    const url = new URL('.', import.meta.url);
    if (url.protocol === 'file:') candidates.push(resolve(fileURLToPath(url), 'server.js'));
  } catch { /* fall through */ }
  candidates.push(resolve(process.cwd(), 'mcp', 'server.js'));
  candidates.push(resolve(process.cwd(), 'server.js'));
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Last resort: return the most likely candidate so any error message is helpful.
  return candidates[0];
}

const SERVER_PATH = resolveServerPath();

/**
 * JSON-RPC client that drives one MCP server child process over stdio.
 *
 * Usage:
 *   const client = new McpStdioClient({ nodeEnv: { CLONE_CHECK_FIXTURE: '1' } });
 *   await client.start();
 *   const tools = await client.listTools();
 *   const result = await client.callCloneCheck('owner/healthy-repo');
 *   await client.stop();
 */
export class McpStdioClient {
  /**
   * @param {object} [options]
   * @param {object} [options.nodeEnv]  Extra env vars for the server child.
   * @param {string} [options.serverPath]  Override path to server entry.
   * @param {number} [options.startupMs=4000]  Max wait for the server process to be ready.
   * @param {number} [options.requestMs=60000]  Per-request timeout.
   */
  constructor(options = {}) {
    this.serverPath = options.serverPath || SERVER_PATH;
    this.nodeEnv = { ...process.env, ...(options.nodeEnv || {}) };
    this.startupMs = options.startupMs ?? 4000;
    this.requestMs = options.requestMs ?? 60000;
    this.child = null;
    this._buffer = '';
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._nextId = 1;
    this._initialized = false;
  }

  /** Spawn the server child and complete the MCP initialize handshake. */
  async start() {
    if (this.child) return;
    this.child = spawn('node', [this.serverPath], {
      env: this.nodeEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      // Surface server stderr for debugging without polluting JSON-RPC stdout.
      const text = chunk.toString('utf8');
      if (text.trim().length) process.stderr.write(`[mcp server stderr] ${text}`);
    });
    this.child.on('error', (err) => {
      this._rejectAll(err);
    });
    this.child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        this._rejectAll(new Error(`MCP server exited with code ${code}`));
      }
    });

    // MCP handshake — `initialize` then the `notifications/initialized` ack.
    await this._request(
      {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'clone-check-harness', version: '0.1.0' }
        }
      },
      this.startupMs
    );
    this._notify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {}
    });
    this._initialized = true;
  }

  /** List the tools the server exposes. */
  async listTools() {
    const res = await this._request({
      jsonrpc: '2.0',
      method: 'tools/list',
      params: {}
    });
    return (res.result && res.result.tools) || [];
  }

  /**
   * Call `clone_check(repo)` and return the parsed payload.
   * @param {string} repo
   * @param {object} [options]
   * @param {string[]} [options.savedStack]
   * @returns {Promise<object>} The parsed JSON payload from the tool's text content.
   */
  async callCloneCheck(repo, options = {}) {
    const args = { repo };
    if (Array.isArray(options.savedStack)) args.savedStack = options.savedStack;
    const res = await this._request({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'clone_check', arguments: args }
    });

    if (res.error) {
      throw new Error(`clone_check JSON-RPC error: ${JSON.stringify(res.error)}`);
    }

    const content = (res.result && res.result.content) || [];
    const textEntry = content.find((c) => c && c.type === 'text');
    if (!textEntry) {
      throw new Error('clone_check returned no text content');
    }
    if (res.result.isError) {
      throw new Error(`clone_check tool error: ${textEntry.text}`);
    }
    return JSON.parse(textEntry.text);
  }

  /** Stop the child process. */
  async stop() {
    if (!this.child) return;
    this._clearTimers();
    try {
      this.child.stdin.end();
    } catch { /* already closed */ }
    await new Promise((r) => {
      const t = setTimeout(() => {
        try { this.child && this.child.kill('SIGKILL'); } catch { /* gone */ }
        r();
      }, 1000);
      if (this.child) {
        this.child.on('exit', () => { clearTimeout(t); r(); });
      } else {
        clearTimeout(t);
        r();
      }
    });
    this.child = null;
    this._initialized = false;
  }

  /* ------------------------------------------------------------------- *
   * Internal JSON-RPC plumbing
   * ------------------------------------------------------------------- */

  _onStdout(chunk) {
    this._buffer += chunk.toString('utf8');
    // Messages are newline-delimited JSON objects (MCP stdio framing).
    let idx;
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Not JSON — skip (could be a stray log line).
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Responses carry an `id`; notifications don't.
    if (msg && (msg.id !== undefined) && this._pending.has(msg.id)) {
      const entry = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  }

  _write(msg) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('MCP server stdio is not writable (child not started or exited)');
    }
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  _notify(msg) {
    this._write(msg);
  }

  _request(msg, timeoutMs) {
    return new Promise((resolve, reject) => {
      const effectiveTimeout = typeof timeoutMs === 'number' ? timeoutMs : this.requestMs;
      const id = this._nextId++;
      const req = { ...msg, id };
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP request timed out after ${effectiveTimeout}ms: ${msg.method}`));
      }, effectiveTimeout);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._write(req);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  _clearTimers() {
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
    }
    this._pending.clear();
  }

  _rejectAll(err) {
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }
}

/**
 * Convenience one-shot helper: spawn, call `clone_check(repo)`, stop.
 * @param {string} repo
 * @param {object} [options]  Passed to the client constructor + callCloneCheck.
 * @returns {Promise<object>} Parsed verdict payload.
 */
export async function cloneCheckViaStdio(repo, options = {}) {
  const { savedStack, nodeEnv, ...rest } = options;
  const client = new McpStdioClient({ nodeEnv, ...rest });
  try {
    await client.start();
    return await client.callCloneCheck(repo, { savedStack });
  } finally {
    await client.stop();
  }
}

// `randomUUID` is re-exported for harness callers that build their own ids.
export { randomUUID };

export default McpStdioClient;
