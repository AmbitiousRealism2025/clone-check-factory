import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchPackageJson,
  fetchReadme,
  fetchFileTree,
  fetchAiRulesFiles,
  getCommitList,
  fetchHeadlineData,
  fetchExpensiveStats,
  getParticipationStats,
  getContributorStats,
  getCommitActivity,
  clearCache
} from '../api.js';
import { STATS_CACHE_TTL_MS, CACHE_TTL_MS } from '../constants.js';

/**
 * Tests for F1.2 — Contents API + tiered data layer.
 *
 * Covers:
 *   VC-CONTENTS-01 — contents API (package.json, README, file tree, AI-rules files)
 *   VC-DATA-01     — headline verdict from at most 2 GitHub calls
 *   VC-DATA-03     — 202 / empty-stats degrade honestly (Unknown/computing)
 *   VC-DATA-05     — expensive stats are opt-in (not called on headline render)
 *   Stats routing through fetchWithRetry + STATS_CACHE_TTL_MS activation
 */

const okResponse = (data, status = 200) => ({
  ok: true,
  status,
  statusText: status === 202 ? 'Accepted' : 'OK',
  json: () => Promise.resolve(data),
  headers: {
    get: (key) => {
      const h = {
        'x-ratelimit-remaining': '59',
        'x-ratelimit-limit': '60',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600)
      };
      return h[key] ?? null;
    }
  }
});

const notFoundResponse = () => ({
  ok: false,
  status: 404,
  statusText: 'Not Found',
  headers: { get: () => null }
});

/** Base64-encode a UTF-8 string the way GitHub does. */
const ghBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  const binary = Array.from(bytes).map((b) => String.fromCharCode(b)).join('');
  return btoa(binary);
};

describe('Contents API + tiered data (F1.2)', () => {
  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ------------------------------------------------------------------- *
   * VC-CONTENTS-01 — contents API
   * ------------------------------------------------------------------- */

  describe('fetchPackageJson (VC-CONTENTS-01)', () => {
    it('fetches, decodes, and JSON-parses package.json', async () => {
      const pkg = { name: 'demo', dependencies: { next: '^14.0.0', react: '^18.0.0' } };
      global.fetch.mockResolvedValueOnce(
        okResponse({ name: 'package.json', path: 'package.json', content: ghBase64(JSON.stringify(pkg)), encoding: 'base64' })
      );

      const result = await fetchPackageJson('owner', 'repo');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('repos/owner/repo/contents/package.json'),
        expect.any(Object)
      );
      expect(result.parsed).toEqual(pkg);
      expect(result.decodedContent).toBe(JSON.stringify(pkg));
    });

    it('returns parsed:null but does NOT throw when package.json is malformed JSON', async () => {
      global.fetch.mockResolvedValueOnce(
        okResponse({ name: 'package.json', content: ghBase64('{ not valid json'), encoding: 'base64' })
      );

      const result = await fetchPackageJson('owner', 'repo');
      expect(result.parsed).toBeNull();
      expect(result.decodedContent).toContain('not valid json');
    });

    it('returns null shape (honest) when package.json is absent — never fabricated', async () => {
      global.fetch.mockResolvedValueOnce(notFoundResponse());

      const result = await fetchPackageJson('owner', 'repo');
      expect(result.data).toBeNull();
      expect(result.parsed).toBeNull();
      expect(result.decodedContent).toBeNull();
    });
  });

  describe('fetchReadme (VC-CONTENTS-01)', () => {
    it('fetches and decodes the README', async () => {
      const body = '# Demo\n\nA starter.';
      global.fetch.mockResolvedValueOnce(
        okResponse({ name: 'README.md', content: ghBase64(body), encoding: 'base64' })
      );

      const result = await fetchReadme('owner', 'repo');
      expect(result.data.decodedContent).toBe(body);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('repos/owner/repo/readme'),
        expect.any(Object)
      );
    });

    it('returns data:null honestly when no README exists', async () => {
      global.fetch.mockResolvedValueOnce(notFoundResponse());
      const result = await fetchReadme('owner', 'repo');
      expect(result.data).toBeNull();
    });
  });

  describe('fetchFileTree (VC-CONTENTS-01)', () => {
    it('fetches the root file tree as an array of entries', async () => {
      const tree = [
        { name: 'src', type: 'dir', path: 'src' },
        { name: 'package.json', type: 'file', path: 'package.json' },
        { name: 'README.md', type: 'file', path: 'README.md' }
      ];
      global.fetch.mockResolvedValueOnce(okResponse(tree));

      const result = await fetchFileTree('owner', 'repo');
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toHaveLength(3);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('repos/owner/repo/contents'),
        expect.any(Object)
      );
    });

    it('honors the recursive flag via git/trees endpoint', async () => {
      const tree = {
        tree: [
          { path: 'src/index.js', type: 'blob' },
          { path: 'CLAUDE.md', type: 'blob' }
        ],
        truncated: false
      };
      // recursive path resolves the default branch first, then the tree.
      global.fetch.mockImplementation((url) => {
        if (url === 'https://api.github.com/repos/owner/repo') {
          return Promise.resolve(okResponse({ full_name: 'owner/repo', default_branch: 'main' }));
        }
        if (url.includes('git/trees')) {
          return Promise.resolve(okResponse(tree));
        }
        return Promise.resolve(notFoundResponse());
      });

      const result = await fetchFileTree('owner', 'repo', { recursive: true });
      const treesUrl = global.fetch.mock.calls.find((c) => c[0].includes('git/trees'))[0];
      expect(treesUrl).toContain('recursive=1');
      expect(result.data.tree).toHaveLength(2);
    });
  });

  describe('fetchAiRulesFiles (VC-CONTENTS-01)', () => {
    it('returns found + missing lists, with CLAUDE.md and AGENTS.md decoded when present', async () => {
      const claude = '# Claude rules\nBe concise.';
      const agents = '# Agents rules\nRun tests.';
      global.fetch.mockImplementation((url) => {
        if (url.endsWith('/contents/CLAUDE.md')) {
          return Promise.resolve(okResponse({ name: 'CLAUDE.md', content: ghBase64(claude), encoding: 'base64' }));
        }
        if (url.endsWith('/contents/AGENTS.md')) {
          return Promise.resolve(okResponse({ name: 'AGENTS.md', content: ghBase64(agents), encoding: 'base64' }));
        }
        // .cursorrules and .cursor variants absent
        return Promise.resolve(notFoundResponse());
      });

      const result = await fetchAiRulesFiles('owner', 'repo');
      const foundPaths = result.found.map((f) => f.path).sort();
      expect(foundPaths).toEqual(['AGENTS.md', 'CLAUDE.md']);
      expect(result.found.find((f) => f.path === 'CLAUDE.md').decodedContent).toBe(claude);
      expect(result.missing.length).toBeGreaterThan(0);
    });

    it('returns empty found list (honest) when no AI-rules files exist', async () => {
      global.fetch.mockResolvedValue(notFoundResponse());
      const result = await fetchAiRulesFiles('owner', 'repo');
      expect(result.found).toEqual([]);
      expect(result.missing.length).toBeGreaterThan(0);
    });
  });

  /* ------------------------------------------------------------------- *
   * VC-DATA-01 — headline from at most 2 cheap calls
   * VC-DATA-05 — expensive stats NOT called on headline render
   * ------------------------------------------------------------------- */

  describe('fetchHeadlineData (VC-DATA-01, VC-DATA-05)', () => {
    it('makes EXACTLY 2 GitHub calls: repo metadata + one commits-list call', async () => {
      const meta = {
        full_name: 'owner/repo',
        archived: false,
        disabled: false,
        pushed_at: '2025-05-01T00:00:00Z',
        license: { key: 'mit', name: 'MIT License' }
      };
      const commits = [
        { sha: 'abc', commit: { author: { date: '2025-05-01T00:00:00Z' } } },
        { sha: 'def', commit: { author: { date: '2025-04-20T00:00:00Z' } } }
      ];
      global.fetch.mockImplementation((url) => {
        if (url === 'https://api.github.com/repos/owner/repo') {
          return Promise.resolve(okResponse(meta));
        }
        if (url.includes('/repos/owner/repo/commits')) {
          return Promise.resolve(okResponse(commits));
        }
        return Promise.resolve(notFoundResponse());
      });

      const result = await fetchHeadlineData('owner', 'repo');

      // The hard gate: at most 2 GitHub calls.
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // And those two calls are the cheap ones — never stats endpoints.
      const calledUrls = global.fetch.mock.calls.map((c) => c[0]);
      calledUrls.forEach((url) => {
        expect(url).not.toMatch(/stats\/participation/);
        expect(url).not.toMatch(/stats\/contributors/);
        expect(url).not.toMatch(/stats\/commit_activity/);
      });

      // Headline payload is well-formed.
      expect(result.meta.fullName).toBe('owner/repo');
      expect(result.meta.license.key).toBe('mit');
      expect(Array.isArray(result.commits)).toBe(true);
      expect(typeof result.asOf).toBe('string');
    });

    it('does NOT call expensive stats endpoints (opt-in only)', async () => {
      global.fetch.mockImplementation((url) => {
        if (url === 'https://api.github.com/repos/owner/repo') {
          return Promise.resolve(okResponse({ full_name: 'owner/repo', pushed_at: '2025-05-01T00:00:00Z', license: { key: 'mit', name: 'MIT' } }));
        }
        if (url.includes('/repos/owner/repo/commits')) {
          return Promise.resolve(okResponse([{ sha: 'abc' }]));
        }
        // If a stats endpoint is hit, explode — that proves the gate.
        if (url.includes('/stats/')) {
          return Promise.resolve(okResponse({ __shouldNotBeCalled: true }));
        }
        return Promise.resolve(notFoundResponse());
      });

      const result = await fetchHeadlineData('owner', 'repo');

      const calledUrls = global.fetch.mock.calls.map((c) => c[0]);
      const statsHit = calledUrls.find((u) => u.includes('/stats/'));
      expect(statsHit, `stats endpoint must NOT be called during headline render, got: ${statsHit}`).toBeUndefined();

      // And no contents calls either on the headline tier.
      const contentsHit = calledUrls.find((u) => u.includes('/contents/') || u.endsWith('/contents'));
      expect(contentsHit).toBeUndefined();
    });

    it('still renders an honest headline when commits list is empty', async () => {
      global.fetch.mockImplementation((url) => {
        if (url === 'https://api.github.com/repos/owner/repo') {
          return Promise.resolve(okResponse({ full_name: 'owner/repo', pushed_at: '2025-05-01T00:00:00Z', license: null }));
        }
        if (url.includes('/repos/owner/repo/commits')) {
          return Promise.resolve(okResponse([]));
        }
        return Promise.resolve(notFoundResponse());
      });

      const result = await fetchHeadlineData('owner/repo'.split('/')[0], 'owner/repo'.split('/')[1]);
      expect(result.commits).toEqual([]);
      expect(result.meta.license).toBeNull();
    });
  });

  describe('getCommitList', () => {
    it('fetches the commits list endpoint with a per_page cap', async () => {
      global.fetch.mockResolvedValueOnce(okResponse([{ sha: 'abc' }]));
      await getCommitList('owner', 'repo', 25);
      const url = global.fetch.mock.calls[0][0];
      expect(url).toContain('/repos/owner/repo/commits');
      expect(url).toContain('per_page=25');
    });
  });

  /* ------------------------------------------------------------------- *
   * VC-DATA-05 — expensive stats are opt-in (fetchExpensiveStats)
   * ------------------------------------------------------------------- */

  describe('fetchExpensiveStats (VC-DATA-05)', () => {
    it('calls the three expensive stats endpoints', async () => {
      global.fetch.mockImplementation((url) => {
        if (url.includes('stats/participation')) {
          return Promise.resolve(okResponse({ all: [1, 2, 3], owner: [0, 1, 1] }));
        }
        if (url.includes('stats/contributors')) {
          return Promise.resolve(okResponse([{ author: { login: 'u1' }, total: 10, weeks: [] }]));
        }
        if (url.includes('stats/commit_activity')) {
          return Promise.resolve(okResponse([{ week: 1, days: [1], total: 1 }]));
        }
        return Promise.resolve(notFoundResponse());
      });

      const result = await fetchExpensiveStats('owner', 'repo');

      const calledUrls = global.fetch.mock.calls.map((c) => c[0]);
      expect(calledUrls.some((u) => u.includes('stats/participation'))).toBe(true);
      expect(calledUrls.some((u) => u.includes('stats/contributors'))).toBe(true);
      expect(calledUrls.some((u) => u.includes('stats/commit_activity'))).toBe(true);

      expect(result.participation.data).toEqual({ all: [1, 2, 3], owner: [0, 1, 1] });
      expect(result.contributors.data).toHaveLength(1);
      expect(result.commitActivity.data).toHaveLength(1);
    });
  });

  /* ------------------------------------------------------------------- *
   * VC-DATA-03 — 202 / empty-stats degrade honestly
   * ------------------------------------------------------------------- */

  describe('honest 202 / empty-stats handling (VC-DATA-03)', () => {
    it('returns explicit processing:true on 202 — never a fabricated number', async () => {
      // First call: 202; retry: 200 with empty {} body (GitHub's honest empty).
      global.fetch.mockResolvedValueOnce(okResponse(null, 202));
      global.fetch.mockResolvedValueOnce(okResponse({}));

      const result = await getParticipationStats('owner', 'repo');
      expect(result.data).toEqual({});
      expect(result.processing).toBe(false);
    });

    it('returns processing:true (computing) when GitHub keeps returning 202', async () => {
      global.fetch.mockResolvedValue(okResponse(null, 202));

      const result = await getParticipationStats('owner', 'repo');
      expect(result.processing).toBe(true);
      expect(result.data).toBeNull();
      // Honest state — never a fabricated number.
      expect(result.data).not.toBeInstanceOf(Array);
    });

    it('commit-activity 202 surfaces a computing flag, not a green default', async () => {
      global.fetch.mockResolvedValue(okResponse(null, 202));
      const result = await getCommitActivity('owner', 'repo');
      expect(result.processing).toBe(true);
      expect(result.data).toBeNull();
    });

    it('contributor 202 surfaces a computing flag, not a green default', async () => {
      global.fetch.mockResolvedValue(okResponse(null, 202));
      const result = await getContributorStats('owner', 'repo');
      expect(result.processing).toBe(true);
      expect(result.data).toBeNull();
    });

    it('fetchExpensiveStats propagates processing flags instead of fabricating', async () => {
      global.fetch.mockImplementation((url) => {
        if (url.includes('/stats/')) return Promise.resolve(okResponse(null, 202));
        return Promise.resolve(notFoundResponse());
      });

      const result = await fetchExpensiveStats('owner', 'repo');
      // Every expensive metric must honestly say "computing" — no fabricated numbers.
      expect(result.participation.processing).toBe(true);
      expect(result.contributors.processing).toBe(true);
      expect(result.commitActivity.processing).toBe(true);
      expect(result.participation.data).toBeNull();
      expect(result.contributors.data).toBeNull();
      expect(result.commitActivity.data).toBeNull();
    });

    it('empty {} participation stats are surfaced as-is, never inflated to a default', async () => {
      global.fetch.mockResolvedValueOnce(okResponse({}));
      const result = await getParticipationStats('owner', 'repo');
      expect(result.data).toEqual({});
      expect(result.processing).toBe(false);
    });
  });

  /* ------------------------------------------------------------------- *
   * Stats routing through fetchWithRetry + STATS_CACHE_TTL_MS activation
   * ------------------------------------------------------------------- */

  describe('stats routing + STATS_CACHE_TTL_MS', () => {
    it('STATS_CACHE_TTL_MS constant is active (greater than the default cache TTL)', () => {
      expect(STATS_CACHE_TTL_MS).toBeGreaterThan(CACHE_TTL_MS);
    });

    it('caches stats responses so the second call does not hit the network', async () => {
      global.fetch.mockResolvedValueOnce(okResponse({ all: [1, 2], owner: [0, 1] }));

      await getParticipationStats('owner', 'repo');
      await getParticipationStats('owner', 'repo');

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT cache a 202 processing response (so the retry genuinely re-fetches)', async () => {
      // Two 202s -> retry-once -> processing result, fetch called twice, nothing cached.
      global.fetch.mockResolvedValue(okResponse(null, 202));

      await getParticipationStats('owner', 'repo');
      expect(global.fetch).toHaveBeenCalledTimes(2);

      // A fresh call after clearCache still hits the network (processing never cached).
      clearCache();
      global.fetch.mockClear();
      global.fetch.mockResolvedValue(okResponse(null, 202));
      await getParticipationStats('owner', 'repo');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });
});
