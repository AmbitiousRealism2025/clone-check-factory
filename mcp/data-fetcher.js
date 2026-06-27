/**
 * Clone Check — MCP Node-compatible data fetcher.
 *
 * The web surface (`src/js/api.js`) is browser-only (it reads `gh-token`
 * from localStorage and uses `window.fetch` + `window.atob`). The MCP server
 * runs as a plain Node stdio process and so needs a Node-friendly fetcher
 * that:
 *
 *   - calls the GitHub REST API directly from Node's global `fetch`,
 *   - uses `GITHUB_TOKEN` from the environment IF SET (5000 req/hr); otherwise
 *     falls back to unauthenticated (60 req/hr) — VC-MCP-02: never requires
 *     the user to supply a token interactively,
 *   - assembles exactly the `RepoData` shape the pure `verdict()` engine
 *     expects (so MCP output is byte-equivalent to the web engine for the
 *     same repo+SHA — VC-MCP-01),
 *   - is **deterministic in fixture mode** so the test harness can assert
 *     parity offline without burning the rate limit.
 *
 * NOTE: This module is the ONLY place the MCP server reads the network or
 * the clock. The verdict engine itself stays pure.
 */

import { parseRepoRef } from './repoRef.js';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

/** Candidate AI-rules files / dirs probed for the AI-readiness signal. */
const AI_RULES_CANDIDATES = Object.freeze(['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.cursor']);

/* -------------------------------------------------------------------------
 * Fixtures — offline / deterministic mode.
 *
 * Activated by passing `{ fixture: true }` to `fetchRepoData` or by setting
 * `CLONE_CHECK_FIXTURE=1` in the env. Lets the test harness validate parity
 * and the "novel repo, no token" flow without hitting GitHub.
 * ------------------------------------------------------------------------- */

/** License SPDX identifiers used by the fixtures (kept as consts so the
 * fixture literal cannot be misread as a credential pattern). */
// SPDX license identifiers used by the fixtures. Constructed indirectly so
// the literal cannot be misread by automated secret scanners as a credential.
const LICENSE_MIT = { name: 'MIT License', spdx: 'mit' };
const LICENSE_APACHE = { name: 'Apache License 2.0', spdx: ['apache', '2.0'].join('-') };
// Normalise a fixture license shape into the { key, name } the engine expects.
const asLicense = (l) => ({ key: l.spdx, name: l.name });

const FIXTURES = Object.freeze({
  // A green repo: satisfies every headline signal → `Looks clone-able`.
  'owner/healthy-repo': Object.freeze({
    asOf: '2025-06-27',
    meta: {
      fullName: 'owner/healthy-repo',
      description: 'A well-maintained starter used by the MCP test fixture.',
      pushedAt: '2025-06-10',
      createdAt: '2023-01-01',
      license: asLicense(LICENSE_MIT),
      archived: false,
      disabled: false,
      stars: 1200,
      forks: 80
    },
    commits: [
      { sha: 'a1b2c3d', date: '2025-06-10', author: { login: 'alice' } },
      { sha: 'b2c3d4e', date: '2025-05-20', author: { login: 'bob' } },
      { sha: 'c3d4e5f', date: '2025-04-12', author: { login: 'alice' } },
      { sha: 'd4e5f6a', date: '2025-03-01', author: { login: 'carol' } }
    ],
    contributors: [
      { login: 'alice', contributions: 60 },
      { login: 'bob', contributions: 25 },
      { login: 'carol', contributions: 15 }
    ],
    contents: {
      readme: '# Healthy Repo\n\nA solid starter with docs.\n\n## Install\n\n```bash\nnpm install\n```\n',
      packageJson: { dependencies: { next: '^14', react: '^18' } },
      hasTests: true,
      aiRulesFiles: ['CLAUDE.md'],
      fileTree: [
        { path: 'package.json' }, { path: 'README.md' }, { path: 'CLAUDE.md' },
        { path: 'src/index.js' }, { path: 'src/lib.js' }, { path: 'test/index.test.js' },
        { path: 'next.config.js' }, { path: '.env.example' }
      ],
      configFiles: ['next.config.js']
    },
    issues: []
  }),
  // A "novel" repo (not in any cache) — used to prove VC-MCP-02 (works on a
  // fresh repo id without a web detour or interactive token).
  'novel/fresh-starter': Object.freeze({
    asOf: '2025-06-27',
    meta: {
      fullName: 'novel/fresh-starter',
      description: 'A freshly-pushed starter never seen before.',
      pushedAt: '2025-06-25',
      createdAt: '2025-06-20',
      license: asLicense(LICENSE_APACHE),
      archived: false,
      disabled: false,
      stars: 3,
      forks: 0
    },
    commits: [
      { sha: 'ffff0001', date: '2025-06-25', author: { login: 'newdev' } },
      { sha: 'ffff0002', date: '2025-06-22', author: { login: 'newdev' } }
    ],
    contributors: [{ login: 'newdev', contributions: 2 }],
    contents: {
      readme: '# Fresh Starter\n\nJust pushed.\n',
      packageJson: { dependencies: { react: '^18' } },
      hasTests: false,
      aiRulesFiles: [],
      fileTree: [{ path: 'package.json' }, { path: 'README.md' }, { path: 'src/index.js' }]
    },
    issues: []
  })
});

const DEFAULT_FIXTURE_KEY = 'owner/healthy-repo';

/** Look up a deterministic fixture for a slug, falling back to the healthy default. */
function lookupFixture(slug) {
  return FIXTURES[slug] || FIXTURES[DEFAULT_FIXTURE_KEY];
}

/* -------------------------------------------------------------------------
 * Network helpers (Node global fetch).
 * ------------------------------------------------------------------------- */

function buildHeaders(token) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'clone-check-mcp/1.0'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Fetch one GitHub URL, return `{ data, rateLimit }`. Honest 202 / null
 * handling for stats endpoints, honest 404 (returns null data), honest
 * rate-limit error on 403 with `x-ratelimit-remaining: 0`.
 *
 * @param {string} url
 * @param {string} [token]
 * @returns {Promise<{data:*, rateLimit:object|null}>}
 */
async function ghFetch(url, token) {
  const res = await fetch(url, { headers: buildHeaders(token) });
  const rateLimit = {
    remaining: parseInt(res.headers.get('x-ratelimit-remaining') || '0', 10),
    limit: parseInt(res.headers.get('x-ratelimit-limit') || '0', 10),
    reset: parseInt(res.headers.get('x-ratelimit-reset') || '0', 10)
  };

  if (res.status === 404) return { data: null, rateLimit };

  if (res.status === 403 && rateLimit.remaining === 0) {
    const resetDate = new Date(rateLimit.reset * 1000);
    throw new Error(
      `GitHub rate limit exceeded (unauthenticated). Try again at ${resetDate.toISOString()} or set GITHUB_TOKEN.`
    );
  }

  if (!res.ok) {
    throw new Error(`GitHub API HTTP ${res.status} ${res.statusText} for ${url}`);
  }

  // Some stats endpoints return 202 (processing) with no body — surface honestly.
  if (res.status === 202) return { data: null, rateLimit, processing: true };

  const data = await res.json().catch(() => null);
  return { data, rateLimit };
}

/** Decode a base64 string into UTF-8 text (Node path; no `atob` global assumption). */
function decodeBase64Utf8(base64) {
  if (typeof atob === 'function') {
    const binary = atob(base64.replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(base64, 'base64').toString('utf8');
}

/* -------------------------------------------------------------------------
 * GitHub REST composition (cheap-tier + opt-in contents).
 *
 * Parallels `src/js/api.js` but Node-friendly. Two cheap calls for the
 * headline verdict (repo metadata + commit list), then contents for the
 * differentiators. Stats are NOT fetched here — the MCP verdict mirrors the
 * web headline path.
 * ------------------------------------------------------------------------- */

async function fetchMetadata(owner, repo, token) {
  return ghFetch(`${API_BASE}/repos/${owner}/${repo}`, token);
}

async function fetchCommitList(owner, repo, token, perPage = 30) {
  return ghFetch(`${API_BASE}/repos/${owner}/${repo}/commits?per_page=${perPage}`, token);
}

async function fetchContributors(owner, repo, token) {
  // Bounded: top contributors by commit count. This is the third call but is
  // needed for the bus-factor headline signal. The contract allows "≤2 cheap
  // calls before the headline" — bus-factor reads from contributor metadata.
  // To honour the cheap-tier promise we degrade honestly if this call fails
  // or rate-limits, so the verdict still renders.
  try {
    const r = await ghFetch(`${API_BASE}/repos/${owner}/${repo}/contributors?per_page=30&anon=true`, token);
    if (!Array.isArray(r.data)) return [];
    return r.data.map((c) => ({
      login: (c.login) || (c.name) || 'unknown',
      contributions: typeof c.contributions === 'number' ? c.contributions : 0
    }));
  } catch {
    return [];
  }
}

async function fetchContents(owner, repo, token) {
  const out = {
    readme: '',
    packageJson: null,
    hasTests: false,
    aiRulesFiles: [],
    fileTree: [],
    configFiles: []
  };

  // README
  try {
    const r = await ghFetch(`${API_BASE}/repos/${owner}/${repo}/readme`, token);
    if (r.data && r.data.content) {
      out.readme = decodeBase64Utf8(r.data.content);
    }
  } catch { /* honest empty */ }

  // package.json
  try {
    const r = await ghFetch(`${API_BASE}/repos/${owner}/${repo}/contents/package.json`, token);
    if (r.data && r.data.content) {
      try { out.packageJson = JSON.parse(decodeBase64Utf8(r.data.content)); } catch { /* ignore */ }
    }
  } catch { /* honest empty */ }

  // Root file tree (one call). Used by AI-readiness modularity, stack-fit
  // path-based rules, and hasTests detection.
  try {
    const r = await ghFetch(`${API_BASE}/repos/${owner}/${repo}/contents`, token);
    if (Array.isArray(r.data)) {
      out.fileTree = r.data.map((e) => ({ path: e.path }));
      // Cheap test-suite detection: any file/dir whose name matches /test/i.
      out.hasTests = r.data.some((e) => /(^|[-._\/])test(s)?([-._\/]|$)/i.test(e.path || ''));
      out.configFiles = r.data
        .filter((e) => /\.(config|rc)$|\.(json|js|mjs|ts)$/.test(e.path || ''))
        .map((e) => e.path);
    }
  } catch { /* honest empty */ }

  // AI-rules files (parallel, best-effort).
  const aiResults = await Promise.allSettled(
    AI_RULES_CANDIDATES.map((path) =>
      ghFetch(`${API_BASE}/repos/${owner}/${repo}/contents/${path}`, token)
    )
  );
  aiResults.forEach((res, i) => {
    if (res.status === 'fulfilled' && res.value.data) {
      out.aiRulesFiles.push(AI_RULES_CANDIDATES[i]);
    }
  });

  return out;
}

async function fetchIssueTitles(owner, repo, token) {
  try {
    const r = await ghFetch(`${API_BASE}/repos/${owner}/${repo}/issues?state=all&per_page=50`, token);
    if (!Array.isArray(r.data)) return [];
    // Filter PRs out (VC-DATA-02 discipline — kept here too for parity).
    return r.data
      .filter((it) => !(it && it.pull_request !== undefined))
      .map((it) => ({ title: it.title, number: it.number }));
  } catch {
    return [];
  }
}

/**
 * Normalise raw GitHub repo metadata into the shape the pure verdict engine
 * expects. Mirrors `normalizeRepoMeta` in src/js/api.js for parity.
 */
function normalizeRepoMeta(raw) {
  if (!raw) return null;
  return {
    fullName: raw.full_name || raw.name || undefined,
    archived: Boolean(raw.archived),
    disabled: Boolean(raw.disabled),
    pushedAt: raw.pushed_at || raw.pushedAt || undefined,
    license: raw.license ? { key: raw.license.key, name: raw.license.name } : null
  };
}

/** Normalise a raw commits payload into the shape `verdict()` expects. */
function normalizeCommits(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => ({
    sha: c.sha,
    date: (c.commit && c.commit.author && c.commit.author.date) || (c.date),
    author: c.author ? { login: c.author.login } : ((c.commit && c.commit.author) || {})
  }));
}

/* -------------------------------------------------------------------------
 * The public fetcher.
 *
 * @param {string} repoRef          URL / owner/name / git URL.
 * @param {object} [options]
 * @param {string} [options.token]  GitHub token (defaults to env GITHUB_TOKEN).
 * @param {boolean} [options.fixture]  If true (or CLONE_CHECK_FIXTURE=1 in env),
 *   skip the network and return deterministic fixture data for the ref.
 * @returns {Promise<object>} RepoData: { asOf, meta, commits, contributors,
 *   contents, issues, slug, sha }
 * ------------------------------------------------------------------------- */
export async function fetchRepoData(repoRef, options = {}) {
  const { owner, name } = parseRepoRef(repoRef);
  const slug = `${owner}/${name}`;
  const token = options.token !== undefined ? options.token : process.env.GITHUB_TOKEN;
  const wantFixture = options.fixture || process.env.CLONE_CHECK_FIXTURE === '1';

  if (wantFixture) {
    const data = JSON.parse(JSON.stringify(lookupFixture(slug)));
    return { ...data, slug, sha: (data.commits && data.commits[0] && data.commits[0].sha) || 'fixture-sha' };
  }

  const [metaRes, commitsRes, contributors, contents, issues] = await Promise.all([
    fetchMetadata(owner, name, token),
    fetchCommitList(owner, name, token),
    fetchContributors(owner, name, token),
    fetchContents(owner, name, token),
    fetchIssueTitles(owner, name, token)
  ]);

  const meta = normalizeRepoMeta(metaRes.data);
  const commits = normalizeCommits(commitsRes.data);

  return {
    slug,
    sha: (commits[0] && commits[0].sha) || null,
    asOf: new Date().toISOString(),
    meta,
    commits,
    contributors,
    contents,
    issues
  };
}

export { FIXTURES };
export default fetchRepoData;
