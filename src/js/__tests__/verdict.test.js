import { describe, it, expect } from 'vitest';
import { verdict, VERDICT_STATES } from '../engine/verdict.js';

/* =========================================================================
 * Clone Check — Pure Verdict Engine unit tests.
 *
 * Covers validation-contract assertions VC-ENGINE-01 .. VC-ENGINE-06:
 *   01 — verdict() is a pure function (byte-identical output, no DOM/fetch)
 *   02 — never positive on missing data
 *   03 — no safety-guarantee language (never "Safe")
 *   04 — four explicit states, no bare 0–100 score
 *   05 — gameable signals worded as likelihoods
 *   06 — dated heuristic disclaimer on every verdict shape
 * ========================================================================= */

/* --------- shared fixtures (deterministic, no Date.now) ------------------ */

const AS_OF = '2025-06-27';

/** A repo that satisfies every headline signal — the only valid input
 *  that should yield the positive `Looks clone-able` state. */
function greenRepo(overrides = {}) {
  return {
    asOf: AS_OF,
    meta: {
      fullName: 'owner/healthy-repo',
      description: 'A well-maintained starter.',
      pushedAt: '2025-06-10', // 17 days before AS_OF → active
      createdAt: '2023-01-01',
      license: { key: 'mit', name: 'MIT License' },
      archived: false,
      disabled: false,
      stars: 1200,
      forks: 80
    },
    commits: [
      { sha: 'a', date: '2025-06-10', author: { login: 'alice' } },
      { sha: 'b', date: '2025-05-20', author: { login: 'bob' } },
      { sha: 'c', date: '2025-04-12', author: { login: 'alice' } },
      { sha: 'd', date: '2025-03-01', author: { login: 'carol' } }
    ],
    contributors: [
      { login: 'alice', contributions: 60 },
      { login: 'bob', contributions: 25 },
      { login: 'carol', contributions: 15 }
    ],
    contents: {
      readme: '# Healthy Repo\n\nA solid starter with docs.',
      packageJson: { dependencies: { next: '^14' } },
      hasTests: true,
      aiRulesFiles: ['CLAUDE.md']
    },
    ...overrides
  };
}

/** Strip a deep-clone of repo, deleting one branch by key path. */
function without(repo, ...paths) {
  const clone = JSON.parse(JSON.stringify(repo));
  for (const path of paths) {
    const parts = path.split('.');
    let cursor = clone;
    for (let i = 0; i < parts.length - 1; i++) cursor = cursor[parts[i]];
    delete cursor[parts[parts.length - 1]];
  }
  return clone;
}

/* =========================================================================
 * VC-ENGINE-01 — verdict() is a pure function
 * ========================================================================= */
describe('VC-ENGINE-01 — purity & determinism', () => {
  it('returns byte-identical output for identical input across many calls', () => {
    const repo = greenRepo();
    const a = verdict(repo);
    const b = verdict(repo);
    const c = verdict(repo);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(b)).toBe(JSON.stringify(c));
  });

  it('does not mutate the input repo object', () => {
    const repo = greenRepo();
    const snapshot = JSON.stringify(repo);
    verdict(repo);
    verdict(repo);
    expect(JSON.stringify(repo)).toBe(snapshot);
  });

  it('produces equal output for two structurally-identical (deep-cloned) inputs', () => {
    const a = verdict(greenRepo());
    const b = verdict(JSON.parse(JSON.stringify(greenRepo())));
    expect(a).toEqual(b);
  });

  it('returns a verdict object for null/undefined input without throwing', () => {
    expect(() => verdict(null)).not.toThrow();
    expect(() => verdict(undefined)).not.toThrow();
    expect(verdict(null).state).toBe(VERDICT_STATES.NOT_ENOUGH_SIGNAL);
  });
});

/* =========================================================================
 * VC-ENGINE-02 — never positive on missing data
 * ========================================================================= */
describe('VC-ENGINE-02 — never positive on missing headline signals', () => {
  it('cannot be Looks clone-able when maintenance signal is missing', () => {
    const repo = without(greenRepo(), 'meta.pushedAt');
    expect(verdict(repo).state).not.toBe(VERDICT_STATES.LOOKS_CLONEABLE);
  });

  it('cannot be Looks clone-able when license is null', () => {
    const repo = greenRepo({ meta: { ...greenRepo().meta, license: null } });
    expect(verdict(repo).state).not.toBe(VERDICT_STATES.LOOKS_CLONEABLE);
  });

  it('cannot be Looks clone-able when contributors are missing', () => {
    const repo = without(greenRepo(), 'contributors');
    expect(verdict(repo).state).not.toBe(VERDICT_STATES.LOOKS_CLONEABLE);
  });

  it('cannot be Looks clone-able when commits are missing', () => {
    const repo = without(greenRepo(), 'commits');
    expect(verdict(repo).state).not.toBe(VERDICT_STATES.LOOKS_CLONEABLE);
  });

  it('returns Not enough signal when ANY single headline signal is missing', () => {
    const cases = [
      without(greenRepo(), 'meta.pushedAt'),
      greenRepo({ meta: { ...greenRepo().meta, license: null } }),
      without(greenRepo(), 'contributors'),
      without(greenRepo(), 'commits')
    ];
    for (const repo of cases) {
      expect(verdict(repo).state).toBe(VERDICT_STATES.NOT_ENOUGH_SIGNAL);
    }
  });

  it('returns Not enough signal when pushedAt is unparseable', () => {
    const repo = greenRepo({ meta: { ...greenRepo().meta, pushedAt: 'not-a-date' } });
    expect(verdict(repo).state).toBe(VERDICT_STATES.NOT_ENOUGH_SIGNAL);
  });

  it('does not reach Looks clone-able with an empty commits array', () => {
    const repo = greenRepo({ commits: [] });
    expect(verdict(repo).state).not.toBe(VERDICT_STATES.LOOKS_CLONEABLE);
  });
});

/* =========================================================================
 * VC-ENGINE-03 — no safety-guarantee language
 * ========================================================================= */
describe('VC-ENGINE-03 — never asserts "Safe"', () => {
  /** Sweep a wide variety of inputs and collect every verdict shape. */
  function allVerdictShapes() {
    const inputs = [
      null,
      undefined,
      {},
      greenRepo(),
      without(greenRepo(), 'meta.pushedAt'),
      greenRepo({ meta: { ...greenRepo().meta, license: null } }),
      without(greenRepo(), 'contributors'),
      without(greenRepo(), 'commits'),
      greenRepo({ meta: { ...greenRepo().meta, archived: true } }),
      greenRepo({ meta: { ...greenRepo().meta, pushedAt: '2023-01-01' } }), // abandoned
      greenRepo({ meta: { ...greenRepo().meta, license: { key: 'gpl-3.0', name: 'GNU GPLv3' } } }),
      greenRepo({ contributors: [{ login: 'solo', contributions: 100 }] }),
      greenRepo({ commits: [{ sha: 'x', date: '2025-06-10', author: { login: 'alice' } }] }),
      greenRepo({ contents: { ...greenRepo().contents, hasTests: false } })
    ];
    return inputs.map((i) => verdict(i));
  }

  it('never emits the string "Safe" as a verdict state value', () => {
    for (const v of allVerdictShapes()) {
      expect(v.state).not.toBe('Safe');
      expect(v.state).not.toContain('Safe');
    }
  });

  it('never emits "Safe to clone" anywhere in serialized output', () => {
    for (const v of allVerdictShapes()) {
      const serialized = JSON.stringify(v);
      expect(serialized).not.toContain('Safe to clone');
      expect(serialized).not.toMatch(/"state"\s*:\s*"Safe/i);
    }
  });

  it('exposes only the four canonical state constants', () => {
    const values = Object.values(VERDICT_STATES);
    expect(values).toEqual(
      expect.arrayContaining([
        'Looks clone-able',
        'Clone with care',
        'Skip it',
        'Not enough signal'
      ])
    );
    expect(values).toHaveLength(4);
    expect(values.some((s) => s === 'Safe')).toBe(false);
  });
});

/* =========================================================================
 * VC-ENGINE-04 — four explicit states, no bare in-app score
 * ========================================================================= */
describe('VC-ENGINE-04 — four states & no bare score', () => {
  it('produces Looks clone-able on a fully-green repo', () => {
    expect(verdict(greenRepo()).state).toBe(VERDICT_STATES.LOOKS_CLONEABLE);
  });

  it('produces Skip it on an archived repo', () => {
    const repo = greenRepo({ meta: { ...greenRepo().meta, archived: true } });
    expect(verdict(repo).state).toBe(VERDICT_STATES.SKIP_IT);
  });

  it('produces Skip it on an abandoned repo (pushed > 365 days ago)', () => {
    const repo = greenRepo({ meta: { ...greenRepo().meta, pushedAt: '2023-01-01' } });
    expect(verdict(repo).state).toBe(VERDICT_STATES.SKIP_IT);
  });

  it('produces Clone with care on a copyleft license', () => {
    const repo = greenRepo({
      meta: { ...greenRepo().meta, license: { key: 'gpl-3.0', name: 'GNU GPLv3' } }
    });
    expect(verdict(repo).state).toBe(VERDICT_STATES.CLONE_WITH_CARE);
  });

  it('produces Clone with care on a fragile bus factor (single contributor)', () => {
    const repo = greenRepo({ contributors: [{ login: 'solo', contributions: 100 }] });
    expect(verdict(repo).state).toBe(VERDICT_STATES.CLONE_WITH_CARE);
  });

  it('produces Not enough signal when a required signal is missing', () => {
    const repo = without(greenRepo(), 'meta.pushedAt');
    expect(verdict(repo).state).toBe(VERDICT_STATES.NOT_ENOUGH_SIGNAL);
  });

  it('does not expose a bare 0–100 numeric score field for in-app display', () => {
    const v = verdict(greenRepo());
    // No top-level score field of any common spelling.
    expect(v).not.toHaveProperty('score');
    expect(v).not.toHaveProperty('score100');
    expect(v).not.toHaveProperty('healthScore');
    expect(v).not.toHaveProperty('numericScore');
    // Walk all top-level primitive values — none should be a 0..100 score integer.
    for (const value of Object.values(v)) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100) {
        throw new Error(`Unexpected bare 0-100 numeric field value: ${value}`);
      }
    }
  });

  it('all reachable states are within the four-state enum', () => {
    const inputs = [
      greenRepo(),
      greenRepo({ meta: { ...greenRepo().meta, archived: true } }),
      greenRepo({ meta: { ...greenRepo().meta, license: { key: 'gpl-3.0', name: 'GPL' } } }),
      without(greenRepo(), 'meta.pushedAt')
    ];
    const enumValues = new Set(Object.values(VERDICT_STATES));
    for (const v of inputs.map((i) => verdict(i))) {
      expect(enumValues.has(v.state)).toBe(true);
    }
  });
});

/* =========================================================================
 * VC-ENGINE-05 — gameable signals worded as likelihoods
 * ========================================================================= */
describe('VC-ENGINE-05 — likelihood wording for slop & AI-ready', () => {
  it('flags initial-commit-only history using "looks" framing (with corroboration)', () => {
    // Per VC-SLOP-01, the squashed-history guard requires corroboration
    // before the single-commit signal contributes a slop reason. Pair the
    // single commit with a no-tests signal so this is genuinely slop.
    const repo = greenRepo({
      commits: [{ sha: 'only', date: '2025-06-10', author: { login: 'alice' } }],
      contents: { ...greenRepo().contents, hasTests: false }
    });
    const v = verdict(repo);
    expect(v.slop).toMatch(/looks/i);
    expect(v.slop.toLowerCase()).not.toContain('is slop');
  });

  it('does NOT flag a single-commit repo with otherwise real content (squashed guard)', () => {
    // 1 commit + has tests + recent activity → squashed-history guard kicks
    // in; this is NOT flagged as slop (VC-SLOP-01 false-positive guard).
    const repo = greenRepo({
      commits: [{ sha: 'only', date: '2025-06-10', author: { login: 'alice' } }]
    });
    const v = verdict(repo);
    expect(v.slop).toMatch(/no signals detected/i);
  });

  it('flags missing tests using likelihood framing', () => {
    const repo = greenRepo({ contents: { ...greenRepo().contents, hasTests: false } });
    const v = verdict(repo);
    // Missing tests contributes likelihood wording.
    expect(v.slop.length).toBeGreaterThan(0);
    expect(v.slop.toLowerCase()).not.toContain('is slop');
  });

  it('emits "likely agent-friendly" wording when AI-rules files are present', () => {
    const v = verdict(greenRepo());
    expect(v.aiReady.toLowerCase()).toContain('likely');
    expect(v.aiReady.toLowerCase()).not.toContain('your agent will grok');
  });

  it('uses hedged wording when AI-rules files are absent', () => {
    const repo = greenRepo({ contents: { ...greenRepo().contents, aiRulesFiles: [] } });
    const v = verdict(repo);
    expect(v.aiReady.length).toBeGreaterThan(0);
    expect(v.aiReady.toLowerCase()).not.toContain('your agent will grok');
    // Hedged framing — no absolute assertions.
    expect(v.aiReady.toLowerCase()).not.toMatch(/^(is|are) agent/);
  });

  it('never asserts slop as a fact anywhere on a slop-flagged repo', () => {
    const repo = greenRepo({
      commits: [{ sha: 'only', date: '2025-06-10', author: { login: 'alice' } }],
      contents: { ...greenRepo().contents, hasTests: false }
    });
    const v = verdict(repo);
    const serialized = JSON.stringify(v).toLowerCase();
    expect(serialized).not.toContain('"is slop"');
    expect(serialized).not.toContain('is abandoned');
    // Slop field should use "looks".
    expect(v.slop.toLowerCase()).toContain('looks');
  });
});

/* =========================================================================
 * VC-ENGINE-06 — dated heuristic disclaimer on every verdict shape
 * ========================================================================= */
describe('VC-ENGINE-06 — dated disclaimer on every verdict shape', () => {
  function verdictsForEachShape() {
    return {
      [VERDICT_STATES.LOOKS_CLONEABLE]: verdict(greenRepo()),
      [VERDICT_STATES.SKIP_IT]: verdict(
        greenRepo({ meta: { ...greenRepo().meta, archived: true } })
      ),
      [VERDICT_STATES.CLONE_WITH_CARE]: verdict(
        greenRepo({ meta: { ...greenRepo().meta, license: { key: 'gpl-3.0', name: 'GPL' } } })
      ),
      [VERDICT_STATES.NOT_ENOUGH_SIGNAL]: verdict(without(greenRepo(), 'meta.pushedAt'))
    };
  }

  it('includes a disclaimer field on every verdict shape', () => {
    const map = verdictsForEachShape();
    for (const [state, v] of Object.entries(map)) {
      expect(v.state, `shape ${state}`).toBe(state);
      expect(v.disclaimer, `disclaimer on ${state}`).toBeTruthy();
      expect(typeof v.disclaimer).toBe('string');
    }
  });

  it('disclaimer carries the canonical heuristic-audit phrase', () => {
    const map = verdictsForEachShape();
    for (const [state, v] of Object.entries(map)) {
      expect(v.disclaimer, `phrase on ${state}`).toContain('heuristic check, not a security audit');
    }
  });

  it('disclaimer carries the as-of date on every shape', () => {
    const map = verdictsForEachShape();
    for (const [state, v] of Object.entries(map)) {
      expect(v.disclaimer, `date on ${state}`).toContain('as of');
      expect(v.disclaimer, `date on ${state}`).toContain('2025-06-27');
    }
  });

  it('falls back to honest "date unknown" when asOf is missing', () => {
    const v = verdict({ ...greenRepo(), asOf: undefined });
    expect(v.disclaimer).toContain('date unknown');
    expect(v.disclaimer).toContain('heuristic check, not a security audit');
  });
});

/* =========================================================================
 * Bonus: behavior contract for the disclaimer body
 * ========================================================================= */
describe('verdict disclaimer honesty', () => {
  it('includes the "verify before you ship" caution in the disclaimer body', () => {
    const v = verdict(greenRepo());
    expect(v.disclaimer).toContain('verify before you ship');
  });
});
