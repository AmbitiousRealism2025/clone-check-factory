/**
 * Clone Check — Slop Detector (F1.4 / VC-SLOP-01).
 *
 * Pure function. Flags repos that "look like" AI-generated slop or throwaway
 * starters using LIKELIHOOD WORDING ONLY ("looks …", never "is slop").
 *
 * Signals considered:
 *   - initial-commit-only history (single-commit repo)
 *   - no test suite detected
 *   - abandoned activity (no push in over a year)
 *
 * Squashed-history false-positive guard (the crux of VC-SLOP-01):
 *   A repo with squashed history (a single squashed commit) but otherwise
 *   real content (tests, recent activity) is explicitly NOT flagged on
 *   commit count alone. The single-commit signal only contributes a reason
 *   when at least one OTHER independent signal corroborates the slop
 *   hypothesis.
 *
 * Pure: zero DOM access, zero network I/O, zero clock reads — the `asOf`
 * reference date is injected by the caller.
 */

/* -------------------------------------------------------------------------
 * Thresholds (kept here so the detector is self-contained and pure).
 * The abandoned threshold intentionally mirrors the verdict engine's
 * maintenance classifier so the two signals agree.
 * ------------------------------------------------------------------------- */

const ABANDONED_MAX_DAYS = 365; // pushed > 365d ago → abandoned

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
 * Independent "abandoned" check (independent of commit count).
 * @param {object|null|undefined} meta
 * @param {string|undefined} asOf
 * @returns {boolean}
 */
function isAbandoned(meta, asOf) {
  if (!meta) return false;
  const pushed = parseEpoch(meta.pushedAt);
  const ref = parseEpoch(asOf);
  if (pushed === null || ref === null) return false;
  return dayDiff(ref, pushed) > ABANDONED_MAX_DAYS;
}

/* -------------------------------------------------------------------------
 * The pure slop detector.
 *
 * @param {object|null|undefined} input
 *   @property {Array}               [commits]   commit history
 *   @property {object}              [contents]  mustered contents (hasTests, …)
 *   @property {object}              [meta]      repo metadata (pushedAt, …)
 *   @property {string}              [asOf]      caller-injected reference date
 * @returns {{state:'flagged'|'clean'|'unknown', label:string, reasons:string[]}}
 * ------------------------------------------------------------------------- */
export function detectSlop(input) {
  const data = input || {};
  const { commits, contents, meta, asOf } = data;

  if (!Array.isArray(commits) || commits.length === 0) {
    return {
      state: 'unknown',
      label: 'slop: unknown (no commit history)',
      reasons: []
    };
  }

  const singleCommitOnly = commits.length === 1;
  const noTests = contents && contents.hasTests === false;
  const abandoned = isAbandoned(meta, asOf);

  // Independent corroborating signals (NOT commit count).
  // Each uses "looks …" likelihood wording.
  const reasons = [];
  if (noTests) {
    reasons.push('looks like it has no test suite');
  }
  if (abandoned) {
    reasons.push('looks abandoned (no push in over a year)');
  }

  // Squashed-history false-positive guard:
  // The single-commit signal contributes ONLY when another independent
  // signal corroborates. A real repo that happens to have a squashed
  // history (1 commit + tests + recent activity) is NOT flagged.
  if (singleCommitOnly && reasons.length > 0) {
    reasons.unshift('looks like initial-commit-only history');
  }

  if (reasons.length === 0) {
    return {
      state: 'clean',
      label: 'slop: no signals detected',
      reasons: []
    };
  }

  return {
    state: 'flagged',
    label: `slop: ${reasons.join('; ')}`,
    reasons
  };
}

export default detectSlop;
