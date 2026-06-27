import { describe, it, expect } from 'vitest';
import { detectSlop } from '../engine/slopDetector.js';

/* =========================================================================
 * Clone Check — Slop Detector unit tests (F1.4 / VC-SLOP-01).
 *
 * The slop detector flags:
 *   - initial-commit-only history
 *   - no test suite detected
 *   - abandoned activity
 * …as likelihood-worded ("looks …") strings, NEVER as the asserted fact
 * "is slop". A squashed-history repo (single commit + real content) is
 * explicitly NOT flagged on commit count alone — the false-positive guard.
 *
 * Pure function: no DOM, no fetch, no Date.now.
 * ========================================================================= */

const AS_OF = '2025-06-27';

/** A healthy repo: many commits, has tests, recently pushed. */
function healthyRepo(overrides = {}) {
  return {
    asOf: AS_OF,
    meta: {
      pushedAt: '2025-06-10', // 17 days before AS_OF → active
      archived: false,
      disabled: false
    },
    commits: [
      { sha: 'a', date: '2025-06-10', author: { login: 'alice' } },
      { sha: 'b', date: '2025-05-20', author: { login: 'bob' } },
      { sha: 'c', date: '2025-04-12', author: { login: 'alice' } },
      { sha: 'd', date: '2025-03-01', author: { login: 'carol' } }
    ],
    contents: {
      hasTests: true,
      aiRulesFiles: ['CLAUDE.md'],
      packageJson: { dependencies: { next: '^14' } },
      readme: '# Healthy\n\nA real starter.'
    },
    ...overrides
  };
}

/** A slop fixture: one commit + no tests + abandoned. */
function slopRepo(overrides = {}) {
  return {
    asOf: AS_OF,
    meta: {
      pushedAt: '2024-01-01', // ~900 days before AS_OF → abandoned
      archived: false,
      disabled: false
    },
    commits: [{ sha: 'only', date: '2024-01-01', author: { login: 'rando' } }],
    contents: {
      hasTests: false,
      aiRulesFiles: [],
      packageJson: null,
      readme: '# repo'
    },
    ...overrides
  };
}

/** A squashed-history fixture: one commit, but real content + tests + active. */
function squashedRepo(overrides = {}) {
  return {
    asOf: AS_OF,
    meta: {
      pushedAt: '2025-06-15', // active
      archived: false,
      disabled: false
    },
    commits: [{ sha: 'squashed', date: '2025-06-15', author: { login: 'team' } }],
    contents: {
      hasTests: true,
      aiRulesFiles: ['AGENTS.md'],
      packageJson: { dependencies: { next: '^14', react: '^18' } },
      readme:
        '# Real Starter\n\n## Install\n\n```bash\nnpm install\n```\n\n## Usage\n\nLong docs.'
    },
    ...overrides
  };
}

/* -------------------------------------------------------------------------
 * Purity / shape
 * ------------------------------------------------------------------------- */
describe('slop detector — purity & shape', () => {
  it('is deterministic — byte-identical output across calls for the same input', () => {
    const repo = slopRepo();
    const a = detectSlop(repo);
    const b = detectSlop(repo);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the input', () => {
    const repo = slopRepo();
    const snapshot = JSON.stringify(repo);
    detectSlop(repo);
    expect(JSON.stringify(repo)).toBe(snapshot);
  });

  it('returns a record with state + label + reasons array', () => {
    const result = detectSlop(slopRepo());
    expect(result).toHaveProperty('state');
    expect(result).toHaveProperty('label');
    expect(Array.isArray(result.reasons)).toBe(true);
  });

  it('handles null/undefined input without throwing', () => {
    expect(() => detectSlop(undefined)).not.toThrow();
    expect(() => detectSlop(null)).not.toThrow();
    expect(detectSlop(null).state).toBe('unknown');
  });
});

/* -------------------------------------------------------------------------
 * VC-SLOP-01 — slop fixture is flagged with likelihood wording
 * ------------------------------------------------------------------------- */
describe('VC-SLOP-01 — slop fixture flagged with likelihood wording', () => {
  it('flags a slop fixture (1 commit + no tests + abandoned) as flagged', () => {
    const result = detectSlop(slopRepo());
    expect(result.state).toBe('flagged');
  });

  it('uses "looks" framing — never asserts "is slop"', () => {
    const result = detectSlop(slopRepo());
    expect(result.label.toLowerCase()).toContain('looks');
    expect(result.label.toLowerCase()).not.toContain('is slop');
  });

  it('includes "initial-commit-only" framing in the slop reasons', () => {
    const result = detectSlop(slopRepo());
    const joined = result.reasons.join(' ').toLowerCase();
    expect(joined).toContain('initial-commit-only');
  });

  it('includes "no test" framing in the slop reasons', () => {
    const result = detectSlop(slopRepo());
    const joined = result.reasons.join(' ').toLowerCase();
    expect(joined).toMatch(/no test/);
  });

  it('includes "abandoned" framing in the slop reasons', () => {
    const result = detectSlop(slopRepo());
    const joined = result.reasons.join(' ').toLowerCase();
    expect(joined).toContain('abandoned');
  });

  it('never asserts slop as a fact anywhere in its output', () => {
    const result = detectSlop(slopRepo());
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain('"is slop"');
    expect(serialized).not.toMatch(/"state"\s*:\s*"slop"/);
  });
});

/* -------------------------------------------------------------------------
 * VC-SLOP-01 — false-positive guard: squashed history NOT flagged
 * ------------------------------------------------------------------------- */
describe('VC-SLOP-01 — squashed-history false-positive guard', () => {
  it('does NOT flag a single-commit repo that otherwise looks real', () => {
    const result = detectSlop(squashedRepo());
    expect(result.state).toBe('clean');
  });

  it('returns the clean label for a squashed repo', () => {
    const result = detectSlop(squashedRepo());
    expect(result.label).toMatch(/no signals detected/i);
    expect(result.reasons).toEqual([]);
  });

  it('a squashed repo with a sparse README but tests + active is still NOT flagged', () => {
    // The guard is specifically about commit COUNT alone — even if README is
    // short, having tests + recent activity disqualifies the slop signal.
    const result = detectSlop(
      squashedRepo({ contents: { ...squashedRepo().contents, readme: '# short' } })
    );
    expect(result.state).toBe('clean');
  });

  it('flags a single-commit repo ONLY when another slop signal corroborates', () => {
    // Single commit + no tests (no other positive signal) → still flagged,
    // because the no-tests reason is independent of commit count.
    const result = detectSlop(
      squashedRepo({ contents: { ...squashedRepo().contents, hasTests: false } })
    );
    expect(result.state).toBe('flagged');
    expect(result.label.toLowerCase()).toContain('looks');
  });

  it('commit count alone NEVER contributes a reason without corroboration', () => {
    // Single commit + has tests + active → no reasons at all.
    const result = detectSlop(squashedRepo());
    expect(result.reasons).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * Signal coverage — combinations
 * ------------------------------------------------------------------------- */
describe('slop detector — signal combinations', () => {
  it('returns "unknown" when commit history is missing entirely', () => {
    const result = detectSlop({ ...healthyRepo(), commits: undefined });
    expect(result.state).toBe('unknown');
    expect(result.label).toMatch(/unknown/i);
  });

  it('returns "unknown" for an empty commits array', () => {
    const result = detectSlop({ ...healthyRepo(), commits: [] });
    expect(result.state).toBe('unknown');
  });

  it('flags a multi-commit repo with no tests (independent signal)', () => {
    const repo = healthyRepo({ contents: { ...healthyRepo().contents, hasTests: false } });
    const result = detectSlop(repo);
    expect(result.state).toBe('flagged');
    expect(result.label.toLowerCase()).toContain('looks');
  });

  it('flags a multi-commit repo that is abandoned', () => {
    const repo = healthyRepo({ meta: { ...healthyRepo().meta, pushedAt: '2023-01-01' } });
    const result = detectSlop(repo);
    expect(result.state).toBe('flagged');
    expect(result.label.toLowerCase()).toContain('abandoned');
  });

  it('returns "clean" for a healthy repo with no signals', () => {
    const result = detectSlop(healthyRepo());
    expect(result.state).toBe('clean');
    expect(result.label).toMatch(/no signals detected/i);
  });

  it('is not affected by archived state (maintenance handles that via verdict)', () => {
    // Archived alone (with multi-commit history + tests) is NOT a slop signal
    // — the maintenance classifier in verdict.js handles archived → Skip it.
    const repo = healthyRepo({ meta: { ...healthyRepo().meta, archived: true } });
    const result = detectSlop(repo);
    expect(result.state).toBe('clean');
  });

  it('treats missing contents.hasTests as "unknown tests" — never a no-tests flag', () => {
    // If we cannot determine test presence, do NOT raise a no-tests reason.
    const repo = healthyRepo({ contents: undefined });
    const result = detectSlop(repo);
    expect(result.state).toBe('clean');
    expect(result.reasons.some((r) => /no test/i.test(r))).toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Wording discipline (VC-ENGINE-05 alignment)
 * ------------------------------------------------------------------------- */
describe('slop detector — likelihood wording', () => {
  it('every reason phrase uses likelihood framing (looks …)', () => {
    const result = detectSlop(slopRepo());
    for (const reason of result.reasons) {
      expect(reason.toLowerCase()).toContain('looks');
    }
  });

  it('label is built by joining the reasons with the "slop: " prefix', () => {
    const result = detectSlop(slopRepo());
    expect(result.label.startsWith('slop:')).toBe(true);
  });

  it('never contains the asserted string "is slop"', () => {
    const inputs = [slopRepo(), squashedRepo(), healthyRepo(), null, undefined, {}];
    for (const input of inputs) {
      const result = detectSlop(input);
      expect(JSON.stringify(result).toLowerCase()).not.toContain('is slop');
    }
  });
});
