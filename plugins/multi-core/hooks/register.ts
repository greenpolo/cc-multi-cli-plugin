import type { EngineInterface, Register } from 'claude-code';
import { atom, read, update } from 'claude-code';
import type { MultiCoreDisplayTools, MultiCorePolicy } from '../types/multi-core.d.ts';
import { register as registerCompaction } from './compact.ts';
import {
  HANDSHAKE_MS,
  type Handshake,
  nodeOf,
  noticeText,
  readHandshake,
  stopServed,
} from './desktop.ts';
import { isActive, postJson, type Wire } from './gateway.ts';
import { register as registerLifecycle } from './lifecycle.ts';
import { type PromptSnapshot, recordPrompt, snapshotKey } from './policy.ts';
import { isHarnessModel } from './provider.ts';
import {
  callDisplayRow,
  isDisplayTool,
  type RowsClient,
  register as registerRows,
  syncDisplayTools,
} from './rows.ts';
import { defined } from './state.ts';
import { register as registerUsage } from './usage.ts';
import { register as registerWorkers } from './workers.ts';

const modKeys = atom(
  { plugin: 'multi-core', key: 'modKeys' } as const,
  {} as Record<string, string>,
);

const wire = ($: EngineInterface): Wire => ({
  url: () => $.env.get('MULTI_MOD_GATEWAY_URL'),
  token: () => $.env.get('MULTI_GATEWAY_TOKEN'),
  fetch: (url, init) => $.http.fetch(url, init),
  sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  keys: { read: () => read($, modKeys), save: (change) => update($, modKeys, change) },
});

// State values are named where they are read: the engine's scan reads an atom's plugin and key
// from this file's own source, not across an import.
const policy = atom({ plugin: 'multi-core', key: 'policy' } as const, {} as MultiCorePolicy);
const displayTools = atom(
  { plugin: 'multi-core', key: 'displayTools' } as const,
  { registered: [] } as MultiCoreDisplayTools,
);

const rowsClient = ($: EngineInterface): RowsClient => ({
  wire: wire($),
  sessionId: () => $.session.id(),
  held: () => read($, displayTools),
  save: (change) => update($, displayTools, change),
  register: (tool) => $.tool.register(tool),
});

type PromptEvent = { session_id: string; cwd: string; permission_mode?: string };

// Claude Code 2.1.272 loads exactly one entry from hooks.json `modules`; compose here.
// What the hooks keep lives in `$.state` (`state.ts`), so a hot reload loses none of it.
export const register: Register = (on, options) => {
  registerUsage(on, options);
  registerLifecycle(on, options);
  registerCompaction(on, options);
  registerWorkers(on, options);
  registerRows(on);
  // One hook for every tool call (a module hooks an event once without a matcher): a
  // display row is answered here; other calls continue through the engine.
  on('tool.call', async ($, event, next) => {
    if (isDisplayTool(event.tool)) {
      return callDisplayRow(rowsClient($), event);
    }
    return next(event);
  });
  on('session.start', async ($, event, next) => {
    const workers = await serveDesktop($);
    if (await isActive(wire($))) {
      await $.command.register({
        name: 'multi-usage',
        description: 'Open provider quotas, spend, and session receipts.',
        immediate: true,
      });
      await greet($, await $.session.id(), await $.session.cwd());
    }
    const started = await next(event);
    for (const worker of workers) {
      await $.agent.register(worker);
    }
    return started;
  });
  on('classic.UserPromptSubmit', async ($, event, next) => {
    await recordSnapshot($, event);
    return next(event);
  });
  on('classic.SessionStart', async ($, event, next) => {
    if (typeof event.permission_mode === 'string') {
      await recordSnapshot($, event);
    }
    return next(event);
  });
};

/**
 * A Claude desktop app session has no launcher, so the mod starts the gateway (src/serve.ts)
 * and sets the session's environment from its handshake, as the launcher sets a terminal
 * session's. Only the desktop app's own sessions are served: a terminal keeps `claude-multi`,
 * and a session a launcher started (its gateway is set and is not one this mod started) is
 * left alone. A hot reload or a new start replaces the gateway this mod started. Returns the
 * worker types to register once the session is bound; any failure leaves plain Claude with
 * a one-line notice.
 */
async function serveDesktop($: EngineInterface): Promise<Handshake['workers']> {
  if ((await $.env.get('CLAUDE_CODE_ENTRYPOINT')) !== 'claude-desktop') {
    return [];
  }
  const ours = Boolean(await $.env.get('MULTI_DESKTOP_GATEWAY'));
  if ((await $.env.get('MULTI_MOD_GATEWAY_URL')) && !ours) {
    return [];
  }
  const stream = $.process.spawn({
    argv: [await installedNode($), `${$.plugin.root}/plugins/multi-core/src/serve.ts`],
    cwd: await $.session.cwd(),
  });
  const waiting = new AbortController();
  const late = $.clock.sleep(HANDSHAKE_MS, { signal: waiting.signal }).then(() => {
    throw new Error(`the gateway did not start within ${HANDSHAKE_MS / 1000} s`);
  });
  late.catch(() => undefined);
  try {
    const handshake = await Promise.race([
      readHandshake(stream, (text) => $.ui.log(text, { to: 'debug' })),
      late,
    ]);
    for (const [name, value] of Object.entries(handshake.env)) {
      await setVariable($, name, value || undefined);
    }
    await $.env.set('MULTI_DESKTOP_GATEWAY', '1');
    if (handshake.notice) {
      $.ui.toast(noticeText(handshake.notice));
    }
    return handshake.workers;
  } catch (error) {
    stopServed();
    if (ours) {
      await restoreSession($);
    }
    const reason = error instanceof Error ? error.message : String(error);
    $.ui.toast(noticeText(`Multi is off in this session: ${reason}`));
    return [];
  } finally {
    waiting.abort();
  }
}

/** The Node that setup recorded, which a desktop app's own PATH may not hold. */
async function installedNode($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
  try {
    return nodeOf(home ? await $.fs.read(`${home}/.local/share/multi-cli/state.json`) : undefined);
  } catch {
    return nodeOf(undefined);
  }
}

/**
 * Sets one variable the handshake names (src/launch/desktop.ts `DESKTOP_VARIABLES`). The
 * engine admits only names spelled in this module, so each is spelled here; any other
 * name is ignored.
 */
async function setVariable($: EngineInterface, name: string, value: string | undefined) {
  switch (name) {
    case 'ANTHROPIC_BASE_URL':
      return $.env.set('ANTHROPIC_BASE_URL', value);
    case 'ANTHROPIC_CUSTOM_HEADERS':
      return $.env.set('ANTHROPIC_CUSTOM_HEADERS', value);
    case 'ENABLE_TOOL_SEARCH':
      return $.env.set('ENABLE_TOOL_SEARCH', value);
    case 'HTTPS_PROXY':
      return $.env.set('HTTPS_PROXY', value);
    case 'https_proxy':
      return $.env.set('https_proxy', value);
    case 'NO_PROXY':
      return $.env.set('NO_PROXY', value);
    case 'no_proxy':
      return $.env.set('no_proxy', value);
    case 'CLAUDE_ENV_FILE':
      return $.env.set('CLAUDE_ENV_FILE', value);
    case 'MULTI_GATEWAY_TOKEN':
      return $.env.set('MULTI_GATEWAY_TOKEN', value);
    case 'MULTI_MOD_GATEWAY_URL':
      return $.env.set('MULTI_MOD_GATEWAY_URL', value);
    default:
      return setOriginal($, name, value);
  }
}

/** The user's own values the gateway's variables replaced, for nested Claude runs. */
async function setOriginal($: EngineInterface, name: string, value: string | undefined) {
  switch (name) {
    case 'MULTI_ORIG_ANTHROPIC_BASE_URL':
      return $.env.set('MULTI_ORIG_ANTHROPIC_BASE_URL', value);
    case 'MULTI_ORIG_ANTHROPIC_CUSTOM_HEADERS':
      return $.env.set('MULTI_ORIG_ANTHROPIC_CUSTOM_HEADERS', value);
    case 'MULTI_ORIG_HTTPS_PROXY':
      return $.env.set('MULTI_ORIG_HTTPS_PROXY', value);
    case 'MULTI_ORIG_https_proxy':
      return $.env.set('MULTI_ORIG_https_proxy', value);
    case 'MULTI_ORIG_NO_PROXY':
      return $.env.set('MULTI_ORIG_NO_PROXY', value);
    case 'MULTI_ORIG_no_proxy':
      return $.env.set('MULTI_ORIG_no_proxy', value);
    case 'MULTI_ORIG_NODE_EXTRA_CA_CERTS':
      return $.env.set('MULTI_ORIG_NODE_EXTRA_CA_CERTS', value);
    case 'MULTI_ORIG_CLAUDE_ENV_FILE':
      return $.env.set('MULTI_ORIG_CLAUDE_ENV_FILE', value);
    default:
      return {};
  }
}

/** A replacement gateway failed to start: the session goes back to the user's own values. */
async function restoreSession($: EngineInterface) {
  await $.env.set('ANTHROPIC_BASE_URL', await $.env.get('MULTI_ORIG_ANTHROPIC_BASE_URL'));
  await $.env.set(
    'ANTHROPIC_CUSTOM_HEADERS',
    await $.env.get('MULTI_ORIG_ANTHROPIC_CUSTOM_HEADERS'),
  );
  await $.env.set('HTTPS_PROXY', await $.env.get('MULTI_ORIG_HTTPS_PROXY'));
  await $.env.set('https_proxy', await $.env.get('MULTI_ORIG_https_proxy'));
  await $.env.set('NO_PROXY', await $.env.get('MULTI_ORIG_NO_PROXY'));
  await $.env.set('no_proxy', await $.env.get('MULTI_ORIG_no_proxy'));
  await $.env.set('CLAUDE_ENV_FILE', await $.env.get('MULTI_ORIG_CLAUDE_ENV_FILE'));
  await $.env.set('MULTI_GATEWAY_TOKEN', undefined);
  await $.env.set('MULTI_MOD_GATEWAY_URL', undefined);
  await $.env.set('MULTI_DESKTOP_GATEWAY', undefined);
}

/**
 * The gateway's first record of a session (which also tells the launcher the mod is
 * live). `/clear` ends a session and starts another in the process without a
 * `session.start`, and `session.end` made the gateway forget the first, so the next
 * prompt greets it again before recording its snapshot.
 */
async function greet($: EngineInterface, sessionId: string, cwd: string) {
  await postJson(wire($), '/multi/mod/session', {
    sessionId,
    cwd,
    model: await $.session.model(),
    event: 'start',
  });
  await update($, policy, (held) => defined({ ...held, handshake: sessionId }));
}

/**
 * Records the prompt-boundary snapshot: the permission mode and workspace every
 * provider reads. It is posted only when it differs from the one the gateway holds, so
 * an unchanged prompt costs no round trip.
 */
async function recordSnapshot($: EngineInterface, event: PromptEvent) {
  if (!(await isActive(wire($)))) {
    return;
  }
  const held = await read($, policy);
  if (held.handshake !== event.session_id) {
    await greet($, event.session_id, event.cwd);
  }
  const prompt = snapshotOf(event);
  const model = await $.session.model();
  const key = snapshotKey(prompt, model);
  let posted = (await read($, policy)).posted;
  if (posted !== key) {
    posted = (await recordPrompt(wire($), prompt, model)) ? key : undefined;
  }
  await update($, policy, (latest) => defined<MultiCorePolicy>({ ...latest, prompt, posted }));
  if (isHarnessModel(model)) {
    // The display rows of this prompt's native run anchor only once their tools exist.
    await syncDisplayTools(rowsClient($));
  }
}

function snapshotOf(event: PromptEvent): PromptSnapshot {
  return defined({
    sessionId: event.session_id,
    cwd: event.cwd,
    permissionMode: event.permission_mode,
  });
}
