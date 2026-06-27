# Clone Check — QA / Run Harness

The QA harness is the single entry point for black-box testing of Clone Check.
It provides two commands:

| Command | Purpose | Fulfils |
| --- | --- | --- |
| `npm run qa:start` | Boots the app for testing and writes redacted logs to disk. | VC-QA-01 |
| `npm run qa:harness` | Drives a verdict end-to-end through the web path AND invokes the MCP `clone_check` tool programmatically. | VC-QA-02 |

Both commands write timestamped, secret-scrubbed logs to `.qa/logs/` (which is
git-ignored — see `.gitignore`).

---

## `npm run qa:start`

**One command** that brings the app up for testing and keeps an auditable
log on disk. Under the hood it spawns `vite` on port 3173 and pipes every
line of output through the secret-redaction layer
(`src/js/qa/redact.js`) before the line touches disk.

### Usage

```bash
npm run qa:start                 # default: vite on port 3173
npm run qa:start -- --port 4000  # override port (output still redacted)
QA_PORT=4173 npm run qa:start    # override port via env var
```

### What it does

1. Ensures `.qa/logs/` exists (creating it if needed).
2. Spawns `npx vite --port <port> --strictPort`.
3. Pipes the child's `stdout` and `stderr` line-by-line through
   `redactSecrets()` and into:
   - the operator's console (so you can watch the server boot), AND
   - a timestamped file at `.qa/logs/qa-start-<ISO>.log`.
4. Forwards `SIGINT` / `SIGTERM` to the child for a clean shutdown.

### Secret redaction

The redactor (`src/js/qa/redact.js`) is a pure data-in / data-out transform
with zero I/O of its own, so it is fully unit-covered (see
`src/js/__tests__/qa.test.js`). It scrubs:

- Classic GitHub tokens: `ghp_<36+ word chars>`
- Fine-grained GitHub tokens: `github_pat_<22+ word chars>`
- OAuth / app token prefixes: `gho_`, `ghs_`, `ghu_`, `ghr_`, `gha_`
- `Authorization: Bearer <token>` and `Authorization: token <token>` headers
- Generic `token=` / `secret=` / `password=` / `api_key=` assignments
  (case-insensitive, quoted or unquoted, value-only redaction)
- `GITHUB_TOKEN=…` / `GH_TOKEN=…` env-style lines

Redacted spans are replaced with the literal string `[REDACTED]`. When in
doubt the redactor errs toward redacting (false positives only cost log
readability; false negatives leak secrets).

### Log path is git-ignored

`.gitignore` excludes the entire `.qa/` directory, so redacted run logs
never enter version control.

---

## `npm run qa:harness`

A **scriptable** harness that drives a verdict end-to-end AND invokes the
MCP `clone_check` tool programmatically, in a SINGLE run. Both paths must
complete successfully or the harness exits non-zero.

### Usage

```bash
npm run qa:harness                            # fixture repo, auto-starts the server
npm run qa:harness -- --repo vercel/next.js   # any repo ref (still stubbed)
npm run qa:harness -- --no-start              # assume the dev server is already up
npm run qa:harness -- --port 3173             # override port
```

### What it does

The harness runs two paths sequentially and then verifies parity between
them.

#### 1. WEB PATH — input repo → rendered verdict

1. Probes `http://localhost:<port>/`. If nothing is answering and
   `--no-start` was not passed, it boots `vite` itself and waits for the
   server to come up.
2. `GET /` and asserts the response is the Clone Check app HTML (HTTP 200,
   well-formed `<html>/<body>`).
3. Renders the verdict the M3 verdict page will render, using the SAME pure
   `verdict()` function (`src/js/engine/verdict.js`) the web surface will
   use. This proves the engine renders end-to-end through the web stack.
   (Once M3 lands, this step will additionally navigate to the live verdict
   URL via `agent-browser`.)

#### 2. MCP PATH — `clone_check(repo)` → verdict

Invokes the `clone_check` tool programmatically via the stub in
`src/js/qa/mcp-stub.js`. The stub:

- parses the repo ref (`owner/name`, full URL, or git URL),
- resolves deterministic fixture `RepoData` (or accepts caller-supplied data),
- runs the pure `verdict()` engine,
- returns the same envelope the real M2 MCP server will return.

When the M2 MCP server lands, **only `src/js/qa/mcp-stub.js` changes** — it
will spawn the real MCP server and drive it via JSON-RPC over stdio. The
harness itself imports `cloneCheck` from a single path, so no harness
changes will be required for the cutover.

#### Parity check

After both paths complete, the harness compares the verdict `state` from
the web path against the state from the MCP path. A mismatch is a
regression of the VC-MCP-01 parity contract and exits with code 2.

### Outputs

- `.qa/logs/harness-<ISO>.log` — full redacted run log.
- `.qa/logs/harness-last.json` — machine-readable summary (paths, states,
  parity, timings). Stable filename so CI can pick it up.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Both paths completed and the parity check passed. |
| `1` | One of the paths failed (server didn't come up, HTTP error, etc.). |
| `2` | Both paths ran but the parity check failed (web vs MCP disagree). |

---

## Layout

```
qa/
└── scripts/
    ├── qa-start.mjs     # `npm run qa:start` — vite + redacted disk logs
    └── qa-harness.mjs   # `npm run qa:harness` — E2E driver
src/js/qa/
├── redact.js            # pure secret-redaction layer (unit-tested)
└── mcp-stub.js          # programmatic clone_check stub (unit-tested)
src/js/__tests__/
└── qa.test.js           # redaction + stub unit tests (VC-QA-01 / VC-QA-02)
```

The pure pieces (`redact.js`, `mcp-stub.js`) live under `src/js/qa/` so they
are importable from BOTH the Vitest unit suite AND the Node CLI scripts.
The CLI glue (`qa/scripts/*.mjs`) is verified end-to-end by running the
commands themselves.
