import { describe, it, expect } from 'vitest';
import { redactSecrets, redactSecretsDeep } from '../qa/redact.js';
import { cloneCheck, parseRepoRef, buildRepoDataFromFixture } from '../qa/mcp-stub.js';
import { verdict } from '../engine/verdict.js';

/* -------------------------------------------------------------------------
 * Fake-token fixtures.
 *
 * Built from parts so the literal token patterns never appear in source,
 * avoiding false positives from static secret scanners. The runtime values
 * are deliberately shaped to exercise each redaction regex.
 * ------------------------------------------------------------------------- */
const GHP_PREFIX = ['g', 'h', 'p', '_'].join('');
const GHP_BODY = ['aBcD', '1234', '5678', '9012', '3456', '7890', '1234', '5678',
  '9012', '3456', '7890'].join('');
const FAKE_GHP = GHP_PREFIX + GHP_BODY;
const FAKE_GHP_TAIL = '5678';
const PAT_PREFIX = ['g', 'i', 't', 'h', 'u', 'b', '_', 'p', 'a', 't', '_'].join('');
const PAT_BODY = ['11charsHere_', '22charsHere_charsHere___'].join('');
const FAKE_PAT = PAT_PREFIX + PAT_BODY;

/* =========================================================================
 * Clone Check — QA / run harness unit tests.
 *
 * Covers validation-contract assertions:
 *   VC-QA-01 — one-command startup with disk logs (secrets redacted,
 *              log path git-ignored). The redaction layer is the pure piece
 *              we can unit-test here; the start/harness CLI scripts are
 *              verified by an end-to-end run.
 *   VC-QA-02 — programmatic harness drives web verdict + MCP clone_check.
 *              The MCP stub (`cloneCheck`) is the pure piece; the CLI glue
 *              is verified by an end-to-end harness run.
 * ========================================================================= */

describe('VC-QA-01 — secret redaction for disk logs', () => {
  it('is a no-op on clean input', () => {
    const clean = 'vite v7.3.0 dev server running on http://localhost:3173/';
    expect(redactSecrets(clean)).toBe(clean);
  });

  it('redacts classic GitHub personal access tokens (ghp_…)', () => {
    const line = 'Authorization: token ' + FAKE_GHP;
    const out = redactSecrets(line);
    expect(out).not.toContain(FAKE_GHP);
    expect(out).toContain('[REDACTED');
  });

  it('redacts fine-grained GitHub tokens (github_pat_…)', () => {
    const line = 'GITHUB_TOKEN=' + FAKE_PAT;
    const out = redactSecrets(line);
    expect(out).not.toContain(FAKE_PAT);
    expect(out).toContain('[REDACTED');
  });

  it('redacts Bearer authorization headers', () => {
    const line = 'Authorization: Bearer ' + FAKE_GHP;
    const out = redactSecrets(line);
    expect(out).not.toContain('ghp_' + 'aBcD');
    expect(out).toMatch(/Bearer\s+\[REDACTED/);
  });

  it('redacts generic token=/secret=/password= assignments', () => {
    const line = 'config token=\"' + FAKE_GHP + '\" password=\"hunter2secret\"';
    const out = redactSecrets(line);
    expect(out).not.toContain('hunter2secret');
    expect(out).toContain('[REDACTED');
  });

  it('preserves non-secret structure (length-prefixed redaction keeps logs readable)', () => {
    const line = 'using token ' + FAKE_GHP + ' for api.github.com';
    const out = redactSecrets(line);
    expect(out).toContain('api.github.com');
    expect(out).toContain('[REDACTED');
  });

  it('redacts secrets across multiple lines', () => {
    const blob =
      'line one is clean\n' +
      'line two has ' + FAKE_GHP + ' in it\n' +
      'line three is also clean';
    const out = redactSecrets(blob);
    expect(out.split('\n')[0]).toBe('line one is clean');
    expect(out.split('\n')[1]).not.toContain('ghp_' + 'aBcD');
    expect(out.split('\n')[2]).toBe('line three is also clean');
  });

  it('redacts secrets inside structured JSON objects (redactSecretsDeep)', () => {
    const obj = {
      url: 'https://api.github.com/repos/owner/repo',
      headers: {
        authorization: 'Bearer ' + FAKE_GHP,
        accept: 'application/vnd.github+json'
      },
      meta: { token: FAKE_PAT }
    };
    const out = redactSecretsDeep(obj);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('ghp_' + 'aBcD');
    expect(serialized).not.toContain(PAT_PREFIX);
    expect(serialized).toContain('[REDACTED');
    // Non-secret fields preserved.
    expect(out.url).toBe(obj.url);
    expect(out.headers.accept).toBe(obj.headers.accept);
  });

  it('never throws on weird input (null / undefined / number)', () => {
    expect(() => redactSecrets(null)).not.toThrow();
    expect(() => redactSecrets(undefined)).not.toThrow();
    expect(() => redactSecrets(42)).not.toThrow();
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(undefined)).toBe(undefined);
  });

  it('does not double-wrap an already-redacted value (regression)', () => {
    // A `token=ghp_…` line is first scrubbed by rule #1 (ghp_ shape) and then
    // rule #6 (generic token=) walks the same span. The second pass must NOT
    // re-wrap, or the log would show `token=[REDACTED]]`.
    const line = 'token=' + FAKE_GHP;
    const out = redactSecrets(line);
    expect(out).toBe('token=[REDACTED]');
    expect(out).not.toContain('[REDACTED]]');
  });
});

describe('VC-QA-02 — MCP clone_check stub', () => {
  describe('parseRepoRef', () => {
    it('parses owner/name form', () => {
      expect(parseRepoRef('owner/name')).toEqual({ owner: 'owner', name: 'name' });
    });

    it('parses full https://github.com URL', () => {
      expect(parseRepoRef('https://github.com/vercel/next.js')).toEqual({
        owner: 'vercel',
        name: 'next.js'
      });
    });

    it('parses git clone URL', () => {
      expect(parseRepoRef('git@github.com:facebook/react.git')).toEqual({
        owner: 'facebook',
        name: 'react'
      });
    });

    it('throws on unparseable input', () => {
      expect(() => parseRepoRef('not-a-repo-ref')).toThrow(/repo/i);
    });
  });

  describe('buildRepoDataFromFixture', () => {
    it('returns a deterministic RepoData object for a known fixture', () => {
      const data = buildRepoDataFromFixture('owner/healthy-repo');
      expect(data.meta.fullName).toBe('owner/healthy-repo');
      // Determinism: same input → identical output.
      const again = buildRepoDataFromFixture('owner/healthy-repo');
      expect(JSON.stringify(again)).toBe(JSON.stringify(data));
    });
  });

  describe('cloneCheck (stub)', () => {
    it('returns the same verdict object the pure engine produces for the same data', async () => {
      const repoData = buildRepoDataFromFixture('owner/healthy-repo');
      const result = await cloneCheck('owner/healthy-repo', { repoData });
      // Parity with the pure engine — this is the contract the real M2 MCP
      // server must also satisfy (VC-MCP-01).
      expect(result.verdict).toEqual(verdict(repoData));
    });

    it('includes the repo ref and a dated disclaimer in the result envelope', async () => {
      const repoData = buildRepoDataFromFixture('owner/healthy-repo');
      const result = await cloneCheck('owner/healthy-repo', { repoData });
      expect(result.repo).toBe('owner/healthy-repo');
      expect(result.verdict.disclaimer).toMatch(/heuristic check, not a security audit/);
      expect(result.verdict.disclaimer).toMatch(/as of /);
    });

    it('marks the invocation path as the MCP stub (until the M2 server lands)', async () => {
      const repoData = buildRepoDataFromFixture('owner/healthy-repo');
      const result = await cloneCheck('owner/healthy-repo', { repoData });
      expect(result.path).toBe('mcp-stub');
      expect(typeof result.ms).toBe('number');
    });

    it('never asserts the safety word (hard invariant)', async () => {
      const repoData = buildRepoDataFromFixture('owner/healthy-repo');
      const result = await cloneCheck('owner/healthy-repo', { repoData });
      expect(JSON.stringify(result.verdict)).not.toMatch(/\bSafe\b/);
    });
  });
});
