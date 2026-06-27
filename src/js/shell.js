/**
 * Shared application shell + page-controller bootstrap (F1.7).
 *
 * This module is the SINGLE source of truth for the page chrome (header +
 * mobile navigation) that was previously copy-pasted across the 7 HTML pages.
 * It also exposes `createPageController()` which folds the duplicated
 * init/theme/state-machine bootstrap that every page controller used to repeat.
 *
 * VC-SHELL-01: Page chrome/nav is rendered from ONE shared source, and verdict
 * state is deep-linkable with working Back/Forward navigation.
 */

import {
  initTheme,
  toggleTheme,
  initMobileNav,
} from './common.js';
import { initErrorBoundary } from './errorBoundary.js';

// ---------------------------------------------------------------------------
// Single source of truth for navigation
// ---------------------------------------------------------------------------

const GITHUB_LOGO_SVG =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>';

/**
 * The canonical nav item list. Every page renders its header and mobile nav
 * from this single array, killing active-class drift and missing aria-current.
 *
 * @typedef {Object} NavItem
 * @property {string} page    - Logical page key (matches `data-page` on pages)
 * @property {string} label   - Visible label
 * @property {string} href    - Absolute href
 * @property {string} iconSvg - Inline SVG used by the mobile nav
 */
export const NAV_ITEMS = [
  {
    page: 'search',
    label: 'Search',
    href: '/',
    iconSvg:
      '<svg class="mobile-nav__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
  },
  {
    page: 'trending',
    label: 'Trending',
    href: '/trending.html',
    iconSvg:
      '<svg class="mobile-nav__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  },
  {
    page: 'favorites',
    label: 'Favorites',
    href: '/favorites.html',
    iconSvg:
      '<svg class="mobile-nav__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>',
  },
  {
    page: 'collections',
    label: 'Collections',
    href: '/collections.html',
    iconSvg:
      '<svg class="mobile-nav__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z"/></svg>',
  },
  {
    page: 'compare',
    label: 'Compare',
    href: '/compare.html',
    iconSvg:
      '<svg class="mobile-nav__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  },
  {
    page: 'pulse',
    label: 'Pulse',
    href: '/pulse.html',
    iconSvg:
      '<svg class="mobile-nav__link-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  },
];

const SUN_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
const MOON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const CLOSE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const SETTINGS_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

/**
 * Build the desktop header HTML for the given active page.
 * @param {Object}   opts
 * @param {string}   opts.page        - Active page key (matches a NAV_ITEMS entry)
 * @param {boolean}  [opts.showSettings] - Render the settings button (search page only)
 * @returns {string}
 */
export const headerHTML = ({ page, showSettings = false } = {}) => `
  <header class="header">
    <div class="container header__inner">
      <a href="/" class="header__logo">
        <svg class="header__logo-icon" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
        </svg>
        GitHub Explorer
      </a>
      <nav class="header__nav" aria-label="Primary">
        ${NAV_ITEMS.map(
          (item) =>
            `<a href="${item.href}" class="header__nav-link"${item.page === page ? ' aria-current="page"' : ''}>${item.label}</a>`
        ).join('')}
      </nav>
      <div class="header__actions">
        ${
          showSettings
            ? `<button class="btn btn--ghost btn--icon" id="settings-btn" aria-label="Settings">${SETTINGS_SVG}</button>`
            : ''
        }
        <button class="mobile-nav-toggle" id="mobile-nav-toggle" aria-label="Open navigation menu" aria-expanded="false" aria-controls="mobile-nav">
          <span class="mobile-nav-toggle__bars">
            <span class="mobile-nav-toggle__bar"></span>
            <span class="mobile-nav-toggle__bar"></span>
            <span class="mobile-nav-toggle__bar"></span>
          </span>
        </button>
        <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme">
          <span class="theme-toggle__sun">${SUN_SVG}</span>
          <span class="theme-toggle__moon">${MOON_SVG}</span>
        </button>
      </div>
    </div>
  </header>
`;

/**
 * Build the mobile navigation panel HTML for the given active page.
 * @param {Object}  opts
 * @param {string}  opts.page - Active page key
 * @returns {string}
 */
export const mobileNavHTML = ({ page } = {}) => `
  <nav class="mobile-nav" id="mobile-nav" aria-label="Mobile navigation" data-open="false">
    <div class="mobile-nav__overlay"></div>
    <div class="mobile-nav__panel">
      <div class="mobile-nav__header">
        <span class="mobile-nav__title">Navigation</span>
        <button class="mobile-nav__close" id="mobile-nav-close" aria-label="Close navigation menu">
          ${CLOSE_SVG}
        </button>
      </div>
      <ul class="mobile-nav__list">
        ${NAV_ITEMS.map(
          (item) => `
          <li class="mobile-nav__item">
            <a href="${item.href}" class="mobile-nav__link"${item.page === page ? ' aria-current="page"' : ''}>
              ${item.iconSvg}
              ${item.label}
            </a>
          </li>
        `
        ).join('')}
      </ul>
      <div class="mobile-nav__footer">
        <div class="mobile-nav__brand">
          ${GITHUB_LOGO_SVG}
          GitHub Explorer
        </div>
      </div>
    </div>
  </nav>
`;

/**
 * Selector used to find the shell mount point in each HTML page. Pages opt in
 * by rendering `<div data-app-shell data-page="search"></div>` where the chrome
 * should appear.
 */
const SHELL_MOUNT_SELECTOR = '[data-app-shell]';

/**
 * Render the shared shell (header + mobile nav) into the page's mount point.
 *
 * Reads the active page from the `data-page` attribute on the mount element
 * unless `page` is passed explicitly. Replaces the placeholder mount with the
 * real chrome so the existing CSS (which expects header/mobile-nav as direct
 * children of `.app`) keeps working.
 *
 * @param {Object}  opts
 * @param {string}  [opts.page]        - Override the active page key
 * @param {boolean} [opts.showSettings] - Render the settings button
 * @returns {{ header: HTMLElement|null, mobileNav: HTMLElement|null }}
 */
export const renderShell = ({ page, showSettings = false } = {}) => {
  const mount = document.querySelector(SHELL_MOUNT_SELECTOR);
  if (!mount) return { header: null, mobileNav: null };

  const activePage = page ?? mount.dataset.page ?? '';

  const headerTpl = document.createElement('template');
  headerTpl.innerHTML = headerHTML({ page: activePage, showSettings }).trim();
  const header = headerTpl.content.firstElementChild;

  const navTpl = document.createElement('template');
  navTpl.innerHTML = mobileNavHTML({ page: activePage }).trim();
  const mobileNav = navTpl.content.firstElementChild;

  // Insert the chrome where the placeholder lived, then drop the placeholder.
  if (header) mount.parentNode.insertBefore(header, mount);
  if (mobileNav) mount.parentNode.insertBefore(mobileNav, mount);
  mount.remove();

  return { header, mobileNav };
};

/**
 * Bootstrap every page controller the same way:
 *   1. apply saved theme (before paint to avoid flash)
 *   2. render the shared shell (single source of chrome)
 *   3. wire mobile nav interactions
 *   4. wire global error boundary
 *   5. wire the theme-toggle click handler
 *   6. run optional page-specific `init()`
 *
 * This folds ~7 copies of the init/theme/state-machine preamble into one call.
 *
 * @param {Object}   opts
 * @param {string}   opts.page           - Active page key (NAV_ITEMS)
 * @param {boolean}  [opts.showSettings] - Render the settings button (search page)
 * @param {Function} [opts.init]         - Page-specific init callback, run last
 * @returns {void}
 */
export const createPageController = ({ page, showSettings = false, init } = {}) => {
  initTheme();
  renderShell({ page, showSettings });
  initMobileNav();
  initErrorBoundary();

  const themeToggle = document.getElementById('theme-toggle');
  themeToggle?.addEventListener('click', toggleTheme);

  if (typeof init === 'function') init();
};

// ---------------------------------------------------------------------------
// Deep-linkable state (History API) — VC-SHELL-01 Back/Forward support
// ---------------------------------------------------------------------------

const buildUrlWithParams = (params) => {
  const url = new URL(window.location.href);
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  });
  return url;
};

/**
 * Push a new history entry with updated URL params. Use this for user-initiated
 * state changes that should appear in Back/Forward history (e.g. performing a
 * search, running a comparison). Pairs with `onPopState` to restore state.
 *
 * @param {Object<string, string|null>} params - Params to set; null/'' removes
 * @param {string} [title] - History entry title
 * @returns {void}
 */
export const pushUrlParams = (params, title = '') => {
  const url = buildUrlWithParams(params);
  window.history.pushState({}, title, url);
};

/**
 * Replace the current history entry's URL params WITHOUT adding a new entry.
 * Use for cosmetic/silent updates that should not create a Back stop.
 *
 * (Mirrors the legacy `setUrlParams` from common.js, kept here so all
 * deep-link plumbing lives in one module.)
 *
 * @param {Object<string, string|null>} params
 * @returns {void}
 */
export const replaceUrlParams = (params) => {
  const url = buildUrlWithParams(params);
  window.history.replaceState({}, '', url);
};

/**
 * Register a handler for `popstate` (Back/Forward). The handler is called
 * whenever the user navigates between history entries this code created via
 * `pushUrlParams`. Returns an unsubscribe function.
 *
 * @param {(event: PopStateEvent) => void} handler
 * @returns {() => void}
 */
export const onPopState = (handler) => {
  window.addEventListener('popstate', handler);
  return () => window.removeEventListener('popstate', handler);
};
