import { describe, it, expect } from 'vitest';

// TEMPORARY: intentionally failing test to demonstrate CI gate failure.
// This file is on a throwaway branch and will be deleted after the demo run.
describe('CI failing-run demonstration (temporary)', () => {
  it('intentionally fails to prove CI blocks merge on test failure', () => {
    expect(true).toBe(false);
  });
});
