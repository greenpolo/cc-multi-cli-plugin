# Changelog

Entries record changes when they were made, including superseded decisions.
See [ARCHITECTURE.md](ARCHITECTURE.md) for current direction and
[README.md](README.md) for current capabilities.

## Unreleased

- **Stop cutting Claude responses at three minutes.** The gateway no longer applies
  an implicit 180-second deadline to Claude passthrough, matching the OpenAI and Zen
  routes. Long streamed Claude turns, including server-side advisor calls, previously
  ended mid-response ("Server error mid-response"; `claude-multi -p` reported the
  truncated text as success). Client disconnects and explicit gateway timeouts still
  abort upstream requests.

## 0.2.1 — 2026-09-22

- Explain missing native worker spawn acknowledgements with the unsupported
  Workflow path and Agent-tool recovery guidance, while retaining refusal before
  provider dispatch. Document that limitation and explicitly mark WSL2 as
  untested pending host verification (#32, #21).

- **Add the September 2026 model releases to the default pickers.** Codex
  workers `openai-luna` and `openai-sol` now run `gpt-6-luna` and `gpt-6-sol`,
  and the no-Claude fallback starts on `gpt-6-luna`; `openai-terra` stays on
  `gpt-5.6-terra`. The Cursor picker shows Grok 4.7 instead of Grok 4.6, which
  remains routable through `MULTI_CURSOR_EXTRA_MODELS`; Claude models stay off
  the Cursor picker because Claude Code already provides them. Zen adds
  `gpt-6-luna` and `gpt-6-sol` to its catalog; its default picker is unchanged. Grok
  Build already discovers Grok 4.7 from `grok models`.

- **Preserve Cursor recovery and bound attachment ownership.** A failed completion
  save retains the pending native run ID even when the subsequent uncertainty
  write succeeds. Idle eviction releases record locks without deleting native
  state; disk-only replay retains no idle locks. Temporary billing resumes share
  the SDK capacity budget. Legacy `pending` records migrate safely, and conflicting
  native identities report recovery paths. Shared normalization again rejects
  malformed messages explicitly. The opt-in OpenAI instructions probe now checks
  active session choices rather than removed workflow defaults.

- **Remove inherited workflow rules and correct maintained documentation.** The
  OpenAI prompt is now a short Claude Code compatibility note; it no longer
  supplies personal assumptions, writing-style bans, or restrictions on planning
  and delegation. Session instructions govern those choices, and reversibility
  does not imply authorization. The legacy Claude-agent fleet ban is removed;
  direct imports are a convention rather than an absolute restriction. Claude
  Mods remains the explicit UI/extensibility requirement, without requiring
  gateway routes for local rendering changes. Login/setup skills now distinguish
  POSIX, PowerShell, and cmd commands. Correct model examples, native hook and
  continuation descriptions, privacy/accounting disclosures, Grok usage and
  login guidance, issue forms, verification scope, and illustration labeling.
  This supersedes the older OpenAI workflow profile described below; historical
  entries are records of previous decisions, not current instructions.

- **Native turn ownership and completion are shared.** All three harnesses use
  scoped turn leases for replay, recovery, and dispatch, with one loading gate
  and separate persisted records and live attachments. Shutdown keeps busy locks
  until the owning turn finishes. Replies are archived before later dispatch;
  completion and replay events commit together before terminal delivery.

- **Claude Mods remains the UI and extensibility boundary.** The gateway accepts
  narrow harness contracts and provider-owned usage callbacks while existing Mods
  hooks own model/worker rows, policy, progress, compaction, and usage UI.
  `docs/claude-mods.md` provides the local reference required by both contributor
  instruction files. Cursor now uses shared conversation/media normalization
  instead of constructing an OpenAI request just to prepare its prompt.

- **Shared harness plumbing.** Grok, Antigravity, and Cursor now share their
  session store, exchange registry, response builder, and notice text. Grok and
  Antigravity also share the native process runner and text prompt preparation;
  Cursor retains its SDK and image-aware prompt format. The initial extraction
  introduced six modules under `plugins/multi-core/src/gateway/harness-*.ts`.
  Each provider still owns its
  event grammar, CLI argument construction, usage accounting, and SDK agent
  lifecycle. The initial extraction through `6c3a97f` reduced production code by
  117 lines; most of the provider-file reduction moved into the shared modules.

- **Antigravity and Cursor refuse a prompt sent while a run is in flight.**
  Both harnesses previously answered a second prompt for the same identity
  with a bare `Error`, which `server.ts` reported as a retryable 502. A retry
  could resume the native conversation with stale history and forward a paid
  turn a second time. They now throw the same `HarnessBusyError` Grok already
  used, which is reported as a deterministic 400: the prompt is refused
  outright instead of risking a duplicate paid turn. Grok's behaviour is
  unchanged.

- **Cursor session record moved to version 3.** The record now carries the
  shared session header (`provider`, `identity`, `interrupted`, `response`,
  `replay`, `policyIdentity`) used by every harness. Version 2 records now migrate
  under both old and current filename locks, preserving native agents and pending
  run recovery. This supersedes the initial extraction's fresh-agent fallback.
  The original file is preserved; conflicting old/current native identities fail
  explicitly instead of choosing one conversation silently.

- **A Grok spawn failure the OS called transient is now retryable.** The shared
  native runner records the operating system's own `code` for a process it could
  not create, and Grok's CLI layer now forwards it from a failure delivered on
  the child's `error` event as well as from a synchronous spawn throw. `EAGAIN`,
  `EMFILE`, `ENFILE`, `ENOMEM` and `ETXTBSY` therefore take the transient branch
  and are answered 502 (retryable) where they were previously 400. That was
  always the intent of the transient list; only the event path had missed it.
  A missing binary stays a deterministic 400.

- **Cursor replays hold the session record's lock.** Cursor's replay path now
  reads the record through the shared store's turn lease, which takes the
  record's lock file and caches the record until the harness closes; the
  previous replay path read the file without the lock. Holding it is what keeps
  a replay, an interrupted-state recovery and a dispatch from interleaving on
  one record. Cursor's 32-agent budget counts attached SDK handles and pending
  attachment reservations. Disk-only replays cannot evict a live agent, and
  simultaneous creations cannot exceed the budget. In-flight billing queries
  protect their attached handles from eviction, and read-only billing can still
  find a legacy record before its first migrated turn.

- **Cursor's token estimate fallback changed.** When the SDK reports no usage
  for a turn, the output token estimate is now `ceil(content length / 4)`,
  matching the shared `HarnessResponse` estimate the other harnesses already
  used, instead of Cursor's previous `o200k_base` tokenizer estimate.

- **Grok on the README banner.** The generated banner lists Grok Build alongside
  the other native harnesses, using the official Grok mark as vector paths from
  grok.com, recolored with `currentColor` like the neighbouring marks and credited
  in [docs/assets/README.md](docs/assets/README.md). Providers now ring the mascot
  at equal angles instead of stacking in two columns, so an odd provider count
  stays symmetric about the hub. No raster image and no request at render time.

- **Grok Build as a native coding harness.** `multi-grok` runs the official `grok`
  CLI inside Claude Code with the subscription account login, exposing the
  advertised models in `/model` and one named worker per model. Claude's
  permission mode travels in the run arguments: the native toolset is bounded
  with `--tools` and execution is gated with deny rules whose syntax matches
  Claude Code's own and which outrank every mode, including Bypass. No global
  hook is installed and nothing is written to the user's Grok configuration.
  The contract was captured from the binary rather than its documentation, which
  disagrees with it on three points: the streaming format is plain NDJSON and not
  ACP session updates, `--permission-mode plan` removes no tool, and
  `--disallowed-tools` accepts an unknown name and runs the tool anyway. Every
  announced toolset is therefore checked against the policy and an unenforced
  removal fails the run. MCP tools join the toolset once their servers connect,
  whatever the allowlist holds, so their execution is denied by rule and their
  exposure is documented in [docs/grok.md](docs/grok.md). The gateway chooses the
  native session identity before the run starts, records it as soon as the CLI
  speaks, resumes with an interruption notice after a run without a terminal
  event, and refuses an answer returned on another session. `XAI_API_KEY` is
  removed from every run so billing stays on the account login. Deny genres are
  coarser than native tool names — `Edit(*)` also refuses the `write` tool — so a
  rule is only sent when none of the tools it reaches was granted. The allowlist
  is not exact either, so every ungranted tool is removed by name as well, through
  the one alias the CLI needs (`run_terminal_command` is removed as
  `run_terminal_cmd`). A policy the CLI did not apply, or a CLI that cannot start
  because its binary is missing or its path is denied, is reported as a request
  error so the session does not retry a paid run; a start the operating system
  refused for want of processes, handles or memory stays retryable, since nothing
  ran and nothing was billed. Failure advice reads `401` and `429` as statuses only
  where the message presents them as such, so a line count or a file name no longer
  sends the user to re-login. A
  prompt sent while a worker is still answering is refused rather than queued
  behind it: that prompt was written before the running turn answered, so its
  history stops at the previous assistant message and resuming with it would send
  the running turn to the CLI a second time. Cursor and Antigravity refuse the
  same way. Claude's tool, MCP, skill and subagent catalogues are no longer
  forwarded: measured on a live session they were 72,704 characters of a 95,852
  character prompt, and they name capabilities the provider cannot call. Every
  other system reminder is forwarded, because the CLI reaches it no other way —
  the project's `CLAUDE.md` and the user's own, the environment and repository
  context, Auto Mode notices, hook output, and recalled memories — and a block
  Multi does not recognise is forwarded rather than dropped. Request identity
  ignores every reminder, so a retry carrying only a refreshed block is recognised
  as the same request instead of paying for a second run.

- Size Antigravity sessions to the provider's real context window. Picker rows and
  named workers took their window from the conservative `behavesAs` profile, so every
  Antigravity model reported 200K and long sessions compacted early. Gemini rows now
  carry a `[1m]` tag on the model ID, which Claude reads before it consults `behavesAs`
  and matches on the untagged spelling, so the window widens without adopting a profile
  that advertises effort levels `agy` does not have. The tag never reaches `agy`:
  `selectAntigravityModel()` strips it, and worker selection compares untagged spellings.
  Only families with a verified window are tagged, because `agy models` reports no
  capacity metadata: Gemini 3.x accepts 1,048,576 tokens, while GPT-OSS 120B accepts
  131,072 and the Claude models served here carry no 1M entitlement.
  `MULTI_DISABLE_1M_CONTEXT=1` opts out, and the opt-out is reversible: a selection saved
  in either spelling resolves to whichever row the picker currently offers, so turning the
  tag off cannot leave `MULTI_MODELS` naming a model the launcher refuses to start. A saved
  or explicit plain model ID is moved onto the tagged row, so `--model` and a restored
  selection get the same window as the picker; the rewrite lands on the last `--model` the
  caller spelled, which is the one Claude resolves. An advertised effort variant is tagged
  from the provider rather than from the picker, since the picker collapses variants into
  one synthesized row and a launch can still name the variant itself. Because two spellings
  name one native model, they are compared in the untagged spelling wherever a model ID is
  an identity: the Antigravity request digest, so a spelling change cannot miss a completed
  exchange and dispatch it twice, and the worker and harness consistency checks, so a
  spawn that names a model without the tag is not refused. `/multi-core:setup --models`
  accepts the tagged spelling the picker displays and persists the untagged one, which
  stays valid whichever way the tag is set later.

- Admit Claude settings with the validator of the harness that will run them. Settings
  discovery validated the merged rules with the Cursor translator on every launch, so a
  launch without Cursor was refused for rules Cursor cannot map but the running harness
  can: `permissions.deny: ["WebSearch", "WebFetch"]` stopped every Antigravity dispatch
  with `Native Cursor cannot enforce Claude tool rule WebSearch`, although Antigravity
  maps both to `search_web` and `read_url_content`. `checkCursorSettings()` now takes a
  `validate` callback, and a `cursorToolRules` option that defers the per-file Cursor tool
  check to it, including on the managed-policy path. One admission result is shared by every
  native provider, so a launch with both harnesses is judged by the one that rejects the
  least and Cursor re-validates on its own dispatch, where the rejection belongs and where
  it can name the file. That choice is only safe while Antigravity's and Grok's admitted tool
  vocabularies each contain Cursor's, which three separate tables maintain by hand, so a test
  now asserts both containments. Structural admission, `permissions.ask`, hooks and sandbox
  checks still run per file, and Cursor keeps its own validator (#33).

- Start native Cursor workers on macOS 27. Managed policy discovery recognized
  an absent `com.anthropic.claudecode` preferences domain only from the
  `does not exist` message of earlier macOS releases. macOS 27 words it
  `Error: Domain 'com.anthropic.claudecode' not found.`, so a Mac without
  managed policy was treated as a failure: every native worker was refused with
  `cannot observe managed policy via defaults`. Both wordings now mean absent;
  any other `defaults` failure still stops the worker (#30).

- Retry temporary-directory teardowns on Windows through a shared test helper.
  Windows can still hold a handle on a file shortly after the process that wrote
  or executed it exits, and `fs.rm` retries `EBUSY` only when `maxRetries` is
  set, so a passing run could fail on cleanup. `test/temporary.ts` now owns the
  removal and the 46 teardowns across 24 files use it, including the live Cursor
  harness that already retried on its own; removals performed deliberately in
  the middle of a test are unchanged.

- Report counts the same way on every machine locale. `toLocaleString()` without
  an argument follows the host, so the launcher's argument-limit message read
  "32 041" on a French Windows and "32,041" on an English one: the pinned
  expectation in `native-launcher.test.ts` failed for contributors whose machine
  is not in English, and `/multi-usage` grouped Cursor token totals differently
  per host. Both now pass `en-US`, the convention receipts already used, and a
  test covers the grouping so it cannot drift back.

- Send Antigravity prompts of 6 KiB or more through stream-json stdin on
  Windows instead of the `-p` argument. Windows caps a command line at 32,767
  characters, and at 8,191 when a `.cmd` shim runs through `cmd.exe`, so prompts
  between roughly 8 KiB and the previous 128 KiB threshold failed with `spawn
  ENAMETOOLONG` before `agy` started. POSIX keeps the 128 KiB threshold.

- Start the gateway on non-English Windows. Managed policy discovery recognized
  an absent `HKLM`/`HKCU` policy only from the English `reg.exe` message, so a
  localized message (for example fr-FR) was treated as a failure and the
  launcher exited before any model was reachable. An unrecognized `reg` failure
  now asks PowerShell, whose error categories are locale-independent, to
  distinguish an absent key or value from a real failure. English machines keep
  the single `reg` query; genuine failures still stop the gateway (#25).

- Let explicit model selections reach the full connected Cursor and Zen catalogs,
  including models outside the curated picker defaults. `--models all` now saves
  an explicit full-catalog choice; existing installs without a saved selection
  keep the compact provider defaults. `--models +<ids>` extends the saved
  selection or the curated defaults. Selected models still control registered
  workers, and effort aliases remain callable while announced once per model.

- Bound registered workers to the selected model-picker rows before starting
  Claude, retaining effort aliases for selected models. Hidden models no longer
  populate Claude's native worker catalog and rely solely on gateway text
  filtering. Register Cursor display tools only when a Cursor harness is
  available, avoiding those extra schemas in Claude/OpenAI/Zen-only launches.

- Keep provider boundaries aligned with execution. Claude, OpenAI, and Zen
  workers record prompt identity while Cursor and Antigravity load full managed
  settings policy at harness prompts or when a harness worker is requested.
  Multi's permission observation hook no longer vetoes Claude tools. OpenAI
  actions still use their originating account for automatic review. Deferred
  schemas are sent to direct providers only after discovery or use, with tool
  references preserved across turns.

- Restore on-demand tool loading when launching through Multi's local gateway.
  Claude otherwise disables tool search for a custom API address and can fill
  most of a helper's context with unused tool descriptions, causing repeated
  compaction and stalled work. Explicit `ENABLE_TOOL_SEARCH` preferences remain
  respected.

- Leave Claude, OpenAI, and Zen compaction to Claude Code without consulting Multi's
  gateway. Child conversations use their own observed model, never the parent's
  provider. Cursor and Antigravity compaction retains its tool-free authorization.

- Invite a bug report when a worker refusal looks like a defect. Worker spawn
  and start refusals now carry the issue-template link alongside the gateway's
  own reason, conditioned on the refusal not being a permission the user chose,
  so an ordinary denial does not turn into an issue and nothing is filed on the
  user's behalf.

- Stop blocking prompts on permission admission. A prompt whose policy could not
  be admitted was rejected outright, which was unrecoverable by anything the user
  could type: no engine hook fires on a permission-mode change, so toggling modes
  could not re-admit either, and the mode only travels on the next prompt — the
  blocked one. Admission now passes the prompt through. The permission hook
  already rebuilds the parent context from the live mode on the turn's first tool
  call, and until it does every native worker spawn is denied with the gateway's
  own reason, and a spawn whose mode no longer matches an older snapshot is still
  refused as inconsistent. Nothing runs under an unadmitted or stale policy (#20).

- Recover policy admission after `/clear`. Detaching a session makes the gateway
  forget its mode, but the hooks module kept the old generation, so every later
  prompt was refused as stale and blocked with `Multi policy is not ready; submit
  the prompt again.` with nothing able to resync it. The module now forgets the
  generation on `session.detach`, and a refused begin adopts the gateway's own
  answer even when that answer is that it holds no generation at all. An
  unreachable gateway still fails closed, and a matching generation is still
  never re-read (#20).

- Draw the `/multi-usage` pane again. Its provider tabs passed
  `autoFocus: false` for every unselected tab, but the prop is typed
  `true | absent`, so the whole client tree failed validation and the pane
  showed `JSX element <Button key="openai"> autoFocus is true or absent`
  instead of usage. The flag is now present only on the selected tab.

- Restore missing parent permission context from the next Claude tool call. The
  gateway now re-runs its settings-policy admission with the hook's current mode
  and workspace, so worker spawning recovers when prompt admission was missed.
  Recovery waits only within the hook budget and remains unavailable when the
  real settings policy cannot be loaded; it never invents unrestricted tools or
  falls back to bypass mode (#20).

- Recover the policy generation after a hooks-module reload. The module kept
  the gateway's mode generation in memory only; a reload (or any desync) left
  it behind the gateway's, so `/multi/mod/policy` refused every later prompt as
  stale and each submission was blocked with `Multi policy is not ready; submit
  the prompt again.` with nothing able to resync it. A refused begin now reads
  the gateway's own mode generation once and retries; a matching generation
  still never re-reads it, and admission still fails closed when the gateway
  holds no generation to adopt.

- Report the gateway's own reason when a worker is refused. Worker admission
  replies that were not 2xx were discarded, so every refusal reached the user as
  the generic `Multi worker policy was not acknowledged.` and hid recoverable
  causes such as `Claude permission mode is unavailable; submit a new prompt`.
  Spawn denials, worker-start blocks, and prompt-snapshot blocks now carry the
  gateway message, and a non-JSON body reports its status instead. A refused
  reply contributes only that reason, so a non-2xx status still fails closed
  whatever its body claims (#20).

- Add a session-only quota-aware model selection toggle to `/multi-usage`.
  An optional main-agent hook suggests the least-used suitable subscription
  on main-agent `Agent`/`Task` calls before tool execution. Guidance is advisory: no model overrides, spawn
  restrictions, or waiting for quota resets.

- Show subscription quota for Codex, Cursor, Zen Go, and Antigravity in
  `/multi-usage`, including provider reset times. Antigravity uses native
  headless account commands and also reports AI credits; Cursor retains
  per-agent billing alongside its account quota. Missing Go entitlement,
  failed lookups, and unavailable prepaid Zen balance are explicit.

- Add a native `/multi-usage` menu for provider quotas, billed spend where
  available, session tokens, and receipts, with optional per-invocation JSONL receipts through `MULTI_RECEIPTS_FILE`.
  Receipts preserve model, effort, provider, endpoint, count source, and replay
  accounting, with incomplete outcomes for interrupted runs. Codex quota windows
  come from its native account API; Cursor charges come from the SDK. Providers
  without a connected billing interface are explicitly marked unavailable.
- Use Cursor SDK token counters in Claude responses and preserve native usage
  during recovery. Report Antigravity count provenance and reasoning totals;
  keep Cursor billed usage and spend separate from runtime token counts.

- Accept rotated Zen reasoning ciphertext at terminal reconciliation while still
  rejecting changes to visible reasoning, fixing interrupted tool streams.
- Preserve native Auto-mode classifier policy in provider reviews and enforce its
  hard-block section as mandatory restrictions. Recognize native worker handback
  in the live check.
- Allow tool-free compaction immediately after restoring a session, before a new
  prompt has supplied its permission snapshot. Keep unknown workers rejected.
- Repair live Zen usage comparisons to include auxiliary model requests and
  explicitly select its provider on fresh-process resume.

- Fix `multi login openai`, `multi login cursor`, `multi login antigravity` and the
  no-provider `claude` pass-through failing with `spawn <command> ENOENT`. The
  foreground process runner read its empty default options as an empty environment
  map, so children were spawned without `PATH`. `run()` now accepts options only and
  inherits the parent environment unless one is supplied. (#18)

## 0.2.0 — 2026-09-16

- Let setup name the launch command (`--command <name>`, default `claude-multi`) and persist the `/model` rows to show (`--models all|none|<ids>`). Choices survive setup reruns, renames remove the previous shim, and `multi` stays reserved. Naming the command `claude` is allowed with a warning; nested runs inside a Multi session then pass through to the real executable. The setup skill and the agent install guide ask both questions with the defaults offered.

- Run the launcher when Claude's plugin cache is a symlink to a checkout. The entry-module guard added with the Windows command-line limit compared the argv spelling against Node's real-path module URL, so `claude-multi` exited silently without starting Claude.

- Limit named Cursor workers to picker rows, shorten worker announcements, and reject Windows launcher command lines above the platform ceiling with provider size diagnostics. Representative four-provider worker definitions remain under 30,000 bytes; off-Windows command-line behavior is covered through injected platform tests.

### Documentation

- Feature an editable SVG demo of Fable 5.1 coordinating GPT-5.6 Luna, Grok 4.6,
  and Gemini 3.8 Flash workers, retaining its original live Luna terminal capture
  and recording the editing details in the asset notes.

- Add README navigation, CI status, feature highlights, provider documentation links,
  and expandable setup details. Add a contributor quick start and pull-request
  template; refresh issue forms for all four integrations and remove outdated
  project maturity labels.

- Rewrite the README as a short install-and-use page and move provider detail into
  `docs/openai.md`, `docs/cursor.md`, `docs/zen.md`, `docs/antigravity.md` and
  `docs/permissions.md`. `ARCHITECTURE.md` and `AGENTS.md` describe the current
  system without roadmap or history. Antigravity uses consistent naming
  in the picker, worker descriptions and plugin manifests.

### Cross-platform runtime

- Replace the Linux-only `flock` state lock with a portable PID-aware state lock shared by native runs. Cross-platform process-tree cancellation now handles POSIX and Windows processes, and executable resolution honors `PATHEXT` and Windows `.cmd` shims.
- Admit Cursor managed policy on macOS through managed preferences, on Windows through the registry, and in WSL through the Linux policy source. Unsupported policy controls continue to fail explicitly.
- Extend wrapper installation to macOS Bash/Zsh/fish and Windows PowerShell plus `cmd` shims. Antigravity now uses platform-specific hook and config paths: the POSIX guard remains on Unix, while Windows invokes Node directly. Zen and Cursor state use `LOCALAPPDATA` on Windows.
- Run `npm run check` in the GitHub Actions matrix on Ubuntu, macOS, and Windows, and enforce LF text checkouts with `.gitattributes`. Offline tests pass on all three operating systems once the CI matrix confirms them; live provider logins, hooks, TTY rendering, and native harness runs on macOS and Windows are still pending.

### Claude Mods runtime

- Precompute worker catalogs at launch and refresh settings/catalog policy through
  bounded gateway generation jobs. Worker offers hide unknown definitions; spawns
  validate parent, model, workspace and generation, and native dispatch waits for
  child-start acknowledgement. Generated `--agents` remains in use.
- Show Cursor lifecycle, model, worker and elapsed time through native status output.
  Gateway-streamed tool rows remain display-only. Model/effort telemetry forwards
  the engine stream unchanged; provider execution stays in the gateway.
- Prepare bounded native compaction summaries outside the hook budget and consume
  them only for the same transcript prefix, instructions, scope and generation.
  Cancellation discards late results. Replace `classic.PreCompact` with explicit
  generation-scoped authorization for core fallback; all Antigravity summary tools
  remain denied, and missing authorization skips compaction.
- Bound mod requests to 32 KiB, remove unused retained row results, bound session and
  pending-action state, and preserve compaction restrictions for workers.

- Make Claude Mods the only display-row and permission synchronization path, removing the MCP display server and row store. The launcher requires Claude Code 2.1.272 or newer and enables function hooks; wrapped rows and mode, worker and compaction snapshots use authenticated loopback routes with generation-based fail-closed acknowledgements.

### Session lifetime

- Disable whole-session supervisor handoff in Multi and reject `--bg`,
  `--background`, `attach` and `respawn`. Claude's supervisor loses the launcher's
  worker definitions and gateway environment, then can run hooks against deleted
  temporary settings. Saved-session `--resume` and ordinary background subagent
  tasks remain supported; a resumed conversation receives a fresh gateway.

### Neutral worker prompts

- Replace the per-provider worker system prompts with one neutral sentence. Claude
  Code rejects an empty subagent prompt, so workers now carry no behavioral rules
  of their own; provider instruction profiles and Claude's native subagent prompt
  govern them. The old text barred "external coding CLIs", which blocked a worker
  from driving `claude -p` as an experiment target.

### Native Claude Auto passthrough

- Forward Claude-only sessions' Auto classifier requests directly to Anthropic,
  preserving native model selection, retry behavior and request formats. Native
  Auto no longer depends on the external-review parser or pending-action match.
- Keep originating-provider review checks for sessions with external models or
  workers; OpenAI reviews never fall back to Anthropic.

### Non-blocking permission-sync failures

- Report hook transport, authentication and snapshot failures without rejecting
  user prompts or worker completion notifications once native permissions have
  been marked unavailable. Preserve native admission checks: a failed sync cannot
  reuse an older parent/worker permission snapshot; successful sync restores it.
- Identify the hook event before endpoint validation so configuration failures no
  longer misleadingly say `event=unknown`. Keep endpoint authentication, redirect
  rejection and bounded transport. No legacy hook-command fallback is added;
  relaunch the updated launcher to load the current hook arguments.
- Verify real Claude delivers a synthetic completion notification through an HTTP
  503 sync failure, plus normal worker/resume hooks and stale-snapshot regressions.

### OpenAI workflow instructions

- Adapt the Codex Astra instruction template for OpenAI main models and workers:
  act directly by default, enter Plan mode only on explicit request, and delegate
  only with user or project/worker authorization. Respect an already-active Plan mode.
- Preserve Claude runtime policies, custom instructions, tools and compaction
  requests. The OpenAI workflow profile supersedes generic behavioral defaults;
  other providers and the independent reviewer retain their existing instructions.
- Count the adapted prompt in the local token estimate. This changes workflow
  guidance, not model context limits, tool availability or permission enforcement.
- Add regression coverage confirming Claude system prompts remain unchanged for
  main sessions, workers and token counting after OpenAI requests in the same session.
- Verify direct work, active Plan restrictions and explicitly requested delegation
  with three bounded live Astra requests; synthetic tool calls are inspected only.

### Picker compatibility, native effort and hook diagnostics

- Add `behavesAs` to generated external picker rows while preserving provider IDs,
  labels, user settings and ordinary Claude tiers. Use conservative 200K client
  profiles, not newer profiles that imply native 1M context; their extra-high UI
  capability remains a documented limitation. Explicit effort workers stay registered.
- Group Antigravity's advertised low/medium/high suffix variants behind base picker
  routes and native `/effort`, with matching base workers and no fabricated variants.
  Preserve native variant workers, independent unsuffixed models and thinking identities.
- Bind permission-sync hooks to the launcher's explicit local control endpoint,
  independent of hook API URL overrides. Validate address/token, reject redirects,
  retain bounded authenticated requests and blocking failure exit codes, and report
  sanitized endpoint/event/status/transport diagnostics with relaunch guidance.
  The historical `fetch failed` cause is not established by this change.
- Add catalog, launcher and hook subprocess regressions; extend the local-only real
  Claude fixture for low/high native effort, 200K context and saved-session hook
  continuation without provider inference. Cursor extras still select base rows,
  retain non-effort parameters and explicit presets, and keep advertised Fast disabled.

### Smaller worker announcements and OpenAI cache affinity

- Advertise one provider worker per finalized `/model` picker model, without
  separate reasoning rows. All registered models and effort variants remain
  callable through the native subagent tool; built-in and custom agents are unchanged.
- Compact known native catalog announcements at the gateway, not the stored
  transcript or worker registry. Unknown formats pass through unchanged.
- Add opaque OpenAI `prompt_cache_key` affinity scoped by session, worker and model,
  stable across gateway restarts when a session identity is available.
- Verify with four live Astra requests: hidden rows absent, all fixture workers
  registered, stable cache keys across two resumes, and 99.0%/98.8% warm cache reuse.
  Cache reuse does not establish subscription-quota savings.

### Provider-owned automatic review

- Route GPT main-session and worker actions to the OpenAI account's automatic
  reviewer even when Claude is signed in. Preserve native Claude review and Zen's
  existing Claude-backed review; unavailable GPT review never falls back to Claude.
- Correlate classifier requests with pending tool origins across model switches
  and headerless worker requests. Observe Claude response tools while preserving
  passthrough bytes, and retain explicit deny/ask rules and provider-scoped denials.
- Add mixed-provider routing and authenticated reviewer discovery regressions, plus
  a live authenticated-branch fixture that uses no real Claude credentials.

- Add Antigravity and OpenCode Zen to the SVG banner alongside Cursor and OpenAI
  Codex, preserving the black background and Anthropic orange styling. Remove
  status labels and space connector dots clear of provider marks and names.

### Marketplace installation

- Add selectable OpenAI, Cursor, Zen and Antigravity plugins with automatic core
  dependency installation, plus setup, login/connect, status and uninstall skills.
- Package the complete runtime in core so cached installs run without a checkout.
  Add a reversible Bash/Zsh startup wrapper providing `claude-multi` to launch
  Multi and `multi` to manage it; it never replaces or shadows `claude`, follows
  installed core updates, and always launches the gateway when a core and a
  provider are enabled, otherwise passing every command through to the real
  `claude` on PATH.
- Avoid probing disabled providers and reject their model routes. Preserve native
  provider-owned login; Zen key entry stays outside the Claude transcript.
- Document human and agent installation paths and verify real isolated-cache
  installation alongside offline wrapper, routing and credential-storage tests.

- Move shared runtime into `plugins/multi-core/src/` and each provider into
  `plugins/multi-<provider>/src/`. Launch with `node plugins/multi-core/src/launcher.ts`.
  Update imports, checks and documentation without changing provider behavior;
  independent marketplace packaging and setup remain subsequent work.

- Document manual and agent installation paths, provider-owned authentication,
  and the planned marketplace setup/login commands separately from current behavior.

### Antigravity native CLI

- Add opt-in official CLI models and named incoming workers, with native login,
  streamed progress, persisted conversation resume and completed-request replay.
- Run `agy` with `--dangerously-skip-permissions` in every supported mode and
  let Claude Code's permission mode and tool rules take precedence: a scoped
  native pre-tool hook denies exactly the native tools mapped from Claude's
  disallowed/missing-from-allowlist tools, plus shell/write/edit/notebook-edit
  and delegation tools in Plan, plus native child-agent and MCP tools always.
  No reviewer in any mode. A live probe against CLI 1.1.28 confirmed a
  PreToolUse hook deny wins regardless of hook order, against an explicit allow
  from another hook, and under `--dangerously-skip-permissions`; other active
  PreToolUse hooks are no longer treated as a precedence conflict.
- Keep native actions display-only and reject unsupported policy/content. Resume the
  newest turn on the native conversation with a notice instead of refusing an
  interrupted or history-changed session. Cache reuse remains best-effort; native compaction has limited validation.
- Persist the native conversation id and an interrupted flag as soon as a run's
  `init` event reports one, before its terminal result arrives, so a gateway
  crash mid-run still resumes the native conversation on the next request
  instead of starting a fresh one.
- Authenticate main-session compaction through Claude's PreCompact hook and deny
  native tools while generating the outer summary.

### Cursor harness simplification

- Admit Claude settings, plugins and worker definitions that carry `PreToolUse`
  or `PermissionRequest` hooks. Those hooks never run for native Cursor or
  Antigravity tools, so they no longer block native execution. Found while
  dogfooding with an observability hook installed in user settings.
- Likewise admit a user or workspace `.cursor/hooks.json`; isolated SDK settings
  never run it. A `.cursor/permissions.json` still refuses, since that is deny
  policy the SDK would silently drop.
- Stop forwarding Claude's `system` content to the Cursor SDK prompt. Cursor's
  own system prompt remains active; the request is one fixed preamble plus the
  conversation text, with no "session instructions" JSON field or saved
  instructions hash.
- Resume the newest turn on the persistent SDK agent once a session has a prior
  response: everything after the last assistant message, matching the
  Antigravity continuation rule. A request whose history ends with an assistant
  message, or that has no new user message after it, fails explicitly. If the
  outer history no longer contains the previous response, stream a notice and
  continue on the native record instead of refusing or replaying rewritten
  history. Delete the anchor-matching and hook-confirmed-prompt reconciliation
  path and the now-unused `PermissionContext.submission`/`promptHash` fields.
  Bump the saved session schema to version 2; an older or foreign-version
  session file is ignored and the session starts fresh (the native SDK agent
  is never deleted).
- Resume interrupted runs instead of refusing them. Keep the SDK run recovery
  (`Agent.getRun`/`wait`): a readable terminal result stays the stronger path
  and is persisted as a completed turn. When recovery is impossible (no run ID,
  the run is still running, `wait` is unsupported, or its identity does not
  match) or the run did not finish, the session stays marked `interrupted`
  instead of throwing or writing a `.failure.json`; the next request prepends
  and streams "[Cursor] The previous turn was interrupted. Report its state and
  do not repeat completed actions." before dispatching fresh work, and the flag
  clears once a run produces a terminal result. Delete `session.failed`, the
  "refusing to replay native work/actions" errors, and all `.failure.json`
  reads and writes; a non-finished run now propagates as an ordinary error and
  an identical retry simply runs again. The pending run ID is still persisted
  as soon as the SDK reports it, before a terminal result arrives.

### Model picker

- Add `MULTI_MODELS` to limit and order external `/model` entries across providers.
  Preserve explicit selections and workers; use the first visible model as the
  no-Claude-login default when no model is selected.

### OpenCode Zen direct gateway

- Default the Zen picker to DeepSeek V4 Pro/Flash, Kimi K3, GLM 5.3/Flash, and
  Muse Spark 1.3. Keep the broader catalog available through explicit selection.

- Add the current non-deprecated free Zen models, including Muse Spark Responses,
  and `MULTI_ZEN_MODELS` to filter Zen without hiding subscription providers.

- Add isolated Zen API-key discovery, explicit GPT Responses and selected Chat
  Completions models, native workers and a `--zen-models` capability listing.
- Preserve native Claude tools/permissions and explicit bypass; gate unavailable
  Zen automatic review without borrowing another provider's reviewer.
- Keep stable Zen session/cache affinity across restarts, model-owned reasoning
  replay and deterministic prefixes. Report upstream cache reads/writes separately
  from fresh input; recognize Responses cache-write usage for accurate accounting.
- Add offline translation, routing, permissions, cancellation and launcher checks,
  plus bounded opt-in live cache, resume, switching and compaction validation.


### Repository release preparation

- Replace the raster banner with an accessible, self-contained SVG generated from
  one provider list. Preserve the original monospace title, pixel mascot and
  provider-spoke composition on pure black with Anthropic orange. Show only
  implemented integrations, lay out added providers automatically and check
  generated output in CI.
- Remove the unused Cursor/OpenCode headless and ACP adapters, process helpers,
  fixtures, tests, vendored SDK and bundle builder. Drop the ACP SDK, esbuild and
  zod as direct development dependencies and remove obsolete tooling exceptions.
- Refresh README, development guidance and GitHub issue templates for the current
  native gateway. Correct privacy documentation for persistent Cursor state and
  Codex-owned credential renewal; preserve historical data-removal guidance.
- Move the cross-plugin kernel file lock (`state-lock.ts`, now exporting
  `lockStateFile`) and local token estimator (`tokens.ts`) out of the Cursor and
  OpenAI plugins into `plugins/multi-core/src/gateway/`, and move the
  `GatewayFetch` type out of `gateway/server.ts` into a new `gateway/fetch.ts` so
  no provider imports the HTTP server. No behavior change; Cursor and Antigravity
  keep sharing the file lock, and OpenAI, Zen, Cursor and Antigravity keep sharing
  the token estimator.

### OpenAI gateway reliability

- Report the local input estimate in `message_start` for OpenAI and Zen responses.
  Claude Code reads its per-turn token count from that event, so worker totals
  no longer collapse to the last turn's output tokens; the terminal
  `message_delta` still carries the provider's real usage.
- Renew expiring Codex ChatGPT credentials through the official CLI app-server.
  Share concurrent renewal and retry an HTTP 401 once, checking account identity;
  never replay accepted inference or expose credential-bearing RPC errors.
- Remove the default three-minute OpenAI gateway deadline while retaining client
  cancellation and explicit limits. Anthropic passthrough keeps its existing timer.
- Recover terminal-only Responses text, tools and encrypted reasoning, including
  `response.done`. Reconcile partial output without duplicate tool calls and reject
  conflicting or unusable output. Extend the bounded cache check with a
  `--terminal-only` native-tool regression.

### OpenAI cache verification

- Add a bounded Astra live cache regression through Claude's native Read loop and
  two saved-session resumes with fresh gateways. Verify provider cached-token
  reuse and exact Claude usage accounting; measured 99.4% and 99.2% warm hits.
- Document that cache-hit evidence does not establish subscription quota charges
  or long-idle/compaction/worker cache behavior. No runtime cache changes.

### Cursor native lifecycle and compatibility

- Remove the single-model request deadline from whole Cursor runs. Preserve
  cancellation and explicit user API timeouts while extending Claude's default
  timeout for native work.
- Recover completed SDK runs after an interrupted gateway commit without another
  inference call. Preserve durable failure records, allow new prompts after known
  cancellation, and retain saved state when idle agents leave memory.
- Continue native history after outer compaction using authenticated fresh prompts
  or an unambiguous prior response. Explain when native history is retained;
  uncertain execution and unsupported rollback never replay earlier actions.
- Discover enabled plugin workers through Claude's CLI; translate whole-tool
  restrictions, supported Linux managed policy and explicit bypass mode. Enforce
  worker-specific permission hooks by rejecting unsupported native execution.
- Route worktree workers to their own SDK workspace and settings. Display bounded
  edit diffs, shell output, exit status and elapsed time without executable tool replay.
- Validate non-Fast Composer recovery/compaction recall, a GPT-parent Grok worker,
  and unmodified Claude worktree hooks.

### Cursor native cutover

- Activate the official SDK harness in the normal launcher: Cursor owns tools,
  persistent conversation state and native review. Claude Code displays progress
  and coordinates Cursor workers without replaying their actions.
- Delete the callback bridge, separate Cursor reviewer and obsolete live checks.
  OpenAI retains its existing Claude-executed tool and approval path.
- Follow Claude's existing mode selector through authenticated hooks. Support Auto
  and read-only Plan; reject unsupported modes and policies before execution.
  Check effective user/project settings on dispatch, with initial admission limited
  to Linux without WSL or managed policy.
- Verify a real Claude-parent Composer worker edit, plus persisted SDK resume,
  completed-request replay, follow-up recall and read-only Plan using non-Fast inference.
- Retry a failed mode change by resuming the saved agent, including when returning
  to the original mode; never send through the closed SDK handle.

### Cursor harness foundation

- Accept Cursor's native Auto fallback when its classifier is unavailable;
  guaranteed review availability is no longer a native-activation requirement.

- Forward resolved worker permissions to the native harness. Translate tool
  restrictions into SDK capabilities, remove shell/edit in Plan, and resume the
  same Cursor conversation when its mode or tool policy changes.
- Make session lock release idempotent so repeated cleanup cannot remove another
  gateway's lock. Verify failed policy resumes and streamed cancellation cannot
  execute work again or appear as successful completion.

- Scope initial delegation to Claude/OpenAI parents spawning Cursor workers.
  Defer Cursor-originated delegation and keep native child spawning disabled.

- Replace the proposed Claude source-patch mode exporter with documented prompt
  and worker hooks. Resolve worker definitions and parent-mode precedence through
  the authenticated gateway without inserting permission markers into prompts.
  Preserve worker tool restrictions as separate context; native enforcement is
  still part of the pending harness transition.
- Resolve gateway session identity consistently from headers and metadata; reject
  conflicting identities before execution and retain worker isolation.
- Commit native completion and replay data together, allow safe pre-send retries,
  and recheck ignored native policy files before new work on reused agents.
- Sanitize terminal escape sequences in native progress and reject unsupported
  native tool controls before streaming. Separate catalog tests from callback tests.

- Map the remaining native transition into owned work packages. Harden cancellation
  and late disposal; verify main/worker native progress and duplicate-request
  behavior through the HTTP gateway with an offline SDK fake.

- Add an independently testable native SDK harness with persistent agents, disk
  resume, retry protection, cancellation, and attributed tool/compaction text.
- Add explicit Auto/Plan mode mapping and reject unsupported manual-approval
  modes instead of treating them as automatic permission grants.
- Keep launcher activation pending reliable Claude permission-mode observation;
  the callback runtime and its reviewer remain until that replacement is ready.

### Cursor harness direction

- Record the accepted transition to Cursor-owned tools, persistent state and
  native review, with Claude Code providing display and outer coordination.
  Preserve cache/UI probe findings and distinguish the historical callback implementation
  from the target architecture. Implementation begins after this checkpoint.

- Default Cursor model routes, named workers and catalog-based live checks to
  explicitly advertised non-Fast parameters, even when the account default is Fast.

### Native Cursor Bash review

- Connect native Cursor allow/deny to the existing Claude Code classifier adapter
  for Cursor main agents and workers when Claude access is absent.
- Use an isolated SDK 1.0.31 process with source-pinned in-memory hooks; pending
  commands never execute in the reviewer. Correlate native decisions to the exact
  command, cwd and tool call; model text is never accepted as a verdict.
- Reject SDK drift, unsupported review operations and missing native proof. Initial
  support is Bash only. No Sand, alternate login, or external MCP review route.
- Add live native allow/deny and classifier-response checks, including a worker
  authorization case and assertions that reviewed commands did not execute.
- Match Claude's removal of a redundant current-directory Bash prefix during
  classification while rejecting other directory changes and ambiguous workers.

### Automatic-review routing corrections

- Reject native classifier retries addressed to ordinary external inference when
  no provider reviewer is enabled; standard Claude classifier requests retain
  subscription passthrough.
- Require a confirmed signed-out Claude auth status before enabling provider-only
  review. Auth-status errors no longer silently select an external reviewer.

### Cursor context and lifecycle

- Estimate each Messages request from its submitted SDK prompt, tool schemas, and
  image allowance; stop treating cumulative SDK usage as current context size.
- Validate and snapshot callback arguments as finite JSON objects before exposing
  them to Claude. Preserve arbitrary tool schemas.
- Keep shared inference alive while any identical request remains connected, and
  bound SDK cancellation waits during shutdown.
- Add a live callback/image capability check; Auto, Composer 2.5 and Grok 4.6
  passed plain callbacks and a valid red-image interpretation probe.
- Extend the compaction check to account Cursor models. Composer 2.5 passed
  manual/repeated/automatic compaction, saved-session recall, and native edits.

### Cursor response recovery

- Preserve terminal response text when Cursor streamed only a prefix, without
  repeating text already delivered across tool callbacks.
- Allow identical requests to retry SDK startup failures before inference starts;
  retain failed continuations so retries cannot repeat tool actions.
- Preserve structured Cursor error status and correlation details through the
  gateway, with credentials redacted from surfaced SDK diagnostics.

### Cursor automatic-review investigation

- Verified the published SDK 1.0.31 custom/MCP callback paths with inert live
  probes. Documented the missing correlated review/capability contract; retained
  the existing block for Cursor auto mode without Anthropic credentials.
- Follow-up research demonstrated native shell executor callbacks without MCP:
  with review guidance forwarded in request context, an allowed control reached
  an inert executor while a blocked canary did not. No production adapter enabled;
  positive verdicts, availability, and Claude permission ordering remain open.
- Found a structured native rejection in checkpoint tool results. The separate
  bundled classification RPC requires a Sand session and rejects SDK-key auth;
  the native reviewer adapter remains unimplemented.

### Runtime organization

- Replaced the catch-all `src/lib/native-*` layout with `gateway/`,
  `providers/openai/`, `providers/cursor/`, and retained `transports/` modules.
  Moved shared Claude Messages types out of the OpenAI translator and OpenAI
  authentication/model registration out of the HTTP server. The launcher path
  remains `plugins/multi-core/src/launcher.ts`.
- Updated direct imports, permission-hook and policy paths, ACP build/drift checks,
  Knip, TypeScript, documentation, and license notices. No compatibility wrappers
  or intended provider behavior changes.

### Development tooling

- Cleared all lint violations across runtime code, retained transports, and tests.
  Split provider routing, request validation, streaming state, Cursor continuation,
  reviewer parsing, and launcher configuration into focused helpers. Added shared
  live-test event types and replaced terminal escape parsing with Node's utility.
  Strict rules remain enabled; only intentional ACP control-byte regexes have
  narrowly documented suppressions.

- Began structural lint cleanup: separated approval-envelope/stage parsing and
  denial-cache insertion, Cursor catalog variants and worker deduplication, and
  Windows/POSIX process termination. Removed unchecked assertions from token
  counting and Cursor/approval unit tests; added cache-eviction and Windows
  cancellation regression coverage. Strict lint rules remain unchanged.
- Added pinned Biome and Knip development dependencies and a shared `npm run check`
  CI command. Biome enforces formatting, braces, single variable declarations,
  no nested ternaries/explicit `any`/non-null assertions, and cognitive complexity
  at most 15; tests follow the same rules. Lint violations fail the check.
- Formatted hand-written source and tests, applied mechanical style fixes, removed
  unused process helpers, and made unused exported types/constants private. Knip
  retains the architecture's Cursor/OpenCode reference entry points.

### Native permission regression contract

- Added `test:live:permissions` for default, accept-edits, plan, don't-ask, and bypass modes through the ordinary OpenAI/Cursor launcher. Checks native dialogs, pre-approval file state, exact-once effects, denial results, provider attribution, and absence of classifier traffic.
- Extended the native worker check with don't-ask/bypass modes and Cursor worker selection; reused the existing Python terminal helper. Plan-mode reports distinguish model restraint from a submitted write denied through a native prompt.

### Automatic approval

- Enabled OpenAI provider review in the ordinary launcher when Anthropic credentials are absent and the Codex catalog exposes its reviewer. Existing Claude subscription/API authentication keeps native classification. The runtime uses Codex's bundled policy, native context, and bounded read-only file investigation.
- Added a local capability guard for provider switches and workers, and disabled auto mode at startup when unsupported. Removed the mid-session manual fallback: auto-mode actions without an available approval adapter are denied with an explicit capability error; Claude's current gateway interface cannot change the displayed permission mode. Sessions started with auto disabled require relaunch to enable it.
- Prevented native classifier retries naming the working model from bypassing the reviewer. Added launcher, reviewer investigation/failure, credential-selection, and worker-isolation checks, plus live launcher and provider-switch modes.

### Auto-mode regression testing

- Added an opt-in native classifier gateway adapter and `test:live:provider-approval -- --native-escalation`. Claude's own permission filtering skips provider review for native-approved actions and explicit rules. Provider allow/block verdicts retain native auto-mode semantics; matching second-stage denials reuse one provider review. Protocol, session/context isolation, malformed/error/abort behavior, and gateway authentication have offline coverage. This earlier opt-in surface is now also used by the launcher.
- Added `npm run test:live:provider-approval`: a credential-isolated OpenAI reviewer and native Claude terminal approval proof. It covers automatic approval, manual Yes/No decisions, exact-once canary effects, and absence of Anthropic classifier requests. Uses Codex's vendored review policy and real `codex-auto-review` requests; This earlier test remains available alongside the runtime integration.
- Added `npm run test:live:auto-mode`: a sequential Claude control plus OpenAI/Cursor main-model and native-worker matrix. Harmless temporary canaries verify actual classifier allow/deny decisions, Anthropic routing, provider tool attribution, denial feedback, and file effects. Session-only rules and retained versioned diagnostics distinguish classifier enforcement from static permissions, sandbox auto-approval, model refusal, or silent fallback.
- All five cases passed with Claude Code 2.1.263: Sonnet control, Luna high main/worker, and Composer 2.5 main/worker. Bash classification requested `claude-sonnet-5` via the existing Claude subscription passthrough; external-provider authentication does not replace classifier authentication.

### Repository layout

- Moved plugin runtime code from `plugins/multi/scripts/` to `plugins/multi-core/src/` and live integration checks to `test/live/`. Root `scripts/` remains for development utilities. Updated imports, npm scripts, and documented launcher commands to the new paths.

### Cursor SDK bridge

- Reduced the default Cursor `/model` lineup to Auto, Grok 4.6, and Composer 2.5, filtered against the signed-in account catalog. Users can add other account models with the documented `MULTI_CURSOR_EXTRA_MODELS` environment variable. Full model IDs, presets, and registered workers remain available.
- Added the official `@cursor/sdk` integration, browser login, account model/preset discovery, `/model` entries, and named Cursor workers alongside Claude and OpenAI. No private Cursor token extraction or backend selector.
- Cursor custom-tool callbacks pause before execution and return native Claude tool requests. Claude handles permissions and supplies results; Cursor's independent execution tools and ambient settings/MCP servers are disabled.
- Added streamed output, bounded callback waits/output, cancellation, in-memory retry deduplication, worker isolation, and transcript-based reconstruction after completed turns/restart. Added offline coverage and `test:live:cursor`; Composer 2.5 passed real callbacks, cancellation, Claude main/subagent Read/Edit, and Cursor → Claude → Cursor with saved history. Other models and Cursor compaction remain unverified.
- Model-picker settings use a temporary file to avoid command-line size limits. Named workers cover base models and reasoning-only presets; all advertised combinations remain available as model choices. The official SDK's unresolved transitive `undici` audit findings are recorded in README.

### Compaction regression testing

- Added `npm run test:live:compaction`: a parameterized live contract for actual manual, repeated, and automatic compaction boundaries, retained conversation-only facts, post-compaction native edits, fresh-process saved-session resume, and switching back to Claude. Uses synthetic fixtures, bounded waits, and versioned JSON reports; the offline suite remains offline.
- Passed on Luna with Claude Code 2.1.263, including an automatic boundary at 70,397 tokens. Full-window stress and subagent compaction remain outside this main-session baseline.

### OpenAI gateway compatibility

- Added deterministic long-tool-name and call-ID aliases, base64 PDF/plain-text documents, tool-result document and tool-reference handling, and a local token-count estimate using `js-tiktoken`.
- Hardened streaming for parallel calls, delayed function metadata, nullable initial usage, malformed nested content, and bounded SSE buffers. Tool arguments are validated before emission; provider errors preserve HTTP status and Retry-After. Added local stop-sequence enforcement and explicit-effort-first legacy thinking-budget mapping.
- Extended offline tests and the synthetic live translation check to cover PDF ingestion and a long MCP name. Provider-hosted tools, exact media/billing token counts, provider output caps, and authentication stores outside Codex's auth.json remain outside the implemented route.

### Migration status

- The native gateway and its tests now use strict TypeScript on Node ≥ 24.12. `npm test` runs type checking and offline tests; native live checks use `.ts` entrypoints. The branch also removed the old companion/command system and retained Cursor/OpenCode/ACP/process references.
- Restored our pre-migration documentation and execution boundaries, with current TypeScript paths and removed-code sections marked historical. Next work remains OpenAI gateway completion, then Cursor; no fixed order is imposed on the other targets.

### Added

- **Native GPT image inputs and structured output.** User images and image-bearing tool results now translate to Responses image inputs; base64 and HTTP(S) sources are supported without gateway-side URL fetching. Modern `output_config.format` and legacy `output_format` JSON schemas translate to strict Responses output without schema rewriting. Includes offline validation/ordering contracts and a synthetic live image/schema check. Corrected the README's non-Claude gateway support statement using Boris Cherny's explicit clarification.

- **GPT as the main Claude Code agent.** The native gateway launcher adds Astra, Sol, Terra, and Luna to `/model` alongside Claude. Registered GPT requests now work for the main conversation as well as subagents, with main-session identity and separate subscription authentication. Provider-specific reasoning state is filtered at the request boundary while ordinary messages and tool history survive model switches. Includes offline switching tests and a live Claude → GPT → native delegation → Claude reproducer. Unsupported content, auxiliary features, and context-window limitations remain documented in the README.

- **Native GPT-5.6 workers and reasoning selection.** The launcher now registers `openai-sol`, `openai-terra`, and `openai-luna` alongside Astra's `openai-native`. Each supports `-low`, `-medium`, `-high`, `-xhigh`, and `-max`; unsuffixed names use medium. Model routing uses an explicit allowlist, traces include the actual upstream reasoning level, and the opt-in live test accepts a worker name and checks model/effort as well as native Read/Edit completion.

- **Native OpenAI subagent.** `node plugins/multi/scripts/native-model-gateway.mjs` launches Claude with an `openai-native` worker backed by GPT-6 Astra through the existing Codex ChatGPT login. A session-local gateway preserves the main agent's Claude subscription and separates provider credentials. The worker uses native Claude Code tools and agent lifecycle instead of a Sonnet forwarder. Includes Messages/Responses streaming translation, encrypted reasoning continuation, cancellation, offline contract tests, and an opt-in launcher; no global configuration changes. Text/function-tool scope and remaining limitations are documented in the README.

- **Grok on your Cursor subscription, documented.** Grok models (`grok-4.6`, `grok-4.6-fast`, `grok-4.5`, `grok-4.5-fast`) are in the Cursor model pool, so `/cursor:delegate --model grok-4.6` (and the research/explore commands) run Grok with no code change — the Cursor adapter passes `--model` through verbatim. README gains a **Models** section that also records why "Grok Bot" (the Cursor-bundled cloud-teammates app — no CLI, API, or headless mode) is not integrable and why Grok Build (`grok`) is out of scope (separate SuperGrok / X Premium+ entitlement).
- **OpenCode `--effort` is now forwarded as `opencode run --variant`** (OpenCode's provider-specific reasoning-effort knob, validated by OpenCode per model). Headless transport only; the ACP path ignores it. Pinned in `test/unit/opencode-headless.test.mjs`.
- **`MULTI_ACP_INACTIVITY_MS` / `MULTI_ACP_OVERALL_MS` operator env knobs** for the ACP watchdog windows (same convention as `CODEX_COMPANION_TURN_INACTIVITY_MS`), read from the spawn env at turn start. Live-verified end-to-end: a knob set in Claude Code's settings env reaches the forwarder subagent's companion process and bounds a hanging CLI.
- **Forwarder-contract directive in the companion's fatal-error output.** Every fatal companion error now ends with a `FORWARDER CONTRACT:` block instructing a forwarding subagent to return the one-line failure format and NOT substitute its own answer — runtime steering at the exact decision moment for the catalogued #319-class failure.
- **HARD GATE block in all 11 forwarder agent definitions** (unconditional forwarding: no task too trivial, Bash for the companion invocation only, failure line is the entire response on error), plus the same substitution ban in the `multi-cli-runtime` skill. Motivated by live stress tests: with the previous definitions, wrappers sometimes bypassed the companion entirely for trivial-looking questions or "helpfully" did the task themselves after a CLI failure — masking the outage from the caller.
- **Failure-mode regression tests** (240 → 243): hang-at-handshake caught by the inactivity watchdog (not the 30-minute overall cap), mid-turn agent crash always yields an explicit error with partial text preserved, and the `MULTI_ACP_INACTIVITY_MS` knob bounds a silent agent. New fake-agent fixture flags `--hang-handshake` and `--die-mid-turn`.

### Changed

- **Refreshed repository guidance for the upcoming gateway refactor.** `AGENTS.md`, `CLAUDE.md`, README, and architecture docs now distinguish the target design from the existing command/skill/forwarder surface, which may be replaced or deleted. Removed stale compatibility promises and model/billing claims; corrected privacy documentation to match current local state storage. Existing command and skill prompts and runtime behavior are unchanged by this documentation pass.

- **Consolidated the product direction around our custom Node gateway and external harness bridges.** `ARCHITECTURE.md` now defines the single-session `/model` and native-worker experience, subscription and execution boundaries, six integration targets, and the first Antigravity bridge milestone. README, agent orientation, integration guidance, and privacy descriptions distinguish the working direct GPT integration from planned CLI-backed workers. Superseded gateway-engine proposals, transport roadmaps, and stale handoffs are archived locally with historical labels. Documentation only; no new provider or harness bridge is implemented by this change.

- **Codex defaults route to GPT-6 Astra.** Both `--task-kind spec` and `open-ended` now map to `gpt-6-astra` at `medium` effort (verified against the live app-server `model/list` for this account on codex-cli 0.153.4: Astra is the catalog default; GPT-6 ships as a single slug, so the spec/open-ended split is framing-only until the line splits again). `VALID_REASONING_EFFORTS` drops `none` and `minimal` — no served model advertises them and Astra returns HTTP 400 for both; the accepted set is `low|medium|high|xhigh|max|ultra` (`ultra` = max reasoning plus automatic subagent delegation). Forwarder prompts, skills, and the `/codex:execute` argument hint updated to match.
- **`gpt-5-4-prompting` skill renamed to `gpt-6-prompting`** and prefixed with the six Astra-specific prompting notes from OpenAI's "Using GPT-6 Astra" guide (bias toward action instead of asking, literal AGENTS.md/skill adherence, list-vs-prose default, explicit delegation at `ultra`, skip tests for trivial reversible edits, rejected efforts). The XML block recipes are unchanged. `codex-rescue` and `codex-cli-runtime` reference the new name; `NOTICE` keeps the upstream attribution.
- **ACP SDK bumped `@agentclientprotocol/sdk` 0.25.0 → 1.4.0** and the vendored bundle rebuilt (protocol version still 1; `session/set_config_option` and request cancellation are now stabilized upstream). `scripts/build-acp-vendor.mjs` resolves the SDK manifest by walking up from the package entry, since 1.x no longer exports `./package.json`. All 27 offline ACP contract tests pass unchanged.
- **Docs caught up to the ACP transport.** README gains a **Transports** section documenting the `MULTI_TRANSPORT_CURSOR` / `MULTI_TRANSPORT_OPENCODE` opt-in; the `multi-cli-anything` and `customize` skills and `AGENTS.md` were corrected — they previously asserted "no shipped adapter uses ACP" and pointed at the legacy `lib/acp-client.mjs`. They now describe ACP as a live transport for Cursor + OpenCode on the SDK-based `lib/acp/client.mjs`, with `customize` documenting the transport toggle as a supported change. Also fixed a stale "Haiku forwarders" reference in `AGENTS.md` (all forwarders are `model: sonnet`). `/multi:setup` needed no change (it's transport-agnostic — the ACP path passes no MCP servers in-protocol, so each CLI still reads its own MCP config). Docs only; no code change.
- **The four read-only forwarder agents (cursor-explore, opencode-explore, antigravity-explorer, codex-review) moved from `model: haiku` to `model: sonnet`.** Live A/B under an injected CLI outage: the haiku wrapper ignored even a point-blank in-band contract directive and substituted its own answer; the sonnet wrapper honored the failure contract. (Consistent with openai/codex-plugin-cc merging its forwarder as sonnet over a haiku proposal in PR #169; haiku's price advantage is also undercut by subagent model-pin reliability issues and subscription-quota weighting.)
- **`/codex:review` and `/codex:adversarial-review` no longer spawn a subagent.** The `codex-review` forwarder was a pure bridge — it added no model/effort choice and no prompt framing, only a companion call — so its whole cost was a subagent round trip. Both commands now run `node ${CLAUDE_PLUGIN_ROOT}/scripts/multi-cli-companion.mjs review|adversarial-review $ARGUMENTS` directly from the main loop with `allowed-tools: Bash(node:*)` + `disable-model-invocation: true` (long runs use `run_in_background`), mirroring `openai/codex-plugin-cc`'s `commands/review.md`. `plugins/multi/agents/codex-review.md` is deleted. Framing forwarders (`codex-execute`, `codex-rescue`, the cursor/antigravity/opencode ones) are unchanged — their prompt shaping earns the subagent. User-facing output is identical: the companion's stdout verbatim.

- **Codex model/effort routing moved out of the `codex-execute` prompt and into code.** The forwarder now only judges the task shape and passes `--task-kind spec|open-ended`; `resolveTaskRouting()` in `lib/task-options.mjs` maps that to the model + effort defaults (`spec` → `gpt-5.3-codex`, `open-ended` → `gpt-5.5`, both `medium`), with explicit `--model`/`--effort` always winning and unknown kinds rejected. Deletes ~20 lines of decision table from the agent prompt (framing guidance stays — that is the model-worthy part) and pins the mapping in `test/unit/task-options.test.mjs`. `codex-rescue` loses its now-redundant `spark` alias line (the companion already resolves it).

- **Model-catalog refresh across defaults, docs, and tests.** Codex `--task-kind spec` now routes to `gpt-5.6-terra` (`gpt-5.3-codex` is no longer offered by the CLI); `open-ended` routes to `gpt-5.6-sol` (a one-off 400 was observed on this slug via the companion path — if it recurs, check account entitlement before blaming the routing). The `spark` alias is removed entirely (`gpt-5.3-codex-spark` is Pro-gated and absent from the account catalog) — model slugs now pass through verbatim. `--effort` accepts `max` and `ultra` (both advertised by the Codex catalog; `max` was previously rejected). The OpenCode default model moves to `opencode/claude-opus-5`, and Antigravity docs now say **Gemini 3.7 Flash** with the stale `gemini-cli#27466` / "agy 1.0.3" citation replaced by `google-antigravity/antigravity-cli#318` (with `--output-format stream-json` on agy ≥1.1.8 noted as the coming workaround). Cursor slugs are unchanged.

### Removed

- **Antigravity support removed entirely.** The `antigravity` plugin (`/antigravity:research`, `/antigravity:explore`), its marketplace entry, the `antigravity` adapter, both forwarder subagents, and the headless test + fixtures are deleted. `--cli` now accepts `codex|cursor|opencode`. Antigravity's `agy` never had a usable headless stdout, so the adapter's transcript read-back was a workaround for an upstream bug that never landed; carrying it cost more than it returned.
- **Dead legacy ACP/Gemini broker stack deleted.** `lib/acp-client.mjs`, `acp-broker.mjs`, `lib/gemini-broker-lifecycle.mjs`, `lib/acp-terminals.mjs`, `lib/acp-diagnostics.mjs`, `lib/socket-permissions.mjs`, `lib/mcp-servers.mjs`, and `lib/thinking.mjs` existed only for the removed Gemini/Antigravity broker path (AGENTS.md had already marked `acp-client.mjs` for deletion). The live ACP layer `lib/acp/` is unaffected. The one function Cursor/OpenCode still needed, `buildSpawnEnvironment`, moved verbatim to `lib/process.mjs`; `sanitizeDiagnosticMessage` now comes from `lib/acp/diagnostics.mjs`.

### Fixed

- **`setup --json` now probes every registered adapter.** The CLI list was a hand-maintained `["codex", "cursor"]` and silently omitted OpenCode; it is now `Object.keys(ADAPTERS)`. Adapter flags re-verified live against codex-cli 0.153.4, Cursor `agent` 2026.09.02, and OpenCode 1.18.29 (`--variant` and the hidden `--dangerously-skip-permissions` alias both accepted).
- **POSIX process-tree kill now actually kills non-detached children.** `terminateProcessTree` tried a process-group kill (`kill(-pid)`) and treated `ESRCH` as "process gone" — but children spawned without `detached: true` (the ACP turn runner, the antigravity adapter, the app-server) are not group leaders, so the group kill always threw `ESRCH` and the child was never signalled. On Linux/macOS this left orphaned CLI children alive (and hung the unit suite forever); Windows was unaffected (`taskkill /T`). The group-kill failure now always falls back to a direct `kill(pid)`. Pinned in `test/unit/process.test.mjs` (243 → 246).

- **ACP inactivity watchdog now covers the HANDSHAKE phase.** Previously it was first armed immediately before `session/prompt`, so a CLI that spawned and hung silently at initialize/session-new (lock, auth, network) was only caught by the 30-minute overall cap — reproduced live, then fixed: the watchdog arms at connection start and re-arms after each completed handshake step. A silent hang now errors out after `inactivityMs` (default 120 s) + the 5 s cancel grace.
- **Mid-turn agent crash can no longer race to a success-shaped result.** A post-handshake child exit with no stopReason and no cancel now sets an explicit `crash` error (whichever of the exit handler or the SDK's connection-closed rejection wins the race), with the stderr tail as detail and partial streamed text preserved.

- **ACP cancel dispatch now reports `transport: "process-tree"` when there is no in-flight ACP turn in the calling process** (the cross-process cancel case — the mechanism that actually does the work is the companion's process-tree kill; the ACP child sits inside the worker's tree). Previously it reported `"acp"` while doing nothing in-process, which was dishonest and also made the suite sensitive to ambient `MULTI_TRANSPORT_*` env (3 pre-existing headless cancel tests failed when the dogfood flags were set session-wide). `transport: "acp"` is now reported only when a live in-flight handle was actually cancelled in-protocol. Suite verified green both with and without the ambient flags.

## 0.1.2 — 2026-06-11

### Added

- **ACP transport layer (slice 1): a shared, SDK-backed turn runner for the Cursor + OpenCode ACP path.** New `plugins/multi/scripts/lib/acp/client.mjs` exports `runAcpTurn(spec)`, a policy layer over the official `@agentclientprotocol/sdk` `ClientSideConnection`: it spawns one ACP child per turn, runs initialize → newSession → (optional set_mode / set_config_option model) → prompt, accumulates `agent_message_chunk` text, and resolves to a uniform `{ text, error, sessionId, stopReason, cancelled, modes, configOptions, usage, exitCode }` (error set, never thrown — matching the adapter contract). Permission requests are auto-rejected by default and allowed only with `allowWrites`. Cancellation (`promise.cancel()` or `spec.signal`) sends in-protocol `session/cancel`, waits a 5 s grace, then process-tree-kills the child via the existing `lib/process.mjs` helpers; per the verified cancelled-detection rule, a cancel-requested turn is reported `cancelled: true` regardless of the agent's `stopReason` (OpenCode mislabels cancel as `end_turn`). Inactivity (reset on every `session/update`) and overall watchdogs convert hangs to a `timeout` error and reap the child; a child that dies before the handshake yields a `spawn` error with the stderr tail. A requested model that is absent from the live `configOptions` list fails the turn with a `config` error **before** prompting (no silent fallback). The runner imports only the vendored SDK bundle, node built-ins, and existing lib helpers, and never logs prompt content.
- **Win32-first ACP spawn resolution.** `plugins/multi/scripts/lib/acp/resolve.mjs` exports `resolveOpenCodeAcp()` / `resolveCursorAcp()` returning `{ exe, args }` (or `{ exe: null, detail }` instead of throwing when not found). OpenCode resolves the platform exe under `%APPDATA%\npm\…\opencode-windows-x64\bin` (with a `-baseline` sibling probe); Cursor resolves the bundled `node.exe` + `index.js acp` under the lexically-latest `^\d{4}\.` version dir in `%LOCALAPPDATA%\cursor-agent\versions` (it self-updates in the background). Both honor the existing `OPENCODE_CLI_PATH` / `CURSOR_AGENT_PATH` overrides and fall back to the bare binary name off-win32.
- **Vendored zero-runtime-dependency SDK bundle.** `scripts/build-acp-vendor.mjs` (run via `npm run build:acp-vendor`) esbuild-bundles `@agentclientprotocol/sdk` + its `zod` peer into a single committed ESM file (`plugins/multi/scripts/lib/acp/vendor/acp-sdk.bundle.mjs`, `external: node:*`), so nothing is installed at plugin-install time. The SDK, `zod`, and `esbuild` are devDependencies only. A banner records the bundled SDK version; the build is idempotent (a second run is byte-identical).
- **Offline ACP contract test suite.** `test/unit/acp-client.test.mjs` (27 tests) drives `runAcpTurn` against a fake ACP agent fixture (`test/fixtures/fake-acp-agent.mjs`, raw newline-delimited JSON-RPC over stdio): happy-path streaming order, set_mode / set_config_option, model-not-in-options, permission reject/allow, all three cancel paths (honored, `end_turn`-mislabel, ignored→tree-kill with orphan-liveness assertion), inactivity timeout, child-exit-before-handshake, unknown/tolerated `sessionUpdate` kinds, and a cwd-with-spaces round-trip — plus `resolve.mjs` unit tests (env overrides, missing-binary `{exe:null}`, Cursor version-dir selection) and a drift-gate test asserting the vendor bundle exists, imports, exports `ndJsonStream`/`ClientSideConnection`/`PROTOCOL_VERSION`, and records the SDK version pinned in `package-lock.json`.
- **ACP transport behind per-CLI flags (slices 2 & 3): OpenCode + Cursor adapters can run over ACP instead of headless, opt-in and off by default.** Two env vars select the transport per turn (read at `invoke()` time, not import time, so it can be flipped per case): `MULTI_TRANSPORT_OPENCODE` and `MULTI_TRANSPORT_CURSOR`, each `acp` | `headless` (default `headless`). Selection lives entirely inside each adapter — the adapter contract, registry, companion, commands, and skills are untouched, and **with no flag set the behavior is byte-identical to today (the headless path)**. On the ACP path each adapter calls the slice-1 `runAcpTurn` and maps its options back to the SAME result shape the headless `invoke()` returns (`text`/`error`/`sessionId`/`status`/`fileChanges`/`commandExecutions`/`toolCalls`), so the render layer is unchanged; `session/update` chunks are mapped to the existing `onStream` phase/message_chunk convention. **OpenCode ACP** (`opencode acp`): read-only roles reuse the headless `buildOpencodeSpawnEnv` verbatim (the `OPENCODE_PERMISSION` deny floor — the same constant, not duplicated JSON), and the model passes through as the same `provider/model` id the headless path gives `--model`, pinned via `set_config_option`. **Cursor ACP** (`cursor-agent acp`): read-only roles (research/explore/…) set session mode `ask`, write/delegate set `agent` (writes allowed); the friendly `--model` name is resolved against the LIVE composite-id list from `session/new` (exact match → unique prefix match on the segment before `[`, e.g. `composer-2.5` → `composer-2.5[fast=true]`; ambiguous or no match → a `config` error listing the available ids, no silent fallback). To resolve the composite id pre-prompt without a second session, `runAcpTurn` gained a small `resolveModel(availableIds, requested)` callback (validated after `session/new`, before the prompt). Cancellation routes to the in-flight ACP turn's in-protocol cancel handle (in-process) and reports `transport: "acp"`; the authoritative cross-process cancel remains the companion's process-tree kill (the ACP child sits inside the worker's tree). The headless cancel/SIGTERM paths are untouched and never run on the ACP path.
- **Decoupled the slice-1 ACP layer from the legacy pre-retreat files.** `lib/acp/client.mjs` now imports `sanitizeDiagnosticMessage` from a new `lib/acp/diagnostics.mjs` (the function copied byte-for-byte from the legacy `lib/acp-diagnostics.mjs`, which is left untouched), so the ACP-v2 layer no longer depends on a file slated for deletion.
- **Offline ACP-path tests for both adapters.** New `test/unit/opencode-acp.test.mjs` (16 tests) and `test/unit/cursor-acp.test.mjs` (17 tests) drive each adapter's `invoke()` against the fake ACP agent via an injected `spawnSpec` (the role `resolve.mjs` env overrides serve in production): transport selection honors the env flag and defaults to headless; the OpenCode read-only deny floor + model pass through (asserted via a new `--echo-env` fixture flag); Cursor session mode by role and model alias resolution (exact, prefix-unique, ambiguous→error, missing→error with the list); result-shape parity with the headless path; and cancel routing through the in-flight handle. `acp-client.test.mjs` gains 3 tests for the new `resolveModel` callback. Suite total 204 → **240**.

## 0.1.0 — 2026-06-02

> **Versioning reset.** The project moved to a pre-1.0 `0.x` scheme to reflect that it is in active development; the earlier `v2.0.0`/`v2.0.1` GitHub releases were removed. Entries under **Pre-reset history** below predate this reset and are kept as a record (their version numbers do not continue the `0.x` line).

### Added

- **OpenCode provider.** `/opencode:delegate`, `/opencode:research`, and `/opencode:explore` are now shipped commands. Transport: headless `opencode run --format json`, piped NDJSON. The adapter (`lib/adapters/opencode.mjs`) parses the NDJSON event stream (step_start, text, step_finish, tool_use, error), derives file changes and command executions from completed tool_use events, and delivers the prompt on stdin (newline-safe). Read-only roles (`research`, `explore`) are enforced via injected oc-* primary agents (`OPENCODE_CONFIG_CONTENT`) with write/edit/bash denied plus an `OPENCODE_PERMISSION` deny floor — OpenCode has no `--read-only` flag. Write roles use `--dangerously-skip-permissions`. `--until-done` is supported; `--effort` is not. Default model: `opencode/claude-opus-4-8` (Zen, billed separately). **Token-offload caveat: `anthropic/*` models reuse the Claude Code subscription — zero offload; use `opencode/*`, `openai/*`, `google/*`, `github-copilot/*`, or `ollama/*` for real offload.** MCP servers are read from OpenCode's own `opencode.json` (not managed by `/multi:setup`). Set `OPENCODE_CLI_PATH` to pin a specific binary; set `OPENCODE_CLI_DEFAULT_MODEL` to override the default model. The adapter is registered in `lib/adapters/registry.mjs` and the opencode plugin is listed in `.claude-plugin/marketplace.json`.

- **Reworked the Cursor slice into `/cursor:delegate`, `/cursor:research`, `/cursor:explore`** (replacing `/cursor:execute`, `/cursor:plan`, `/cursor:debug`). `delegate` is agentic implementation (Cursor writes code; the calling Claude thread runs the listed `## Verification` commands), `research` is read-only **external** web/docs research (Cursor's built-in WebSearch with the Exa MCP as a fallback), and `explore` is read-only codebase Q&A (semantic search + grep). All three default to Cursor's `auto` model and accept `--model`. `delegate` also gains the autonomous **`--until-done`** multi-step loop (with `--max-turns`), previously Codex-only — the loop's stop logic is now a shared, transport-agnostic helper (`evaluateAutonomousStop`).
- **Implemented the Antigravity slice on Google's headless `agy` CLI.** `/antigravity:research` and `/antigravity:explore` now run read-only against `agy -p` (Gemini 3.5 Flash). Because `agy`'s headless stdout is empty upstream (gemini-cli#27466, unfixed as of agy 1.0.3), the adapter spawns `agy -p`, learns the conversation id from a per-invocation `--log-file`, and recovers the answer from agy's on-disk transcript JSONL (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`); the last non-empty `PLANNER_RESPONSE` step is the answer. Auth is `agy`'s own OAuth keyring (no API key); the desktop app is not required. Cancel is a process-tree kill. Per-call `--model`, write-`delegate`, and `--until-done` are intentionally unsupported on this path. New pure-helper tests in `test/unit/antigravity-headless.test.mjs` (against captured fixtures).

### Fixed

- **Codex broker leak.** The reused per-cwd app-server broker daemon now self-terminates after an idle window (`CODEX_COMPANION_BROKER_IDLE_MS`, default 600000 ms), so brokers spawned for transient or extra workspaces no longer linger forever (and, on Windows, no longer pin their cwd directory open). The SessionEnd hook already reaped the session's primary-cwd broker; this idle timer is the backstop for every other case (`app-server-broker.mjs`, `lib/broker-lifecycle.mjs` → `shouldIdleShutdown`).
- **Unreachable review-gate toggle / dangling `/codex:setup` references.** `setup` was renamed to `/multi:setup`, but the companion, the Codex adapter, the stop-review-gate hook, the stop-gate prompt, and the `codex-result-handling` skill still pointed users at the non-existent `/codex:setup` — and `/multi:setup` did not expose `--enable-review-gate`/`--disable-review-gate`, so the stop-time review gate could not be toggled from any shipped command. Repointed every reference to `/multi:setup` and taught `/multi:setup` to forward the review-gate flags to the companion (which already implemented the toggle).

### Changed

- **Revamped the `customize` and `multi-cli-anything` skills to match the post-split, headless shape.** Both predated the Cursor ACP→headless migration, the Antigravity headless-`agy` slice, the shared `multi-cli-runtime` forwarding contract, and the companion monolith split — so they documented a `buildPrompt()` role→slash-prefix layer and an `ADAPTERS` map inside `multi-cli-companion.mjs` that no longer exist, and treated ACP as the default integration path. `customize` now teaches the real four moving parts (slash command / forwarder framing block / adapter role→flag map / shared `multi-cli-runtime` contract), the forwarder model-by-role policy (Sonnet for framing roles, Haiku for pure path-bridges), and headless-era escape hatches (`CURSOR_AGENT_PATH`, `AGY_CLI_PATH`, per-CLI MCP config), with `ACP_TRACE` demoted to legacy; its stale `/cursor:research` "add-a-command" example and `cursor-researcher` role name are replaced with current ones. `multi-cli-anything` now leads with headless print-mode (`cursor.mjs`) as the common path, documents spawn-and-read-artifacts (`antigravity.mjs`) and ASP (`codex.mjs`), demotes ACP to a clearly-labeled legacy section, and points registration at `lib/adapters/registry.mjs` and dispatch at `lib/commands/task.mjs` (not the companion). Docs-only; no runtime change.
- **Refreshed the banner and README for the four-CLI lineup.** New banner art (Cursor · Antigravity · OpenCode · OpenAI Codex, replacing the stale gold banner that still showed the removed Copilot/Gemini/Qwen). The "CLIs supported" badge and intro now include OpenCode, with a note that **OpenCode is in active development** (its `/opencode:*` provider commands don't ship yet; today's working providers are Codex, Cursor, Antigravity). Also corrected the README's stale `ACP_TRACE` troubleshooting note — no shipped provider uses ACP.
- **Migrated the Cursor adapter from `agent acp` (ACP JSON-RPC) to headless `agent -p`.** Headless fixes what ACP could not on Windows: MCP/web tools fire (they were silently dead in ACP since ~2026.04.17), cancel is a real process-tree kill (was a no-op), progress is parsed from the documented `stream-json` event stream, and model/mode selection are first-class flags (`--model <flat-name>`, `--mode ask`) instead of post-session RPCs — so the stale bracketed-`modelId` resolution is gone and `auto` is the default. The prompt is delivered on **stdin** (newline-safe). ACP (`lib/acp-client.mjs`) now serves only the antigravity/gemini path. Forwarders run on **Sonnet** (`cursor-delegate`, `cursor-research`) and **Haiku** (`cursor-explore`, a pure read-only path-bridge).
- **Forwarder subagent models tuned by role.** `codex-execute` and `codex-rescue` run on **Sonnet**: they *frame and route* the prompt (choosing model/effort and shaping the task) where a more capable model materially improves the work the external CLI then does — matching the official `codex-plugin-cc` rescue subagent. `codex-review` stays on **Haiku**: it does no framing, only bridging the plugin boundary to forward `review`/`adversarial-review` to the companion, so the cheapest model is the correct one. (The cursor/antigravity forwarders already run on Sonnet.)
- **Repo structure for multi-agent work (no behavior change).** Added `AGENTS.md`/`CLAUDE.md` orientation, `ARCHITECTURE.md`, an explicit adapter `CONTRACT.md`, a zero-dependency offline test suite (`npm test`, Node's built-in runner) with a reusable sandbox fixture, and a gitignored `.agent/` scratch area. Began splitting the companion monolith: extracted the pure task-option normalizers (model alias, reasoning-effort validation, argv splitting) into `lib/task-options.mjs` with characterization tests.
- **Split the two monoliths into focused modules (no behavior change).** `multi-cli-companion.mjs` (1462 lines) is now a ~100-line dispatcher; its command handlers moved verbatim into `lib/commands/{shared,setup,jobs,review,task}.mjs`. `lib/adapters/codex.mjs` (1110 lines) is now a ~30-line re-export barrel over `codex-{roles-prompts,render-parse,transport}.mjs`, keeping the public import surface and the `adapter` object intact. Every function was moved byte-for-byte; the offline suite grew from 27 to **82** characterization tests (all passing), and the live suite plus an adversarial verbatim diff against the prior revision confirm the CLI surface and behavior are unchanged.
- **Antigravity transport: replaced the planned desktop Language Server (ConnectRPC live-attach) with the headless `agy` CLI.** The v3.0.0 stub targeted attaching to the running Antigravity 2.0 desktop app's LS; that approach is dropped — driving the Antigravity desktop/OAuth login from third-party software violates Google's ToS, and Google now ships the standalone `agy` CLI (which runs without the desktop app). The `antigravity.mjs` stub is replaced by a real adapter, `handleCancel` gained an antigravity branch, and `/multi:setup` now points users at installing `agy` and signing in (rather than running the desktop app).

---

## Pre-reset history

_The entries below predate the move to `0.x` versioning and are retained for the record._

## v3.0.0 — 2026-05-24

**Breaking release.** The provider set is now **Codex, Cursor, and Antigravity**. Three providers were removed and command namespaces were reorganized — there is no in-place behavioral compatibility with v2.x for the dropped CLIs. After upgrading, restart Claude Code so the subagent roster refreshes, then re-run `/multi:setup`.

### Removed (breaking)

- **Gemini, Copilot, and Qwen providers** — their plugins, adapters, subagents, and commands are gone. Gemini CLI access was cut during the gap (Gemini CLI sunset); Copilot was dropped after MSFT's billing change; Qwen was unused in practice. The Antigravity provider replaces Gemini-family access via a different transport.
- The Gemini ACP broker lifecycle (`gemini-broker-lifecycle.mjs`) and the `/gemini:*`, `/copilot:*`, `/qwen:*` command surfaces.

### Added

- **Antigravity provider** — `/antigravity:research` (Gemini 3.1 Pro) and `/antigravity:explore` (Gemini 3.5 Flash), both read-only, reached through the running **Antigravity 2.0 desktop app's** Language Server. This release ships a **stub adapter**: process detection works (Windows-first), but the Language Server transport (ConnectRPC live-attach) lands in a follow-up (Phase 2). `/antigravity:*` commands currently return a clean "not implemented (Phase 2)" message; macOS/Linux discovery is also Phase 2.
- **Forked-and-merged the official OpenAI `codex-plugin-cc`** into our `codex` slice: new `/codex:rescue`, `/codex:review`, and `/codex:adversarial-review` commands, the `codex-rescue` and `codex-review` subagents (with disjoint-trigger descriptions so Claude's auto-dispatch stops confusing them), and three vendored helper skills (`codex-cli-runtime`, `gpt-5-4-prompting`, `codex-result-handling`). All routed through our `multi` companion. Attribution recorded in `NOTICE` (Apache-2.0).

### Fixed

- **Latent ENOENT in the review / stop-gate paths.** The companion dispatched `review`/`adversarial-review` and the stop-review-gate hook, but the data files they read (`schemas/review-output.schema.json`, `prompts/adversarial-review.md`, `prompts/stop-review-gate.md`) were missing from the repo, so those paths threw at runtime. Restored the schema and prompt templates.

### Changed

- **Modernized the Cursor adapter.** Model selection now uses `session/set_config_option` (Cursor 2026.04.13+ ignores `session/new.model` and `session/set_model`). Dropped the `~/.cursor/cli-config.json` allowlist injection entirely — the 2026.04.17 MCP/Terminal regression that required it was fixed upstream (forum #155544/#155516). Refreshed the current-model reference list and the known-broken-version warning.
- **Command-namespace policy.** Provider plugins own their own command namespaces (`/codex:*`, `/cursor:*`, `/antigravity:*`); `/multi:*` is reserved for cross-cutting operations (`setup`, `status`, `result`, `cancel`).
- **`/multi:setup` detection** now probes Codex, Cursor, and Antigravity (and reports a running Antigravity desktop) instead of the removed CLIs. The companion's setup report enumerates the live provider set via each adapter's `isAvailable()`.
- **Skills** (`customize`, `multi-cli-anything`, `multi-cli-runtime`, `multi-plan-handoff`, `multi-result-handling`) updated for the new inventory; `multi-cli-anything` now documents Antigravity's non-ACP Language Server (ConnectRPC) transport as a worked example of a non-ACP adapter.

### Migration from v2.x

1. Update the marketplace: `/plugin marketplace update cc-multi-cli-plugin`.
2. Uninstall the dropped provider plugins if you had them: `/plugin uninstall gemini@cc-multi-cli-plugin` (and `copilot`, `qwen`).
3. Reinstall the hub and the providers you want: `/plugin install multi@cc-multi-cli-plugin --force`, then `codex` / `cursor` / `antigravity`.
4. Restart Claude Code (subagent definitions are cached at session start), then run `/multi:setup`.

## v2.0.1 — 2026-04-26

Bug-fix release. Real-world prompts beyond a one-shot text reply silently broke before this — agents stalled, errors vanished, the forwarding subagents reported success on empty output. This release fixes the entire ACP traffic path.

### Fixed

- **ACP session hangs across all CLIs.** The shared ACP client now responds to incoming JSON-RPC requests from the agent (previously dropped). `buildAutoApproveRequestHandler` services `session/request_permission`, `cursor/ask_question`, and the full `terminal/*` family — without these, agents stalled forever waiting for our response.
- **Silently-dropped errors.** Non-codex adapter branches now exit 0 on in-protocol errors (with the failure message in rendered output). Previously, exit 1 tripped the forwarding subagent's "if Bash fails, return nothing" rule and the user saw nothing at all.
- **Cursor `agent acp` Terminal hang.** Plugin now auto-injects a permissive allowlist (`Shell(*)`, `Read/Write/Edit(**)`, `MCP(*)`) into `~/.cursor/cli-config.json` before each Cursor invocation. Without this, Cursor's out-of-band permission gate silently stalls every `execute` tool call.
- **Gemini `--model auto` hang.** Companion now treats `auto` as "skip `session/set_model`" so the CLI's native alias resolver picks a real model id. Calling `set_model("auto")` over ACP was silently accepted but caused `session/prompt` to hang.
- **MCP server schema.** `env` is now an array of `{name, value}` per ACP spec (was a `Record<string, string>`).

### Added

- **MCP wiring (Exa + Context7) into ACP `session/new`** for all four ACP adapters (Gemini, Cursor, Copilot, Qwen). Reads keys from `~/.claude/plugins/cc-multi-cli-plugin/config.json` (already populated by `/multi:setup`).
- **Client-side ACP terminal services** (`scripts/lib/acp-terminals.mjs`) — `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` backed by `child_process.spawn` with a 1 MiB output ring buffer. Handshake declares `clientCapabilities.terminal: true`.
- **Yolo / max-permission defaults.** Gemini approval mode is now always `yolo`; Codex sandbox for `--write` tasks is `danger-full-access`; Cursor spawn includes `--yolo --approve-mcps acp` and explicitly sets ACP mode based on role.
- **`ACP_TRACE=1` env var** for full incoming-message tracing — single most useful diagnostic when an agent silently hangs.
- **One-time stderr warning** when Cursor 2026.04.17-787b533 (the build with the documented MCP/Terminal regression) is detected. Auto-quiet on other versions.
- **Operator escape hatches**: `CURSOR_AGENT_PATH` env var is now honored for pinning a specific Cursor build. Documented in the `customize` skill.

### Changed

- **All 10 multi/agents/*.md** loosened forwarding contract: capture stderr (`2>&1`), forbid ad-hoc polling/sleep/cat, return a structured one-line failure summary on Bash failure (instead of silently returning nothing). `--write` defaults added to writer-style agents (cursor-debugger, cursor-writer, qwen-writer).
- **Skills** (`multi-cli-anything`, `customize`) now document the ACP gotchas we hit empirically — out-of-band permission gates, terminal capability semantics, MCP wiring quirks, mode-setting variance, version sensitivity. `cursor.mjs` is cited as the worked example.
- **README** Known Issues section with documented Cursor 2026.04.17 upstream regressions (forum links).

### Known issues (upstream, not fixable from the plugin)

- Cursor 2026.04.17 `agent acp` does not send `session/request_permission` over the wire and silently stalls Terminal/MCP tool calls. Workaround: pre-approval via `cli-config.json` allowlist (auto-applied) keeps simple shell exec working; complex multi-tool runs may still hang. Pin an older build via `CURSOR_AGENT_PATH` if needed.

## v2.0.0 — 2026-04-24

### Breaking — renamed from `skill-gemini` to `cc-multi-cli-plugin`

This release fully replaces the former `skill-gemini` plugin. The plugin has a new name, a new repo URL (github.com/greenpolo/cc-multi-cli-plugin), a new scope (4 CLI providers, not just Gemini), and new commands. There is no in-place upgrade path.

**Migration from v1 (`skill-gemini`):**
1. In Claude Code: `/plugin uninstall skill-gemini`
2. In Claude Code: `/plugin install cc-multi-cli-plugin` (from github.com/greenpolo/cc-multi-cli-plugin)
3. Run `/multi:setup` to configure MCPs on each CLI
4. The old `skills/gemini` SKILL is gone. Its functionality is absorbed by `/gemini:research` and the `gemini-researcher` subagent.

### Added

**Four CLI transport adapters, three protocols:**
- Codex via App Server Protocol (ASP) — `codex --app-server`
- Gemini via Agent Client Protocol (ACP) — `gemini --acp`
- Cursor via ACP — `agent acp`
- GitHub Copilot via ACP — `copilot --acp --stdio`

**Eight slash commands:**
- `/multi:setup` — one-shot Claude-driven wizard that detects installed CLIs and configures Exa + Context7 MCPs on each
- `/gemini:research` — deep research / exploration with Gemini's 1M-token context (read-only)
- `/codex:execute` — delegate a specific plan step to Codex for rigorous implementation
- `/cursor:write` — bulk / multi-file code writing in Cursor Agent mode
- `/cursor:plan` — Cursor Plan mode for approach design (read-only)
- `/cursor:debug` — Cursor Debug mode for hypothesis-driven root-cause investigation
- `/copilot:research` — Copilot's /research (GitHub + web investigation)
- `/copilot:review` — Copilot's /review code review agent

**Four auto-dispatch subagents** (Claude proactively delegates via the Agent tool):
- `gemini-researcher`, `codex-execute`, `cursor-writer`, `cursor-debugger`

**Two extension skills:**
- `customize` — guides Claude through rewiring which CLI handles which role (swap, disable, restrict, etc.)
- `multi-cli-anything` — guides Claude through adding brand-new CLI providers (ACP, ASP, or subprocess paths)

**Companion runtime** (ported from OpenAI's `codex-plugin-cc`):
- Shared CLI adapter registry with `--cli <name>` dispatch
- Background job control (`--background` / `--wait`)
- Session state persistence under `~/.claude/plugins/cc-multi-cli-plugin/state/`
- Session lifecycle hooks
- Windows-safe `spawn()` pattern for `.cmd`-wrapped CLIs (Cursor, Gemini, Copilot on npm global installs)

### Changed

- Plugin name: `skill-gemini` → `cc-multi-cli-plugin`
- License: unchanged (Apache 2.0) but `LICENSE` and `NOTICE` files added with full upstream attribution
- Repo layout: flattened from marketplace format (`plugins/skill-gemini/`) to a single-plugin layout at the repo root

### Removed

- The old Gemini-only `skills/gemini/SKILL.md` — functionality absorbed by `gemini-researcher` + `/gemini:research`
- The repo's former `plugins/skill-gemini/` nested directory
- The former `.claude-plugin/marketplace.json` marketplace manifest

### Known limitations

These are explicit v2.0.0 deferrals. Filed for a future release.

- **Background task worker untested for non-Codex CLIs.** The `cli` field is stored in the job request and threaded through `executeTaskRun`, so Gemini/Cursor/Copilot background jobs *should* work — not yet verified end-to-end.
- **`--resume-last` is Codex-only.** Gemini/Cursor/Copilot receive the flag but have no session-resumption logic wired to the adapter. Per-invocation ACP sessions work; cross-invocation resume does not yet.
- **`job-observability` integration** between the shared runtime and non-Codex adapters is partial. `recordObserverEvent` is a no-op in the Gemini/Cursor/Copilot paths. Doesn't affect correctness, does affect introspection.
- **`/codex:review` and `/codex:adversarial-review`** remain in the official `openai-codex` plugin; our plugin has no review path for non-Codex CLIs yet. Gemini/Cursor/Copilot reviews can be invoked through each CLI's native slash command via the companion runtime but not through top-level plugin commands.
- **Setup wizard's MCP probes.** `/multi:setup` configures MCPs on each CLI but doesn't deeply verify Exa / Context7 are reachable after configuration. Users should do a sanity check by running `/gemini:research test` or similar after setup.

### Attribution

Apache 2.0 licensed. Major portions derived from:

- OpenAI's `codex-plugin-cc` (Apache 2.0) — runtime architecture, Codex adapter, hooks
- `sakibsadmanshajib/gemini-plugin-cc` (Apache 2.0) — Gemini ACP transport pattern
- `blowmage/cursor-agent-acp-npm` (MIT) — Cursor ACP adapter reference

See [NOTICE](NOTICE) for the full attribution.

## v1.0.0 — 2026-03 (as `skill-gemini`)

Original Gemini-only read-only consultation skill. See `v1.0.0` git tag for history. Superseded by v2.0.0.
