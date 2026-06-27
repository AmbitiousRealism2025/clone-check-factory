/**
 * F1.3 — Data-correctness fixes (VC-DATA-02, VC-DATA-04).
 *
 * Covers:
 *   1. Issue counts exclude items carrying a `pull_request` field. The GitHub
 *      /issues endpoint returns BOTH issues and PRs; PRs surface there with a
 *      `pull_request` object. Any issue count / temperature signal MUST filter
 *      them out. (VC-DATA-02)
 *   2. Bus factor renders real `{login, percentage}` rows — never an array of
 *      bare numbers (which destructure to "Unknown 0%") and never missing.
 *      (VC-DATA-04)
 *   3. A single shared `mapPulseData()` produces the same dashboard shape on
 *      both surfaces (kills the divergent detail.js / pulse.js mappings).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getIssueTimeline, clearCache } from '../api.js';
import {
  calculateIssueTemperature,
  calculateBusFactor,
  calculateAllMetrics
} from '../components/PulseDashboard/PulseCalculator.js';
import { mapPulseData } from '../components/PulseDashboard/mapPulseData.js';

beforeEach(() => {
  clearCache();
  vi.clearAllMocks();
});

/* =========================================================================
 * Helpers / fixtures
 * ========================================================================= */

const mockFetchResponse = (data) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(data),
  headers: { get: () => '59' }
});

/** A mixed payload exactly as the GitHub /issues endpoint returns it. */
const MIXED_ISSUES_AND_PRS = [
  { id: 1, number: 1, title: 'Real issue 1', state: 'open', created_at: '2024-01-01T00:00:00Z' },
  {
    id: 2,
    number: 2,
    title: 'A pull request sneaking in',
    state: 'open',
    created_at: '2024-01-02T00:00:00Z',
    pull_request: { url: 'https://api.github.com/repos/o/r/pulls/2' }
  },
  { id: 3, number: 3, title: 'Real issue 2', state: 'closed', created_at: '2024-01-03T00:00:00Z', closed_at: '2024-01-04T00:00:00Z' },
  {
    id: 4,
    number: 4,
    title: 'A merged PR sneaking in',
    state: 'closed',
    created_at: '2024-01-05T00:00:00Z',
    closed_at: '2024-01-06T00:00:00Z',
    pull_request: { merged_at: '2024-01-06T00:00:00Z' }
  }
];

/* =========================================================================
 * VC-DATA-02 — Issues exclude pull requests
 * ========================================================================= */

describe('VC-DATA-02 — issue counts exclude pull requests', () => {
  describe('api.getIssueTimeline filters PRs from the /issues endpoint', () => {
    it('strips items carrying a pull_request field out of the returned data', async () => {
      global.fetch.mockResolvedValueOnce(mockFetchResponse(MIXED_ISSUES_AND_PRS));

      const result = await getIssueTimeline('owner', 'repo');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('repos/owner/repo/issues'),
        expect.any(Object)
      );
      // Only the two real issues survive.
      expect(result.data).toHaveLength(2);
      expect(result.data.every((item) => item.pull_request === undefined)).toBe(true);
      expect(result.data.map((i) => i.number)).toEqual([1, 3]);
    });

    it('returns an empty array (not a throw) when every item is a PR', async () => {
      global.fetch.mockResolvedValueOnce(
        mockFetchResponse([
          { id: 9, number: 9, state: 'open', created_at: '2024-01-01T00:00:00Z', pull_request: {} }
        ])
      );
      const result = await getIssueTimeline('owner', 'repo');
      expect(result.data).toEqual([]);
    });

    it('is a no-op for a payload that already contains only real issues', async () => {
      const pure = [
        { id: 1, number: 1, state: 'open', created_at: '2024-01-01T00:00:00Z' },
        { id: 2, number: 2, state: 'closed', created_at: '2024-01-02T00:00:00Z' }
      ];
      global.fetch.mockResolvedValueOnce(mockFetchResponse(pure));
      const result = await getIssueTimeline('owner', 'repo');
      expect(result.data).toEqual(pure);
    });
  });

  describe('PulseCalculator.calculateIssueTemperature is defensively PR-free', () => {
    it('ignores pull_request items even if a caller hands them in raw', () => {
      // Recents within the analysis window — half are PRs that must not count.
      const recent = new Date().toISOString();
      const mixed = [
        { state: 'open', created_at: recent },
        { state: 'open', created_at: recent, pull_request: {} },
        { state: 'closed', created_at: recent, closed_at: recent, pull_request: { merged_at: recent } }
      ];

      const result = calculateIssueTemperature(mixed);
      // 1 real issue total → default "Cool" (no-recent-issues) shape, NOT a
      // temperature driven by the PR. The PRs must never inflate counts.
      expect(result).toBeTruthy();
      // Stronger invariant: feed the same set minus PRs and we get the same
      // temperature object back. PRs are invisible to the calculator.
      const withoutPrs = mixed.filter((i) => !i.pull_request);
      const resultWithoutPrs = calculateIssueTemperature(withoutPrs);
      expect(resultWithoutPrs).toEqual(result);
    });
  });
});

/* =========================================================================
 * VC-DATA-04 — Bus factor shows real {login, percentage} rows
 * ========================================================================= */

describe('VC-DATA-04 — bus factor renders real contributor rows', () => {
  const CONTRIBUTORS = [
    { total: 100, author: { login: 'dev1' } },
    { total: 50, author: { login: 'dev2' } },
    { total: 30, author: { login: 'dev3' } }
  ];

  it('calculateBusFactor exposes a distribution of {login, percentage} objects', () => {
    const result = calculateBusFactor(CONTRIBUTORS);

    expect(Array.isArray(result.distribution)).toBe(true);
    expect(result.distribution.length).toBeGreaterThan(0);
    // Every row carries a real login and a numeric percentage > 0.
    for (const row of result.distribution) {
      expect(typeof row.login).toBe('string');
      expect(row.login.length).toBeGreaterThan(0);
      expect(typeof row.percentage).toBe('number');
      expect(row.percentage).toBeGreaterThan(0);
    }
    // Top contributor is dev1 with ~55.6% (100/180).
    expect(result.distribution[0].login).toBe('dev1');
    expect(result.distribution[0].percentage).toBeCloseTo((100 / 180) * 100, 1);
  });

  it('distribution rows are never bare numbers (which render as "Unknown 0%")', () => {
    const result = calculateBusFactor(CONTRIBUTORS);
    for (const row of result.distribution) {
      expect(typeof row).toBe('object');
      expect(row).not.toBeNull();
      expect(row.login).not.toBe('Unknown');
      expect(row.percentage).not.toBe(0);
    }
  });

  it('still exposes the numeric sparklineData (back-compat with existing tests)', () => {
    const result = calculateBusFactor(CONTRIBUTORS);
    expect(Array.isArray(result.sparklineData)).toBe(true);
    expect(result.sparklineData).toHaveLength(10);
  });
});

/* =========================================================================
 * Shared mapPulseData — single mapping used on both surfaces
 * ========================================================================= */

describe('mapPulseData — single shared dashboard mapping', () => {
  const FIXTURE = {
    repo: {
      full_name: 'owner/repo',
      stargazers_count: 100,
      forks_count: 10,
      created_at: '2020-01-01T00:00:00Z',
      pushed_at: new Date().toISOString()
    },
    participation: { all: [5, 10, 8, 12, 15, 20, 18, 22, 25, 30, 28, 32] },
    issues: [
      { state: 'open', created_at: new Date().toISOString() },
      { state: 'closed', created_at: new Date().toISOString(), closed_at: new Date().toISOString() }
    ],
    prs: [{ state: 'closed', created_at: new Date().toISOString(), merged_at: new Date().toISOString(), merged: true }],
    contributors: [
      { total: 100, author: { login: 'dev1' } },
      { total: 40, author: { login: 'dev2' } }
    ],
    events: [{ type: 'WatchEvent', created_at: new Date().toISOString() }],
    releases: [{ tag_name: 'v1.0.0', published_at: new Date().toISOString() }]
  };

  it('produces the six canonical metric keys + repoName + overallStatus', () => {
    const calculated = calculateAllMetrics(FIXTURE);
    const dashboard = mapPulseData(calculated, { repoName: 'owner/repo' });

    for (const key of [
      'commitVelocity',
      'issueHealth',
      'prHealth',
      'busFactor',
      'releaseFreshness',
      'communityHealth'
    ]) {
      expect(dashboard).toHaveProperty(key);
    }
    expect(dashboard.repoName).toBe('owner/repo');
    expect(typeof dashboard.overallStatus).toBe('string');
  });

  it('plumbs real {login, percentage} rows into busFactor.distribution', () => {
    const calculated = calculateAllMetrics(FIXTURE);
    const dashboard = mapPulseData(calculated, { repoName: 'owner/repo' });

    expect(Array.isArray(dashboard.busFactor.distribution)).toBe(true);
    expect(dashboard.busFactor.distribution.length).toBeGreaterThan(0);
    // No bare numbers — every entry is a real {login, percentage} object.
    for (const row of dashboard.busFactor.distribution) {
      expect(typeof row).toBe('object');
      expect(typeof row.login).toBe('string');
      expect(row.login).not.toBe('Unknown');
      expect(typeof row.percentage).toBe('number');
      expect(row.percentage).toBeGreaterThan(0);
    }
  });

  it('is deterministic — identical input yields identical output', () => {
    const a = mapPulseData(calculateAllMetrics(FIXTURE), { repoName: 'owner/repo' });
    const b = mapPulseData(calculateAllMetrics(FIXTURE), { repoName: 'owner/repo' });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('handles missing/empty contributor data without throwing', () => {
    const minimal = calculateAllMetrics({ repo: FIXTURE.repo });
    const dashboard = mapPulseData(minimal, { repoName: 'owner/repo' });
    // distribution may be an empty array, but it MUST be an array (not numbers).
    expect(Array.isArray(dashboard.busFactor.distribution)).toBe(true);
  });

  it('default option set still maps repoName from calculated object when omitted', () => {
    const calculated = calculateAllMetrics(FIXTURE);
    const dashboard = mapPulseData(calculated);
    expect(typeof dashboard.repoName).toBe('string');
  });
});
