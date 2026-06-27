#!/usr/bin/env node
/**
 * Clone Check — MCP server (F2.1 / VC-MCP-01, VC-MCP-02).
 *
 * Exposes ONE tool to in-agent clients (Cursor / Claude Code / any MCP-aware
 * IDE) over the standard stdio JSON-RPC transport:
 *
 *   clone_check(repo)
 *     - repo: repo URL or `owner/name` (git URLs accepted)
 *     - returns: the full structured verdict + deterministic context block
 *       as JSON `text` content — byte-equivalent to the web engine for the
 *       same repo + SHA.
 *
 * The server calls the GitHub REST API directly from the Node process. It
 * uses the `GITHUB_TOKEN` env var IF SET (5000 req/hr); otherwise it falls
 * back to unauthenticated (60 req/hr). The user is NEVER prompted for a
 * token, and no website visit is required (VC-MCP-02).
 *
 * All verdict logic lives in the pure `verdict()` + `assembleContextBlock()`
 * engine modules; this file is the thinnest possible stdio wrapper.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { buildVerdictForRepo } from './build-verdict.js';

const SERVER_NAME = 'clone-check';
const SERVER_VERSION = '0.1.0';

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION
});

/**
 * `clone_check(repo)` tool.
 *
 * The optional `savedStack` lets an agent pass the user's 3-chip stack
 * preference (matches the web first-run picker). It defaults to empty,
 * so the tool works without it.
 */
server.tool(
  'clone_check',
  'Clone Check: should I clone this starter? Returns a structured verdict ' +
  '(Looks clone-able / Clone with care / Skip it / Not enough signal) plus a ' +
  'deterministic paste-ready agent context block. Accepts a GitHub URL or ' +
  'owner/name. Heuristic check, not a security audit.',
  {
    repo: z.string().describe('GitHub repo URL or owner/name (e.g. "vercel/next.js")'),
    savedStack: z
      .array(z.string())
      .optional()
      .describe('Optional 3-chip stack preference (e.g. ["next","react","tailwind"]). Defaults to empty.')
  },
  async ({ repo, savedStack }) => {
    try {
      const result = await buildVerdictForRepo(repo, { savedStack });
      // MCP text content — the full structured payload as JSON. Agents and
      // the parity test parse this back into the verdict object.
      const text = JSON.stringify(result, null, 2);
      return {
        content: [{ type: 'text', text }],
        isError: false
      };
    } catch (err) {
      // Honest error surface — never claim a verdict on failure.
      const message = err && err.message ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `clone_check failed: ${message}` }],
        isError: true
      };
    }
  }
);

/**
 * Boot using the stdio transport. `process.stdin`/`process.stdout` are the
 * JSON-RPC wire — no port, no HTTP server.
 */
const transport = new StdioServerTransport();
await server.connect(transport);

// NOTE: do NOT call process.exit() here — the transport owns the lifecycle.
// The process stays alive listening on stdio until the client disconnects.

export { server };
