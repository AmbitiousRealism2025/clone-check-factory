import { searchRepositories } from './api.js';
import {
  Storage,
  formatNumber,
  debounce,
  getUrlParam,
  updateRateLimitDisplay,
  getRequiredElement
} from './common.js';
import { createPageController, pushUrlParams, onPopState } from './shell.js';
import { 
  renderRepoGrid, 
  renderPagination, 
  handleFavoriteToggle, 
  handlePaginationClick,
  handleCollectionClick,
  handleCollectionKeydown,
  initCollectionPickerCloseHandler
} from './components/RepoGrid.js';

createPageController({ page: 'search', showSettings: true });

const searchInput = getRequiredElement('search-input');
const searchBtn = getRequiredElement('search-btn');
const languageFilter = getRequiredElement('language-filter');
const starsFilter = getRequiredElement('stars-filter');
const sortFilter = getRequiredElement('sort-filter');
const repoGrid = getRequiredElement('repo-grid');
const resultsSection = getRequiredElement('results-section');
const resultsCount = getRequiredElement('results-count');
const emptyState = getRequiredElement('empty-state');
const loadingState = getRequiredElement('loading-state');
const errorState = getRequiredElement('error-state');
const errorMessage = getRequiredElement('error-message');
const pagination = getRequiredElement('pagination');
const settingsBtn = getRequiredElement('settings-btn');
const settingsModal = getRequiredElement('settings-modal');
const settingsClose = getRequiredElement('settings-close');
const githubTokenInput = getRequiredElement('github-token');
const saveTokenBtn = getRequiredElement('save-token');
const clearTokenBtn = getRequiredElement('clear-token');
const retryBtn = document.getElementById('retry-btn'); // Optional - may not exist

let currentPage = 1;
let currentQuery = '';
let totalResults = 0;

const showState = (state) => {
  emptyState.classList.add('hidden');
  loadingState.classList.add('hidden');
  errorState.classList.add('hidden');
  resultsSection.classList.add('hidden');
  
  switch (state) {
    case 'empty':
      emptyState.classList.remove('hidden');
      break;
    case 'loading':
      loadingState.classList.remove('hidden');
      break;
    case 'error':
      errorState.classList.remove('hidden');
      break;
    case 'results':
      resultsSection.classList.remove('hidden');
      break;
  }
};

const performSearch = async (page = 1, { updateUrl = true } = {}) => {
  const query = searchInput.value.trim();
  if (!query) {
    showState('empty');
    return;
  }
  
  currentQuery = query;
  currentPage = page;
  
  // Only push a new history entry for user-initiated searches. On popstate
  // restoration (Back/Forward) the URL is already correct, so we skip —
  // otherwise we'd re-push and break the Back stack (VC-SHELL-01).
  if (updateUrl) {
    pushUrlParams({
      q: query,
      lang: languageFilter.value,
      stars: starsFilter.value,
      sort: sortFilter.value,
      page: page > 1 ? page : null
    });
  }
  
  showState('loading');
  
  try {
    const result = await searchRepositories(query, {
      language: languageFilter.value,
      minStars: parseInt(starsFilter.value) || 0,
      sort: sortFilter.value,
      page: page
    });
    
    totalResults = result.data.total_count;
    resultsCount.innerHTML = `<strong>${formatNumber(totalResults)}</strong> repositories found`;
    
    renderRepoGrid(repoGrid, result.data.items, { dateField: 'updated_at', datePrefix: 'Updated' });
    renderPagination(pagination, currentPage, totalResults);
    showState('results');
    
    if (result.rateLimit) {
      updateRateLimitDisplay(result.rateLimit);
    }
  } catch (error) {
    errorMessage.textContent = error.message;
    showState('error');
  }
};

const initFromUrl = ({ updateUrl = true } = {}) => {
  const query = getUrlParam('q');
  const lang = getUrlParam('lang');
  const stars = getUrlParam('stars');
  const sort = getUrlParam('sort');
  const page = getUrlParam('page');
  
  if (query) searchInput.value = query;
  if (lang) languageFilter.value = lang;
  if (stars) starsFilter.value = stars;
  if (sort) sortFilter.value = sort;
  
  if (query) {
    performSearch(parseInt(page) || 1, { updateUrl });
  }
};

searchBtn.addEventListener('click', () => performSearch(1));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') performSearch(1);
});

const debouncedSearch = debounce(() => performSearch(1), 500);
languageFilter.addEventListener('change', debouncedSearch);
starsFilter.addEventListener('change', debouncedSearch);
sortFilter.addEventListener('change', debouncedSearch);

repoGrid.addEventListener('click', (e) => {
  handleFavoriteToggle(e);
  handleCollectionClick(e);
});
repoGrid.addEventListener('keydown', handleCollectionKeydown);
pagination.addEventListener('click', (e) => handlePaginationClick(e, performSearch));
retryBtn?.addEventListener('click', () => performSearch(currentPage));
initCollectionPickerCloseHandler();

// Theme toggle is bound by createPageController(); nothing to do here.

settingsBtn.addEventListener('click', () => {
  githubTokenInput.value = Storage.getToken() || '';
  settingsModal.classList.add('open');
});

settingsClose.addEventListener('click', () => {
  settingsModal.classList.remove('open');
});

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) {
    settingsModal.classList.remove('open');
  }
});

saveTokenBtn.addEventListener('click', () => {
  const token = githubTokenInput.value.trim();
  Storage.setToken(token);
  settingsModal.classList.remove('open');
});

clearTokenBtn.addEventListener('click', () => {
  Storage.setToken(null);
  githubTokenInput.value = '';
});

// Deep-linkable state (VC-SHELL-01): restoring URL params on Back/Forward.
// On popstate the URL is already correct, so we restore without re-pushing.
onPopState(() => initFromUrl({ updateUrl: false }));

initFromUrl({ updateUrl: false });
