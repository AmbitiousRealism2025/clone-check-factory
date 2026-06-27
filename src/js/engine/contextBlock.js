/**
 * Clone Check — Deterministic Context Block Assembler (F1.5 / VC-CONTEXT-01).
 *
 * Assembles a BOUNDED, paste-ready agent brief from the verdict and its raw
 * signals. The block is what gets copied into Cursor / Claude Code when the
 * user clicks "Copy context for your agent".
 *
 * Required sections (all present, all bounded):
 *   1. README excerpt
 *   2. Detected stack
 *   3. Verdict
 *   4. Setup gotchas grep'd from README + issues
 *   5. Key files
 *
 * Hard guarantees (asserted in contextBlock.test.js):
 *
 *   VC-CONTEXT-01 (determinism) — Identical input yields byte-identical output.
 *     The function never reads a clock, never touches the DOM, never fetches.
 *     All ordering is deterministic: arrays are sorted before emission.
 *
 *   VC-CONTEXT-01 (bounded) — The block never expands into whole-repo ingest.
 *     Every section is capped by a hard limit (lines, items, bytes), and the
 *     final block is enforced against an absolute byte ceiling.
 *
 * Pure module: zero DOM, zero fetch, zero Date.now.
 */

import { STACK_CHIP_LABELS } from './stackMatcher.js';

/* -------------------------------------------------------------------------
 * Hard bounds — the block is a *brief*, never a repo ingest.
 *
 * These are intentionally tight. The point is to give an agent enough to act
 * without swallowing the entire repository.
 * ------------------------------------------------------------------------- */

export const CONTEXT_BLOCK_LIMITS = Object.freeze({
  README_EXCERPT_LINES: 30,     // cap on excerpt line count
  README_EXCERPT_CHARS: 2000,   // cap on excerpt character count
  MAX_GOTCHAS: 10,              // cap on gotcha bullets
  MAX_GOTCHA_LEN: 200,          // cap on each gotcha line (chars)
  MAX_KEY_FILES: 20,            // cap on key files list
  MAX_KEY_FILE_LEN: 200,        // cap on each key file line (chars)
  MAX_ISSUES_SCANNED: 200,      // cap on issue titles scanned for gotchas
  MAX_BLOCK_BYTES: 16000        // absolute ceiling on the assembled block
});

/* -------------------------------------------------------------------------
 * Section header constants (stable strings → deterministic output).
 * ------------------------------------------------------------------------- */

const HEADER = [
  '# Clone Check context block',
  '',
  'Paste-ready brief assembled by the Clone Check engine.',
  'This is a heuristic check, not a security audit — verify before you ship.',
  ''
].join('\n');

const SECTION_README = '## README excerpt';
const SECTION_STACK = '## Detected stack';
const SECTION_VERDICT = '## Verdict';
const SECTION_GOTCHAS = '## Setup gotchas';
const SECTION_KEY_FILES = '## Key files';

const NO_EXCERPT = '(no README available)';
const NO_GOTCHAS = 'No setup gotchas detected.';
const NO_KEY_FILES = '(no file tree available)';
const NO_STACK = 'No stack chips detected.';

/* -------------------------------------------------------------------------
 * Gotcha keyword vocabulary.
 *
 * Lines / issue titles matching any of these (case-insensitive) are treated
 * as setup gotchas. The vocabulary is deliberately narrow so we surface
 * genuine onboarding friction, not feature requests.
 * ------------------------------------------------------------------------- */

const GOTCHA_KEYWORDS = Object.freeze([
  'must',
  'required',
  'require',
  'ensure',
  'note:',
  'warning',
  'error',
  'fail',
  'fails',
  'failed',
  'missing',
  'before you',
  'before running',
  'copy .env',
  'env var',
  'environment variable',
  'secret',
  'api key',
  'token',
  'install',
  'prerequisite',
  'gotcha',
  'caveat',
  'caution'
]);

/* -------------------------------------------------------------------------
 * Small pure helpers
 * ------------------------------------------------------------------------- */

/**
 * Coerce possibly-absent input into a stable empty object.
 * Lets the rest of the module assume `data.x` is safe to read.
 */
function normalize(input) {
  return input || {};
}

/**
 * Truncate a string to `max` chars, appending an ellipsis if cut.
 * Never throws; safe for non-strings (returns '').
 */
function truncate(value, max) {
  if (typeof value !== 'string') return '';
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Collapse a string to a single line, trim, and bound its length.
 * Used for gotcha bullets derived from README lines or issue titles.
 */
function cleanLine(line, max) {
  if (typeof line !== 'string') return '';
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return truncate(collapsed, max);
}

/**
 * Strip markdown noise from a README line for a cleaner gotcha bullet.
 * Removes leading heading hashes, list markers, and code fences.
 */
function stripMarkdown(line) {
  if (typeof line !== 'string') return '';
  let out = line.trim();
  out = out.replace(/^#{1,6}\s+/, '');     // leading heading hashes
  out = out.replace(/^\s*[-*+]\s+/, '');   // leading list markers
  out = out.replace(/^```.*$/, '');         // code fences → empty
  out = out.replace(/[`*]/g, '');           // inline code/bold markers
  return out.trim();
}

/**
 * True if the line matches a gotcha keyword (case-insensitive).
 */
function isGotcha(line) {
  if (typeof line !== 'string' || line.length === 0) return false;
  const lower = line.toLowerCase();
  return GOTCHA_KEYWORDS.some((kw) => lower.includes(kw));
}

/* -------------------------------------------------------------------------
 * Section builders — each returns a deterministic string.
 * ------------------------------------------------------------------------- */

/** @param {object} data normalized input */
function buildReadmeExcerpt(contents) {
  const readme = contents && typeof contents.readme === 'string' ? contents.readme : '';
  if (readme.length === 0) {
    return `${SECTION_README}\n\n${NO_EXCERPT}\n`;
  }
  // Bound by lines first, then by chars.
  const allLines = readme.split(/\r?\n/);
  const lines = allLines.slice(0, CONTEXT_BLOCK_LIMITS.README_EXCERPT_LINES);
  let excerpt = lines.join('\n');
  const truncatedByLines = allLines.length > lines.length;
  if (excerpt.length > CONTEXT_BLOCK_LIMITS.README_EXCERPT_CHARS) {
    excerpt = truncate(excerpt, CONTEXT_BLOCK_LIMITS.README_EXCERPT_CHARS);
  }
  const note = truncatedByLines ? '\n\n_(README truncated — see full README in the repo.)_' : '';
  return `${SECTION_README}\n\n${excerpt}${note}\n`;
}

/**
 * @param {object} verdictObj the verdict object (carries stackFit)
 * Deterministic: chips are emitted in STACK_CHIPS-canonical order via labels.
 */
function buildStackSection(verdictObj) {
  const stackFit = verdictObj && verdictObj.stackFit ? verdictObj.stackFit : null;
  const detected = stackFit && Array.isArray(stackFit.detected) ? stackFit.detected : [];
  if (detected.length === 0) {
    return `${SECTION_STACK}\n\n${NO_STACK}\n`;
  }
  // Map chip IDs to human labels; unknown IDs fall back to the raw id.
  // Stable order: emit in the order of `detected` (already canonical from
  // the stack matcher, which sorts by STACK_CHIPS).
  const lines = detected.map((id) => `- ${STACK_CHIP_LABELS[id] || id}`);
  return `${SECTION_STACK}\n\n${lines.join('\n')}\n`;
}

/** @param {object} verdictObj */
function buildVerdictSection(verdictObj) {
  const state = (verdictObj && verdictObj.state) || 'Not enough signal';
  const what = (verdictObj && verdictObj.whatThisIs) || '(no summary available)';
  const disclaimer = (verdictObj && verdictObj.disclaimer) || '';
  const trust = verdictObj && verdictObj.trustInWords
    ? verdictObj.trustInWords
    : {};
  const aiReady = (verdictObj && verdictObj.aiReady) || 'AI-readiness: unknown';
  const slop = (verdictObj && verdictObj.slop) || 'slop: unknown';

  const lines = [
    `- State: ${state}`,
    `- Summary: ${what}`,
    `- ${trust.maintenance || 'maintenance: unknown'}`,
    `- ${trust.license || 'license: unknown'}`,
    `- ${trust.busFactor || 'bus factor: unknown'}`,
    `- ${slop}`,
    `- ${aiReady}`
  ];
  if (disclaimer) lines.push(`- ${disclaimer}`);
  return `${SECTION_VERDICT}\n\n${lines.join('\n')}\n`;
}

/**
 * Grep README + issue titles for setup gotchas.
 * Deterministic: results are sorted (deduped) before emission.
 *
 * @param {string} readme
 * @param {Array}  issues  array of {title, number}
 */
function buildGotchasSection(readme, issues) {
  const found = [];

  // From README: scan non-empty lines, score those matching a gotcha keyword.
  if (typeof readme === 'string' && readme.length > 0) {
    const lines = readme.split(/\r?\n/);
    for (const raw of lines) {
      if (!isGotcha(raw)) continue;
      const stripped = stripMarkdown(raw);
      if (stripped.length === 0) continue;
      found.push(cleanLine(`README: ${stripped}`, CONTEXT_BLOCK_LIMITS.MAX_GOTCHA_LEN));
    }
  }

  // From issue titles: bounded scan.
  if (Array.isArray(issues)) {
    const slice = issues.slice(0, CONTEXT_BLOCK_LIMITS.MAX_ISSUES_SCANNED);
    for (const issue of slice) {
      if (!issue || typeof issue.title !== 'string') continue;
      if (!isGotcha(issue.title)) continue;
      const num = typeof issue.number === 'number' ? `#${issue.number}` : '';
      found.push(cleanLine(`Issue ${num}: ${stripMarkdown(issue.title)}`.trim(), CONTEXT_BLOCK_LIMITS.MAX_GOTCHA_LEN));
    }
  }

  if (found.length === 0) {
    return `${SECTION_GOTCHAS}\n\n${NO_GOTCHAS}\n`;
  }

  // Deterministic ordering: sort lexicographically, then dedupe.
  const sorted = found.slice().sort();
  const deduped = [];
  for (const line of sorted) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== line) {
      deduped.push(line);
    }
  }
  const capped = deduped.slice(0, CONTEXT_BLOCK_LIMITS.MAX_GOTCHAS);
  const note = deduped.length > capped.length
    ? `\n\n_(${deduped.length - capped.length} more gotchas truncated — see issues/README.)_`
    : '';
  return `${SECTION_GOTCHAS}\n\n${capped.map((l) => `- ${l}`).join('\n')}${note}\n`;
}

/**
 * Build the key files list. Deterministic ordering:
 *   1. Always include AI-rules files first (CLAUDE.md, AGENTS.md, .cursor*)
 *   2. Then canonical config files (package.json, README*, .env.example)
 *   3. Then the rest of the file tree, sorted lexicographically.
 *
 * Always bounded by MAX_KEY_FILES.
 *
 * @param {object} contents
 */
function buildKeyFilesSection(contents) {
  const fileTree = contents && Array.isArray(contents.fileTree) ? contents.fileTree : [];
  const aiRules = Array.isArray(contents.aiRulesFiles) ? contents.aiRulesFiles : [];

  if (fileTree.length === 0 && aiRules.length === 0) {
    return `${SECTION_KEY_FILES}\n\n${NO_KEY_FILES}\n`;
  }

  // Flatten file tree into path strings (handle both string and {path} shapes).
  const paths = new Set();
  for (const entry of fileTree) {
    const p = typeof entry === 'string' ? entry : (entry && entry.path) || (entry && entry.name);
    if (typeof p === 'string' && p.length > 0) paths.add(p);
  }
  for (const p of aiRules) {
    if (typeof p === 'string' && p.length > 0) paths.add(p);
  }

  const all = Array.from(paths);

  // Priority buckets — within each bucket, sort lexicographically.
  const aiSet = new Set(aiRules.filter((p) => typeof p === 'string' && p.length > 0));
  const canonicalNames = new Set([
    'package.json', 'readme.md', 'readme', 'license',
    '.env.example', 'tsconfig.json', 'next.config.js', 'next.config.mjs',
    'tailwind.config.js', 'tailwind.config.ts'
  ]);

  const bucketAi = [];
  const bucketCanonical = [];
  const bucketRest = [];
  for (const p of all) {
    const base = p.lastIndexOf('/') === -1 ? p : p.slice(p.lastIndexOf('/') + 1);
    const baseLower = base.toLowerCase();
    if (aiSet.has(p)) {
      bucketAi.push(p);
    } else if (canonicalNames.has(baseLower)) {
      bucketCanonical.push(p);
    } else {
      bucketRest.push(p);
    }
  }
  bucketAi.sort();
  bucketCanonical.sort();
  bucketRest.sort();

  const ordered = bucketAi.concat(bucketCanonical).concat(bucketRest);
  const capped = ordered.slice(0, CONTEXT_BLOCK_LIMITS.MAX_KEY_FILES);

  const lines = capped.map((p) => `- ${truncate(p, CONTEXT_BLOCK_LIMITS.MAX_KEY_FILE_LEN)}`);
  const note = ordered.length > capped.length
    ? `\n\n_(${ordered.length - capped.length} more files truncated.)_`
    : '';
  return `${SECTION_KEY_FILES}\n\n${lines.join('\n')}${note}\n`;
}

/* -------------------------------------------------------------------------
 * The public pure assembler.
 *
 * @param {object|null|undefined} input
 *   @property {string}              [asOf]      caller-injected date (unused
 *                                              except as a passthrough — the
 *                                              disclaimer comes from verdict)
 *   @property {object}              [meta]      repo metadata
 *   @property {object}              [verdict]   verdict object from verdict()
 *   @property {object}              [contents]  README, packageJson, fileTree, …
 *   @property {Array}               [issues]    issues list (for gotcha grep)
 * @returns {string} deterministic, bounded paste-ready block.
 * ------------------------------------------------------------------------- */
export function assembleContextBlock(input) {
  const data = normalize(input);
  const meta = normalize(data.meta);
  const verdictObj = normalize(data.verdict);
  const contents = normalize(data.contents);
  const issues = Array.isArray(data.issues) ? data.issues : [];

  const readme = contents && typeof contents.readme === 'string' ? contents.readme : '';

  const sections = [
    HEADER,
    buildReadmeExcerpt(contents),
    buildStackSection(verdictObj),
    buildVerdictSection(verdictObj),
    buildGotchasSection(readme, issues),
    buildKeyFilesSection(contents)
  ];

  // Join with single blank lines between sections.
  let block = sections.join('\n');

  // Absolute ceiling: if (somehow) the block still exceeds the byte budget,
  // hard-truncate it. This is the last line of defence against any future
  // unbounded growth, and guarantees the "bounded regardless of repo size"
  // contract holds even if every other cap is loosened.
  if (block.length > CONTEXT_BLOCK_LIMITS.MAX_BLOCK_BYTES) {
    block = truncate(block, CONTEXT_BLOCK_LIMITS.MAX_BLOCK_BYTES);
  }

  return block;
}

export default assembleContextBlock;
