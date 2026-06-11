#!/usr/bin/env node
/**
 * Fake ACP agent fixture for offline, Windows-first contract tests of
 * lib/acp/client.mjs. Speaks newline-delimited JSON-RPC 2.0 on stdio exactly as a
 * real ACP agent (the client side is the SDK's ClientSideConnection).
 *
 * It is the AGENT half: it RECEIVES initialize/session_new/session/set_mode/
 * session/set_config_option/session/prompt requests and session/cancel
 * notifications, and SENDS session/update notifications + (optionally)
 * session/request_permission requests back to the client.
 *
 * Behavior is driven entirely by argv flags / env so a single file covers every
 * scenario:
 *   --models a,b,c        configOptions advertises a "model" select with these
 *                         value ids (and currentValue = first).
 *   --modes ask,plan      session/new advertises these mode ids.
 *   --stream "a|b|c"      emit these agent_message_chunk texts (pipe-separated)
 *                         before ending the turn (default a single "hello").
 *   --thought             emit an agent_thought_chunk before the message chunks.
 *   --weird-update        emit a made-up sessionUpdate kind (tests passthrough/
 *                         no-crash; the SDK drops it but must not crash).
 *   --usage               emit a usage_update notification.
 *   --permission          send a session/request_permission for a write tool and
 *                         honor the client's decision (records it to --record).
 *   --stop <reason>       stopReason for the prompt response (default end_turn).
 *   --cancel-mode honor|mislabel|ignore
 *                         honor    → on session/cancel, respond stopReason=cancelled.
 *                         mislabel → on session/cancel, respond stopReason=end_turn
 *                                    (the opencode mislabel).
 *                         ignore   → ignore session/cancel entirely (never replies
 *                                    to the prompt) → client must tree-kill us.
 *   --silent-after-init   complete the handshake, then go silent forever (never
 *                         answer the prompt) → inactivity watchdog must fire.
 *   --hang-handshake      spawn fine but never answer ANY request (hang at
 *                         initialize) → inactivity watchdog must fire pre-prompt.
 *   --die-mid-turn        handshake + one chunk, then exit(3) without answering
 *                         the prompt → explicit crash/protocol error required.
 *   --die-early           print a stderr line and exit(1) before any handshake.
 *   --record <file>       append received methods / decisions as JSON lines.
 *   --delay-ms <n>        delay before answering the prompt (default 30).
 *   --echo-env <NAME>     on startup, record {env_NAME: process.env.NAME ?? null}
 *                         so a test can assert the spawn env (e.g. the read-only
 *                         OPENCODE_PERMISSION deny floor) actually reached us.
 *
 * No external deps; raw stdio JSON-RPC only.
 */

import { appendFileSync } from "node:fs";
import process from "node:process";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const val = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const RECORD = val("record", null);
function record(obj) {
  if (!RECORD) return;
  try {
    appendFileSync(RECORD, JSON.stringify(obj) + "\n");
  } catch {
    // best-effort
  }
}

if (flag("die-early")) {
  process.stderr.write("fake-acp-agent: fatal boot error (die-early)\n");
  process.exit(1);
}

// Record a chosen env var on startup so tests can assert the spawn env (e.g. the
// read-only OPENCODE_PERMISSION deny floor) reached the spawned process.
{
  const echoName = val("echo-env", null);
  if (echoName) {
    record({ [`env_${echoName}`]: process.env[echoName] ?? null });
  }
}

const MODELS = (val("models", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const MODES = (val("modes", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const STREAM = (val("stream", "hello") || "").split("|").filter((s) => s.length);
const STOP = val("stop", "end_turn");
const CANCEL_MODE = val("cancel-mode", "honor");
const DELAY_MS = parseInt(val("delay-ms", "30"), 10);

let sessionCounter = 0;
let cancelled = false;
let promptReqId = null;
let promptSessionId = null;

// ── wire helpers ────────────────────────────────────────────────────────────
function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function sessionUpdate(sessionId, update) {
  notify("session/update", { sessionId, update });
}

let nextOutboundId = 10000;
const pendingOutbound = new Map();
function requestClient(method, params) {
  return new Promise((resolve) => {
    const id = nextOutboundId++;
    pendingOutbound.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

// ── inbound parsing ─────────────────────────────────────────────────────────
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function handle(msg) {
  // Response to one of OUR outbound requests (e.g. request_permission).
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pendingOutbound.get(msg.id);
    if (resolve) {
      pendingOutbound.delete(msg.id);
      resolve(msg);
    }
    return;
  }
  // Notification from the client.
  if (msg.id === undefined && msg.method) {
    if (msg.method === "session/cancel") {
      cancelled = true;
      record({ recv: "session/cancel" });
      onCancel();
    }
    return;
  }
  // Request from the client.
  if (msg.id !== undefined && msg.method) {
    record({ recv: msg.method });
    dispatchRequest(msg);
  }
}

function dispatchRequest(msg) {
  if (flag("hang-handshake")) {
    // Spawn fine, then never answer ANY request (a CLI stuck on a lock/auth/
    // network at startup). The client's inactivity watchdog must catch this —
    // not the 30-minute overall cap.
    record({ hung_on: msg.method });
    return;
  }
  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? 1,
        agentCapabilities: {},
        agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
        authMethods: [],
      });
      return;
    case "session/new": {
      const sessionId = `fake-sess-${++sessionCounter}`;
      const response = { sessionId };
      if (MODES.length) {
        response.modes = {
          currentModeId: MODES[0],
          availableModes: MODES.map((m) => ({ id: m, name: m })),
        };
      }
      if (MODELS.length) {
        response.configOptions = [
          {
            type: "select",
            id: "model",
            category: "model",
            name: "Model",
            currentValue: MODELS[0],
            options: MODELS.map((m) => ({ value: m, name: m })),
          },
        ];
      }
      respond(msg.id, response);
      return;
    }
    case "session/set_mode":
      record({ set_mode: msg.params?.modeId });
      respond(msg.id, {});
      return;
    case "session/set_config_option":
      record({
        set_config: {
          configId: msg.params?.configId,
          value: msg.params?.value,
          sessionId: msg.params?.sessionId,
        },
      });
      // Echo back the (now-updated) config options.
      respond(msg.id, {
        configOptions: MODELS.length
          ? [
              {
                type: "select",
                id: "model",
                category: "model",
                name: "Model",
                currentValue: msg.params?.value ?? MODELS[0],
                options: MODELS.map((m) => ({ value: m, name: m })),
              },
            ]
          : [],
      });
      return;
    case "session/prompt":
      promptReqId = msg.id;
      promptSessionId = msg.params?.sessionId;
      runTurn();
      return;
    default:
      // Unknown request — method not found.
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `fake agent: ${msg.method} not supported` },
      });
      return;
  }
}

// ── turn execution ──────────────────────────────────────────────────────────
async function runTurn() {
  const sessionId = promptSessionId;

  if (flag("silent-after-init")) {
    // Never answer the prompt → client inactivity watchdog should fire.
    return;
  }

  if (flag("die-mid-turn")) {
    // Stream one chunk, then crash without ever answering the prompt request
    // (a CLI segfault/OOM mid-run). The client must surface an explicit error —
    // never a success-shaped result — whichever of the exit handler or the
    // SDK's connection-closed rejection wins the race.
    sessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "partial before crash " },
    });
    setTimeout(() => {
      process.stderr.write("fake-acp-agent: simulated mid-turn crash (exit 3)\n");
      process.exit(3);
    }, 150);
    return;
  }

  if (CANCEL_MODE === "ignore") {
    // Emit nothing and never resolve the prompt — but keep streaming slowly so we
    // are clearly "alive". The client will cancel, we ignore it, grace expires,
    // and the client tree-kills us. Stay alive until killed.
    const keepAlive = setInterval(() => {
      if (cancelled) {
        // Intentionally ignore: do NOT respond to the prompt.
      }
    }, 250);
    keepAlive.unref?.();
    return;
  }

  // Optional permission round-trip BEFORE streaming.
  if (flag("permission")) {
    const resp = await requestClient("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "tc-1", title: "Write file", kind: "edit" },
      options: [
        { optionId: "allow-once", kind: "allow_once", name: "Allow" },
        { optionId: "reject-once", kind: "reject_once", name: "Reject" },
      ],
    });
    record({ permission_outcome: resp?.result?.outcome ?? resp?.error ?? null });
  }

  if (flag("thought")) {
    sessionUpdate(sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking..." },
    });
  }

  if (flag("weird-update")) {
    // A made-up kind the SDK's zod union does NOT know. The SDK must drop it
    // without crashing the connection.
    sessionUpdate(sessionId, {
      sessionUpdate: "totally_made_up_kind",
      content: { type: "text", text: "ignore me" },
    });
  }

  for (const text of STREAM) {
    sessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  }

  if (flag("usage")) {
    sessionUpdate(sessionId, {
      sessionUpdate: "usage_update",
      size: 100000,
      used: 1234,
    });
  }

  await delay(DELAY_MS);

  if (cancelled) {
    // The cancel arrived during the turn.
    finishTurn(CANCEL_MODE === "mislabel" ? "end_turn" : "cancelled");
    return;
  }
  finishTurn(STOP);
}

function onCancel() {
  if (CANCEL_MODE === "ignore") return; // explicitly ignore
  if (promptReqId === null) return; // no in-flight prompt
  // Respond promptly to the in-flight prompt with the configured reason.
  const reason = CANCEL_MODE === "mislabel" ? "end_turn" : "cancelled";
  finishTurn(reason);
}

let turnFinished = false;
function finishTurn(stopReason) {
  if (turnFinished || promptReqId === null) return;
  turnFinished = true;
  respond(promptReqId, { stopReason });
  promptReqId = null;
  // Close cleanly so the client's child-exit path runs.
  setTimeout(() => process.exit(0), 10);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Keep the process alive while waiting on stdin.
process.stdin.resume();
