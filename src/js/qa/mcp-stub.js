/**
 * Clone Check — MCP `clone_check` stub for the QA harness.
 *
 * The real MCP server (M2, feature f2-1) exposes a `clone_check(repo)` tool
 * over stdio JSON-RPC and returns the SAME structured verdict as the web
 * engine for the same repo + SHA (VC-MCP-01).
 *
 * Until that server lands, this module provides a programmatic STUB with the
 * identical input → output contract. It:
 *   - parses a repo ref (URL / `owner/name` / git URL),
 *   - resolves `RepoData` (deterministic fixture by default, or caller-supplied),
 *   - invokes the pure `verdict()` engine,
 *   - wraps the result in the same envelope the real MCP server will use.
 *
 * When M2 ships, this file is replaced by a `cloneCheck` that spawns the real
 * MCP server and drives it via JSON-RPC. The harness (`qa/scripts/qa-harness.mjs`)
 * imports `cloneCheck` from a single path, so no harness changes will be
 * needed — only this file swaps over.
 *
 * Hard invariants (inherited from the engine):
 *   - Never asserts "Safe".
 *   - Never returns a positive verdict on missing data.
 */

import { verdict } from '../engine/verdict.js';

/* -------------------------------------------------------------------------
 * Repo-ref parsing.
 * ------------------------------------------------------------------------- */

/**
 * Parse a repo reference in any of these forms into `{ owner, name }`:
 *   - `owner/name`
 *   - `https://github.com/owner/name`
 *   - `https://github.com/owner/name.git`
 *   - `git@github.com:owner/name.git`
 *   - `ssh://git@github.com/owner/name.git`
 *
 * @param {string} ref
 * @returns {{owner: string, name: string}}
 * @throws {Error} if the input cannot be parsed.
 */
export function parseRepoRef(ref) {
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error(`repo: expected a non-empty repo ref, got ${JSON.stringify(ref)}`);
  }
  let s = ref.trim();

  // Strip a trailing path/query/anchor.
  s = s.split(/[?#]/)[0];

  // Strip protocols.
  s = s.replace(/^https?:\/\/github\.com\//i, '');
  s = s.replace(/^ssh:\/\/git@github\.com\//i, '');
  s = s.replace(/^git@github\.com:/i, '');

  // Strip trailing `.git`.
  s = s.replace(/\.git$/i, '');

  // Strip leading `github.com/`.
  s = s.replace(/^github\.com\//i, '');

  // Now expect exactly `owner/name` (allowing dots/dashes/underscores).
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)$/);
  if (!m) {
    throw new Error(`repo: could not parse ${JSON.stringify(ref)} as owner/name`);
  }
  return { owner: m[1], name: m[2] };
}

/* -------------------------------------------------------------------------
 * Deterministic fixture (stub data).
 *
 * The fixture satisfies every headline signal so the stub returns a real
 * `Looks clone-able` verdict, proving end-to-end that the engine renders
 * through both the web path and the MCP path. The real MCP server will
 * fetch live GitHub data instead; the harness's `--repo` flag lets you
 * exercise that path once M2 lands.
 * ------------------------------------------------------------------------- */

/** A single deterministic RepoData fixture keyed by `owner/name`. */
const FIXTURES = Object.freeze({
  'owner/healthy-repo': Object.freeze({
    asOf: '2025-06-27',
    meta: {
      fullName: 'owner/healthy-repo',
      description: 'A well-maintained starter used by the QA harness fixture.',
      pushedAt: '2025-06-10',
      createdAt: '2023-01-01',
      license: { key: 'mit', name: 'MIT License' },
      archived: false,
      disabled: false,
      stars: 1200,
      forks: 80
    },
    commits: [
      { sha: 'a', date: '2025-06-10', author: { login: 'alice' } },
      { sha: 'b', date: '2025-05-20', author: { login: 'bob' } },
      { sha: 'c', date: '2025-04-12', author: { login: 'alice' } },
      { sha: 'd', date: '2025-03-01', author: { login: 'carol' } }
    ],
    contributors: [
      { login: 'alice', contributions: 60 },
      { login: 'bob', contributions: 25 },
      { login: 'carol', contributions: 15 }
    ],
    contents: {
      readme: '# Healthy Repo\n\nA solid starter with docs.',
      packageJson: { dependencies: { next: '^14' } },
      hasTests: true,
      aiRulesFiles: ['CLAUDE.md']
    }
  })
});

const DEFAULT_FIXTURE_KEY = 'owner/healthy-repo';

/**
 * Build a deterministic RepoData object for a known fixture key.
 * Falls back to the canonical healthy-repo fixture for unknown keys so the
 * harness never crashes on a typo; the harness always prints which key was
 * used so the operator knows.
 *
 * @param {string} [repoRef=DEFAULT_FIXTURE_KEY]
 * @returns {object} A deep-frozen RepoData fixture.
 */
export function buildRepoDataFromFixture(repoRef = DEFAULT_FIXTURE_KEY) {
  const key = FIXTURES[repoRef] ? repoRef : DEFAULT_FIXTURE_KEY;
  return JSON.parse(JSON.stringify(FIXTURES[key]));
}

/* -------------------------------------------------------------------------
 * cloneCheck — the stub entry point.
 *
 * @param {string} repoRef          Repo ref (URL / owner/name / git URL).
 * @param {object} [options]
 * @param {object} [options.repoData]  Caller-supplied RepoData. When present,
 *   the stub skips fixture resolution and runs the engine directly. (The
 *   real M2 server will skip this entirely and use live-fetched data.)
 * @param {string} [options.asOf]      Override the `asOf` date stamp.
 * @returns {Promise<{
 *   repo: string,
 *   path: 'mcp-stub',
 *   ms: number,
 *   verdict: object,
 *   repoData: object,
 *   note: string
 * }>}
 * ------------------------------------------------------------------------- */
export async function cloneCheck(repoRef, options = {}) {
  const t0 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();

  // Parse first so a malformed ref surfaces a clear error (parity with the
  // real server, which will reject unknown arg shapes via zod).
  parseRepoRef(repoRef);

  const baseData = options.repoData
    ? JSON.parse(JSON.stringify(options.repoData))
    : buildRepoDataFromFixture(repoRef);

  if (options.asOf) baseData.asOf = options.asOf;

  const v = verdict(baseData);
  const t1 = (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();

  return {
    repo: repoRef,
    path: 'mcp-stub',
    ms: Math.round((t1 - t0) * 1000) / 1000,
    verdict: v,
    repoData: baseData,
    note: 'MCP clone_check invoked via programmatic stub. ' +
          'Will be swapped to a real stdio JSON-RPC call when the M2 MCP server lands.'
  };
}

export default cloneCheck;
