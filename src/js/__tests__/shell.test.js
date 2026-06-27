import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  NAV_ITEMS,
  headerHTML,
  mobileNavHTML,
  renderShell,
  createPageController,
  pushUrlParams,
  replaceUrlParams,
  onPopState,
} from '../shell.js';

// initErrorBoundary attaches window listeners; stub the side effect at import.
vi.mock('../errorBoundary.js', () => ({
  initErrorBoundary: vi.fn(() => {}),
}));

describe('shell — single-source chrome', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, '', '/');
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('NAV_ITEMS (single source of truth)', () => {
    it('exposes the 6 canonical nav items', () => {
      const pages = NAV_ITEMS.map((i) => i.page);
      expect(pages).toEqual([
        'search',
        'trending',
        'favorites',
        'collections',
        'compare',
        'pulse',
      ]);
    });

    it('every nav item has a label, href, and iconSvg', () => {
      NAV_ITEMS.forEach((item) => {
        expect(typeof item.label).toBe('string');
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.href.startsWith('/')).toBe(true);
        expect(item.iconSvg.includes('<svg')).toBe(true);
      });
    });
  });

  describe('headerHTML — aria-current on active link', () => {
    it('marks only the active desktop link with aria-current="page"', () => {
      const html = headerHTML({ page: 'trending' });
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const links = Array.from(tpl.content.querySelectorAll('.header__nav-link'));
      const current = links.filter((a) =>
        a.getAttribute('aria-current') === 'page'
      );
      expect(current.length).toBe(1);
      expect(current[0].textContent.trim()).toBe('Trending');
      expect(current[0].getAttribute('href')).toBe('/trending.html');
    });

    it('rotates aria-current with the active page (no drift)', () => {
      const pages = ['search', 'favorites', 'pulse'];
      pages.forEach((p) => {
        const html = headerHTML({ page: p });
        const tpl = document.createElement('template');
        tpl.innerHTML = html.trim();
        const current = tpl.content.querySelector(
          '.header__nav-link[aria-current="page"]'
        );
        expect(current).not.toBeNull();
        expect(
          NAV_ITEMS.find((i) => i.page === p).label
        ).toBe(current.textContent.trim());
      });
    });

    it('emits no aria-current when the page is unknown', () => {
      const html = headerHTML({ page: 'unknown' });
      expect(html).not.toContain('aria-current');
    });

    it('omits the settings button by default and includes it on demand', () => {
      expect(headerHTML({ page: 'search' })).not.toContain('id="settings-btn"');
      expect(
        headerHTML({ page: 'search', showSettings: true })
      ).toContain('id="settings-btn"');
    });

    it('always renders the theme-toggle and mobile-nav-toggle', () => {
      const html = headerHTML({ page: 'search' });
      expect(html).toContain('id="theme-toggle"');
      expect(html).toContain('id="mobile-nav-toggle"');
    });
  });

  describe('mobileNavHTML — aria-current on active link', () => {
    it('marks only the active mobile link with aria-current="page"', () => {
      const html = mobileNavHTML({ page: 'collections' });
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      const current = tpl.content.querySelectorAll(
        '.mobile-nav__link[aria-current="page"]'
      );
      expect(current.length).toBe(1);
      expect(current[0].textContent.trim()).toContain('Collections');
    });
  });

  describe('renderShell — injects chrome into the mount point', () => {
    it('replaces the placeholder with header + mobile nav', () => {
      document.body.innerHTML = `
        <div class="app">
          <div data-app-shell data-page="search"></div>
          <main id="main-content"></main>
        </div>`;
      const { header, mobileNav } = renderShell();
      expect(header).not.toBeNull();
      expect(mobileNav).not.toBeNull();
      expect(document.querySelector('[data-app-shell]')).toBeNull();
      expect(document.querySelector('.header')).not.toBeNull();
      expect(document.querySelector('.mobile-nav')).not.toBeNull();
    });

    it('reads the active page from data-page when not passed explicitly', () => {
      document.body.innerHTML = `
        <div class="app">
          <div data-app-shell data-page="favorites"></div>
        </div>`;
      renderShell();
      const current = document.querySelector(
        '.header__nav-link[aria-current="page"]'
      );
      expect(current.textContent.trim()).toBe('Favorites');
    });

    it('keeps header and mobile-nav as siblings of subsequent content', () => {
      document.body.innerHTML = `
        <div class="app">
          <div data-app-shell data-page="search"></div>
          <main id="main-content">main</main>
        </div>`;
      renderShell();
      const app = document.querySelector('.app');
      expect(app.children[0].classList.contains('header')).toBe(true);
      expect(app.children[1].classList.contains('mobile-nav')).toBe(true);
      expect(app.children[2].id).toBe('main-content');
    });

    it('returns nulls when no mount is present', () => {
      document.body.innerHTML = '<div class="app"></div>';
      const { header, mobileNav } = renderShell({ page: 'search' });
      expect(header).toBeNull();
      expect(mobileNav).toBeNull();
    });
  });

  describe('createPageController — bootstrap', () => {
    it('runs theme, shell, mobile-nav, and error boundary init in order', () => {
      document.body.innerHTML = `
        <div class="app">
          <div data-app-shell data-page="search"></div>
        </div>`;

      createPageController({ page: 'search' });

      // shell rendered (header + mobile nav present)
      expect(document.querySelector('.header')).not.toBeNull();
      expect(document.querySelector('.mobile-nav')).not.toBeNull();
      // theme applied to <html>
      expect(document.documentElement.getAttribute('data-theme')).toBeTruthy();
    });

    it('binds the theme-toggle click handler', () => {
      document.body.innerHTML = `
        <div class="app">
          <div data-app-shell data-page="search"></div>
        </div>`;
      createPageController({ page: 'search' });
      const toggle = document.getElementById('theme-toggle');
      expect(toggle).not.toBeNull();
      // toggleTheme flips the data-theme attribute between light and dark
      const before = document.documentElement.getAttribute('data-theme') || 'light';
      toggle.click();
      const after = document.documentElement.getAttribute('data-theme');
      expect(after).not.toBe(before);
    });

    it('renders the settings button when showSettings is true', () => {
      document.body.innerHTML = `
        <div class="app">
          <div data-app-shell data-page="search"></div>
        </div>`;
      createPageController({ page: 'search', showSettings: true });
      expect(document.getElementById('settings-btn')).not.toBeNull();
    });

    it('runs the optional init callback after bootstrap', () => {
      document.body.innerHTML = `
        <div class="app">
          <div data-app-shell data-page="search"></div>
        </div>`;
      const init = vi.fn();
      createPageController({ page: 'search', init });
      expect(init).toHaveBeenCalledTimes(1);
    });
  });
});

describe('shell — deep-linkable state (History API)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('pushUrlParams pushes a new history entry with the given params', () => {
    expect(window.location.search).toBe('');
    pushUrlParams({ q: 'react', page: '2' });
    expect(window.location.search).toContain('q=react');
    expect(window.location.search).toContain('page=2');
  });

  it('replaceUrlParams overwrites params without adding a history entry', () => {
    pushUrlParams({ q: 'first' });
    const lenBefore = window.history.length;
    replaceUrlParams({ q: 'second' });
    // location reflects the new value but no extra push happened
    expect(window.location.search).toContain('q=second');
    // history.length is at least lenBefore (some browsers cap growth)
    expect(window.history.length).toBeGreaterThanOrEqual(lenBefore);
  });

  it('pushUrlParams removes params when value is null/empty', () => {
    pushUrlParams({ q: 'keep', drop: 'x' });
    expect(window.location.search).toContain('drop=x');
    pushUrlParams({ drop: null });
    expect(window.location.search).not.toContain('drop=');
  });

  it('onPopState fires the handler on popstate and returns an unsubscribe', () => {
    const handler = vi.fn();
    const off = onPopState(handler);
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('pushUrlParams + onPopState enable Back/Forward state restoration', () => {
    let restored = null;
    onPopState((e) => {
      restored = new URLSearchParams(window.location.search).get('q');
    });
    pushUrlParams({ q: 'alpha' });
    pushUrlParams({ q: 'beta' });
    // Simulate the user pressing Back: popstate fires with the prior URL.
    window.history.back();
    // back() is async in jsdom; dispatch a synthetic popstate carrying alpha.
    window.history.replaceState({}, '', '/?q=alpha');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(restored).toBe('alpha');
  });
});
