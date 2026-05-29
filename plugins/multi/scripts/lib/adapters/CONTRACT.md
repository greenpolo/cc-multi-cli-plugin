# Adapter contract

Every CLI adapter in this directory exports a single `adapter` object with the
shape below. The companion's registry (`multi-cli-companion.mjs`) consumes only
this object, so any module that conforms is a drop-in CLI backend.

`test/unit/adapter-contract.test.mjs` enforces this shape — run `npm test` after
changing or adding an adapter.

## Shape

```js
export const adapter = {
  name: "codex",            // string — MUST equal the registry key for this CLI
  isAvailable,              // sync  (cwd) => { available: boolean, detail: string, version?: string|null }
  isAuthenticated,          // async (cwd) => { authenticated: boolean, ...adapter-specific }
  invoke,                   // async — run one turn (see below)
  cancel,                   // async (jobId) => { attempted, interrupted, transport, detail }
  getSession,               // function | undefined — optional session lookup
};
```

### `isAvailable(cwd) → { available, detail, version? }`
Synchronous binary/desktop detection. Never throws — report failures via
`available: false` and a human-readable `detail`.

### `isAuthenticated(cwd) → Promise<authStatus>`
Async login check. Returns at least `{ authenticated: boolean }`; adapters add
their own fields (`method`, `detail`, …).

### `invoke(cwd, prompt, options) → Promise<result>`
The primary turn function. `options` may include `model`, `role`, `effort`,
`sessionId`, `env`, `onNotification`, `onStream`, `onDiagnostic`. The result is an
object; by convention it carries `text` (joined assistant output) and `error`
(`null` on success), plus adapter-specific extras (`sessionId`/`threadId`,
`toolCalls`, `fileChanges`, …). On failure, set `error` rather than throwing, and
keep the result shape uniform so the companion's dispatch/render code stays generic
(`formatAdapterError` in the companion normalizes error objects).

### `cancel(jobId) → Promise<{ attempted, interrupted, transport, detail }>`
Best-effort interrupt. If the CLI has no cancel path, return
`{ attempted: false, interrupted: false, transport: null, detail: "..." }`.

### `getSession`
Optional. `undefined` when the adapter has no session-lookup concept.

## Adding a new CLI

1. Create `lib/adapters/<name>.mjs` exporting a conforming `adapter`.
2. Register it in the `ADAPTERS` map in `multi-cli-companion.mjs` and add it to the
   `--cli` usage string.
3. `npm test` — the conformance test will fail until the shape matches.
4. Add a live smoke test under `test/live` (or extend the existing harness) and a
   `CHANGELOG.md` entry.
