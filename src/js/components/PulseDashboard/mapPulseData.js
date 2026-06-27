/**
 * mapPulseData — the SINGLE shared mapping from `calculateAllMetrics` output
 * to the `createPulseDashboard` data shape.
 *
 * Why this exists (F1.3 / bugs #2 and #9):
 *   `detail.js` and `pulse.js` previously each hand-rolled their own mapping
 *   and they DIVERGED:
 *     - detail.js passed `busFactor: calculatedMetrics.metrics.busFactor` (the
 *       whole object), whose `.distribution` was undefined → "No contributor
 *       data".
 *     - pulse.js passed `busFactor.distribution = metrics.busFactor.sparklineData`
 *       (a numeric array) → destructured by `createContributorBars` into
 *       `{login: 'Unknown', percentage: 0}` for every row.
 *
 *   One mapping, used on both surfaces, kills both bugs. The bus-factor
 *   contributor bars now always receive real `{login, percentage}` rows from
 *   `calculateBusFactor().distribution` (VC-DATA-04).
 *
 * This module is DOM-free and deterministic — safe to unit-test in isolation
 * and reuse by any surface (web detail, web pulse, future MCP receipts view).
 */

/**
 * Map a `calculateAllMetrics` result into the dashboard data shape consumed by
 * `createPulseDashboard`.
 *
 * @param {{metrics: Object, overall: Object}} calculated - Output of
 *   `calculateAllMetrics({ repo, participation, issues, prs, contributors, events, releases })`.
 * @param {Object} [options]
 * @param {string} [options.repoName] - Optional override for the displayed repo
 *   name. Falls back to `calculated` repo name or `'Unknown'`.
 * @returns {Object} Dashboard data with the six canonical metric keys plus
 *   `overallStatus` and `repoName`.
 */
export const mapPulseData = (calculated, options = {}) => {
  const safe = calculated && typeof calculated === 'object' ? calculated : { metrics: {}, overall: {} };
  const metrics = (safe.metrics && typeof safe.metrics === 'object') ? safe.metrics : {};
  const overall = (safe.overall && typeof safe.overall === 'object') ? safe.overall : {};

  const { repoName } = options;

  return {
    // commitVelocity — standard metric card (value/trend/sparkline/status).
    commitVelocity: {
      value: metrics.velocity?.value,
      trend: metrics.velocity?.trend,
      status: metrics.velocity?.status ?? 'stable',
      sparklineData: metrics.velocity?.sparklineData ?? []
    },
    // issueHealth — temperature card.
    issueHealth: {
      temperature: metrics.issues?.temperature,
      trend: metrics.issues?.trend,
      status: metrics.issues?.status ?? 'stable'
    },
    // prHealth — funnel card.
    prHealth: {
      funnel: metrics.prs?.funnel,
      status: metrics.prs?.status ?? 'stable'
    },
    // busFactor — contributor bars. VC-DATA-04: ALWAYS real {login, percentage}
    // rows from calculateBusFactor().distribution. Never the numeric
    // sparklineData, never undefined.
    busFactor: {
      distribution: Array.isArray(metrics.busFactor?.distribution)
        ? metrics.busFactor.distribution
        : [],
      status: metrics.busFactor?.status ?? 'stable'
    },
    // releaseFreshness — freshness gauge card.
    releaseFreshness: {
      score: metrics.freshness?.score,
      daysSincePush: metrics.freshness?.daysSincePush,
      status: metrics.freshness?.status ?? 'stable'
    },
    // communityHealth — standard metric card (momentum).
    communityHealth: {
      value: metrics.momentum?.value,
      trend: metrics.momentum?.trend,
      status: metrics.momentum?.status ?? 'stable',
      sparklineData: metrics.momentum?.sparklineData ?? []
    },
    overallStatus: overall.status ?? 'stable',
    repoName: repoName ?? safe.repoName ?? 'Unknown'
  };
};

export default mapPulseData;
