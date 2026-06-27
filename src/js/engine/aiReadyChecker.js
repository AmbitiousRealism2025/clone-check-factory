/**
 * Clone Check — AI-readiness Checker (F1.4 / VC-AIREADY-01).
 *
 * Pure function. Derives an "AI-readiness" badge from three signals:
 *
 *   1. Presence of AI-rules files (CLAUDE.md / AGENTS.md / .cursorrules / .cursor)
 *   2. README quality (length + structure: headings, install/code blocks)
 *   3. File-count modularity (a repo split across many files is more
 *      agent-traversable than one giant file)
 *
 * The output is worded as a LIKELIHOOD ("likely agent-friendly",
 * "probably agent-friendly", "agent may need more context") — never as the
 * asserted fact "your agent will grok this".
 *
 * Pure: zero DOM access, zero network I/O, zero clock reads.
 */

/* -------------------------------------------------------------------------
 * Canonical readiness levels.
 * ------------------------------------------------------------------------- */

export const AI_READINESS_LEVELS = Object.freeze({
  LIKELY: 'likely',     // AI-rules files present (the dominant signal)
  PROBABLY: 'probably', // no AI-rules files, but README + modularity both good
  LOW: 'low',           // sparse signals — agent may need more context
  UNKNOWN: 'unknown'    // no contents data available
});

/* -------------------------------------------------------------------------
 * Thresholds for the heuristic signals.
 * ------------------------------------------------------------------------- */

const README_MIN_LENGTH = 80;          // chars (excluding whitespace)
const README_MIN_HEADINGS = 2;         // markdown headings (#, ##, …)
const MODULAR_FILE_COUNT = 8;          // files >= this → modular

/* -------------------------------------------------------------------------
 * Signal scoring
 * ------------------------------------------------------------------------- */

/**
 * README quality heuristic. Returns true if the README is non-trivial:
 * long enough AND structured (multiple headings, or install/code blocks).
 * @param {string|null|undefined} readme
 * @returns {boolean}
 */
function isGoodReadme(readme) {
  if (typeof readme !== 'string' || readme.length === 0) return false;
  const nonSpace = readme.replace(/\s+/g, '');
  if (nonSpace.length < README_MIN_LENGTH) return false;

  // Count markdown headings.
  const headings = readme.match(/^\s{0,3}#{1,6}\s+\S/gm);
  const headingCount = headings ? headings.length : 0;
  if (headingCount >= README_MIN_HEADINGS) return true;

  // Fallback: an install/code block ("```") or an "npm install"/"npm i" hint.
  if (/```/.test(readme)) return true;
  if (/npm\s+i(nstall)?/i.test(readme)) return true;

  return false;
}

/**
 * Modularity heuristic. A repo with many files is more agent-traversable.
 * @param {number|undefined} fileCount   explicit count if available
 * @param {Array|undefined} fileTree     used to derive a count
 * @returns {boolean}
 */
function isModular(fileCount, fileTree) {
  let count = typeof fileCount === 'number' ? fileCount : -1;
  if (count === -1) {
    count = Array.isArray(fileTree) ? fileTree.length : 0;
  }
  return count >= MODULAR_FILE_COUNT;
}

/* -------------------------------------------------------------------------
 * The pure AI-readiness checker.
 *
 * @param {object|null|undefined} input
 *   @property {object} [contents]
 *     @property {string[]} [aiRulesFiles]
 *     @property {string}   [readme]
 *     @property {number}   [fileCount]
 *     @property {Array}    [fileTree]
 * @returns {{label:string, level:string, signals:{aiRules:boolean, readmeQuality:boolean, modularity:boolean}}}
 * ------------------------------------------------------------------------- */
export function checkAiReady(input) {
  const data = input || {};
  const contents = data.contents;

  if (!contents) {
    return {
      label: 'AI-readiness: unknown (no contents data)',
      level: AI_READINESS_LEVELS.UNKNOWN,
      signals: { aiRules: false, readmeQuality: false, modularity: false }
    };
  }

  const aiRulesFiles = Array.isArray(contents.aiRulesFiles)
    ? contents.aiRulesFiles
    : [];
  const hasAiRules = aiRulesFiles.length > 0;
  const readmeQuality = isGoodReadme(contents.readme);
  const modularity = isModular(contents.fileCount, contents.fileTree);

  // --- Resolve level -----------------------------------------------------
  // AI-rules files are the dominant signal — their presence alone yields
  // "likely" wording. Without them, "probably" requires BOTH a solid README
  // and modularity. Otherwise the badge hedges to "may need more context".
  let level;
  if (hasAiRules) {
    level = AI_READINESS_LEVELS.LIKELY;
  } else if (readmeQuality && modularity) {
    level = AI_READINESS_LEVELS.PROBABLY;
  } else {
    level = AI_READINESS_LEVELS.LOW;
  }

  // --- Compose the likelihood-worded label -------------------------------
  let label;
  if (hasAiRules) {
    const list = aiRulesFiles.slice(0, 3).join(', ');
    const extra = [];
    if (readmeQuality) extra.push('solid README');
    if (modularity) extra.push('modular structure');
    const tail = extra.length > 0 ? ` + ${extra.join(' + ')}` : '';
    label = `AI-readiness: has ${list}${tail} — likely agent-friendly`;
  } else if (level === AI_READINESS_LEVELS.PROBABLY) {
    label =
      'AI-readiness: no AI-rules files but README is solid and structure is modular — probably agent-friendly';
  } else {
    label =
      'AI-readiness: no AI-rules files detected — agent may need more context';
  }

  return {
    label,
    level,
    signals: { aiRules: hasAiRules, readmeQuality, modularity }
  };
}

export default checkAiReady;
