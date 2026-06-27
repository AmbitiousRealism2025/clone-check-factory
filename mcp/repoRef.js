/**
 * Clone Check — MCP repo-ref parser.
 *
 * Pure utility shared by the MCP server, the data fetcher, and the
 * programmatic test harness. It normalises the many forms a "repo" argument
 * can take (URL / `owner/name` / git URL) into a stable `{ owner, name }`.
 *
 * Pure: zero DOM, zero network, zero clock reads. Safe to import from the
 * pure engine tests as well as the Node-only MCP entry points.
 */

/**
 * Parse a repo reference in any of these forms into `{ owner, name }`:
 *   - `owner/name`
 *   - `https://github.com/owner/name`
 *   - `https://github.com/owner/name.git`
 *   - `https://github.com/owner/name/tree/sha`  (sha path stripped)
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

  // Strip a trailing path/query/anchor (e.g. /tree/main, .git, ?tab=readme).
  // Keep the first two path segments after the host — owner/name only.
  s = s.split(/[?#]/)[0];

  // Strip protocols.
  s = s.replace(/^https?:\/\/github\.com\//i, '');
  s = s.replace(/^ssh:\/\/git@github\.com\//i, '');
  s = s.replace(/^git@github\.com:/i, '');

  // Strip leading `github.com/`.
  s = s.replace(/^github\.com\//i, '');

  // Strip trailing `.git`.
  s = s.replace(/\.git$/i, '');

  // If the user pasted a deeper path (e.g. owner/name/tree/sha), keep only
  // the first two segments — the verdict is keyed on owner+name+SHA-of-default-branch.
  const segments = s.split('/').filter(Boolean);
  if (segments.length >= 2) {
    s = `${segments[0]}/${segments[1]}`;
  }

  // Now expect exactly `owner/name` (allowing dots/dashes/underscores).
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)$/);
  if (!m) {
    throw new Error(`repo: could not parse ${JSON.stringify(ref)} as owner/name`);
  }
  return { owner: m[1], name: m[2] };
}

/** Render `{ owner, name }` back into the canonical `owner/name` slug. */
export function formatRepoSlug({ owner, name }) {
  return `${owner}/${name}`;
}

export default { parseRepoRef, formatRepoSlug };
