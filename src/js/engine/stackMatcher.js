/**
 * Clone Check — Stack-fit Matcher (F1.4 / VC-STACK-01).
 *
 * Pure function. Two jobs:
 *
 *   1. `detectStack()` — auto-detect framework chips from package.json +
 *      config files + file tree. Recognises the seven canonical chips:
 *      Next.js, React, Supabase, Tailwind, shadcn/ui, Stripe, Prisma.
 *
 *   2. `matchStack()` — visibly MATCH the detected chips against a saved
 *      3-chip stack (the user's first-run preference). Produces matches /
 *      misses / extras / fitScore for the stack-fit row in the verdict UI.
 *
 * Pure: zero DOM access, zero network I/O, zero clock reads.
 */

/* -------------------------------------------------------------------------
 * Canonical chip IDs + human labels.
 * ------------------------------------------------------------------------- */

/** The seven canonical chips. Sorted tests rely on this exact membership. */
export const STACK_CHIPS = Object.freeze([
  'next',
  'react',
  'supabase',
  'tailwind',
  'shadcn',
  'stripe',
  'prisma'
]);

/** Human-readable labels keyed by chip ID (used by the UI). */
export const STACK_CHIP_LABELS = Object.freeze({
  next: 'Next.js',
  react: 'React',
  supabase: 'Supabase',
  tailwind: 'Tailwind CSS',
  shadcn: 'shadcn/ui',
  stripe: 'Stripe',
  prisma: 'Prisma'
});

/* -------------------------------------------------------------------------
 * Per-chip detection rules.
 *
 * Each rule is a pure predicate over a normalized input view:
 *   { deps, devDeps, configFileNames, filePaths }
 * where:
 *   - deps / devDeps  are plain objects (package.json dependency maps)
 *   - configFileNames are bare filenames (e.g. "next.config.js")
 *   - filePaths       are full repo paths (e.g. "prisma/schema.prisma")
 * ------------------------------------------------------------------------- */

/** True if any key matching the regex appears in the dependency map. */
const hasDep = (deps, regex) =>
  !!deps && Object.keys(deps).some((k) => regex.test(k));

/** True if any filename in the list matches the regex. */
const hasFile = (names, regex) =>
  Array.isArray(names) && names.some((n) => regex.test(n));

const RULES = [
  {
    id: 'next',
    test: ({ deps, devDeps, configFileNames }) =>
      hasDep(deps, /^next$/i) ||
      hasDep(devDeps, /^next$/i) ||
      hasFile(configFileNames, /^next\.config\./i)
  },
  {
    id: 'react',
    test: ({ deps }) => hasDep(deps, /^react$/i)
  },
  {
    id: 'supabase',
    test: ({ deps }) => hasDep(deps, /^@supabase\//i)
  },
  {
    id: 'tailwind',
    test: ({ deps, devDeps, configFileNames }) =>
      hasDep(deps, /^tailwindcss$/i) ||
      hasDep(devDeps, /^tailwindcss$/i) ||
      hasFile(configFileNames, /^tailwind\.config\./i)
  },
  {
    id: 'shadcn',
    test: ({ deps, devDeps, filePaths }) =>
      hasDep(deps, /^class-variance-authority$/i) ||
      hasDep(devDeps, /^class-variance-authority$/i) ||
      hasDep(deps, /^@radix-ui\//i) ||
      hasDep(devDeps, /^@radix-ui\//i) ||
      hasFile(filePaths, /(^|\/)components\.json$/i)
  },
  {
    id: 'stripe',
    test: ({ deps }) =>
      hasDep(deps, /^stripe$/i) || hasDep(deps, /^@stripe\//i)
  },
  {
    id: 'prisma',
    test: ({ deps, devDeps, filePaths }) =>
      hasDep(deps, /^prisma$/i) ||
      hasDep(devDeps, /^prisma$/i) ||
      hasDep(deps, /^@prisma\/client$/i) ||
      hasFile(filePaths, /(^|\/)schema\.prisma$/i)
  }
];

/* -------------------------------------------------------------------------
 * Input normalization helpers
 * ------------------------------------------------------------------------- */

/**
 * Flatten a file tree into a list of path strings.
 * Accepts either:
 *   - an array of strings (already paths)
 *   - an array of { path } objects
 *   - an array mixing both
 * @param {Array} fileTree
 * @returns {string[]}
 */
function flattenPaths(fileTree) {
  if (!Array.isArray(fileTree)) return [];
  const out = [];
  for (const entry of fileTree) {
    if (typeof entry === 'string') {
      out.push(entry);
    } else if (entry && typeof entry.path === 'string') {
      out.push(entry.path);
    } else if (entry && typeof entry.name === 'string') {
      out.push(entry.name);
    }
  }
  return out;
}

/** Extract the bare filename from a path (last segment). */
function basename(p) {
  if (typeof p !== 'string') return '';
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/* -------------------------------------------------------------------------
 * detectStack — chip detection from package.json + config files + tree.
 *
 * @param {object|null|undefined} input
 *   @property {object} [packageJson]    parsed package.json
 *   @property {string[]} [configFiles]  bare config filenames
 *   @property {Array}    [fileTree]     file tree entries (strings | {path})
 * @returns {string[]} detected chip IDs (deduped, in STACK_CHIPS order).
 * ------------------------------------------------------------------------- */
export function detectStack(input) {
  const data = input || {};
  const pkg = data.packageJson || {};
  const deps = pkg.dependencies || null;
  const devDeps = pkg.devDependencies || null;

  const configFileNames = Array.isArray(data.configFiles)
    ? data.configFiles.map((c) => (typeof c === 'string' ? c : c && c.path) || '')
    : [];

  const filePaths = flattenPaths(data.fileTree);
  // Config files also count as paths for path-based rules (e.g. components.json).
  const allPaths = filePaths.concat(configFileNames);
  const allConfigNames = configFileNames.concat(filePaths.map(basename));

  const view = { deps, devDeps, configFileNames: allConfigNames, filePaths: allPaths };

  const detected = [];
  for (const chip of STACK_CHIPS) {
    const rule = RULES.find((r) => r.id === chip);
    if (rule && rule.test(view)) {
      detected.push(chip);
    }
  }
  return detected;
}

/* -------------------------------------------------------------------------
 * matchStack — visible match against a saved 3-chip stack.
 *
 * @param {object|null|undefined} input
 *   @property {object}  [packageJson]
 *   @property {string[]} [configFiles]
 *   @property {Array}   [fileTree]
 *   @property {string[]} savedStack   the user's saved 3-chip stack
 * @returns {{
 *   detected: string[],
 *   savedStack: string[],
 *   matches: string[],   // saved chips that ARE detected
 *   misses: string[],    // saved chips NOT detected
 *   extras: string[],    // detected chips NOT saved
 *   matchCount: number,
 *   savedCount: number,
 *   fitScore: number     // 0..1 = matchCount / savedCount (0 if no saved)
 * }}
 * ------------------------------------------------------------------------- */
export function matchStack(input) {
  const data = input || {};
  const savedStack = Array.isArray(data.savedStack) ? data.savedStack.slice() : [];

  const detected = detectStack({
    packageJson: data.packageJson,
    configFiles: data.configFiles,
    fileTree: data.fileTree
  });

  const matches = savedStack.filter((chip) => detected.includes(chip));
  const misses = savedStack.filter((chip) => !detected.includes(chip));
  const extras = detected.filter((chip) => !savedStack.includes(chip));

  const matchCount = matches.length;
  const savedCount = savedStack.length;
  const fitScore = savedCount > 0 ? matchCount / savedCount : 0;

  return {
    detected,
    savedStack,
    matches,
    misses,
    extras,
    matchCount,
    savedCount,
    fitScore
  };
}

export default { detectStack, matchStack };
