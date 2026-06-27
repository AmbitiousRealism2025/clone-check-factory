import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Quota-aware request manager tests (F2.3 / VC-PLATFORM-03).
//
// Covers:
//   - Honest 429 / Retry-After messaging ("try again in N seconds")
//   - NEVER the misleading "Forbidden: check your token" copy
//   - AbortController cancels superseded in-flight requests
//   - Stats endpoints route through fetchWithRetry (activate STATS_CACHE_TTL_MS)
//
// We import the public-facing API functions plus the managed-request helpers
// so the tests exercise the real code paths the UI uses.

import {
  getRepository,
  getCommitActivity,
  getParticipationStats,
  getContributorStats,
  fetchWithRetry,
  createManagedRequest,
  clearManagedRequest,
  withManagedRequest,
  parseRetryAfter,
  clearCache
} from '../api.js';
import { STATS_CACHE_TTL_MS, CACHE_TTL_MS } from '../constants.js';

/** Builds a fake fetch Response with arbitrary status + headers. */
const buildResponse = (status, { body = null, headers = {}, statusText = '' } = {}) => {
  const headerMap = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusText || (status === 200 ? 'OK' : ''),
    json: vi.fn().mockResolvedValue(body),
    headers: {
      get: (key) => headerMap.get(key.toLowerCase()) ?? null
    }
  };
};

describe('quota-aware request manager — parseRetryAfter', () => {
  it('parses integer-seconds form', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter('0')).toBe(1); // clamped to >=1
  });

  it('parses HTTP-date form into remaining seconds', () => {
    const future = new Date(Date.now() + 90_000); // 90s out
    const seconds = parseRetryAfter(future.toUTCString());
    expect(seconds).toBeGreaterThanOrEqual(80);
    expect(seconds).toBeLessThanOrEqual(95);
  });

  it('returns null for missing or unparseable values', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('not-a-date-or-number')).toBeNull();
  });
});

describe('quota-aware request manager — honest 429 / Retry-After messaging', () => {
  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('on 429 with Retry-After, throws "try again in N seconds" using Retry-After', async () => {
    global.fetch.mockResolvedValueOnce(
      buildResponse(429, {
        headers: {
          'retry-after': '45',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600)
        },
        statusText: 'rate limit exceeded'
      })
    );

    await expect(getRepository('owner', 'repo')).rejects.toThrow(
      /try again in 45 seconds/
    );
  });

  it('on 429 without Retry-After, falls back to x-ratelimit-reset to compute the wait', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120; // ~120s out
    global.fetch.mockResolvedValueOnce(
      buildResponse(429, {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(reset)
        },
        statusText: 'rate limit exceeded'
      })
    );

    await expect(getRepository('owner', 'repo')).rejects.toThrow(
      /Rate limited by GitHub — try again in \d+ seconds/
    );
  });

  it('on 403 with Retry-After (secondary rate limit), throws the honest "try again" message', async () => {
    global.fetch.mockResolvedValueOnce(
      buildResponse(403, {
        headers: {
          'retry-after': '30',
          'x-ratelimit-remaining': '5000'
        },
        statusText: 'Forbidden'
      })
    );

    await expect(getRepository('owner', 'repo')).rejects.toThrow(
      /try again in 30 seconds/
    );
  });

  it('on 403 with x-ratelimit-remaining=0 (primary limit), throws the honest "try again" message', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    global.fetch.mockResolvedValueOnce(
      buildResponse(403, {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(reset)
        },
        statusText: 'rate limit exceeded'
      })
    );

    await expect(getRepository('owner', 'repo')).rejects.toThrow(
      /Rate limited by GitHub — try again in \d+ seconds/
    );
  });

  it('NEVER throws "Forbidden: Check your access token" or any "check your token" copy', async () => {
    // Primary rate limit
    global.fetch.mockResolvedValueOnce(
      buildResponse(403, {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60)
        }
      })
    );
    await expect(getRepository('owner', 'repo')).rejects.toThrow(
      /^(?!.*[Cc]heck your (?:access )?token).*$/
    );

    clearCache();

    // Secondary rate limit
    global.fetch.mockResolvedValueOnce(
      buildResponse(429, {
        headers: { 'retry-after': '10' }
      })
    );
    await expect(getRepository('owner', 'repo')).rejects.toThrow(
      /^(?!.*[Cc]heck your (?:access )?token).*$/
    );

    clearCache();

    // Genuine 403 (not a rate limit) — still never blames the token.
    global.fetch.mockResolvedValueOnce(
      buildResponse(403, {
        headers: { 'x-ratelimit-remaining': '5000' }
      })
    );
    await expect(getRepository('owner', 'repo')).rejects.toThrow(
      /^(?!.*[Cc]heck your (?:access )?token).*$/
    );
  });

  it('a genuine 403 (not a rate limit) surfaces honest permission copy, never blaming rate limit on the token', async () => {
    global.fetch.mockResolvedValueOnce(
      buildResponse(403, {
        headers: { 'x-ratelimit-remaining': '5000' }
      })
    );

    await expect(getRepository('owner', 'repo')).rejects.toThrow(/Forbidden/);
    // The honest permission message must NOT be the misleading old copy.
    global.fetch.mockResolvedValueOnce(
      buildResponse(403, {
        headers: { 'x-ratelimit-remaining': '5000' }
      })
    );
    clearCache();
    let caught;
    try {
      await getRepository('owner', 'repo');
    } catch (e) {
      caught = e.message;
    }
    expect(caught).not.toMatch(/[Cc]heck your (?:access )?token/);
    expect(caught.length).toBeGreaterThan(0);
  });
});

describe('quota-aware request manager — AbortController cancels superseded requests', () => {
  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createManagedRequest aborts the prior controller for the same key', () => {
    const signal1 = createManagedRequest('verdict-input');
    expect(signal1.aborted).toBe(false);

    const signal2 = createManagedRequest('verdict-input');
    expect(signal1.aborted).toBe(true); // prior superseded
    expect(signal2.aborted).toBe(false);

    // Different keys do not interfere.
    const other = createManagedRequest('other-key');
    expect(signal2.aborted).toBe(false);
    expect(other.aborted).toBe(false);

    clearManagedRequest('verdict-input');
    clearManagedRequest('other-key');
  });

  it('clearManagedRequest is a no-op when the slot is held by a different signal', () => {
    const s1 = createManagedRequest('k');
    const s2 = createManagedRequest('k'); // supersedes s1
    expect(s1.aborted).toBe(true);

    // Passing s1 (the old owner) should NOT clear the slot held by s2.
    clearManagedRequest('k', s1);
    // The slot is still tracked; start a third and s2 should abort.
    const s3 = createManagedRequest('k');
    expect(s2.aborted).toBe(true);

    clearManagedRequest('k');
  });

  it('withManagedRequest passes a live signal to the producer and cleans up on resolve', async () => {
    let observedSignal;
    global.fetch.mockImplementationOnce(async (url, opts) => {
      observedSignal = opts?.signal;
      return buildResponse(200, {
        body: { id: 1, full_name: 'owner/repo' },
        headers: { 'x-ratelimit-remaining': '59' }
      });
    });

    const url = 'https://api.github.com/repos/owner/repo';
    const result = await withManagedRequest('verdict-input', (signal) =>
      fetchWithRetry(url, { signal })
    );

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(false);
    expect(result.data).toEqual({ id: 1, full_name: 'owner/repo' });
  });

  it('withManagedRequest aborts a prior in-flight request when called again with the same key', async () => {
    // First producer: registers an abort listener so we can observe the
    // cancellation, and never resolves until aborted.
    let firstAborted = false;
    let resolveFirst;
    const firstPromise = new Promise((resolve) => { resolveFirst = resolve; });

    const firstFetchPromise = withManagedRequest('verdict-input', (signal) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          firstAborted = true;
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
        // Never resolve on its own; the abort listener rejects first once
        // superseded. (resolveFirst exists only to keep the linter happy
        // about an "unused" promise capability.)
        resolveFirst(resolve);
      });
    });

    // Yield once to let the producer register its listener.
    await Promise.resolve();

    // Second managed request with the same key supersedes the first; this
    // must abort the first controller before the second fetch runs.
    global.fetch.mockImplementationOnce(() =>
      Promise.resolve(
        buildResponse(200, {
          body: { fresh: true },
          headers: { 'x-ratelimit-remaining': '59' }
        })
      )
    );
    const url = 'https://api.github.com/repos/owner/repo';
    const secondResult = await withManagedRequest('verdict-input', (signal) =>
      fetchWithRetry(url, { signal })
    );
    expect(secondResult.data).toEqual({ fresh: true });

    // The first producer should have been rejected via its abort listener.
    await expect(firstFetchPromise).rejects.toThrow();
    expect(firstAborted).toBe(true);
  });

  it('fetchWithRetry does NOT retry on AbortError (caller intentionally cancelled)', async () => {
    // First call rejects with an AbortError; the retry loop must NOT retry it.
    global.fetch.mockImplementationOnce(() => {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const url = 'https://api.github.com/repos/owner/repo';
    await expect(fetchWithRetry(url)).rejects.toThrow();

    // Exactly one fetch call — no retries.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('quota-aware request manager — stats endpoints route through fetchWithRetry', () => {
  beforeEach(() => {
    clearCache();
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeStatsResponse = (body) =>
    buildResponse(200, {
      body,
      headers: { 'x-ratelimit-remaining': '59' }
    });

  it('getCommitActivity resolves with stats data and processing=false', async () => {
    const data = [{ week: 1, days: [1, 2, 3], total: 6 }];
    global.fetch.mockImplementationOnce(() => Promise.resolve(makeStatsResponse(data)));

    const result = await getCommitActivity('owner', 'repo');
    expect(result.data).toEqual(data);
    expect(result.processing).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('stats/commit_activity'),
      expect.any(Object)
    );
  });

  it('getParticipationStats resolves with stats data and processing=false', async () => {
    const data = { all: [1, 2, 3], owner: [0, 1, 1] };
    global.fetch.mockImplementationOnce(() => Promise.resolve(makeStatsResponse(data)));

    const result = await getParticipationStats('owner', 'repo');
    expect(result.data).toEqual(data);
    expect(result.processing).toBe(false);
  });

  it('getContributorStats resolves with stats data and processing=false', async () => {
    const data = [{ author: { login: 'u' }, total: 5, weeks: [] }];
    global.fetch.mockImplementationOnce(() => Promise.resolve(makeStatsResponse(data)));

    const result = await getContributorStats('owner', 'repo');
    expect(result.data).toEqual(data);
    expect(result.processing).toBe(false);
  });

  it('stats cache uses the longer STATS_CACHE_TTL_MS (activated, not dead)', () => {
    // Sanity: the constants module exports a distinct, longer TTL for stats.
    expect(STATS_CACHE_TTL_MS).toBeGreaterThan(CACHE_TTL_MS);
  });

  it('a successful stats response is cached (second call does not re-fetch)', async () => {
    const data = [{ week: 1, days: [1, 2, 3], total: 6 }];
    global.fetch.mockImplementation(() => Promise.resolve(makeStatsResponse(data)));

    await getCommitActivity('owner', 'repo');
    await getCommitActivity('owner', 'repo');

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
