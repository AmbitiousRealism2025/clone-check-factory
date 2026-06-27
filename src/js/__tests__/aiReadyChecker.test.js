import { describe, it, expect } from 'vitest';
import { checkAiReady, AI_READINESS_LEVELS } from '../engine/aiReadyChecker.js';

/* =========================================================================
 * Clone Check — AI-readiness Checker unit tests (F1.4 / VC-AIREADY-01).
 *
 * The badge is derived from:
 *   - presence of CLAUDE.md / AGENTS.md / .cursor* AI-rules files
 *   - README quality (length + structure)
 *   - file-count modularity
 * …and worded as a LIKELIHOOD ("likely agent-friendly"), never as the
 * asserted fact "your agent will grok this".
 *
 * Pure function: no DOM, no fetch, no Date.now.
 * ========================================================================= */

/** A solid README with structure + install instructions. */
const SOLID_README = [
  '# Real Starter',
  '',
  'A production-grade boilerplate.',
  '',
  '## Install',
  '',
  '```bash',
  'npm install',
 '```',
  '',
  '## Usage',
  '',
  'Run the dev server, edit components, ship.',
  '',
  '## Architecture',
  '',
  'Long docs about layout.'
].join('\n');

/** A bare-bones README. */
const SPARSE_README = '# repo';

function baseContents(overrides = {}) {
  return {
    aiRulesFiles: [],
    readme: SPARSE_README,
    fileCount: 3,
    fileTree: [{ path: 'README.md' }, { path: 'package.json' }, { path: 'src/index.js' }],
    ...overrides
  };
}

/* -------------------------------------------------------------------------
 * Purity / shape
 * ------------------------------------------------------------------------- */
describe('AI-readiness checker — purity & shape', () => {
  it('is deterministic across calls', () => {
    const contents = baseContents({ aiRulesFiles: ['CLAUDE.md'], readme: SOLID_README, fileCount: 12 });
    const a = checkAiReady({ contents });
    const b = checkAiReady({ contents });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the input', () => {
    const contents = baseContents({ aiRulesFiles: ['CLAUDE.md'] });
    const snapshot = JSON.stringify(contents);
    checkAiReady({ contents });
    expect(JSON.stringify(contents)).toBe(snapshot);
  });

  it('returns a record with label + level + signals', () => {
    const result = checkAiReady({ contents: baseContents() });
    expect(result).toHaveProperty('label');
    expect(result).toHaveProperty('level');
    expect(result).toHaveProperty('signals');
    expect(typeof result.label).toBe('string');
  });

  it('handles null/undefined input without throwing', () => {
    expect(() => checkAiReady(undefined)).not.toThrow();
    expect(() => checkAiReady(null)).not.toThrow();
    expect(checkAiReady(null).level).toBe(AI_READINESS_LEVELS.UNKNOWN);
  });
});

/* -------------------------------------------------------------------------
 * VC-AIREADY-01 — likelihood wording
 * ------------------------------------------------------------------------- */
describe('VC-AIREADY-01 — likelihood wording', () => {
  it('uses "likely agent-friendly" when AI-rules files are present', () => {
    const result = checkAiReady({
      contents: baseContents({ aiRulesFiles: ['CLAUDE.md'] })
    });
    expect(result.label.toLowerCase()).toContain('likely');
    expect(result.label.toLowerCase()).not.toContain('your agent will grok');
  });

  it('mentions the AI-rules file names in the label', () => {
    const result = checkAiReady({
      contents: baseContents({ aiRulesFiles: ['CLAUDE.md', 'AGENTS.md'] })
    });
    expect(result.label).toContain('CLAUDE.md');
    expect(result.label).toContain('AGENTS.md');
  });

  it('recognizes .cursorrules and .cursor as AI-rules files', () => {
    const result = checkAiReady({
      contents: baseContents({ aiRulesFiles: ['.cursorrules'] })
    });
    expect(result.label.toLowerCase()).toContain('likely');
    expect(result.label).toContain('.cursorrules');
  });

  it('uses likelihood wording (likely/probably/may) — never asserts as fact', () => {
    const inputs = [
      baseContents({ aiRulesFiles: ['CLAUDE.md'], readme: SOLID_README, fileCount: 15 }),
      baseContents({ aiRulesFiles: [], readme: SOLID_README, fileCount: 12 }),
      baseContents({ aiRulesFiles: [], readme: SPARSE_README, fileCount: 2 })
    ];
    for (const contents of inputs) {
      const result = checkAiReady({ contents });
      const lower = result.label.toLowerCase();
      const isLikelihood = /likely|probably|may need|unknown/i.test(lower);
      expect(isLikelihood, `label must be likelihood-worded: "${result.label}"`).toBe(true);
      // Never an asserted fact like "is agent-friendly" / "your agent will grok this"
      expect(lower).not.toMatch(/^(is|are)\s+agent/);
      expect(lower).not.toContain('your agent will grok');
    }
  });

  it('level is one of the canonical levels', () => {
    const inputs = [
      null,
      baseContents({ aiRulesFiles: ['CLAUDE.md'], readme: SOLID_README, fileCount: 15 }),
      baseContents({ aiRulesFiles: [], readme: SPARSE_README, fileCount: 2 })
    ];
    const validLevels = new Set(Object.values(AI_READINESS_LEVELS));
    for (const contents of inputs) {
      const result = checkAiReady({ contents });
      expect(validLevels.has(result.level)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------
 * Signal coverage — combination matrix
 * ------------------------------------------------------------------------- */
describe('AI-readiness checker — signal combination matrix', () => {
  it('STRONG: AI-rules files + solid README + modular → likely + highest level', () => {
    const result = checkAiReady({
      contents: baseContents({
        aiRulesFiles: ['CLAUDE.md', 'AGENTS.md'],
        readme: SOLID_README,
        fileCount: 20
      })
    });
    expect(result.label.toLowerCase()).toContain('likely');
    expect(result.level).toBe(AI_READINESS_LEVELS.LIKELY);
    // All three signals flagged.
    expect(result.signals).toHaveProperty('aiRules', true);
    expect(result.signals).toHaveProperty('readmeQuality', true);
    expect(result.signals).toHaveProperty('modularity', true);
  });

  it('has AI-rules files but sparse README → still "likely agent-friendly"', () => {
    // AI-rules files are the dominant signal — they alone trigger "likely".
    const result = checkAiReady({
      contents: baseContents({ aiRulesFiles: ['CLAUDE.md'], readme: SPARSE_README, fileCount: 3 })
    });
    expect(result.label.toLowerCase()).toContain('likely');
    expect(result.level).toBe(AI_READINESS_LEVELS.LIKELY);
  });

  it('no AI-rules files but solid README + modular → "probably agent-friendly"', () => {
    const result = checkAiReady({
      contents: baseContents({ aiRulesFiles: [], readme: SOLID_README, fileCount: 18 })
    });
    expect(result.label.toLowerCase()).toContain('probably');
    expect(result.level).toBe(AI_READINESS_LEVELS.PROBABLY);
  });

  it('no AI-rules + sparse README + tiny file count → "may need more context"', () => {
    const result = checkAiReady({
      contents: baseContents({ aiRulesFiles: [], readme: SPARSE_README, fileCount: 2 })
    });
    expect(result.label.toLowerCase()).toContain('may need');
    expect(result.level).toBe(AI_READINESS_LEVELS.LOW);
  });

  it('missing contents entirely → "unknown"', () => {
    const result = checkAiReady({ contents: null });
    expect(result.level).toBe(AI_READINESS_LEVELS.UNKNOWN);
    expect(result.label.toLowerCase()).toContain('unknown');
  });

  it('treats an empty aiRulesFiles array the same as missing', () => {
    const a = checkAiReady({ contents: baseContents({ aiRulesFiles: [] }) });
    const b = checkAiReady({ contents: baseContents({ aiRulesFiles: undefined }) });
    expect(a.level).toBe(b.level);
    expect(a.label).toBe(b.label);
  });

  it('derives file count from fileTree when fileCount is not supplied', () => {
    const result = checkAiReady({
      contents: {
        aiRulesFiles: [],
        readme: SOLID_README,
        fileTree: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.js` }))
      }
    });
    // 12 files + solid README → probably agent-friendly.
    expect(result.label.toLowerCase()).toContain('probably');
    expect(result.signals.modularity).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * README quality heuristic
 * ------------------------------------------------------------------------- */
describe('AI-readiness checker — README quality heuristic', () => {
  it('a long, well-structured README counts as a positive signal', () => {
    const result = checkAiReady({
      contents: baseContents({ aiRulesFiles: [], readme: SOLID_README, fileCount: 1 })
    });
    expect(result.signals.readmeQuality).toBe(true);
  });

  it('a one-line README does NOT count as a positive signal', () => {
    const result = checkAiReady({
      contents: baseContents({ aiRulesFiles: [], readme: '# hi', fileCount: 1 })
    });
    expect(result.signals.readmeQuality).toBe(false);
  });

  it('a missing README does NOT count as a positive signal', () => {
    const result = checkAiReady({
      contents: baseContents({ aiRulesFiles: [], readme: null, fileCount: 10 })
    });
    expect(result.signals.readmeQuality).toBe(false);
  });
});
