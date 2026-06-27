import { describe, it, expect } from 'vitest';
import {
  detectStack,
  matchStack,
  STACK_CHIPS,
  STACK_CHIP_LABELS
} from '../engine/stackMatcher.js';

/* =========================================================================
 * Clone Check — Stack-fit Matcher unit tests (F1.4 / VC-STACK-01).
 *
 * The matcher:
 *   1. Auto-detects framework chips from package.json + config files + file tree
 *      (Next.js, React, Supabase, Tailwind, shadcn, Stripe, Prisma).
 *   2. Visibly MATCHES detected chips against a saved 3-chip stack.
 *
 * Pure function: no DOM, no fetch, no Date.now.
 * ========================================================================= */

/** Realistic Next.js + Tailwind + Prisma package.json. */
function fullPkg(overrides = {}) {
  return {
    dependencies: {
      next: '^14.0.0',
      react: '^18.0.0',
      'react-dom': '^18.0.0',
      '@supabase/supabase-js': '^2.0.0',
      '@stripe/stripe-js': '^3.0.0',
      prisma: '^5.0.0',
      '@prisma/client': '^5.0.0'
    },
    devDependencies: {
      tailwindcss: '^3.4.0',
      'class-variance-authority': '^0.7.0',
      '@radix-ui/react-dialog': '^1.0.0'
    },
    ...overrides
  };
}

/* -------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */
describe('stack matcher — constants', () => {
  it('exposes exactly the seven canonical chip IDs', () => {
    expect(STACK_CHIPS.slice().sort()).toEqual(
      ['next', 'prisma', 'react', 'shadcn', 'stripe', 'supabase', 'tailwind'].sort()
    );
  });

  it('exposes a human label for every chip ID', () => {
    for (const id of STACK_CHIPS) {
      expect(typeof STACK_CHIP_LABELS[id]).toBe('string');
      expect(STACK_CHIP_LABELS[id].length).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------
 * VC-STACK-01 — chip detection from package.json
 * ------------------------------------------------------------------------- */
describe('VC-STACK-01 — chip detection from package.json', () => {
  it('detects Next.js from dependencies.next', () => {
    const detected = detectStack({ packageJson: fullPkg() });
    expect(detected).toContain('next');
  });

  it('detects React from dependencies.react', () => {
    const detected = detectStack({ packageJson: fullPkg() });
    expect(detected).toContain('react');
  });

  it('detects Supabase from @supabase/supabase-js', () => {
    const detected = detectStack({ packageJson: fullPkg() });
    expect(detected).toContain('supabase');
  });

  it('detects Tailwind from devDependencies.tailwindcss', () => {
    const detected = detectStack({ packageJson: fullPkg() });
    expect(detected).toContain('tailwind');
  });

  it('detects shadcn from class-variance-authority + @radix-ui/*', () => {
    const detected = detectStack({ packageJson: fullPkg() });
    expect(detected).toContain('shadcn');
  });

  it('detects Stripe from @stripe/stripe-js', () => {
    const detected = detectStack({ packageJson: fullPkg() });
    expect(detected).toContain('stripe');
  });

  it('detects Prisma from prisma OR @prisma/client', () => {
    const detected = detectStack({ packageJson: fullPkg() });
    expect(detected).toContain('prisma');
  });

  it('returns ALL seven chips for the full-stack package.json', () => {
    const detected = detectStack({ packageJson: fullPkg() });
    expect(detected.slice().sort()).toEqual(STACK_CHIPS.slice().sort());
  });

  it('returns an empty array when no dependencies match', () => {
    const detected = detectStack({
      packageJson: { dependencies: { lodash: '^4.0.0', express: '^4.0.0' } }
    });
    expect(detected).toEqual([]);
  });

  it('returns an empty array when packageJson is null/missing', () => {
    expect(detectStack({})).toEqual([]);
    expect(detectStack({ packageJson: null })).toEqual([]);
    expect(detectStack({})).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * Chip detection from config files + file tree
 * ------------------------------------------------------------------------- */
describe('chip detection from config files + file tree', () => {
  it('detects Next.js from next.config.js even without the dep', () => {
    const detected = detectStack({
      packageJson: { dependencies: {} },
      configFiles: ['next.config.js']
    });
    expect(detected).toContain('next');
  });

  it('detects Tailwind from tailwind.config.ts', () => {
    const detected = detectStack({
      packageJson: { dependencies: {} },
      configFiles: ['tailwind.config.ts']
    });
    expect(detected).toContain('tailwind');
  });

  it('detects shadcn from components.json', () => {
    const detected = detectStack({
      packageJson: { dependencies: {} },
      configFiles: ['components.json']
    });
    expect(detected).toContain('shadcn');
  });

  it('detects Prisma from prisma/schema.prisma in the file tree', () => {
    const detected = detectStack({
      packageJson: { dependencies: {} },
      fileTree: [{ path: 'prisma/schema.prisma' }, { path: 'src/index.js' }]
    });
    expect(detected).toContain('prisma');
  });

  it('file tree accepts plain strings too', () => {
    const detected = detectStack({
      packageJson: { dependencies: {} },
      fileTree: ['prisma/schema.prisma', 'README.md']
    });
    expect(detected).toContain('prisma');
  });

  it('dedupes chips detected from both packageJson and config files', () => {
    const detected = detectStack({
      packageJson: fullPkg(),
      configFiles: ['next.config.js', 'tailwind.config.js']
    });
    const nextEntries = detected.filter((c) => c === 'next');
    expect(nextEntries).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------
 * VC-STACK-01 — visible match against saved 3-chip stack
 * ------------------------------------------------------------------------- */
describe('VC-STACK-01 — visible match against saved stack', () => {
  it('returns a structured match record with required fields', () => {
    const result = matchStack({
      packageJson: fullPkg(),
      savedStack: ['next', 'react', 'tailwind']
    });
    expect(result).toHaveProperty('detected');
    expect(result).toHaveProperty('savedStack');
    expect(result).toHaveProperty('matches');
    expect(result).toHaveProperty('misses');
    expect(result).toHaveProperty('extras');
  });

  it('matches = saved chips that ARE detected in the repo', () => {
    const result = matchStack({
      packageJson: fullPkg(),
      savedStack: ['next', 'react', 'tailwind']
    });
    // All three saved chips are in fullPkg().
    expect(result.matches.slice().sort()).toEqual(['next', 'react', 'tailwind'].sort());
  });

  it('misses = saved chips that are NOT detected in the repo', () => {
    const result = matchStack({
      packageJson: { dependencies: { next: '^14', react: '^18' } },
      savedStack: ['next', 'react', 'supabase']
    });
    expect(result.misses).toEqual(['supabase']);
  });

  it('extras = detected chips that are NOT in the saved stack', () => {
    const result = matchStack({
      packageJson: fullPkg(),
      savedStack: ['next', 'react', 'tailwind']
    });
    // supabase, shadcn, stripe, prisma detected but not saved → extras
    expect(result.extras.slice().sort()).toEqual(['prisma', 'shadcn', 'stripe', 'supabase'].sort());
  });

  it('matchCount counts the matched chips', () => {
    const result = matchStack({
      packageJson: { dependencies: { next: '^14', react: '^18' } },
      savedStack: ['next', 'react', 'tailwind']
    });
    expect(result.matchCount).toBe(2);
    expect(result.savedCount).toBe(3);
  });

  it('fitScore is a 0..1 ratio of matches / saved chips', () => {
    const full = matchStack({
      packageJson: fullPkg(),
      savedStack: ['next', 'react', 'tailwind']
    });
    expect(full.fitScore).toBe(1);

    const partial = matchStack({
      packageJson: { dependencies: { next: '^14' } },
      savedStack: ['next', 'react', 'tailwind']
    });
    expect(partial.fitScore).toBeCloseTo(1 / 3, 5);
  });

  it('handles an empty saved stack honestly (no division by zero)', () => {
    const result = matchStack({
      packageJson: fullPkg(),
      savedStack: []
    });
    expect(result.matches).toEqual([]);
    expect(result.misses).toEqual([]);
    expect(result.fitScore).toBe(0);
    expect(result.matchCount).toBe(0);
  });

  it('survives null/undefined input without throwing', () => {
    expect(() => matchStack(null)).not.toThrow();
    expect(() => matchStack(undefined)).not.toThrow();
    const result = matchStack(null);
    expect(result.matches).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
 * Purity
 * ------------------------------------------------------------------------- */
describe('stack matcher — purity', () => {
  it('is deterministic — same input → byte-identical output', () => {
    const input = { packageJson: fullPkg(), savedStack: ['next', 'react', 'tailwind'] };
    const a = matchStack(input);
    const b = matchStack(JSON.parse(JSON.stringify(input)));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the input packageJson or savedStack', () => {
    const input = { packageJson: fullPkg(), savedStack: ['next', 'react', 'tailwind'] };
    const snapshot = JSON.stringify(input);
    matchStack(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
