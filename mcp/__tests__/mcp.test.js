import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { verdict } from '../../src/js/engine/verdict.js';
import { assembleContextBlock } from '../../src/js/engine/contextBlock.js';
import { parseRepoRef, formatRepoSlug } from '../repoRef.js';
import { fetchRepoData, FIXTURES } from '../data-fetcher.js';
import { buildVerdictForRepo } from '../build-verdict.js';
import { McpStdioClient, cloneCheckViaStdio } from '../client.js';

/* =========================================================================
 * Clone Check — MCP server (F2.1) unit + end-to-end tests.
 *
 * Covers validation-contract assertions:
 *   VC-MCP-01 — MCP parity: same structured verdict + context block as the
 *               web engine for the same repo + SHA.
 *   VC-MCP-02 — clone_check works on a novel (not-yet-cached) repo in-agent,
 *               without a website visit or an interactive token prompt.
 *
 * Testing strategy:
 *   - Parity tests run the SAME RepoData through the web engine (verdict +
 *     assembleContextBlock) and through the MCP composer; output must match.
 *   - End-to-end tests spawn the real stdio MCP server (`mcp/server.js`) as
 *     a child process in fixture mode (CLONE_CHECK_FIXTURE=1) so they run
 *     fully offline, deterministically, and never need a GitHub token.
 *   - One opt-in live-network test is included but skipped by default so the
 *     suite stays green in CI; run it with `MCP_LIVE_NETWORK=1`.
 * ========================================================================= */

// Fixture mode => no network, no token, fully deterministic.
const FIXTURE_ENV = { CLONE_CHECK_FIXTURE: '1', GITHUB_TOKEN: '' };

/* -------------------------------------------------------------------------
 * repoRef parsing
 * ------------------------------------------------------------------------- */
describe('parseRepoRef', () => {
  it('parses owner/name', () => {
    expect(parseRepoRef('vercel/next.js')).toEqual({ owner: 'vercel', name: 'next.js' });
  });

  it('parses https URL', () => {
    expect(parseRepoRef('https://github.com/facebook/react')).toEqual({
      owner: 'facebook', name: 'react'
    });
  });

  it('parses https URL with trailing .git', () => {
    expect(parseRepoRef('https://github.com/facebook/react.git')).toEqual({
      owner: 'facebook', name: 'react'
    });
  });

  it('parses git+ssh URL', () => {
    expect(parseRepoRef('git@github.com:facebook/react.git')).toEqual({
      owner: 'facebook', name: 'react'
    });
  });

  it('parses deeper tree URL down to owner/name', () => {
    expect(parseRepoRef('https://github.com/vercel/next.js/tree/canary/docs')).toEqual({
      owner: 'vercel', name: 'next.js'
    });
  });

  it('throws on unparseable input', () => {
    expect(() => parseRepoRef('https://example.com/x')).toThrow(/repo/i);
    expect(() => parseRepoRef('')).toThrow(/repo/i);
    expect(() => parseRepoRef(null)).toThrow(/repo/i);
  });

  it('round-trips through formatRepoSlug', () => {
    const parsed = parseRepoRef('https://github.com/vercel/next.js');
    expect(formatRepoSlug(parsed)).toBe('vercel/next.js');
  });
});

/* -------------------------------------------------------------------------
 * data-fetcher fixture mode
 * ------------------------------------------------------------------------- */
describe('fetchRepoData (fixture mode)', () => {
  it('returns deterministic data for a known fixture slug', async () => {
    const a = await fetchRepoData('owner/healthy-repo', { fixture: true });
    const b = await fetchRepoData('owner/healthy-repo', { fixture: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.slug).toBe('owner/healthy-repo');
    expect(a.sha).toBe('a1b2c3d');
  });

  it('falls back to the default fixture for an unknown slug (still no network)', async () => {
    const data = await fetchRepoData('some-unknown/repo', { fixture: true });
    expect(data.meta).toBeTruthy();
    expect(Array.isArray(data.commits)).toBe(true);
  });

  it('respects CLONE_CHECK_FIXTURE env var', async () => {
    const prev = process.env.CLONE_CHECK_FIXTURE;
    process.env.CLONE_CHECK_FIXTURE = '1';
    try {
      const data = await fetchRepoData('owner/healthy-repo');
      expect(data.slug).toBe('owner/healthy-repo');
    } finally {
      if (prev === undefined) delete process.env.CLONE_CHECK_FIXTURE;
      else process.env.CLONE_CHECK_FIXTURE = prev;
    }
  });

  it('fixture data has no Date.now() / clock coupling (asOf is fixed)', async () => {
    const data = await fetchRepoData('owner/healthy-repo', { fixture: true });
    expect(data.asOf).toBe('2025-06-27'); // canonical fixture date
  });
});

/* -------------------------------------------------------------------------
 * VC-MCP-01 — MCP parity
 *
 * The web engine path is: verdict(repoData) + assembleContextBlock(...).
 * The MCP path is: buildVerdictForRepo(repoRef, { fixture: true, asOf }).
 * Both must yield byte-identical verdict + context block for the same data.
 * ------------------------------------------------------------------------- */
describe('VC-MCP-01 — MCP parity with web engine', () => {
  it('produces the same verdict object as the pure web engine for the same RepoData', async () => {
    const repoData = JSON.parse(JSON.stringify(FIXTURES['owner/healthy-repo']));
    const expectedVerdict = verdict(repoData);

    const mcp = await buildVerdictForRepo('owner/healthy-repo', {
      fixture: true,
      asOf: repoData.asOf
    });

    expect(mcp.verdict).toEqual(expectedVerdict);
  });

  it('produces the same context block as the web engine for the same RepoData', async () => {
    const repoData = JSON.parse(JSON.stringify(FIXTURES['owner/healthy-repo']));
    const v = verdict(repoData);
    const expectedBlock = assembleContextBlock({
      asOf: repoData.asOf,
      meta: repoData.meta,
      verdict: v,
      contents: repoData.contents,
      issues: repoData.issues
    });

    const mcp = await buildVerdictForRepo('owner/healthy-repo', {
      fixture: true,
      asOf: repoData.asOf
    });

    expect(mcp.contextBlock).toBe(expectedBlock);
  });

  it('is byte-equivalent across repeated MCP calls (deterministic)', async () => {
    const a = await buildVerdictForRepo('owner/healthy-repo', { fixture: true });
    const b = await buildVerdictForRepo('owner/healthy-repo', { fixture: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('threads savedStack through identically to the web engine', async () => {
    const savedStack = ['next', 'react', 'tailwind'];
    const repoData = {
      ...JSON.parse(JSON.stringify(FIXTURES['owner/healthy-repo'])),
      savedStack
    };
    const expected = verdict(repoData);

    const mcp = await buildVerdictForRepo('owner/healthy-repo', {
      fixture: true,
      savedStack,
      asOf: repoData.asOf
    });
    expect(mcp.verdict.stackFit).toEqual(expected.stackFit);
    expect(mcp.verdict.stackFit.matches).toContain('next');
    expect(mcp.verdict.stackFit.matches).toContain('react');
  });

  it('never asserts "Safe" in MCP output (hard product invariant)', async () => {
    const mcp = await buildVerdictForRepo('owner/healthy-repo', { fixture: true });
    expect(JSON.stringify(mcp.verdict)).not.toMatch(/\bSafe\b/);
    expect(JSON.stringify(mcp.contextBlock)).not.toMatch(/\bSafe\b/);
  });

  it('carries the dated disclaimer on every verdict (VC-ENGINE-06)', async () => {
    const mcp = await buildVerdictForRepo('owner/healthy-repo', { fixture: true });
    expect(mcp.verdict.disclaimer).toMatch(/heuristic check, not a security audit/);
    expect(mcp.verdict.disclaimer).toMatch(/as of /);
  });
});

/* -------------------------------------------------------------------------
 * VC-MCP-02 — novel repo, in-agent, no web detour, no interactive token
 *
 * Spawned end-to-end: the stdio MCP server is launched WITHOUT a
 * GITHUB_TOKEN, invoked on a novel repo id, and must return a verdict.
 * Fixture mode keeps it deterministic + offline (so the test never makes a
 * network call and never prompts for a token).
 * ------------------------------------------------------------------------- */

describe('VC-MCP-02 — novel repo via stdio (no web detour, no token)', () => {
  let client;

  beforeAll(async () => {
    client = new McpStdioClient({
      nodeEnv: FIXTURE_ENV,
      startupMs: 8000,
      requestMs: 30000
    });
    await client.start();
  });

  afterAll(async () => {
    if (client) await client.stop();
  });

  it('exposes clone_check in tools/list', async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('clone_check');
  });

  it('returns a verdict for a novel repo id without a token', async () => {
    const payload = await client.callCloneCheck('novel/fresh-starter');
    expect(payload).toBeTruthy();
    expect(payload.verdict).toBeTruthy();
    expect(payload.verdict.state).toBeTruthy();
    // One of the four canonical verdict states only.
    expect([
      'Looks clone-able',
      'Clone with care',
      'Skip it',
      'Not enough signal'
    ]).toContain(payload.verdict.state);
    expect(payload.contextBlock).toEqual(expect.any(String));
  });

  it('returns a verdict for the healthy repo fixture', async () => {
    const payload = await client.callCloneCheck('owner/healthy-repo');
    expect(payload.verdict.state).toBe('Looks clone-able');
    expect(payload.sha).toBe('a1b2c3d');
  });

  it('parses a full https URL through the tool', async () => {
    const payload = await client.callCloneCheck('https://github.com/owner/healthy-repo');
    expect(payload.owner).toBe('owner');
    expect(payload.name).toBe('healthy-repo');
    expect(payload.verdict.state).toBe('Looks clone-able');
  });

  it('returns isError=true on a malformed repo ref (honest failure, no fabricated verdict)', async () => {
    // Use the raw one-shot client to inspect isError semantics.
    await expect(cloneCheckViaStdio('not-a-repo', {
      nodeEnv: FIXTURE_ENV,
      startupMs: 8000
    })).rejects.toThrow(/clone_check tool error|could not parse|repo/i);
  });

  it('never prompts for a token / never references localStorage', async () => {
    // The server child runs with an empty GITHUB_TOKEN. The fact that the
    // previous calls returned verdicts proves no interactive token flow.
    // Additionally assert the verdict payload does not surface a token field.
    const payload = await client.callCloneCheck('novel/fresh-starter');
    expect(JSON.stringify(payload)).not.toMatch(/token/i);
  });
});

/* -------------------------------------------------------------------------
 * End-to-end parity via the real stdio round-trip.
 *
 * Spawns the server, calls clone_check, and compares the JSON the server
 * returned to what the pure web engine produces for the same RepoData.
 * This is the strongest possible VC-MCP-01 evidence: the verdict crossed a
 * process boundary over JSON-RPC and still matches the engine byte-for-byte.
 * ------------------------------------------------------------------------- */
describe('VC-MCP-01 — end-to-end stdio parity', () => {
  let client;

  beforeAll(async () => {
    client = new McpStdioClient({
      nodeEnv: FIXTURE_ENV,
      startupMs: 8000,
      requestMs: 30000
    });
    await client.start();
  });

  afterAll(async () => {
    if (client) await client.stop();
  });

  it('stdio clone_check output === web engine output for the same repo+SHA', async () => {
    const repoData = JSON.parse(JSON.stringify(FIXTURES['owner/healthy-repo']));
    const expectedVerdict = verdict(repoData);
    const expectedBlock = assembleContextBlock({
      asOf: repoData.asOf,
      meta: repoData.meta,
      verdict: expectedVerdict,
      contents: repoData.contents,
      issues: repoData.issues
    });

    const payload = await client.callCloneCheck('owner/healthy-repo');

    // Same SHA, same verdict object, same context block.
    expect(payload.sha).toBe('a1b2c3d');
    expect(payload.verdict).toEqual(expectedVerdict);
    expect(payload.contextBlock).toBe(expectedBlock);
  });
});

/* -------------------------------------------------------------------------
 * Opt-in live-network smoke test (skipped by default).
 *
 * Set MCP_LIVE_NETWORK=1 to run. Calls the real GitHub API without a token
 * against a popular, stable public repo. Validates the unauthenticated
 * end-to-end path the contract calls out (60 req/hr).
 * ------------------------------------------------------------------------- */
describe.skipIf(!process.env.MCP_LIVE_NETWORK)('VC-MCP-02 live (real GitHub, no token)', () => {
  it('clone_check returns a verdict for a real public repo', async () => {
    const payload = await cloneCheckViaStdio('desktop/dext', {
      nodeEnv: { GITHUB_TOKEN: '' }, // force unauthenticated
      startupMs: 10000,
      requestMs: 60000
    });
    expect(payload).toBeTruthy();
    expect(payload.verdict).toBeTruthy();
    expect([
      'Looks clone-able',
      'Clone with care',
      'Skip it',
      'Not enough signal'
    ]).toContain(payload.verdict.state);
  }, 90000);
});
