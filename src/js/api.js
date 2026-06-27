import { API_BASE, API_VERSION, CACHE_TTL_MS, CACHE_MAX_ENTRIES, STATS_CACHE_TTL_MS, TRENDING_DAYS_BACK, TRENDING_CATEGORIES } from './constants.js';

const RETRY_CONFIG = { MAX_RETRIES: 3, INITIAL_BACKOFF_MS: 1000, BACKOFF_MULTIPLIER: 2 };

/* -------------------------------------------------------------------------
 * Clone Check — Quota-aware request manager (F2.3 / VC-PLATFORM-03).
 *
 * Two pieces:
 *   1. An in-flight registry keyed by an arbitrary string. Starting a new
 *      managed request with the same key ABORTS the prior in-flight request
 *      via its AbortController, so superseded fetches are cancelled rather
 *      than racing the newer one (e.g. user typing fast in the URL input).
 *   2. Honest 429 / Retry-After handling inside `fetchWithRetry`: GitHub's
 *      secondary rate limits come back as 429 (or 403) with a `Retry-After`
 *      header. We surface "Rate limited — try again in N seconds" instead of
 *      the misleading "Forbidden: Check your access token".
 * ------------------------------------------------------------------------- */

/** @type {Map<string, AbortController>} In-flight managed requests keyed by request key. */
const inflightRequests = new Map();

/**
 * Allocates a fresh `AbortController` for `key`, aborting any prior
 * in-flight request that shares the same key. Returns the new controller's
 * `signal` so the caller can pass it to `fetch` (or to `fetchWithRetry`).
 *
 * Use this for any user-initiated request where a newer request supersedes
 * an older one (e.g. the URL input on the verdict page, search-as-you-type).
 * For fire-and-forget calls that should NOT cancel each other, call `fetch`
 * directly with no signal.
 *
 * @param {string} key  Arbitrary identifier for the request slot.
 * @returns {AbortSignal} Signal for the new request. Aborted if a newer
 *   request with the same key starts before this one settles.
 */
export const createManagedRequest = (key) => {
  const existing = inflightRequests.get(key);
  if (existing) {
    existing.abort();
  }
  const controller = new AbortController();
  inflightRequests.set(key, controller);
  return controller.signal;
};

/**
 * Clears the in-flight slot for `key` if the active controller still owns it.
 * Safe to call after any settle (success or error); idempotent.
 *
 * @param {string} key
 * @param {AbortSignal} [signal]  Only clears if this signal is the active one.
 */
export const clearManagedRequest = (key, signal) => {
  const current = inflightRequests.get(key);
  if (!current) return;
  if (signal && current.signal !== signal) return;
  inflightRequests.delete(key);
};

/**
 * Runs `producer(signal)` with managed abort semantics: any prior in-flight
 * request sharing `key` is aborted, and the active slot is cleaned up when
 * the producer settles. If a newer managed request supersedes this one
 * mid-flight, `signal.aborted` becomes true and the producer's fetch rejects
 * with an `AbortError` (which `fetchWithRetry` rethrows without retrying).
 *
 * @template T
 * @param {string} key
 * @param {(signal: AbortSignal) => Promise<T>} producer
 * @returns {Promise<T>}
 */
export const withManagedRequest = async (key, producer) => {
  const signal = createManagedRequest(key);
  try {
    return await producer(signal);
  } finally {
    clearManagedRequest(key, signal);
  }
};

/**
 * Parses an HTTP `Retry-After` header value into a whole number of seconds.
 *
 * The header is defined as EITHER a non-negative integer (seconds) OR an
 * HTTP-date in RFC 1123 format. Returns `null` for missing / unparseable
 * values so callers can fall back to other signals (x-ratelimit-reset, a
 * default).
 *
 * @param {string|null|undefined} value
 * @returns {number|null} Whole seconds (≥1), or null.
 */
export const parseRetryAfter = (value) => {
  if (value == null || value === '') return null;
  const trimmed = String(value).trim();
  // Integer-seconds form.
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return Number.isFinite(seconds) ? Math.max(1, seconds) : null;
  }
  // HTTP-date form.
  const date = new Date(trimmed);
  if (!Number.isNaN(date.getTime())) {
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    return seconds > 0 ? seconds : 1;
  }
  return null;
};

/**
 * Candidate AI-rules files / dirs we probe for AI-readiness (VC-CONTENTS-01).
 * Order matters only for display; missing entries are reported honestly.
 */
const AI_RULES_CANDIDATES = Object.freeze(['CLAUDE.md', 'AGENTS.md', '.cursorrules', '.cursor']);

const getHeaders = () => {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION
  };
  
  const token = localStorage.getItem('gh-token');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  
  return headers;
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const cache = new Map();

const getCachedResponse = (url) => {
  const cached = cache.get(url);
  if (!cached) return null;

  // Each entry carries its own TTL (cheap calls vs expensive stats differ).
  const ttl = typeof cached.ttl === 'number' ? cached.ttl : CACHE_TTL_MS;
  if (Date.now() - cached.timestamp > ttl) {
    cache.delete(url);
    return null;
  }

  console.log(`[Cache] HIT: ${url.substring(0, 60)}...`);
  return cached.data;
};

const setCachedResponse = (url, data, ttl = CACHE_TTL_MS) => {
  cache.set(url, { data, timestamp: Date.now(), ttl });

  if (cache.size > CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
};

/**
 * Clears the internal API response cache
 * @returns {void}
 */
export const clearCache = () => {
  cache.clear();
  console.log('[Cache] Cleared');
};

/**
 * Fetch a GitHub URL with retry, caching, and honest 202 handling.
 *
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.retries=RETRY_CONFIG.MAX_RETRIES]   Network-error retries.
 * @param {number} [options.backoff=RETRY_CONFIG.INITIAL_BACKOFF_MS] Current backoff (ms).
 * @param {boolean} [options.useCache=true]                     Whether to consult the response cache.
 * @param {number} [options.cacheTtlMs=CACHE_TTL_MS]            Per-entry TTL (stats use STATS_CACHE_TTL_MS).
 * @param {boolean} [options.acceptStatsProcessing=false]       When true, a 202 returns
 *   `{ data: null, processing: true, rateLimit }` instead of being treated as success
 *   or thrown. Processing responses are NEVER cached (so retries genuinely re-fetch).
 * @param {AbortSignal} [options.signal]                        Optional AbortSignal
 *   forwarded to `fetch`. AbortErrors are rethrown WITHOUT retry (the request
 *   was intentionally cancelled — usually by `withManagedRequest`).
 * @returns {Promise<{data:*, rateLimit:Object, processing?: boolean}>}
 */
export const fetchWithRetry = async (url, options = {}) => {
  const {
    retries = RETRY_CONFIG.MAX_RETRIES,
    backoff = RETRY_CONFIG.INITIAL_BACKOFF_MS,
    useCache = true,
    cacheTtlMs = CACHE_TTL_MS,
    acceptStatsProcessing = false,
    signal
  } = options;

  if (useCache) {
    const cached = getCachedResponse(url);
    if (cached) return cached;
  }

  try {
    const response = await fetch(url, { headers: getHeaders(), signal });

    // 202 Accepted — GitHub stats are still being computed. Surface an honest
    // "computing" state and DO NOT cache (so the caller's retry re-fetches).
    if (response.status === 202 && acceptStatsProcessing) {
      return {
        data: null,
        processing: true,
        rateLimit: {
          remaining: parseInt(response.headers.get('x-ratelimit-remaining') || '0'),
          limit: parseInt(response.headers.get('x-ratelimit-limit') || '0'),
          reset: parseInt(response.headers.get('x-ratelimit-reset') || '0')
        }
      };
    }

    // VC-PLATFORM-03 — Honest rate-limit handling.
    // GitHub emits primary rate limits as 403 with x-ratelimit-remaining=0,
    // and secondary (abuse) rate limits as 429 (or 403) with a Retry-After
    // header. ALL of these surface as an honest "Rate limited — try again in
    // N seconds" message. We NEVER blame rate limits on the token with copy
    // like "Forbidden: Check your access token".
    if (response.status === 429 || response.status === 403) {
      const retryAfterSec = parseRetryAfter(response.headers.get('retry-after'));
      const remaining = response.headers.get('x-ratelimit-remaining');
      const resetTime = response.headers.get('x-ratelimit-reset');

      const isRateLimited =
        response.status === 429 ||
        remaining === '0' ||
        retryAfterSec !== null;

      if (isRateLimited) {
        let waitSeconds;
        if (retryAfterSec !== null) {
          waitSeconds = retryAfterSec;
        } else if (resetTime && /^\d+$/.test(resetTime)) {
          waitSeconds = Math.max(1, parseInt(resetTime, 10) - Math.floor(Date.now() / 1000));
        } else {
          waitSeconds = 60;
        }
        throw new Error(`Rate limited by GitHub — try again in ${waitSeconds} seconds`);
      }

      // A 403 that is NOT a rate limit is a genuine permission failure. Still
      // never blame the token for the rate limit; this honest copy describes
      // what's actually happening (private repo, missing scope, etc.).
      throw new Error('Forbidden — this repository may be private or require a token with appropriate scope');
    }

    if (response.status === 404) {
      throw new Error('Resource not found');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = {
      data: await response.json(),
      rateLimit: {
        remaining: parseInt(response.headers.get('x-ratelimit-remaining') || '0'),
        limit: parseInt(response.headers.get('x-ratelimit-limit') || '0'),
        reset: parseInt(response.headers.get('x-ratelimit-reset') || '0')
      }
    };

    if (useCache) {
      setCachedResponse(url, result, cacheTtlMs);
    }

    return result;
  } catch (error) {
    // AbortErrors come from `withManagedRequest` cancelling a superseded
    // request. Never retry — the caller intentionally cancelled.
    if (error && (error.name === 'AbortError' || signal?.aborted)) {
      throw error;
    }
    const isHttpError = error.message.startsWith('HTTP ') ||
      error.message.includes('Rate limit') ||
      error.message.includes('Resource not found') ||
      error.message.includes('Forbidden') ||
      error.message.includes('try again in');

    if (retries > 0 && !isHttpError) {
      const jitter = Math.random() * 100;
      await sleep(backoff + jitter);
      return fetchWithRetry(url, {
        ...options,
        retries: retries - 1,
        backoff: backoff * RETRY_CONFIG.BACKOFF_MULTIPLIER
      });
    }
    throw error;
  }
};

/**
 * Searches GitHub repositories with optional filters
 * @param {string} query - Search query string
 * @param {Object} [options={}] - Search options
 * @param {string} [options.language=''] - Filter by programming language
 * @param {number} [options.minStars=0] - Minimum star count filter
 * @param {string} [options.sort='stars'] - Sort field (stars, forks, updated)
 * @param {string} [options.order='desc'] - Sort order (asc, desc)
 * @param {number} [options.page=1] - Page number for pagination
 * @param {number} [options.perPage=30] - Results per page (max 100)
 * @returns {Promise<{data: {items: Array, total_count: number}, rateLimit: {remaining: number, limit: number, reset: number}}>}
 * @throws {Error} When API request fails after retries or rate limit exceeded
 */
export const searchRepositories = async (query, options = {}) => {
  const {
    language = '',
    minStars = 0,
    sort = 'stars',
    order = 'desc',
    page = 1,
    perPage = 30
  } = options;
  
  let q = query;
  if (language) q += `+language:${language}`;
  if (minStars > 0) q += `+stars:>=${minStars}`;
  
  const url = `${API_BASE}/search/repositories?q=${encodeURIComponent(q)}&sort=${sort}&order=${order}&page=${page}&per_page=${perPage}`;
  
  return fetchWithRetry(url);
};

/**
 * Fetches trending repositories created within the last 7 days
 * @param {Object} [options={}] - Filter options
 * @param {string} [options.language=''] - Filter by programming language
 * @param {string} [options.category='all'] - Filter by category (matches TRENDING_CATEGORIES keys)
 * @param {number} [options.page=1] - Page number for pagination
 * @param {number} [options.perPage=30] - Results per page (max 100)
 * @returns {Promise<{data: {items: Array, total_count: number}, rateLimit: {remaining: number, limit: number, reset: number}}>}
 * @throws {Error} When API request fails after retries
 */
export const getTrendingRepositories = async (options = {}) => {
  const {
    language = '',
    category = 'all',
    page = 1,
    perPage = 30
  } = options;
  
  const date = new Date();
  date.setDate(date.getDate() - TRENDING_DAYS_BACK);
  const dateStr = date.toISOString().split('T')[0];
  
  let q = `created:>${dateStr}`;
  
  if (language) {
    q += ` language:${language}`;
  }
  
  if (category && category !== 'all') {
    const categoryConfig = TRENDING_CATEGORIES[category];
    if (categoryConfig && categoryConfig.topics.length > 0) {
      const topicFilters = categoryConfig.topics.map(t => `topic:${t}`);
      q += ` (${topicFilters.join(' OR ')})`;
    }
  }
  
  const url = `${API_BASE}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&page=${page}&per_page=${perPage}`;
  
  return fetchWithRetry(url);
};

/**
 * Fetches detailed information for a single repository
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @returns {Promise<{data: Object, rateLimit: {remaining: number, limit: number, reset: number}}>}
 * @throws {Error} When repository not found or API request fails
 */
export const getRepository = async (owner, repo) => {
  const url = `${API_BASE}/repos/${owner}/${repo}`;
  return fetchWithRetry(url);
};

const decodeBase64Utf8 = (base64) => {
  const binary = atob(base64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
};

/**
 * Fetches and decodes the README file for a repository
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @returns {Promise<{data: {content: string, decodedContent: string, ...} | null, rateLimit: Object | null}>}
 */
export const getRepositoryReadme = async (owner, repo) => {
  try {
    const url = `${API_BASE}/repos/${owner}/${repo}/readme`;
    const response = await fetchWithRetry(url);
    
    if (response.data.content) {
      const decoded = decodeBase64Utf8(response.data.content);
      return { ...response, data: { ...response.data, decodedContent: decoded } };
    }
    
    return response;
  } catch (error) {
    if (error.message.includes('not found')) {
      return { data: null, rateLimit: null };
    }
    throw error;
  }
};

/**
 * Fetches programming language breakdown for a repository
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @returns {Promise<{data: Object<string, number>, rateLimit: {remaining: number, limit: number, reset: number}}>} Language names as keys, byte counts as values
 * @throws {Error} When API request fails
 */
export const getRepositoryLanguages = async (owner, repo) => {
  const url = `${API_BASE}/repos/${owner}/${repo}/languages`;
  return fetchWithRetry(url);
};

/**
 * Fetches recent events/activity for a repository
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @param {number} [perPage=10] - Number of events to fetch (max 100)
 * @returns {Promise<{data: Array, rateLimit: {remaining: number, limit: number, reset: number}}>}
 * @throws {Error} When API request fails
 */
export const getRepositoryEvents = async (owner, repo, perPage = 10) => {
  const url = `${API_BASE}/repos/${owner}/${repo}/events?per_page=${perPage}`;
  return fetchWithRetry(url);
};

/**
 * Checks current GitHub API rate limit status
 * @returns {Promise<{data: {resources: Object, rate: Object}, rateLimit: {remaining: number, limit: number, reset: number}}>}
 * @throws {Error} When API request fails
 */
export const checkRateLimit = async () => {
  const url = `${API_BASE}/rate_limit`;
  return fetchWithRetry(url);
};

/**
 * Shared helper for the three expensive GitHub stats endpoints.
 *
 * Routes the request through `fetchWithRetry` (so it shares the cache +
 * rate-limit discipline with the rest of the API layer), activates the longer
 * STATS_CACHE_TTL_MS, and treats 202 as an explicit "computing" state.
 *
 * On a 202 the request is retried ONCE after a short delay; if GitHub is still
 * computing, an honest `{ data: null, processing: true }` is returned — never
 * a fabricated number and never a default green (VC-DATA-03).
 *
 * @param {string} url
 * @param {boolean} [retryOnce=true]  Retry once on the first 202.
 * @returns {Promise<{data:*|null, processing:boolean, rateLimit:Object|null}>}
 */
const fetchStatsEndpoint = async (url, retryOnce = true) => {
  const statsOptions = {
    cacheTtlMs: STATS_CACHE_TTL_MS,
    acceptStatsProcessing: true
  };

  let result = await fetchWithRetry(url, statsOptions);

  if (result.processing && retryOnce) {
    await sleep(2000);
    result = await fetchWithRetry(url, statsOptions);
  }

  // Always return a normalized shape with an explicit processing flag.
  return { ...result, processing: Boolean(result.processing) };
};

/**
 * Fetches weekly commit activity for the past year (52 weeks)
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @param {boolean} [retryOnce=true] - Whether to retry once if GitHub returns 202 (processing)
 * @returns {Promise<{data: Array<{week: number, days: number[], total: number}> | null, processing: boolean, rateLimit: Object | null}>}
 * @throws {Error} When API request fails
 */
export const getCommitActivity = async (owner, repo, retryOnce = true) => {
  const url = `${API_BASE}/repos/${owner}/${repo}/stats/commit_activity`;
  return fetchStatsEndpoint(url, retryOnce);
};

/**
 * Fetches weekly participation stats (commit counts) for the last year
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @param {boolean} [retryOnce=true] - Whether to retry once if GitHub returns 202 (processing)
 * @returns {Promise<{data: {all: number[], owner: number[]} | null, processing: boolean, rateLimit: Object | null}>}
 * @throws {Error} When API request fails
 */
export const getParticipationStats = async (owner, repo, retryOnce = true) => {
  const url = `${API_BASE}/repos/${owner}/${repo}/stats/participation`;
  return fetchStatsEndpoint(url, retryOnce);
};

/**
 * Fetches contributor commit activity for a repository
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @param {boolean} [retryOnce=true] - Whether to retry once if GitHub returns 202 (processing)
 * @returns {Promise<{data: Array<{author: Object, total: number, weeks: Array}> | null, processing: boolean, rateLimit: Object | null}>}
 * @throws {Error} When API request fails
 */
export const getContributorStats = async (owner, repo, retryOnce = true) => {
  const url = `${API_BASE}/repos/${owner}/${repo}/stats/contributors`;
  return fetchStatsEndpoint(url, retryOnce);
};

/**
 * Strips pull requests out of a GitHub `/issues` payload.
 *
 * The REST `/issues` endpoint returns BOTH issues AND PRs — PRs surface there
 * carrying a `pull_request` field. Every issue count / temperature signal we
 * derive from this endpoint MUST exclude those PRs, otherwise PR traffic
 * silently inflates issue counts (VC-DATA-02). Pure function so it is reusable
 * and unit-testable in isolation.
 *
 * @param {Array} items - Raw array from `/issues`.
 * @returns {Array} A new array containing only items WITHOUT a `pull_request` field.
 */
export const filterIssuesOnly = (items) => {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => !(item && typeof item === 'object' && item.pull_request !== undefined));
};

/**
 * Fetches issues with created/closed timestamps for a repository.
 *
 * The GitHub `/issues` endpoint returns BOTH issues AND PRs (PRs carry a
 * `pull_request` field). PRs are filtered out here at the API layer so every
 * downstream consumer — issue temperature, pulse metrics, verdict signals —
 * sees real issues only (VC-DATA-02).
 *
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @param {Object} [params={}] - Optional query parameters to override defaults
 * @param {string} [params.state='all'] - Issue state filter (open, closed, all)
 * @param {string} [params.sort='created'] - Sort field (created, updated, comments)
 * @param {string} [params.direction='desc'] - Sort direction (asc, desc)
 * @param {number} [params.per_page=100] - Results per page (max 100)
 * @returns {Promise<{data: Array, rateLimit: {remaining: number, limit: number, reset: number}}>}
 * @throws {Error} When API request fails
 */
export const getIssueTimeline = async (owner, repo, params = {}) => {
  const query = new URLSearchParams({
    state: 'all',
    per_page: '100',
    sort: 'created',
    direction: 'desc',
    ...params
  });
  const url = `${API_BASE}/repos/${owner}/${repo}/issues?${query}`;
  const response = await fetchWithRetry(url);
  // VC-DATA-02: strip PRs at the source so no downstream count can ever see them.
  return { ...response, data: filterIssuesOnly(response.data) };
};

/**
 * Fetches pull requests with merge timestamps for a repository
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @param {Object} [params={}] - Optional query parameters to override defaults
 * @param {string} [params.state='all'] - PR state filter (open, closed, all)
 * @param {string} [params.sort='created'] - Sort field (created, updated, popularity, long-running)
 * @param {string} [params.direction='desc'] - Sort direction (asc, desc)
 * @param {number} [params.per_page=100] - Results per page (max 100)
 * @returns {Promise<{data: Array, rateLimit: {remaining: number, limit: number, reset: number}}>}
 * @throws {Error} When API request fails
 */
export const getPullRequestTimeline = async (owner, repo, params = {}) => {
  const query = new URLSearchParams({
    state: 'all',
    per_page: '100',
    sort: 'created',
    direction: 'desc',
    ...params
  });
  const url = `${API_BASE}/repos/${owner}/${repo}/pulls?${query}`;
  return fetchWithRetry(url);
};

/**
 * Fetches release history for a repository
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @param {number} [perPage=30] - Number of releases to fetch (max 100)
 * @returns {Promise<{data: Array, rateLimit: {remaining: number, limit: number, reset: number}}>}
 * @throws {Error} When API request fails
 */
export const getReleaseHistory = async (owner, repo, perPage = 30) => {
  const url = `${API_BASE}/repos/${owner}/${repo}/releases?per_page=${perPage}`;
  return fetchWithRetry(url);
};

/**
 * Fetches all pulse-related data for a repository in parallel
 * Uses Promise.allSettled for error resilience - failed endpoints return null
 * @param {string} owner - Repository owner's username
 * @param {string} repo - Repository name
 * @returns {Promise<{participation: Object|null, contributors: Array|null, issues: Array|null, pullRequests: Array|null, releases: Array|null, commits: Array|null}>}
 */
export const fetchPulseData = async (owner, repo) => {
  const results = await Promise.allSettled([
    getParticipationStats(owner, repo),
    getContributorStats(owner, repo),
    getIssueTimeline(owner, repo),
    getPullRequestTimeline(owner, repo),
    getReleaseHistory(owner, repo),
    getCommitActivity(owner, repo)
  ]);

  const extractData = (result) => {
    if (result.status === 'fulfilled' && result.value) {
      return result.value.data;
    }
    return null;
  };

  return {
    participation: extractData(results[0]),
    contributors: extractData(results[1]),
    issues: extractData(results[2]),
    pullRequests: extractData(results[3]),
    releases: extractData(results[4]),
    commits: extractData(results[5])
  };
};

/* -------------------------------------------------------------------------
 * Clone Check — Contents API (F1.2 / VC-CONTENTS-01).
 *
 * These calls fetch the files the verdict engine's differentiators need
 * (package.json → stack-fit, README → context, file tree → AI-readiness /
 * hasTests, AI-rules files → AI-readiness). They are OPT-IN: the headline
 * verdict is computed from at most 2 cheap calls and never calls these.
 * ------------------------------------------------------------------------- */

/**
 * Fetches, base64-decodes, and JSON-parses a repo's package.json.
 * Honest shape on absence — never throws on a missing or malformed file.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{data:Object|null, decodedContent:string|null, parsed:Object|null, rateLimit:Object|null}>}
 */
export const fetchPackageJson = async (owner, repo) => {
  try {
    const url = `${API_BASE}/repos/${owner}/${repo}/contents/package.json`;
    const response = await fetchWithRetry(url);

    if (response.data && response.data.content) {
      const decodedContent = decodeBase64Utf8(response.data.content);
      let parsed = null;
      try {
        parsed = JSON.parse(decodedContent);
      } catch {
        parsed = null;
      }
      return { data: response.data, decodedContent, parsed, rateLimit: response.rateLimit };
    }

    return { data: response.data, decodedContent: null, parsed: null, rateLimit: response.rateLimit };
  } catch (error) {
    if (error.message.includes('not found')) {
      return { data: null, decodedContent: null, parsed: null, rateLimit: null };
    }
    throw error;
  }
};

/**
 * Fetches and decodes a repo's README (Clone Check contents-tier name).
 * Thin wrapper over getRepositoryReadme preserving its honest null-on-missing
 * behavior. Returns `{ data: {...decodedContent} | null, rateLimit }`.
 *
 * @param {string} owner
 * @param {string} repo
 */
export const fetchReadme = async (owner, repo) => getRepositoryReadme(owner, repo);

/**
 * Fetches a repo's file tree — the root contents listing by default, or the
 * full recursive tree via the git/trees endpoint when `{ recursive: true }`.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {object} [options]
 * @param {boolean} [options.recursive=false]  Use git/trees/{defaultBranch}?recursive=1
 * @returns {Promise<{data:Array|Object, rateLimit:Object}>}
 * @throws {Error} When API request fails
 */
export const fetchFileTree = async (owner, repo, options = {}) => {
  const { recursive = false } = options;

  if (recursive) {
    // Resolve the default branch, then ask for the full recursive tree.
    // The cheap contents endpoint can't recurse; this costs 1 extra call but
    // is only used by opt-in differentiators (AI-readiness, hasTests).
    const repoRes = await getRepository(owner, repo);
    const branch = (repoRes.data && repoRes.data.default_branch) || 'HEAD';
    const url = `${API_BASE}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    return fetchWithRetry(url);
  }

  const url = `${API_BASE}/repos/${owner}/${repo}/contents`;
  return fetchWithRetry(url);
};

/**
 * Probes a repo for AI-rules files used by the AI-readiness differentiator.
 *
 * Checks CLAUDE.md, AGENTS.md, .cursorrules, and the .cursor directory. Found
 * files are decoded; absent ones are reported in `missing`. This is the honest
 * shape — no fabrication, no defaults.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{found:Array<{path:string, decodedContent:string|null, type:string}>, missing:string[]}>}
 */
export const fetchAiRulesFiles = async (owner, repo) => {
  const results = await Promise.allSettled(
    AI_RULES_CANDIDATES.map(async (path) => {
      const url = `${API_BASE}/repos/${owner}/${repo}/contents/${path}`;
      const response = await fetchWithRetry(url);
      // A directory listing comes back as an array (e.g. .cursor/).
      if (Array.isArray(response.data)) {
        const entries = response.data.map((e) => e && e.name).filter(Boolean);
        return { path, type: 'directory', decodedContent: null, entries };
      }
      const decodedContent = response.data && response.data.content
        ? decodeBase64Utf8(response.data.content)
        : null;
      return { path, type: 'file', decodedContent };
    })
  );

  const found = [];
  const missing = [];
  results.forEach((result, index) => {
    const path = AI_RULES_CANDIDATES[index];
    if (result.status === 'fulfilled') {
      found.push(result.value);
    } else {
      missing.push(path);
    }
  });

  return { found, missing };
};

/* -------------------------------------------------------------------------
 * Clone Check — Tiered data layer (F1.2 / VC-DATA-01, VC-DATA-05).
 *
 * The headline verdict is computed from AT MOST 2 cheap GitHub calls
 * (repo metadata + one commits-list call). Expensive stats endpoints
 * (participation / contributors / commit-activity) are opt-in only and never
 * fire on the initial headline render.
 * ------------------------------------------------------------------------- */

/**
 * Fetches a single page of the commit history (the second cheap call used to
 * compute the headline verdict).
 *
 * @param {string} owner
 * @param {string} repo
 * @param {number} [perPage=30]  Caps the page size (≤100 per GitHub).
 * @returns {Promise<{data:Array, rateLimit:Object}>}
 */
export const getCommitList = async (owner, repo, perPage = 30) => {
  const capped = Math.max(1, Math.min(100, perPage));
  const url = `${API_BASE}/repos/${owner}/${repo}/commits?per_page=${capped}`;
  return fetchWithRetry(url);
};

/**
 * Normalizes a raw GitHub repo-metadata object into the shape the pure verdict
 * engine expects. Honest about missing fields.
 */
const normalizeRepoMeta = (raw) => {
  if (!raw) return null;
  return {
    fullName: raw.full_name || raw.name || undefined,
    archived: Boolean(raw.archived),
    disabled: Boolean(raw.disabled),
    pushedAt: raw.pushed_at || raw.pushedAt || undefined,
    license: raw.license
      ? { key: raw.license.key, name: raw.license.name }
      : null
  };
};

/**
 * Fetches the CHEAP-tier data needed for the headline verdict:
 *   call 1: repo metadata        (getRepository)
 *   call 2: one commits-list page (getCommitList)
 *
 * This is the hard VC-DATA-01 gate: at most 2 GitHub calls before the headline
 * paints. It does NOT call contents, stats, contributors, or participation —
 * those are opt-in (fetchExpensiveStats / contents API).
 *
 * @param {string} owner
 * @param {string} repo
 * @param {object} [options]
 * @param {number} [options.commitPage=30]  per_page cap for the commits list.
 * @returns {Promise<{meta:Object|null, commits:Array, asOf:string}>}
 */
export const fetchHeadlineData = async (owner, repo, options = {}) => {
  const { commitPage = 30 } = options;

  const [repoRes, commitsRes] = await Promise.all([
    getRepository(owner, repo),
    getCommitList(owner, repo, commitPage)
  ]);

  return {
    meta: normalizeRepoMeta(repoRes.data),
    commits: Array.isArray(commitsRes.data) ? commitsRes.data : [],
    // The "as of" reference date injected into the pure verdict engine.
    // Read here in the data layer (the engine itself never reads a clock).
    asOf: new Date().toISOString()
  };
};

/**
 * Fetches the EXPENSIVE-tier stats — opt-in only, fired when the user opens
 * "show the receipts." Returns honest per-metric `{ data, processing }` shapes;
 * a `processing:true` or `data === null` result must render as an explicit
 * Unknown / computing state, never a fabricated number and never a default
 * green (VC-DATA-03, VC-DATA-05).
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{participation:{data:*,processing:boolean}|null, contributors:{data:*,processing:boolean}|null, commitActivity:{data:*,processing:boolean}|null}>}
 */
export const fetchExpensiveStats = async (owner, repo) => {
  const results = await Promise.allSettled([
    getParticipationStats(owner, repo),
    getContributorStats(owner, repo),
    getCommitActivity(owner, repo)
  ]);

  const normalize = (result) => {
    if (result.status !== 'fulfilled') return null;
    const value = result.value;
    if (!value) return null;
    return {
      data: value.data === undefined ? null : value.data,
      processing: Boolean(value.processing),
      rateLimit: value.rateLimit ?? null
    };
  };

  return {
    participation: normalize(results[0]),
    contributors: normalize(results[1]),
    commitActivity: normalize(results[2])
  };
};
