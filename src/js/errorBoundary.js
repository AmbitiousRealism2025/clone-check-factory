import { showToast } from './common.js';

const ERROR_MESSAGES = {
  network: 'Network error. Please check your connection.',
  rateLimit: 'API rate limit reached. Please wait a moment.',
  notFound: 'Resource not found.',
  // VC-PLATFORM-03: never the misleading "Check your token" copy for what is
  // actually a rate-limit or a private-repo permission failure.
  forbidden: 'Access denied — this repository may be private or require a token with appropriate scope.',
  default: 'Something went wrong. Please try again.'
};

const classifyError = (error) => {
  const message = error?.message?.toLowerCase() || '';
  
  if (message.includes('rate limit')) return 'rateLimit';
  if (message.includes('network') || message.includes('fetch')) return 'network';
  if (message.includes('not found') || message.includes('404')) return 'notFound';
  if (message.includes('forbidden') || message.includes('403')) return 'forbidden';
  
  return 'default';
};

/**
 * Resolves the user-facing message for an error.
 *
 * For rate-limit errors thrown by `fetchWithRetry`, the underlying message
 * already carries the honest "try again in N seconds" countdown derived from
 * `Retry-After` / `x-ratelimit-reset`. We surface THAT verbatim rather than
 * the generic fallback so the UI never strips the countdown (VC-PLATFORM-03).
 *
 * @param {Error} error
 * @returns {string}
 */
const resolveUserMessage = (error) => {
  const errorType = classifyError(error);
  if (errorType === 'rateLimit' && error?.message && /try again in \d+ seconds/i.test(error.message)) {
    return error.message;
  }
  return ERROR_MESSAGES[errorType];
};

const handleError = (error, context = 'Unknown') => {
  console.error(`[ErrorBoundary] ${context}:`, error);
  
  const userMessage = resolveUserMessage(error);
  
  showToast(userMessage, 'error');
};

export const initErrorBoundary = () => {
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    handleError(event.reason, 'Unhandled Promise Rejection');
  });

  window.addEventListener('error', (event) => {
    if (event.filename && !event.filename.includes(window.location.origin)) {
      return;
    }
    handleError(event.error, 'Uncaught Error');
  });

  console.log('[ErrorBoundary] Initialized');
};

export { handleError };
