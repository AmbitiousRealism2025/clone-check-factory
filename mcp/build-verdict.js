/**
 * Clone Check — MCP verdict composer.
 *
 * Single entry point that:
 *   1. Resolves `RepoData` for a repo ref (via the Node data fetcher), and
 *   2. Runs the SAME pure `verdict()` + `assembleContextBlock()` the web
 *      surface uses.
 *
 * Because both surfaces route through the identical pure functions, the
 * structured verdict + context block produced here is byte-equivalent to
 * the web engine for the same repo + SHA (VC-MCP-01).
 *
 * The composer is the only place the MCP path "decides" anything beyond
 * running the pure engine — it pulls the saved 3-chip stack from the
 * caller (defaults to empty = no fitScore) and threads it through.
 */

import { verdict } from '../src/js/engine/verdict.js';
import { assembleContextBlock } from '../src/js/engine/contextBlock.js';
import { fetchRepoData } from './data-fetcher.js';
import { parseRepoRef } from './repoRef.js';

/**
 * Build the full MCP response payload for a repo ref.
 *
 * @param {string} repoRef
 * @param {object} [options]
 * @param {string} [options.token]       GitHub token override (else env GITHUB_TOKEN).
 * @param {boolean} [options.fixture]    Force deterministic fixture data.
 * @param {string[]} [options.savedStack] User's saved 3-chip stack (default []).
 * @param {string} [options.asOf]        Override the as-of date stamp.
 * @returns {Promise<{
 *   repo: string,
 *   owner: string,
 *   name: string,
 *   sha: string|null,
 *   fetchedAt: string,
 *   verdict: object,
 *   contextBlock: string
 * }>}
 */
export async function buildVerdictForRepo(repoRef, options = {}) {
  // Parse first so malformed refs surface a clear, zod-style error before
  // any network call.
  const { owner, name } = parseRepoRef(repoRef);

  const repoData = await fetchRepoData(repoRef, {
    token: options.token,
    fixture: options.fixture
  });

  // The saved stack is caller-supplied (web: localStorage; MCP: agent context).
  // Default empty → verdict still emits detected chips, fitScore = 0.
  const savedStack = Array.isArray(options.savedStack) ? options.savedStack.slice() : [];

  // Override asOf if the caller wants determinism (used by parity tests).
  if (options.asOf) repoData.asOf = options.asOf;

  const v = verdict({ ...repoData, savedStack });
  const contextBlock = assembleContextBlock({
    asOf: repoData.asOf,
    meta: repoData.meta,
    verdict: v,
    contents: repoData.contents,
    issues: repoData.issues
  });

  return {
    repo: repoRef,
    owner,
    name,
    sha: repoData.sha || null,
    fetchedAt: repoData.asOf,
    verdict: v,
    contextBlock
  };
}

export default buildVerdictForRepo;
