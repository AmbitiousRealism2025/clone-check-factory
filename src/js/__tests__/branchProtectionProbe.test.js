import { describe, it, expect } from 'vitest';

// Temporary canary test used to PROVE that branch protection on `main` blocks
// merges when a required status check fails. This file is intentionally failing
// and is removed after the demonstration completes (see fix-f2-2-branch-protection).
describe('branch-protection canary (intentionally failing)', () => {
  it('fails on purpose so the required CI check fails', () => {
    expect(true).toBe(false);
  });
});
