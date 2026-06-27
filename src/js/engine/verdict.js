/**
 * Clone Check — Pure Verdict Engine.
 *
 * This module is the single source of truth for the four-state "should I clone
 * this starter?" verdict. It is a PURE FUNCTION module:
 *
 *   - Zero DOM access (no browser globals touched).
 *   - Zero network I/O. All data is supplied by the caller.
 *   - Zero clock reads. The current date is injected via the
 *     `asOf` field on the input, which keeps the function deterministic.
 *
 * Hard product invariants encoded here (asserted in verdict.test.js):
 *
 *   VC-ENGINE-01 — Pure & deterministic: identical input → byte-identical output.
 *   VC-ENGINE-02 — Never positive on missing data. Any unknown headline signal
 *                  forces `Not enough signal`.
 *   VC-ENGINE-03 — Never asserts the safety word; the max positive label is the four
 *                  canonical states below.
 *   VC-ENGINE-04 — Exactly four states; no bare 0–100 numeric score field.
 *   VC-ENGINE-05 — Gameable signals (slop, AI-ready) worded as likelihoods.
 *   VC-ENGINE-06 — Dated `heuristic check, not a security audit` disclaimer
 *                  on every verdict shape.
 */

/* -------------------------------------------------------------------------
 * Four-state enum (frozen — the only verdict values that exist).
 * ------------------------------------------------------------------------- */

export const VERDICT_STATES = Object.freeze({
  LOOKS_CLONEABLE: 'Looks clone-able',
  CLONE_WITH_CARE: 'Clone with care',
  SKIP_IT: 'Skip it',
  NOT_ENOUGH_SIGNAL: 'Not enough signal'
});

/* -------------------------------------------------------------------------
 * Disclaimer body — the canonical phrase carried on every verdict shape.
 * ------------------------------------------------------------------------- */

const DISCLAIMER_BODY = 'heuristic check, not a security audit — verify before you ship';

/* -------------------------------------------------------------------------
 * Signal taxonomy & thresholds.
 *
 * `daysSince` is computed against the caller-injected `asOf` date — never
 * against a caller-injected date, which keeps the engine deterministic.
 * ------------------------------------------------------------------------- */

const MAINTENANCE = Object.freeze({
  ACTIVE_MAX_DAYS: 90, // pushed within 90d  → active
  STALE_MAX_DAYS: 365, // pushed within 365d → stale (cautionary)
  // pushed > 365d ago   → abandoned (skip-worthy)
});

const PERMISSIVE_LICENSES = Object.freeze(new Set([
  'mit', 'apache-2.0', 'isc', 'bsd-2-clause', 'bsd-3-clause',
  '0bsd', 'unlicense', 'mpl-2.0', 'cc0-1.0'
]));

const COPYLEFT_LICENSES = Object.freeze(new Set([
  'gpl-2.0', 'gpl-3.0', 'lgpl-2.1', 'lgpl-3.0', 'agpl-3.0', 'sspl-1.0'
]));

/* -------------------------------------------------------------------------
 * Small pure helpers
 * ------------------------------------------------------------------------- */

/**
 * Parse an ISO date string into epoch ms, or `null` if unparseable / missing.
 * Uses `Date.parse` (a pure data-in/data-out transform — no clock read).
 * @param {string|undefined} iso
 * @returns {number|null}
 */
function parseEpoch(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Whole-day difference between two epoch-ms values. */
function dayDiff(laterMs, earlierMs) {
  return Math.floor((laterMs - earlierMs) / (24 * 60 * 60 * 1000));
}

/**
 * Build the dated disclaimer. The date is supplied by the caller (`asOf`),
 * never read from a clock. If `asOf` is missing, we surface an honest
 * "date unknown" — the disclaimer is still present and still dated in shape.
 * @param {string|undefined} asOf ISO date supplied by caller.
 * @returns {string}
 */
function buildDisclaimer(asOf) {
  const iso = typeof asOf === 'string' && asOf.length > 0 ? asOf : null;
  const datePart = iso ? iso.split('T')[0] : 'date unknown';
  return `${DISCLAIMER_BODY} (as of ${datePart})`;
}

/* -------------------------------------------------------------------------
 * Headline signal classifiers.
 *
 * Each returns a record `{ state, label }`:
 *   - `state` is one of a small classifier-local vocabulary (e.g. 'active',
 *     'stale', 'abandoned', 'archived', 'unknown').
 *   - `label` is the plain-English sentence used in `trustInWords`.
 * ------------------------------------------------------------------------- */

/** @param {object|null} meta @param {string|undefined} asOf */
function classifyMaintenance(meta, asOf) {
  if (!meta) return { state: 'unknown', label: 'maintenance: unknown' };
  if (meta.archived) return { state: 'archived', label: 'maintenance: repo is archived' };
  if (meta.disabled) return { state: 'archived', label: 'maintenance: repo is disabled' };

  const pushed = parseEpoch(meta.pushedAt);
  const ref = parseEpoch(asOf);
  if (pushed === null || ref === null) {
    return { state: 'unknown', label: 'maintenance: unknown' };
  }
  const days = dayDiff(ref, pushed);
  if (days < 0) {
    // pushed after the reference date — treat as active (clock skew).
    return { state: 'active', label: 'maintenance: actively pushed' };
  }
  if (days <= MAINTENANCE.ACTIVE_MAX_DAYS) {
    return { state: 'active', label: 'maintenance: actively pushed' };
  }
  if (days <= MAINTENANCE.STALE_MAX_DAYS) {
    return { state: 'stale', label: 'maintenance: stale (no recent push)' };
  }
  return { state: 'abandoned', label: 'maintenance: looks abandoned (no push in over a year)' };
}

/** @param {object|null} meta */
function classifyLicense(meta) {
  if (!meta || !meta.license) return { state: 'unknown', label: 'license: unknown' };
  const key = String(meta.license.key || '').toLowerCase();
  if (!key) return { state: 'unknown', label: 'license: unknown' };
  if (PERMISSIVE_LICENSES.has(key)) {
    return { state: 'permissive', label: `license: ${meta.license.name || key} (permissive)` };
  }
  if (COPYLEFT_LICENSES.has(key)) {
    return { state: 'copyleft', label: `license: ${meta.license.name || key} (copyleft — check obligations)` };
  }
  return { state: 'other', label: `license: ${meta.license.name || key} (review before use)` };
}

/** @param {Array<{login:string,contributions:number}>|undefined} contributors */
function classifyBusFactor(contributors) {
  if (!Array.isArray(contributors) || contributors.length === 0) {
    return { state: 'unknown', label: 'bus factor: unknown' };
  }
  if (contributors.length === 1) {
    return { state: 'fragile', label: 'bus factor: fragile (single contributor)' };
  }
  return { state: 'healthy', label: `bus factor: healthy (${contributors.length} contributors)` };
}

/**
 * Slop classifier. Uses likelihood wording only ("looks …", never "is slop").
 *
 * Signals considered:
 *   - single-commit (initial-commit-only) history
 *   - no test suite detected
 *   - note: a squashed-history repo with real content is NOT flagged on
 *     commit count alone (false-positive guard for F1.4 / VC-SLOP-01).
 *
 * @param {Array|undefined} commits
 * @param {object|null} contents
 */
function classifySlop(commits, contents) {
  if (!Array.isArray(commits) || commits.length === 0) {
    return { state: 'unknown', label: 'slop: unknown (no commit history)' };
  }

  const reasons = [];
  if (commits.length === 1) {
    reasons.push('looks like initial-commit-only history');
  }
  if (contents && contents.hasTests === false) {
    reasons.push('looks like it has no test suite');
  }

  if (reasons.length === 0) {
    return { state: 'clean', label: 'slop: no signals detected' };
  }
  // Join likelihood clauses; never assert as fact.
  return { state: 'flagged', label: `slop: ${reasons.join('; ')}` };
}

/**
 * AI-readiness classifier. Likelihood wording only.
 * @param {object|null} contents
 */
function classifyAiReady(contents) {
  if (!contents) {
    return 'AI-readiness: unknown (no contents data)';
  }
  const files = Array.isArray(contents.aiRulesFiles) ? contents.aiRulesFiles : [];
  if (files.length > 0) {
    const list = files.slice(0, 3).join(', ');
    return `AI-readiness: has ${list} — likely agent-friendly`;
  }
  return 'AI-readiness: no AI-rules files detected — agent may need more context';
}

/* -------------------------------------------------------------------------
 * Verdict-object field builders
 * ------------------------------------------------------------------------- */

function buildWhatThisIs(meta, state) {
  const name = (meta && meta.fullName) || 'this repo';
  const summaries = {
    [VERDICT_STATES.LOOKS_CLONEABLE]:
      `${name} looks clone-able: the headline signals we check (maintenance, license, bus factor, history shape) all read favorably.`,
    [VERDICT_STATES.CLONE_WITH_CARE]:
      `${name} is clone-able with care: at least one headline signal is cautionary, so review before relying on it.`,
    [VERDICT_STATES.SKIP_IT]:
      `${name} is probably worth skipping: at least one headline signal is strongly negative.`,
    [VERDICT_STATES.NOT_ENOUGH_SIGNAL]:
      `${name} cannot be graded yet: we are missing one or more required headline signals, so we will not assert a positive verdict.`
  };
  return summaries[state] || summaries[VERDICT_STATES.NOT_ENOUGH_SIGNAL];
}

/** @param {{maintenance:object,license:object,busFactor:object,slop:object}} signals */
function buildTrustInWords(signals) {
  return {
    maintenance: signals.maintenance.label,
    license: signals.license.label,
    busFactor: signals.busFactor.label,
    slop: signals.slop.label
  };
}

/* -------------------------------------------------------------------------
 * The pure verdict function.
 *
 * @param {object|null|undefined} repoData
 *   @property {string}              [asOf]         ISO date — caller injects.
 *   @property {object}              [meta]         repo metadata
 *   @property {Array}               [commits]      commit history
 *   @property {Array}               [contributors] contributor list
 *   @property {object}              [contents]     README / package.json / files
 * @returns {object} Verdict object (see README/contract).
 * ------------------------------------------------------------------------- */
export function verdict(repoData) {
  // Defensively normalize null/undefined inputs into a stable empty shape so
  // the function is total and byte-identical for `verdict(null)` and
  // `verdict(undefined)`.
  const data = repoData || {};
  const { asOf, meta, commits, contributors, contents } = data;

  // --- classify the four headline signals ---------------------------------
  const maintenance = classifyMaintenance(meta, asOf);
  const license = classifyLicense(meta);
  const busFactor = classifyBusFactor(contributors);
  const slop = classifySlop(commits, contents);
  const signals = { maintenance, license, busFactor, slop };

  // --- resolve the verdict state ------------------------------------------
  const anyUnknown = Object.values(signals).some((s) => s.state === 'unknown');

  let state;
  if (anyUnknown) {
    state = VERDICT_STATES.NOT_ENOUGH_SIGNAL;
  } else {
    const skipWorthy =
      maintenance.state === 'abandoned' ||
      maintenance.state === 'archived';
    if (skipWorthy) {
      state = VERDICT_STATES.SKIP_IT;
    } else {
      const cautionary =
        maintenance.state === 'stale' ||
        license.state === 'copyleft' ||
        license.state === 'other' ||
        busFactor.state === 'fragile' ||
        slop.state === 'flagged';
      state = cautionary ? VERDICT_STATES.CLONE_WITH_CARE : VERDICT_STATES.LOOKS_CLONEABLE;
    }
  }

  // --- assemble the verdict object ----------------------------------------
  return {
    state,
    whatThisIs: buildWhatThisIs(meta, state),
    trustInWords: buildTrustInWords(signals),
    aiReady: classifyAiReady(contents),
    slop: slop.label,
    disclaimer: buildDisclaimer(asOf),
    // Raw signal states for downstream consumers (MCP receipts, web receipts).
    // Deliberately NO numeric 0–100 score field for in-app display (VC-ENGINE-04).
    signals: {
      maintenance: maintenance.state,
      license: license.state,
      busFactor: busFactor.state,
      slop: slop.state
    }
  };
}

export default verdict;
