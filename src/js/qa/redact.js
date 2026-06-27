/**
 * Clone Check — secret-redaction layer for disk logs.
 *
 * The QA harness (VC-QA-01) writes every run's logs to `.qa/logs/`. Logs may
 * accidentally capture secrets from environment variables, GitHub tokens, or
 * Authorization headers — this module scrubs them BEFORE the line is written
 * to disk. It is a pure data-in / data-out transform with no I/O of its own,
 * so it is fully unit-testable.
 *
 * Design choices:
 *   - Conservative on purpose: when in doubt, redact. False positives only
 *     cost log readability; false negatives leak secrets.
 *   - Token-shaped patterns (ghp_, github_pat_, Bearer …) are matched
 *     regardless of context, so the redactor survives log-format changes.
 *   - Generic `token=` / `secret=` / `password=` assignments are matched
 *     case-insensitively against quoted or unquoted values.
 *   - `redactSecretsDeep` walks structured objects (JSON-serializable) and
 *     returns a REDACTED COPY so the original is never mutated.
 */

const REDACTED = '[REDACTED]';

/* -------------------------------------------------------------------------
 * Ordered redaction rules.
 *
 * Each rule is `[pattern, replacement]`. Patterns are applied in order; the
 * first match wins per overlapping span because regex replacement is
 * non-overlapping left-to-right.
 * ------------------------------------------------------------------------- */

const RULES = Object.freeze([
  // 1. Classic GitHub personal access tokens: ghp_<36+ word chars>
  [/\bghp_[A-Za-z0-9]{36,}\b/g, REDACTED],

  // 2. Fine-grained GitHub tokens: github_pat_<11 chars>_<22+ chars>
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, REDACTED],

  // 3. OAuth / app tokens: gho_, ghs_, ghu_, ghr_, gha_ prefixes
  [/\bgh[osubra]_[A-Za-z0-9]{36,}\b/g, REDACTED],

  // 4. Authorization: Bearer <token>  (covers bearer tokens of any shape)
  [/(Authorization\s*:\s*Bearer\s+)([^\s,"']+)/gi, (_m, p1) => `${p1}${REDACTED}`],

  // 5. Authorization: token <token>  (older GitHub header form)
  [/(Authorization\s*:\s*token\s+)([^\s,"']+)/gi, (_m, p1) => `${p1}${REDACTED}`],

  // 6. Generic secret-bearing assignments in env/config dumps:
  //    token="…", secret=…, password='…', api_key=…, etc.
  //    Redacts the value only; keeps the key for debuggability. The value
  //    char class excludes `[` and `]` so an already-redacted `[REDACTED]`
  //    span is never matched (no double-wrapping when a ghp_… token was
  //    scrubbed by an earlier rule).
  [
    /\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)\s*(:|=)\s*(['"]?)([^'"\s,;}\[\]]+)\3/gi,
    (_m, key, sep, q, val) => `${key}${sep}${q}${REDACTED}${q}`
  ],

  // 7. GITHUB_TOKEN=… / GH_TOKEN=… env-style lines (value form).
  [/\b(GITHUB_TOKEN|GH_TOKEN)\s*=\s*([^\s,"']+)/g, (_m, k) => `${k}=${REDACTED}`]
]);

/**
 * Redact known secret shapes from a single string.
 *
 * @param {string} input
 * @returns {string} The input with all matched secret spans replaced by
 *   `[REDACTED]`. Non-string input is returned unchanged (the caller decides
 *   what to do with it).
 */
export function redactSecrets(input) {
  if (typeof input !== 'string') return input;
  let out = input;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Deep-clone a JSON-serializable value with every string scrubbed by
 * {@link redactSecrets}. The input is NOT mutated.
 *
 * @param {unknown} value
 * @returns {unknown} A redacted deep copy.
 */
export function redactSecretsDeep(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactSecretsDeep);
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Redact key too — a secret-shaped key like `ghp_...` is suspicious.
      const rk = typeof k === 'string' ? redactSecrets(k) : k;
      out[rk] = redactSecretsDeep(v);
    }
    return out;
  }
  return value;
}

export default redactSecrets;
