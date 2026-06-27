import { describe, it, expect, beforeAll } from 'vitest';
import { assembleContextBlock, CONTEXT_BLOCK_LIMITS } from '../engine/contextBlock.js';

/* =========================================================================
 * Clone Check — Deterministic Context Block unit tests (F1.5 / VC-CONTEXT-01).
 *
 * The context block is a BOUNDED, paste-ready agent brief assembled from:
 *   - README excerpt
 *   - Detected stack
 *   - Verdict (state + whatThisIs + disclaimer)
 *   - Setup gotchas grep'd from README + issues
 *   - Key files
 *
 * Hard requirements:
 *   1. Deterministic — identical input yields byte-identical output.
 *   2. All five required sections present.
 *   3. Bounded — block size is capped regardless of repo size.
 *
 * Pure function: no DOM, no fetch, no Date.now.
 * ========================================================================= */

/* --------- shared fixtures (deterministic, no Date.now) ------------------ */

const AS_OF = '2025-06-27';

/** A canonical verdict object, matching the shape verdict() returns. */
function greenVerdict(overrides = {}) {
  return {
    state: 'Looks clone-able',
    whatThisIs:
      'owner/healthy-repo looks clone-able: the headline signals we check all read favorably.',
    stackFit: {
      detected: ['next', 'react', 'tailwind'],
      savedStack: ['next', 'react', 'supabase'],
      matches: ['next', 'react'],
      misses: ['supabase'],
      extras: ['tailwind'],
      matchCount: 2,
      savedCount: 3,
      fitScore: 0.6666666666666666
    },
    trustInWords: {
      maintenance: 'maintenance: actively pushed',
      license: 'license: MIT License (permissive)',
      busFactor: 'bus factor: healthy (3 contributors)',
      slop: 'slop: no signals detected'
    },
    aiReady: 'AI-readiness: has CLAUDE.md + solid README — likely agent-friendly',
    slop: 'slop: no signals detected',
    disclaimer: `heuristic check, not a security audit — verify before you ship (as of ${AS_OF})`,
    signals: { maintenance: 'active', license: 'permissive', busFactor: 'healthy', slop: 'clean' },
    ...overrides
  };
}

function baseContents(overrides = {}) {
  return {
    readme: [
      '# Healthy Repo',
      '',
      'A solid starter.',
      '',
      '## Setup',
      '',
      '```bash',
      'npm install',
      'npm run dev',
      '```',
      '',
      '## Required env vars',
      '',
      'You MUST set `DATABASE_URL` before running.',
      'Note: a Stripe key is required for billing.',
      '',
      '## Known issues',
      '',
      '- Build fails on Node < 18.',
      '- Ensure you copy `.env.example` first.'
    ].join('\n'),
    packageJson: {
      name: 'healthy-repo',
      dependencies: { next: '^14', react: '^18' }
    },
    fileTree: [
      { path: 'README.md' },
      { path: 'package.json' },
      { path: 'CLAUDE.md' },
      { path: 'src/index.js' },
      { path: 'src/App.js' },
      { path: 'tailwind.config.js' },
      { path: '.env.example' }
    ],
    aiRulesFiles: ['CLAUDE.md'],
    configFiles: ['tailwind.config.js'],
    hasTests: true,
    ...overrides
  };
}

function baseIssues(overrides = []) {
  return [
    { title: 'Build fails on Windows', number: 12 },
    { title: 'Feature: add dark mode', number: 5 },
    { title: 'Setup error: missing .env causes crash', number: 8 },
    ...overrides
  ];
}

function baseInput(overrides = {}) {
  return {
    asOf: AS_OF,
    meta: { fullName: 'owner/healthy-repo', description: 'A solid starter.' },
    verdict: greenVerdict(),
    contents: baseContents(),
    issues: baseIssues(),
    ...overrides
  };
}

/* =========================================================================
 * VC-CONTEXT-01 — Deterministic context block
 * ========================================================================= */
describe('VC-CONTEXT-01 — determinism', () => {
  it('produces byte-identical output across many calls for identical input', () => {
    const input = baseInput();
    const a = assembleContextBlock(input);
    const b = assembleContextBlock(input);
    const c = assembleContextBlock(input);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('is unaffected by object key insertion order (deep-equal inputs match)', () => {
    const a = assembleContextBlock(baseInput());
    // Rebuild the same input with shuffled key order.
    const shuffled = {
      issues: baseIssues(),
      contents: baseContents(),
      verdict: greenVerdict(),
      meta: { fullName: 'owner/healthy-repo', description: 'A solid starter.' },
      asOf: AS_OF
    };
    const b = assembleContextBlock(shuffled);
    expect(a).toBe(b);
  });

  it('returns a string (paste-ready text, not an object)', () => {
    expect(typeof assembleContextBlock(baseInput())).toBe('string');
  });

  it('produces different output for different verdict states', () => {
    const positive = assembleContextBlock(baseInput());
    const negative = assembleContextBlock({
      ...baseInput(),
      verdict: greenVerdict({ state: 'Skip it', whatThisIs: 'owner/bad-repo is probably worth skipping.' })
    });
    expect(positive).not.toBe(negative);
  });
});

/* -------------------------------------------------------------------------
 * All five required sections present
 * ------------------------------------------------------------------------- */
describe('VC-CONTEXT-01 — required sections present', () => {
  let block;
  beforeAll(() => {
    block = assembleContextBlock(baseInput());
  });
  // Import beforeAll locally (vitest provides beforeAll globally, but keep
  // the import explicit in case the test file is reused).
  // eslint-disable-next-line no-undef

  it('includes a README excerpt section', () => {
    expect(block).toMatch(/README excerpt/i);
  });

  it('includes a detected stack section', () => {
    expect(block).toMatch(/detected stack/i);
  });

  it('includes the verdict section', () => {
    expect(block).toMatch(/verdict/i);
  });

  it('includes a setup gotchas section', () => {
    expect(block).toMatch(/setup gotchas/i);
  });

  it('includes a key files section', () => {
    expect(block).toMatch(/key files/i);
  });

  it('includes the verdict state label and disclaimer in the block', () => {
    expect(block).toContain('Looks clone-able');
    expect(block).toContain('heuristic check, not a security audit');
    expect(block).toContain(AS_OF);
  });

  it('includes detected stack chips with human labels', () => {
    expect(block).toContain('Next.js');
    expect(block).toContain('React');
    expect(block).toContain('Tailwind CSS');
  });
});

/* -------------------------------------------------------------------------
 * Setup gotchas grep'd from README + issues
 * ------------------------------------------------------------------------- */
describe('VC-CONTEXT-01 — setup gotchas grep', () => {
  it('surfaces gotcha keywords found in README (MUST/required/ensure/note/error/fail)', () => {
    const block = assembleContextBlock(baseInput());
    // The fixture README contains "MUST set", "required", "Ensure", "fails".
    expect(block.toLowerCase()).toMatch(/must|required|ensure|note/);
    expect(block.toLowerCase()).toMatch(/fail|error/);
  });

  it('surfaces gotcha keywords found in issue titles', () => {
    const block = assembleContextBlock(baseInput());
    // Issue "Build fails on Windows" + "Setup error: missing .env causes crash".
    expect(block).toMatch(/Build fails on Windows|missing \.env/i);
  });

  it('does not include non-gotcha issues (feature requests, etc.)', () => {
    const block = assembleContextBlock(baseInput());
    expect(block).not.toContain('Feature: add dark mode');
  });

  it('emits an explicit "no gotchas found" line when nothing matches', () => {
    const block = assembleContextBlock({
      ...baseInput(),
      contents: baseContents({
        readme: '# Plain Repo\n\nA plain starter. Hello world, this is fine.',
        fileTree: [{ path: 'README.md' }]
      }),
      issues: [{ title: 'Feature: add a color picker', number: 1 }]
    });
    expect(block).toMatch(/no setup gotchas detected/i);
  });
});

/* -------------------------------------------------------------------------
 * Bounded scope — block stays capped regardless of repo size
 * ------------------------------------------------------------------------- */
describe('VC-CONTEXT-01 — bounded scope', () => {
  it('stays within a hard byte ceiling even for a huge README and file tree', () => {
    const hugeReadme = '# Huge\n\n' + 'x'.repeat(500_000);
    const hugeTree = Array.from({ length: 10_000 }, (_, i) => ({ path: `file-${i}.js` }));
    const manyIssues = Array.from({ length: 5_000 }, (_, i) => ({
      title: `Build fails on case ${i}`,
      number: i + 1
    }));
    const block = assembleContextBlock({
      ...baseInput(),
      contents: baseContents({ readme: hugeReadme, fileTree: hugeTree }),
      issues: manyIssues
    });
    // The block must remain bounded well below the input sizes.
    expect(block.length).toBeLessThan(CONTEXT_BLOCK_LIMITS.MAX_BLOCK_BYTES);
    expect(block.length).toBeLessThan(20_000); // generous upper bound for a brief
  });

  it('caps the README excerpt to a bounded number of lines', () => {
    const longReadme = Array.from({ length: 500 }, (_, i) => `Line ${i}`).join('\n');
    const block = assembleContextBlock({
      ...baseInput(),
      contents: baseContents({ readme: longReadme })
    });
    // Excerpt section must NOT contain all 500 lines.
    const excerptStart = block.indexOf('README excerpt');
    const excerptEnd = block.indexOf('##', excerptStart + 10);
    const slice = excerptEnd === -1 ? block.slice(excerptStart) : block.slice(excerptStart, excerptEnd);
    // Count occurrences of "Line " — bounded well below 500.
    const lineHits = (slice.match(/Line \d+/g) || []).length;
    expect(lineHits).toBeLessThan(60);
  });

  it('caps the key files list to a bounded count', () => {
    const bigTree = Array.from({ length: 1_000 }, (_, i) => ({ path: `src/file-${i}.js` }));
    const block = assembleContextBlock({
      ...baseInput(),
      contents: baseContents({ fileTree: bigTree })
    });
    // The key files section should never list 1_000 files.
    const filesStart = block.indexOf('Key files');
    const filesEnd = block.length;
    const slice = block.slice(filesStart, filesEnd);
    const hits = (slice.match(/^- /gm) || []).length;
    expect(hits).toBeLessThan(50);
  });

  it('never copies the whole README verbatim into the block', () => {
    const marker = 'UNIQUE_MARKER_' + 'A'.repeat(2_000);
    const block = assembleContextBlock({
      ...baseInput(),
      contents: baseContents({ readme: '# Title\n\n' + marker })
    });
    expect(block).not.toContain(marker);
  });
});

/* -------------------------------------------------------------------------
 * Determinism under partial / missing inputs
 * ------------------------------------------------------------------------- */
describe('VC-CONTEXT-01 — robust under missing data', () => {
  it('still produces a bounded block when contents is null', () => {
    const block = assembleContextBlock({
      ...baseInput(),
      contents: null
    });
    expect(typeof block).toBe('string');
    expect(block.length).toBeGreaterThan(0);
    expect(block).toMatch(/README excerpt/i);
    // No README → the excerpt section reports none.
    expect(block).toMatch(/no README available/i);
  });

  it('still produces a bounded block when issues is missing', () => {
    const block = assembleContextBlock({
      ...baseInput(),
      issues: undefined
    });
    expect(typeof block).toBe('string');
    expect(block).toContain('Looks clone-able');
  });

  it('still produces a bounded block when verdict.stackFit is missing detected chips', () => {
    const block = assembleContextBlock({
      ...baseInput(),
      verdict: greenVerdict({ stackFit: { detected: [], savedStack: [], matches: [], misses: [], extras: [], matchCount: 0, savedCount: 0, fitScore: 0 } })
    });
    expect(block).toMatch(/detected stack/i);
    expect(block).toMatch(/none detected|no stack chips/i);
  });

  it('handles undefined input gracefully (never throws)', () => {
    expect(() => assembleContextBlock()).not.toThrow();
    expect(() => assembleContextBlock({})).not.toThrow();
    expect(() => assembleContextBlock(null)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------
 * Bounded on empty/missing inputs
 * ------------------------------------------------------------------------- */
describe('VC-CONTEXT-01 — stable shape across boundary inputs', () => {
  it('is deterministic for empty input across runs', () => {
    const a = assembleContextBlock({});
    const b = assembleContextBlock({});
    expect(a).toBe(b);
  });

  it('is deterministic for null input across runs', () => {
    const a = assembleContextBlock(null);
    const b = assembleContextBlock(null);
    expect(a).toBe(b);
  });
});
