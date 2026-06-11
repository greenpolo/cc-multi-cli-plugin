/**
 * ACP turn runner — the policy layer over the vendored ACP SDK's
 * ClientSideConnection. One ACP child process per turn; resolves (never rejects
 * for operational failures) to a uniform result that slots into the adapter
 * contract (`{ text, error, ... }`, error set rather than thrown).
 *
 * This module imports ONLY:
 *   - the committed vendor bundle (the ACP SDK + zod, inlined),
 *   - node built-ins,
 *   - existing lib helpers (process tree-kill, diagnostic sanitizer).
 * Hand-rolling the JSON-RPC client is prohibited (see the blueprint) — the SDK's
 * 0.19/0.22 fixes are exactly the hang class that killed the 2025 client.
 *
 * Policy implemented here (all per the blueprint):
 *   - permission auto-responder: reject by default; allow only when allowWrites.
 *   - setSessionMode + model pin via set_config_option (from the live
 *     configOptions list; a requested-but-absent model is a hard error, no
 *     silent fallback).
 *   - inactivity watchdog (reset on every session/update) + overall cap.
 *   - cancel = in-protocol session/cancel, 5s grace, then process-tree kill.
 *   - cancelled-detection rule: cancel-requested + turn-ended ⇒ cancelled=true,
 *     REGARDLESS of stopReason (opencode mislabels cancel as end_turn).
 *   - never log prompt content (diagnostics carry methods/tools/errors only).
 */

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import process from "node:process";

import {
  ndJsonStream,
  ClientSideConnection,
  PROTOCOL_VERSION,
} from "./vendor/acp-sdk.bundle.mjs";
import { terminateProcessTree } from "../process.mjs";
import { sanitizeDiagnosticMessage } from "./diagnostics.mjs";

/** Grace period (ms) between session/cancel and the process-tree kill. */
const CANCEL_GRACE_MS = 5000;
/** Default inactivity / overall watchdog windows (ms). */
const DEFAULT_INACTIVITY_MS = 120000;
const DEFAULT_OVERALL_MS = 1800000;

/**
 * Operator escape hatches (same convention as CODEX_COMPANION_TURN_INACTIVITY_MS):
 * MULTI_ACP_INACTIVITY_MS / MULTI_ACP_OVERALL_MS override the watchdog windows
 * when set to a positive integer. Read from the spawn env so tests and the
 * companion can scope them.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {number} fallback
 */
function envWindowMs(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Client identity advertised to the agent (never carries prompt content). */
const CLIENT_INFO = {
  name: "cc-multi-cli-plugin",
  title: "cc-multi-cli ACP client",
  version: "0.1.0",
};

/**
 * @typedef {object} AcpTurnSpec
 * @property {string} exe                 Executable to spawn.
 * @property {string[]} args              Argv for the executable.
 * @property {string} cwd                 Absolute working directory for the session.
 * @property {NodeJS.ProcessEnv} [env]    Spawn environment (defaults to process.env).
 * @property {string} prompt              The user prompt text.
 * @property {string} [sessionMode]       Mode id for session/set_mode (e.g. "ask").
 * @property {string} [model]             Value id for the "model" config option.
 * @property {(availableIds: string[], requested: string|undefined) => ({ value: string } | { error: { code?: string, message: string, detail?: string } })} [resolveModel]
 *   Optional resolver invoked with the LIVE model value ids (post-session/new,
 *   pre-prompt) so the caller can map a friendly/partial name to an exact id
 *   (e.g. cursor's composite "composer-2.5" → "composer-2.5[fast=true]"). Return
 *   `{ value }` to pin that id, or `{ error }` to fail the turn before prompting.
 *   When omitted, `model` is used directly and validated against the live list.
 * @property {boolean} [allowWrites]      Allow write tool calls (default false → reject).
 * @property {number} [inactivityMs]      No-update watchdog window (default 120000).
 * @property {number} [overallMs]         Hard overall cap (default 1800000).
 * @property {(chunk: string) => void} [onStream]       Assistant text-chunk sink.
 * @property {(update: any) => void} [onUpdate]         Raw session/update sink.
 * @property {(message: string) => void} [onDiagnostic] Diagnostic line sink.
 * @property {AbortSignal} [signal]       External cancel trigger (alternative to .cancel()).
 */

/**
 * @typedef {object} AcpTurnResult
 * @property {string} text
 * @property {{ code: string, message: string, detail?: string } | null} error
 * @property {string|null} sessionId
 * @property {string|null} stopReason
 * @property {boolean} cancelled
 * @property {any} modes
 * @property {Array<any>} configOptions
 * @property {any} usage
 * @property {number|null} exitCode
 */

/**
 * Flatten a "model" config option's options list into an array of value ids,
 * tolerating both the flat (`[{value}]`) and grouped (`[{group, options:[{value}]}]`)
 * shapes the SDK allows.
 *
 * @param {any} modelOption
 * @returns {string[]}
 */
export function listModelValueIds(modelOption) {
  const options = Array.isArray(modelOption?.options) ? modelOption.options : [];
  const ids = [];
  for (const opt of options) {
    if (opt && typeof opt === "object" && Array.isArray(opt.options)) {
      // grouped
      for (const inner of opt.options) {
        if (inner && typeof inner.value === "string") ids.push(inner.value);
      }
    } else if (opt && typeof opt === "object" && typeof opt.value === "string") {
      ids.push(opt.value);
    }
  }
  return ids;
}

/** Locate the "model" config option (by category first, then by id). */
export function findModelConfigOption(configOptions) {
  const list = Array.isArray(configOptions) ? configOptions : [];
  return (
    list.find((o) => o?.category === "model") ??
    list.find((o) => o?.id === "model") ??
    null
  );
}

/**
 * Run one ACP turn. Resolves to {@link AcpTurnResult}; never rejects for
 * operational failures. The returned promise carries a `.cancel()` method (in
 * addition to honoring `spec.signal`) so an in-flight turn can be cancelled.
 *
 * @param {AcpTurnSpec} spec
 * @returns {Promise<AcpTurnResult> & { cancel: () => void }}
 */
export function runAcpTurn(spec) {
  const {
    exe,
    args = [],
    cwd,
    env = process.env,
    prompt,
    sessionMode,
    model,
    resolveModel,
    allowWrites = false,
    inactivityMs = envWindowMs(spec?.env ?? process.env, "MULTI_ACP_INACTIVITY_MS", DEFAULT_INACTIVITY_MS),
    overallMs = envWindowMs(spec?.env ?? process.env, "MULTI_ACP_OVERALL_MS", DEFAULT_OVERALL_MS),
    onStream,
    onUpdate,
    onDiagnostic,
    signal,
  } = spec ?? {};

  // Cancel plumbing: a single flag + an outward-facing trigger. cancelRequested
  // is the source of truth for the cancelled-detection rule.
  let cancelRequested = false;
  let triggerCancel = () => {};
  // Exposed on the returned promise so callers/tests can probe the child (e.g.
  // assert no orphan after a tree-kill). Set once the child is spawned.
  let childPid = null;

  const diag = (message) => {
    if (!onDiagnostic) return;
    const clean = sanitizeDiagnosticMessage(message);
    if (clean) {
      try {
        onDiagnostic(clean);
      } catch {
        // Best-effort.
      }
    }
  };

  const promise = new Promise((resolve) => {
    /** @type {AcpTurnResult} */
    const result = {
      text: "",
      error: null,
      sessionId: null,
      stopReason: null,
      cancelled: false,
      modes: null,
      configOptions: [],
      usage: null,
      exitCode: null,
    };

    let settled = false;
    let child = null;
    let connection = null;
    let inactivityTimer = null;
    let overallTimer = null;
    let killTimer = null;
    let handshakeDone = false;
    let stderrTail = "";

    const clearTimers = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (overallTimer) clearTimeout(overallTimer);
      if (killTimer) clearTimeout(killTimer);
      inactivityTimer = overallTimer = killTimer = null;
    };

    /** Tree-kill the child (no orphans). Safe to call repeatedly. */
    const killChild = () => {
      if (!child || child.killed || result.exitCode !== null) return;
      try {
        terminateProcessTree(child.pid, { env });
      } catch {
        try {
          child.kill();
        } catch {
          // Best-effort.
        }
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimers();
      // Cancelled-detection rule: if cancel was ever requested and the turn ended,
      // it is cancelled regardless of the stopReason the agent reported.
      if (cancelRequested) result.cancelled = true;
      killChild();
      resolve(result);
    };

    const setError = (code, message, detail) => {
      if (result.error) return; // first error wins
      result.error = {
        code,
        message,
        ...(detail ? { detail: sanitizeDiagnosticMessage(detail) } : {}),
      };
    };

    const resetInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        diag(`inactivity watchdog fired after ${inactivityMs}ms`);
        setError("timeout", `No ACP session/update for ${inactivityMs}ms.`);
        cancelFlow("inactivity timeout");
      }, inactivityMs);
    };

    /**
     * Cancel flow: mark cancelled, send in-protocol session/cancel, wait a grace
     * window for the prompt promise to resolve, then tree-kill the child. The
     * prompt promise resolving (or the child exiting) triggers finish() normally.
     */
    const cancelFlow = (reason) => {
      cancelRequested = true;
      diag(`cancel requested (${reason})`);
      // Stop the inactivity timer from re-firing during the grace window.
      if (inactivityTimer) {
        clearTimeout(inactivityTimer);
        inactivityTimer = null;
      }
      if (connection && result.sessionId) {
        try {
          // Notification — returns a promise but needs no await for flow control.
          Promise.resolve(connection.cancel({ sessionId: result.sessionId })).catch(() => {});
        } catch {
          // Best-effort.
        }
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          diag("cancel grace expired — killing process tree");
          killChild();
        }, CANCEL_GRACE_MS);
      }
    };

    triggerCancel = () => cancelFlow("external cancel");

    if (signal) {
      if (signal.aborted) {
        // Defer so .cancel()/resolve wiring is in place.
        queueMicrotask(() => cancelFlow("signal already aborted"));
      } else {
        signal.addEventListener("abort", () => cancelFlow("signal aborted"), { once: true });
      }
    }

    // ── spawn ─────────────────────────────────────────────────────────────────
    try {
      child = spawn(exe, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      childPid = child.pid ?? null;
    } catch (err) {
      setError("spawn", `Failed to spawn ACP agent: ${String(err?.message ?? err)}`);
      finish();
      return;
    }

    child.on("error", (err) => {
      setError("spawn", `ACP agent process error: ${String(err?.message ?? err)}`, stderrTail);
      finish();
    });

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        // Keep a bounded tail for spawn-failure detail; emit each line as a
        // diagnostic. Never includes prompt content (that goes over stdin only).
        stderrTail = (stderrTail + text).slice(-4000);
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) diag(line);
        }
      });
    }

    child.on("exit", (code, sig) => {
      result.exitCode = code ?? (sig ? -1 : 0);
      if (!handshakeDone) {
        // Child died before we completed the handshake → spawn-class failure.
        setError(
          "spawn",
          `ACP agent exited before handshake (code ${code ?? "null"}${sig ? `, signal ${sig}` : ""}).`,
          stderrTail
        );
        finish();
      } else {
        // Post-handshake exit. If the turn has not settled, no stopReason ever
        // arrived, and we did not cancel, the agent CRASHED mid-turn. Set an
        // explicit error: whether this handler or the SDK's connection-closed
        // rejection wins the race, the result must never look like a success.
        if (!settled && !cancelRequested && result.stopReason === null) {
          setError(
            "crash",
            `ACP agent exited mid-turn (code ${code ?? "null"}${sig ? `, signal ${sig}` : ""}) without finishing the prompt.`,
            stderrTail
          );
        }
        finish();
      }
    });

    // ── connection ──────────────────────────────────────────────────────────────
    // Input writable FIRST, then readable (per the SDK recipe).
    let stream;
    try {
      stream = ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(child.stdout)
      );
    } catch (err) {
      setError("spawn", `Failed to wrap ACP stdio streams: ${String(err?.message ?? err)}`, stderrTail);
      finish();
      return;
    }

    // The client handler: ONLY requestPermission + sessionUpdate (we advertise no
    // fs/terminal capabilities, so nothing else can fire).
    const clientHandler = {
      async requestPermission(params) {
        const options = Array.isArray(params?.options) ? params.options : [];
        const toolTitle =
          params?.toolCall?.title ??
          params?.toolCall?.toolCallId ??
          params?.toolCall?.kind ??
          "tool";
        if (cancelRequested) {
          // Per ACP: if we cancelled, respond Cancelled to outstanding permissions.
          diag(`permission request during cancel (${toolTitle}) → cancelled`);
          return { outcome: { outcome: "cancelled" } };
        }
        const reject =
          options.find((o) => o?.kind === "reject_once") ??
          options.find((o) => o?.kind === "reject_always");
        const allow =
          options.find((o) => o?.kind === "allow_once") ??
          options.find((o) => o?.kind === "allow_always") ??
          options[0];
        const chosen = allowWrites ? (allow ?? reject) : (reject ?? allow);
        diag(
          `permission request (${toolTitle}) → ${allowWrites ? "allow" : "reject"}` +
            (chosen?.kind ? ` [${chosen.kind}]` : "")
        );
        if (!chosen) {
          // No options offered — cancel outcome is the safe response.
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome: { outcome: "selected", optionId: chosen.optionId } };
      },

      async sessionUpdate(params) {
        // Every update resets the inactivity watchdog.
        resetInactivity();
        const update = params?.update ?? {};
        const kind = update.sessionUpdate;
        if (onUpdate) {
          try {
            onUpdate(update);
          } catch {
            // Best-effort.
          }
        }
        if (kind === "agent_message_chunk") {
          const block = update.content;
          if (block?.type === "text" && typeof block.text === "string") {
            result.text += block.text;
            if (onStream) {
              try {
                onStream(block.text);
              } catch {
                // Best-effort.
              }
            }
          }
        } else if (kind === "usage_update") {
          // Capture the latest usage snapshot.
          result.usage = {
            size: update.size,
            used: update.used,
            ...(update.cost ? { cost: update.cost } : {}),
          };
        }
        // Unknown-but-schema-valid kinds (e.g. agent_thought_chunk) are tolerated:
        // forwarded to onUpdate above, otherwise ignored.
      },
    };

    try {
      connection = new ClientSideConnection(() => clientHandler, stream);
    } catch (err) {
      setError("spawn", `Failed to establish ACP connection: ${String(err?.message ?? err)}`, stderrTail);
      finish();
      return;
    }

    // Overall hard cap.
    overallTimer = setTimeout(() => {
      diag(`overall watchdog fired after ${overallMs}ms`);
      setError("timeout", `ACP turn exceeded the overall cap of ${overallMs}ms.`);
      cancelFlow("overall timeout");
    }, overallMs);

    // Arm the inactivity watchdog from the very start so it covers the HANDSHAKE
    // phase too (initialize → session/new → set_mode → model pin). A CLI that
    // spawns and then hangs silently before ever answering must be caught by
    // inactivityMs, not by the 30-minute overall cap. Handshake steps normally
    // complete in seconds; cold starts (~15 s) sit far inside the 120 s default.
    resetInactivity();

    // ── main flow ───────────────────────────────────────────────────────────────
    (async () => {
      try {
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            // terminal omitted (false) — we provide no terminal services.
          },
          clientInfo: CLIENT_INFO,
        });

        // Each completed handshake step is progress — re-arm the silence window.
        resetInactivity();
        const session = await connection.newSession({ cwd, mcpServers: [] });
        resetInactivity();
        result.sessionId = session?.sessionId ?? null;
        result.modes = session?.modes ?? null;
        result.configOptions = Array.isArray(session?.configOptions) ? session.configOptions : [];
        handshakeDone = true;
        diag(`session ready (${result.sessionId ?? "no id"})`);

        // Session mode (e.g. "ask"/"plan" for read-only roles).
        if (sessionMode) {
          await connection.setSessionMode({ sessionId: result.sessionId, modeId: sessionMode });
          diag(`set session mode → ${sessionMode}`);
        }

        // Model pin: resolve + validate against the LIVE options list first (no
        // silent fallback — a miss is a configuration error before we ever prompt).
        if (model || resolveModel) {
          const modelOption = findModelConfigOption(result.configOptions);
          const available = listModelValueIds(modelOption);

          // Caller-supplied resolver gets the live ids so a friendly/partial name
          // can be mapped to an exact composite id (cursor) before prompting.
          let pinned = model;
          if (typeof resolveModel === "function") {
            let resolution;
            try {
              resolution = resolveModel(available, model);
            } catch (err) {
              resolution = { error: { code: "config", message: String(err?.message ?? err) } };
            }
            if (resolution && resolution.error) {
              const e = resolution.error;
              setError(e.code ?? "config", e.message, e.detail);
              diag(`model resolver rejected "${model ?? ""}" — failing before prompt`);
              killChild();
              finish();
              return;
            }
            if (resolution && typeof resolution.value === "string") {
              pinned = resolution.value;
            }
          }

          if (pinned) {
            if (modelOption && available.length && !available.includes(pinned)) {
              setError(
                "config",
                `Requested model "${pinned}" is not offered by this agent.`,
                `Available: ${available.join(", ")}`
              );
              diag(`model "${pinned}" not in options — failing before prompt`);
              // End the turn cleanly without prompting.
              killChild();
              finish();
              return;
            }
            // SDK setSessionConfigOption param shape for a select option is
            // { sessionId, configId, value } (the non-boolean union member; no
            // `type` field) — verified against the bundled .d.ts. This matches the
            // blueprint's expected wire shape, so the SDK wrapper is used directly.
            await connection.setSessionConfigOption({
              sessionId: result.sessionId,
              configId: modelOption?.id ?? "model",
              value: pinned,
            });
            diag(`set config option model → ${pinned}`);
          }
        }

        resetInactivity();
        const promptRes = await connection.prompt({
          sessionId: result.sessionId,
          prompt: [{ type: "text", text: String(prompt ?? "") }],
        });
        result.stopReason = promptRes?.stopReason ?? null;
        if (promptRes?.usage) result.usage = promptRes.usage;
        diag(`prompt resolved (stopReason ${result.stopReason})`);
        finish();
      } catch (err) {
        // The connection closing mid-flight (e.g. after a kill) rejects pending
        // requests — that's an expected path during cancel/timeout, not a new error.
        if (cancelRequested) {
          diag(`flow ended during cancel: ${String(err?.message ?? err)}`);
          finish();
          return;
        }
        if (!handshakeDone) {
          // The connection broke before the handshake completed — almost always
          // the child dying on spawn. Let the child's `exit` handler (the
          // authoritative spawn-failure path: it records exitCode + the stderr
          // tail) finish first. If the exit hasn't landed yet, wait for it (capped)
          // so exitCode is reliably captured; the exit handler will call finish().
          const settleSpawnFailure = () => {
            if (!result.error) {
              setError(
                "spawn",
                `ACP agent failed before handshake: ${String(err?.message ?? err)}`,
                stderrTail
              );
            }
            finish();
          };
          if (result.exitCode !== null) {
            // Child already exited — its handler ran (or is about to); settle now.
            settleSpawnFailure();
          } else {
            // Wait for the exit (which sets exitCode + finishes), with a fallback
            // cap so we never hang if no exit ever arrives.
            child.once("exit", settleSpawnFailure);
            setTimeout(settleSpawnFailure, 1000);
          }
          return;
        }
        if (!result.error) {
          setError("protocol", `ACP turn failed: ${String(err?.message ?? err)}`, stderrTail);
        }
        finish();
      }
    })();
  });

  // Attach the cancel handle. Both .cancel() and spec.signal are supported; the
  // caller may pick either (documented in the JSDoc above).
  promise.cancel = () => triggerCancel();
  // The child's PID (or null if spawn failed). Lets callers/tests probe liveness.
  Object.defineProperty(promise, "pid", { get: () => childPid });
  return promise;
}
