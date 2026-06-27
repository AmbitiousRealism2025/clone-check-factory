import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Storage,
  escapeAttr,
  safeSetItem
} from '../common.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Helper: build a DOMException-like QuotaExceededError
const quotaError = () => {
  const err = new Error('The quota has been exceeded');
  err.name = 'QuotaExceededError';
  // DOMException code used by some browsers
  err.code = 22;
  return err;
};

// Re-establish a fresh in-memory localStorage impl for each test so that
// any permanent mockImplementation from a sibling test (in this file or
// another) does not leak in. setup.js only calls clearAllMocks, which does
// NOT reset implementations.
const resetLocalStorageImpl = () => {
  const store = {};
  localStorage.getItem.mockImplementation((k) => (k in store ? store[k] : null));
  localStorage.setItem.mockImplementation((k, v) => { store[k] = String(v); });
  localStorage.removeItem.mockImplementation((k) => { delete store[k]; });
  localStorage.clear.mockImplementation(() => {
    for (const k of Object.keys(store)) delete store[k];
  });
  localStorage.key.mockImplementation((i) => Object.keys(store)[i] ?? null);
  Object.defineProperty(localStorage, 'length', {
    get: () => Object.keys(store).length,
    configurable: true,
  });
};

describe('VC-PLATFORM-04 — escapeAttr', () => {
  it('escapes single quotes', () => {
    expect(escapeAttr("it's")).toBe("it&#39;s");
    expect(escapeAttr("O'Brien")).toBe("O&#39;Brien");
  });

  it('escapes double quotes', () => {
    expect(escapeAttr('say "hi"')).toBe('say &quot;hi&quot;');
    expect(escapeAttr('a="b"')).toBe('a=&quot;b&quot;');
  });

  it('escapes BOTH single and double quotes in the same string', () => {
    const input = `she said "it's fine"`;
    const out = escapeAttr(input);
    expect(out).toContain('&quot;');
    expect(out).toContain('&#39;');
    // And critically, neither raw quote survives
    expect(out).not.toContain('"');
    expect(out).not.toContain("'");
  });

  it('escapes other attribute-unsafe characters (<, >, &)', () => {
    expect(escapeAttr('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });

  it('returns empty string for null/undefined/empty input', () => {
    expect(escapeAttr(null)).toBe('');
    expect(escapeAttr(undefined)).toBe('');
    expect(escapeAttr('')).toBe('');
  });

  it('coerces non-string input to string before escaping', () => {
    expect(escapeAttr(42)).toBe('42');
    expect(escapeAttr(true)).toBe('true');
  });

  it('never leaks a raw quote through double-escaping', () => {
    const safe = escapeAttr(`"x" 'y'`);
    const doubly = escapeAttr(safe);
    expect(doubly).not.toContain('"');
    expect(doubly).not.toContain("'");
  });
});

describe('VC-PLATFORM-04 — safeSetItem (QuotaExceededError handling)', () => {
  beforeEach(() => {
    resetLocalStorageImpl();
  });

  it('writes through to localStorage when no error occurs', () => {
    const result = safeSetItem('plain-key', 'plain-value');
    expect(result).toBe(true);
    expect(localStorage.setItem).toHaveBeenCalledWith('plain-key', 'plain-value');
    expect(localStorage.getItem('plain-key')).toBe('plain-value');
  });

  it('does NOT throw when localStorage.setItem raises QuotaExceededError', () => {
    localStorage.setItem.mockImplementationOnce(() => { throw quotaError(); });
    expect(() => safeSetItem('k', 'v')).not.toThrow();
  });

  it('shows a toast on QuotaExceededError', () => {
    // Force permanent quota error so safeSetItem cannot recover.
    localStorage.setItem.mockImplementation(() => { throw quotaError(); });
    safeSetItem('k', 'v');
    // showToast appends a .toast element to the document body (creating a
    // container if absent), so verify the DOM side-effect directly.
    const toasts = document.querySelectorAll('.toast');
    expect(toasts.length).toBeGreaterThanOrEqual(1);
  });

  it('prunes oldest entries on QuotaExceededError then retries', () => {
    // Seed storage with two timestamped entries, oldest first.
    const older = JSON.stringify({ timestamp: 1000, data: 'old' });
    const newer = JSON.stringify({ timestamp: 5000, data: 'new' });
    localStorage.setItem('gh-explorer-notes', older);
    localStorage.setItem('gh-explorer-stats', newer);

    // First setItem attempt throws QuotaExceededError; second (after prune) succeeds.
    localStorage.setItem.mockImplementationOnce(() => { throw quotaError(); });

    const result = safeSetItem('gh-explorer-favorites', 'newdata');
    expect(result).toBe(true);
    // Oldest entry (notes) should have been pruned in favor of newer (stats).
    expect(localStorage.getItem('gh-explorer-notes')).toBeNull();
    expect(localStorage.getItem('gh-explorer-stats')).toBe(newer);
    expect(localStorage.getItem('gh-explorer-favorites')).toBe('newdata');
  });

  it('returns false (without throwing) when pruning cannot free enough space', () => {
    // Seed one entry so prune has something to remove.
    localStorage.setItem('gh-explorer-stats', JSON.stringify({ timestamp: 1 }));
    // Every setItem throws — even after pruning.
    localStorage.setItem.mockImplementation(() => { throw quotaError(); });
    let result;
    expect(() => { result = safeSetItem('k', 'v'); }).not.toThrow();
    expect(result).toBe(false);
  });

  it('never throws for non-quota errors either (defensive)', () => {
    localStorage.setItem.mockImplementationOnce(() => { throw new Error('something else'); });
    let result;
    expect(() => { result = safeSetItem('k', 'v'); }).not.toThrow();
    expect(result).toBe(false);
  });
});

describe('VC-PLATFORM-04 — Storage methods route writes through safeSetItem', () => {
  beforeEach(() => {
    resetLocalStorageImpl();
  });

  it('Storage.saveFavorites does not throw on QuotaExceededError', () => {
    localStorage.setItem.mockImplementation(() => { throw quotaError(); });
    expect(() => Storage.saveFavorites([{ id: 1 }])).not.toThrow();
  });

  it('Storage.saveNote does not throw on QuotaExceededError', () => {
    localStorage.setItem.mockImplementation(() => { throw quotaError(); });
    expect(() => Storage.saveNote('owner/repo', 'note text')).not.toThrow();
  });

  it('Storage.saveCollections does not throw on QuotaExceededError', () => {
    localStorage.setItem.mockImplementation(() => { throw quotaError(); });
    expect(() => Storage.saveCollections([{ id: 'c1' }])).not.toThrow();
  });

  it('Storage.trackExploration does not throw on QuotaExceededError', () => {
    localStorage.setItem.mockImplementation(() => { throw quotaError(); });
    expect(() => Storage.trackExploration({ id: 1, language: 'JS' })).not.toThrow();
  });

  it('Storage.setTheme does not throw on QuotaExceededError', () => {
    localStorage.setItem.mockImplementation(() => { throw quotaError(); });
    expect(() => Storage.setTheme('dark')).not.toThrow();
  });

  it('Storage.createCollection prunes and recovers on QuotaExceededError', () => {
    // Seed an older entry to be pruned.
    localStorage.setItem('gh-explorer-notes', JSON.stringify({ timestamp: 100 }));
    // First setItem (inside saveCollections) throws; retry after prune succeeds.
    localStorage.setItem.mockImplementationOnce(() => { throw quotaError(); });
    const collection = Storage.createCollection('My Coll');
    expect(collection).toBeDefined();
    expect(collection.name).toBe('My Coll');
    // Oldest entry was pruned to make room
    expect(localStorage.getItem('gh-explorer-notes')).toBeNull();
  });

  it('every localStorage.setItem call inside Storage is delegated to safeSetItem', () => {
    // Static guarantee: no direct localStorage.setItem calls should remain
    // inside the Storage object body. Read the source file from disk.
    const src = readFileSync(
      path.resolve(process.cwd(), 'src/js/common.js'),
      'utf8'
    );
    const storageStart = src.indexOf('export const Storage');
    const storageEnd = src.indexOf('export const initTheme');
    expect(storageStart).toBeGreaterThan(-1);
    expect(storageEnd).toBeGreaterThan(storageStart);
    const storageBody = src.slice(storageStart, storageEnd);
    expect(storageBody).not.toMatch(/localStorage\.setItem/);
  });
});
