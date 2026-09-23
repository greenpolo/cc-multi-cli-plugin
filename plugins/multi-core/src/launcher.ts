#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AntigravityHarness } from '../../multi-antigravity/src/harness.ts';
import {
  checkAntigravityHooks,
  installAntigravityHook,
} from '../../multi-antigravity/src/hooks.ts';
import {
  type AntigravityModel,
  antigravityDefaultWorkerModel,
  antigravityPickerOptions,
  discoverAntigravityModels,
  nativeSpelling,
} from '../../multi-antigravity/src/models.ts';
import { antigravityPermissionPolicy } from '../../multi-antigravity/src/permissions.ts';
import { antigravityUsageReader } from '../../multi-antigravity/src/usage-adapter.ts';
import { CursorHarness } from '../../multi-cursor/src/harness.ts';
import type { CursorModelOption } from '../../multi-cursor/src/models.ts';
import {
  CURSOR_DEFAULT_WORKER_MODEL,
  cursorModelOptions,
  cursorPickerOptions,
} from '../../multi-cursor/src/models.ts';
import {
  cursorPermissionPolicy,
  mergeCursorPermissions,
} from '../../multi-cursor/src/permissions.ts';
import { cursorUsageReader } from '../../multi-cursor/src/usage-adapter.ts';
import { CursorWorkspaces } from '../../multi-cursor/src/workspaces.ts';
import { GrokHarness } from '../../multi-grok/src/harness.ts';
import {
  discoverGrokModels,
  type GrokModel,
  grokDefaultWorkerModel,
  grokPickerOptions,
} from '../../multi-grok/src/models.ts';
import { grokPermissionPolicy } from '../../multi-grok/src/permissions.ts';
import { grokUsageReader } from '../../multi-grok/src/usage-adapter.ts';
import { createOpenAIApproval, discoverOpenAIReviewer } from '../../multi-openai/src/approval.ts';
import { readCodexAuth } from '../../multi-openai/src/auth.ts';
import {
  MODELS,
  OPENAI_DEFAULT_WORKER_MODEL,
  OPENAI_WORKER_EFFORT,
} from '../../multi-openai/src/models.ts';
import type { Effort } from '../../multi-openai/src/responses.ts';
import { openAIUsageReader } from '../../multi-openai/src/usage-adapter.ts';
import { readZenKey } from '../../multi-zen/src/auth.ts';
import {
  ZEN_DEFAULT_WORKER_MODEL,
  ZEN_MODELS,
  ZEN_WORKER_EFFORT,
  zenModelOptions,
  zenPickerOptions,
} from '../../multi-zen/src/models.ts';
import { zenUsageReader } from '../../multi-zen/src/usage-adapter.ts';
import { AgentCatalog } from './gateway/agent-catalog.ts';
import {
  loadWorkerPermissions,
  type PluginPermissionInventory,
  pluginPermissions,
} from './gateway/agent-definitions.ts';
import { type CursorSettingsOptions, checkCursorSettings } from './gateway/cursor-settings.ts';
import { executableInvocation, resolveExecutable } from './gateway/executable.ts';
import { ModBridge } from './gateway/mod-bridge.ts';
import { PermissionModes } from './gateway/mode-hook.ts';
import { hookCommand } from './gateway/permission-hook.ts';
import type { ProviderUsageReader } from './gateway/provider-usage.ts';
import { ReceiptLedger } from './gateway/receipts.ts';
import type { GatewayEvent } from './gateway/server.ts';
import { createNativeGateway } from './gateway/server.ts';
import {
  buildWorkerCatalog,
  type WorkerCatalog,
  type WorkerProvider,
  workerDescription,
} from './gateway/worker-catalog.ts';

import { providerSelection } from './install/plugins.ts';

const enabledProviders = providerSelection(process.env.MULTI_ENABLED_PROVIDERS);
const providerEnabled = (provider: string) =>
  enabledProviders?.some((name) => name === provider) ?? true;
const claudeExecutable = process.env.MULTI_REAL_CLAUDE;

/**
 * Claude Code requires a non-empty subagent prompt. Workers get no behavioral rules here;
 * provider profiles and Claude's native subagent prompt govern them.
 */
const WORKER_PROMPT = 'Complete the delegated task.';

const CLAUDE_WORKER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'];

/** One `--agents` entry: an external worker using Claude Code's native tools. */
interface AgentDefinition {
  description: string;
  prompt: string;
  model: string;
  tools: string[];
  effort?: Effort;
}

/** One `/model` entry the launched session offers. */
interface ModelOption {
  behavesAs?: string;
  model: string;
  label: string;
  description: string;
}

interface LaunchSettings {
  modelPicker: { options: ModelOption[] };
  permissions?: Record<string, unknown>;
  [key: string]: unknown;
}

async function main() {
  const args = process.argv.slice(2);
  await handleCommand(args[0]);
  const { cursorModels, cursorSignedIn } = await discoverCursor(args[0] === '--cursor-models');
  if (args[0] === '--cursor-models') {
    printCursorModels(cursorModels, cursorSignedIn);
    return;
  }
  if (args[0] === '--') {
    args.shift();
  }
  validateSessionLaunch(args);
  const pluginInventory = await pluginPermissions(process.cwd(), args);
  const pluginRoot = await findPluginRoot(fileURLToPath(import.meta.url));
  await assertFunctionHooksSupported();
  const anthropic = await anthropicSignedIn();
  const fullCatalog = process.env.MULTI_MODELS !== undefined;
  const cursorPicker = selectedCursorOptions(cursorModels, fullCatalog);
  const authFile = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'auth.json',
  );
  const { codexSignedIn, openaiReview } = await discoverOpenAI(authFile);
  const zenKey = providerEnabled('zen') ? await readZenKey() : undefined;
  const antigravityModels = await discoverAntigravity();
  const grokModels = await discoverGrok();
  const token = randomBytes(32).toString('hex');
  const defaultModels = fullCatalog
    ? pickerSettings(
        codexSignedIn,
        selectedCursorOptions(cursorModels, false),
        Boolean(zenKey),
        antigravityModels,
        grokModels,
      ).modelPicker.options.map((option) => option.model)
    : [];
  const settings = pickerSettings(
    codexSignedIn,
    cursorPicker,
    Boolean(zenKey),
    antigravityModels,
    grokModels,
    fullCatalog,
  );
  await mergeSettings(args, settings);
  // The supervisor does not transfer --agents or our session-local gateway env,
  // and can outlive the child whose exit releases settingsDir and the gateway.
  // Keep ordinary background subagent tasks available within this owned session.
  settings.disableAgentView = true;
  filterPicker(settings, process.env.MULTI_MODELS, defaultModels);
  const callerSettings = structuredClone(settings);
  const { cursor, antigravity, grok } = nativeHarnesses(
    cursorModels,
    antigravityModels,
    grokModels,
    args,
    callerSettings,
  );
  const usageReaders = providerUsageReaders(authFile, zenKey, { cursor, antigravity, grok });
  const workers = workerCatalog(settings.modelPicker.options, grokModels);
  const agents = workerDefinitions(workers);
  const modBridge = new ModBridge();
  const settingsDir = await mkdtemp(path.join(os.tmpdir(), 'multi-native-settings-'));
  const callerSettingsFile = path.join(settingsDir, 'caller-settings.json');
  await writeFile(callerSettingsFile, JSON.stringify(callerSettings), { mode: 0o600 });
  const permissionModes = new PermissionModes(
    (cwd) =>
      loadWorkerPermissions(
        cwd,
        agents,
        [...args, '--settings', callerSettingsFile],
        pluginInventory,
      ),
    nativeSettingsCheck({ cursor, antigravity, grok }, args, callerSettings),
    { workers },
  );
  await permissionModes.precompute(process.cwd());
  const { approvalBridge, approvalProviders } = await discoverApprovals(
    authFile,
    cursorModels.length > 0,
    openaiReview,
  );
  const receipts = new ReceiptLedger({
    file: process.env.MULTI_RECEIPTS_FILE
      ? path.resolve(process.env.MULTI_RECEIPTS_FILE)
      : undefined,
    onError: (error) => {
      process.stderr.write(`[native] receipt not written: ${String(error)}\n`);
    },
  });
  const server = createNativeGateway({
    receipts,
    billedUsage: cursor?.billedUsageForSession.bind(cursor),
    token,
    enabledProviders,
    authFile,
    modBridge,
    cursor,
    antigravity,
    grok,
    zen: zenKey ? { apiKey: zenKey } : undefined,
    usageReaders,
    permissionModes,
    approvalBridge,
    approvalProviders,
    blockAnthropic: !anthropic,
    guardAuto: true,
    agentCatalog: new AgentCatalog(
      agents,
      settings.modelPicker.options.map((option) => option.model),
    ),
    onEvent: traceEvent,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Gateway did not bind a local port.');
  }
  const settingsFile = path.join(settingsDir, 'settings.json');
  const { selectedModel, modelArgument } = await initialSelection(args, settings, anthropic);
  if (modelArgument) {
    applyModelArgument(args, modelArgument);
  }
  configureApproval(settings, approvalProviders, selectedModel, { antigravity, grok }, anthropic);
  await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
  const definitions = JSON.stringify(agents);
  const childEnvironment = gatewayEnvironment(address.port, token, anthropic, Boolean(cursor));
  const claudePath = resolveExecutable('claude', {
    configuredPath: claudeExecutable,
    env: childEnvironment,
  });
  const childArguments = launcherArguments(
    args,
    settingsFile,
    definitions,
    pluginInventory,
    pluginRoot,
  );
  const childInvocation = executableInvocation(
    claudePath,
    childArguments,
    process.platform,
    childEnvironment,
  );
  try {
    checkLauncherArgumentLimit(agents, childInvocation, claudePath, process.platform);
  } catch (error) {
    server.close();
    await closeHarnesses({ cursor, antigravity, grok });
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
    throw error;
  }
  const ready = awaitModSessionStart();
  const child = spawn(childInvocation.command, childInvocation.args, {
    stdio: 'inherit',
    env: childEnvironment,
    detached: process.platform !== 'win32',
    ...childInvocation.options,
  });
  const shutdown = async () => {
    server.closeAllConnections();
    server.close();
    await closeHarnesses({ cursor, antigravity, grok });
    receipts.finishAll();
    await receipts.drain();
    await rm(settingsDir, { recursive: true, force: true });
  };
  try {
    await ready;
  } catch (error) {
    child.kill();
    await shutdown();
    throw error;
  }
  child.once('error', (error) => {
    console.error(error.message);
    void shutdown().finally(() => process.exit(1));
  });
  child.once('exit', (code) => {
    void shutdown().finally(() => process.exit(code ?? 1));
  });
  if (process.platform === 'win32') {
    // Windows console control events do not provide POSIX process groups. Claude's
    // child owns Ctrl+C handling; forward termination explicitly to its process tree.
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    process.on('SIGINT', () => {});
  } else {
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    // Unix foreground terminals deliver SIGINT to both processes; Claude owns its
    // interrupt UI, so the gateway deliberately remains alive.
    process.on('SIGINT', () => {});
  }
}

/**
 * Claude's plugin cache may be a symlink to a checkout. Node resolves the entry
 * module to its real path, so compare real paths rather than the argv spelling.
 */
function isEntryModule(argument: string | undefined): boolean {
  if (!argument) {
    return false;
  }
  const entry = fileURLToPath(import.meta.url);
  const resolved = path.resolve(argument);
  if (resolved === entry) {
    return true;
  }
  try {
    return realpathSync(resolved) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isEntryModule(process.argv[1])) {
  void main().catch((error) => {
    console.error(`Native gateway: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

function validateSessionLaunch(args: string[]) {
  if (
    args.some((arg) => arg === '--bg' || arg === '--background') ||
    ['attach', 'respawn'].includes(args[0] ?? '')
  ) {
    throw new Error(
      'Multi sessions must stay attached to their launcher. Exit and use --resume <session-id> to continue with a fresh gateway; whole-session background handoff is unsupported.',
    );
  }
  if (process.env.ANTHROPIC_BASE_URL) {
    throw new Error(
      'Start without ANTHROPIC_BASE_URL; this launcher supplies the central gateway.',
    );
  }
  if (args.some((arg) => arg === '--agents' || arg.startsWith('--agents='))) {
    throw new Error('This launcher supplies --agents; use agent files for additional agents.');
  }
}

interface Closable {
  close(): Promise<void>;
}

/** Every native harness releases its locks and child processes before the gateway exits. */
async function closeHarnesses(harnesses: Record<string, Closable | undefined>) {
  for (const harness of Object.values(harnesses)) {
    await harness?.close();
  }
}

/** Native harness runs answer to the caller's settings; other providers do not. */
function nativeSettingsCheck(
  harnesses: { cursor?: unknown; antigravity?: unknown; grok?: unknown },
  args: string[],
  callerSettings: LaunchSettings,
) {
  const native = Boolean(harnesses.cursor || harnesses.antigravity || harnesses.grok);
  return async (cwd: string) => {
    if (!native) {
      return {};
    }
    try {
      return await checkCursorSettings(cwd, args, callerSettings, sharedAdmission(harnesses));
    } catch (error) {
      return { nativePermissionError: String(error) };
    }
  };
}

function nativeHarnesses(
  cursorModels: CursorModelOption[],
  antigravityModels: AntigravityModel[],
  grokModels: GrokModel[],
  args: string[],
  callerSettings: LaunchSettings,
) {
  const cursor = cursorModels.length
    ? new CursorWorkspaces(
        (cwd) =>
          new CursorHarness(cursorModels, {
            cwd,
            checkPermissions: () => checkCursorSettings(cwd, args, callerSettings),
          }),
      )
    : undefined;
  const antigravity = antigravityModels.length
    ? new AntigravityHarness(antigravityModels, {
        checkPermissions: async (cwd, context) => {
          await checkAntigravityHooks();
          const restrictions = await checkCursorSettings(cwd, args, callerSettings, {
            validate: antigravityPermissionPolicy,
          });
          return antigravityPermissionPolicy(mergeCursorPermissions(context, restrictions));
        },
      })
    : undefined;
  const grok = grokModels.length
    ? new GrokHarness(grokModels, {
        checkPermissions: async (cwd, context) => {
          const restrictions = await checkCursorSettings(cwd, args, callerSettings);
          return grokPermissionPolicy(mergeCursorPermissions(context, restrictions));
        },
      })
    : undefined;
  return { cursor, antigravity, grok };
}

function providerUsageReaders(
  authFile: string,
  zenKey: string | undefined,
  harnesses: ReturnType<typeof nativeHarnesses>,
): Partial<Record<'openai' | 'cursor' | 'zen' | 'antigravity' | 'grok', ProviderUsageReader>> {
  const { cursor, antigravity, grok } = harnesses;
  return {
    openai: openAIUsageReader(authFile),
    cursor: cursor ? cursorUsageReader(cursor) : undefined,
    zen: zenKey ? zenUsageReader(zenKey) : undefined,
    antigravity: antigravity ? antigravityUsageReader() : undefined,
    grok: grok ? grokUsageReader() : undefined,
  };
}

async function discoverCursor(required: boolean) {
  if (!providerEnabled('cursor')) {
    return { cursorModels: [] as CursorModelOption[], cursorSignedIn: false };
  }
  const { Cursor } = await import('@cursor/sdk');
  const cursorSignedIn =
    Boolean(process.env.CURSOR_API_KEY) || (await Cursor.auth.status()).status === 'logged-in';
  let cursorModels: CursorModelOption[] = [];
  if (cursorSignedIn) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cursor model discovery timed out')), 15000);
      });
      cursorModels = cursorModelOptions(await Promise.race([Cursor.models.list(), timeout]));
    } catch (error) {
      if (required) {
        throw error;
      }
      console.error(
        `Cursor choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return { cursorModels, cursorSignedIn };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failedAuthProbeOutput(error: unknown): string {
  const details = recordValue(error);
  const code = details?.code;
  const stdout = details?.stdout;
  if (code === 1 && typeof stdout === 'string') {
    return stdout;
  }
  throw new Error('Claude auth status probe failed; cannot determine login state');
}

function parseAuthProbeOutput(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Claude auth status probe returned invalid JSON');
  }
  const details = recordValue(parsed);
  if (!details || typeof details.loggedIn !== 'boolean') {
    throw new Error('Claude auth status probe returned no boolean loggedIn field');
  }
  return details.loggedIn;
}

async function assertFunctionHooksSupported(): Promise<void> {
  let stdout: string;
  let executable = 'claude';
  try {
    executable = resolveExecutable('claude', {
      platform: process.platform,
      env: process.env,
      configuredPath: claudeExecutable,
    });
    const invocation = executableInvocation(
      executable,
      ['--version'],
      process.platform,
      process.env,
    );
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      timeout: 10000,
      maxBuffer: 65536,
      ...invocation.options,
    }));
  } catch (error) {
    const details = recordValue(error);
    const code = typeof details?.code === 'string' ? ` (${details.code})` : '';
    const firstLine = String(error).split('\n', 1)[0];
    throw new Error(
      `Claude Code 2.1.272 or newer with function hooks is required; unable to read ${executable} --version${code}: ${firstLine}.`,
      { cause: error },
    );
  }
  const match = stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match || !atLeastVersion(match.slice(1).map(Number), [2, 1, 272])) {
    throw new Error('Claude Code 2.1.272 or newer with function hooks is required.');
  }
}

function claudeCommand(args: readonly string[]) {
  const environment = process.env;
  return executableInvocation(
    resolveExecutable('claude', {
      platform: process.platform,
      env: environment,
      configuredPath: claudeExecutable,
    }),
    args,
    process.platform,
    environment,
  );
}

function atLeastVersion(actual: number[], required: number[]): boolean {
  for (let index = 0; index < required.length; index++) {
    const received = actual[index] ?? 0;
    const minimum = required[index] ?? 0;
    if (received !== minimum) {
      return received > minimum;
    }
  }
  return true;
}

/**
 * Claude Code has to start, load the plugin worker and run session.start before
 * the mod can acknowledge. A cold start on Windows takes well over five seconds
 * (large binary, antivirus scan), so the wait is generous and overridable.
 */
const modSessionStartTimeoutMs = Number(process.env.MULTI_MOD_START_TIMEOUT_MS ?? 30000);

function awaitModSessionStart(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.off('multi-mod-session-start', ready);
      reject(
        new Error(
          'Claude Code 2.1.272 or newer with loaded function hooks is required; the Multi mod did not acknowledge session.start.',
        ),
      );
    }, modSessionStartTimeoutMs);
    const ready = () => {
      clearTimeout(timer);
      resolve();
    };
    process.once('multi-mod-session-start', ready);
  });
}

async function anthropicSignedIn(): Promise<boolean> {
  // Ask Claude, including its OS credential store and configured helpers. Never read its tokens.
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return true;
  }
  let stdout: string;
  try {
    const invocation = claudeCommand(['auth', 'status', '--json']);
    ({ stdout } = await promisify(execFile)(invocation.command, invocation.args, {
      timeout: 10000,
      maxBuffer: 65536,
      ...invocation.options,
    }));
  } catch (error) {
    stdout = failedAuthProbeOutput(error);
  }
  return parseAuthProbeOutput(stdout);
}

async function discoverOpenAI(authFile: string) {
  if (!providerEnabled('openai')) {
    return { codexSignedIn: false, openaiReview: false };
  }
  let codexSignedIn = false;
  try {
    await readCodexAuth(authFile);
    codexSignedIn = true;
  } catch {
    console.error('OpenAI choices unavailable: sign in with codex login to enable them.');
  }
  let openaiReview = false;
  if (codexSignedIn) {
    try {
      openaiReview = await discoverOpenAIReviewer(authFile);
    } catch {
      /* Missing capability disables auto mode; inference remains available. */
    }
    if (!openaiReview) {
      console.error('OpenAI automatic reviewer unavailable; auto mode is disabled.');
    }
  }
  return { codexSignedIn, openaiReview };
}

/** One admission result is shared by every native provider, so it has to be judged by the
 * validator that rejects the least: a rule Antigravity or Grok supports natively must not be
 * refused here because Cursor cannot express it. Antigravity and Grok map every Claude tool
 * name Cursor cannot, so either one judges the shared result when present; Cursor re-validates
 * with its own policy on its own dispatch, where the rejection belongs and where it can name
 * the file. */
export function sharedAdmission(harnesses: {
  cursor?: unknown;
  antigravity?: unknown;
  grok?: unknown;
}): CursorSettingsOptions {
  if (harnesses.antigravity) {
    return { validate: antigravityPermissionPolicy, cursorToolRules: false };
  }
  if (harnesses.grok) {
    return { validate: grokPermissionPolicy, cursorToolRules: false };
  }
  return { validate: cursorPermissionPolicy, cursorToolRules: true };
}

/** The five provider workers resolve their models from the session's picker rows. */
export function workerCatalog(
  pickerModels: readonly { model: string }[],
  grokModels: readonly GrokModel[] = [],
): WorkerCatalog {
  return buildWorkerCatalog(pickerModels, {
    openai: { defaultId: () => OPENAI_DEFAULT_WORKER_MODEL, effort: OPENAI_WORKER_EFFORT },
    zen: { defaultId: () => ZEN_DEFAULT_WORKER_MODEL, effort: ZEN_WORKER_EFFORT },
    cursor: { defaultId: () => CURSOR_DEFAULT_WORKER_MODEL },
    antigravity: { defaultId: antigravityDefaultWorkerModel },
    grok: { defaultId: () => grokDefaultWorkerModel(grokModels) },
  });
}

const WORKER_RUNS: Readonly<Record<WorkerProvider, string>> = {
  openai: "Claude Code's tools",
  zen: "Claude Code's tools",
  cursor: 'native Cursor agent',
  antigravity: 'native Antigravity CLI',
  grok: 'native Grok Build CLI',
};

/**
 * One Agent type per signed-in provider. The definition's model is the provider's
 * default; an Agent call's `model` selects another, resolved by the mod at spawn.
 */
export function workerDefinitions(catalog: WorkerCatalog): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  for (const worker of Object.values(catalog)) {
    const model = worker.models.find((entry) => entry.id === worker.defaultId)?.model;
    if (!model) {
      continue;
    }
    agents[worker.type] = {
      description: workerDescription(worker, WORKER_RUNS[worker.provider]),
      prompt: WORKER_PROMPT,
      model,
      tools: CLAUDE_WORKER_TOOLS,
      ...(worker.effort ? { effort: worker.effort as Effort } : {}),
    };
  }
  return agents;
}

interface LauncherInvocation {
  command: string;
  args: readonly string[];
  viaComSpec?: boolean;
}

export function checkLauncherArgumentLimit(
  agents: Record<string, AgentDefinition>,
  invocation: LauncherInvocation,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') {
    return;
  }
  const viaComSpec = invocation.viaComSpec ?? /(?:^|[\\/])cmd\.exe$/i.test(invocation.command);
  const limit = viaComSpec ? 8000 : 32000;
  const commandLine = [invocation.command, ...invocation.args].join(' ');
  if (commandLine.length <= limit) {
    return;
  }
  const providers = new Map<string, number>();
  for (const [name, agent] of Object.entries(agents)) {
    const provider = agent.model.split('/')[1] ?? 'unknown';
    providers.set(
      provider,
      (providers.get(provider) ?? 0) + Buffer.byteLength(JSON.stringify({ [name]: agent })),
    );
  }
  const largest = [...providers.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([provider, bytes]) => `${provider} (${bytes} B)`)
    .join(', ');
  const shim = viaComSpec ? ' cmd.exe shim' : '';
  throw new Error(
    `Native worker registration needs ${commandLine.length.toLocaleString('en-US')} characters for ${executable}, above the Windows${shim} limit of ${limit.toLocaleString('en-US')}. Largest providers: ${largest || 'none'}. Disable providers or extra models to reduce the launcher arguments.`,
  );
}

async function mergeSettings(args: string[], settings: LaunchSettings) {
  // Keep one --settings argument, preserving explicit caller settings and our picker.
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--settings' && !args[i].startsWith('--settings=')) {
      continue;
    }
    const inline = args[i].startsWith('--settings=');
    const value = inline ? args[i].slice(11) : args[i + 1];
    if (!value) {
      throw new Error('--settings requires a JSON object or file');
    }
    const extra = await readSettings(value);
    const picker = settings.modelPicker;
    Object.assign(settings, extra);
    settings.modelPicker = {
      ...picker,
      ...extra.modelPicker,
      options: [...picker.options, ...(extra.modelPicker?.options ?? [])],
    };
    args.splice(i, inline ? 1 : 2);
    i--;
  }
}

async function initialSelection(args: string[], settings: LaunchSettings, anthropic: boolean) {
  const savedModel = await savedSelection(args);
  const requested =
    explicitModel(args) ??
    process.env.ANTHROPIC_MODEL ??
    (typeof settings.model === 'string' ? settings.model : savedModel);
  // With no Claude login, start on an available external model instead of Sonnet.
  const options = settings.modelPicker.options;
  const initialModel = retagSelection(requested, options);
  const defaultModel =
    process.env.MULTI_MODELS === undefined
      ? options.find((option) => option.model === 'multi/openai/gpt-6-luna')
      : undefined;
  const fallback = anthropic ? undefined : (defaultModel ?? options[0])?.model;
  const selectedModel = initialModel ?? fallback;
  // Claude is told the model when it would otherwise choose one itself, and when retagging
  // changed the spelling: the selection Claude restores on its own carries no context tag.
  const retagged = initialModel !== requested;
  const passToClaude = selectedModel !== undefined && (initialModel === undefined || retagged);
  return { selectedModel, modelArgument: passToClaude ? selectedModel : undefined };
}

/** The last `--model` the caller spelled, in either form. */
function explicitModel(args: readonly string[]): string | undefined {
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') {
      model = args[i + 1];
    } else if (args[i].startsWith('--model=')) {
      model = args[i].slice(8);
    }
  }
  return model;
}

/** Move a selection onto whichever spelling the picker offers: tagged, or plain once the
 * context tag is switched off. A selection that survives the opt-out keeps its own row. */
function retagSelection(
  model: string | undefined,
  options: readonly ModelOption[],
): string | undefined {
  if (model === undefined || options.some((option) => option.model === model)) {
    return model;
  }
  const native = nativeSpelling(model) ?? model;
  const rows = new Set(options.map((option) => option.model));
  const tagged = `${native}[1m]`;
  if (rows.has(tagged)) {
    return tagged;
  }
  if (rows.has(native)) {
    return native;
  }
  // An advertised effort variant is collapsed into one synthesized picker row, so a model
  // selected by its own variant ID matches no row. It is still a real Antigravity model and
  // takes the same window, so decide from the provider rather than from the picker.
  const prefix = 'multi/antigravity/';
  return native.startsWith(prefix) ? oneMillionContext(native, native.slice(prefix.length)) : model;
}

/** Replace the caller's own `--model`, so a retagged selection cannot be passed twice.
 * This walks the arguments exactly as `explicitModel` does, so both agree on which
 * occurrence is authoritative; rewriting an earlier one would leave the child on the
 * spelling the retag was meant to replace. */
function applyModelArgument(args: string[], model: string) {
  let index = -1;
  let inline = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') {
      index = i;
      inline = false;
    } else if (args[i].startsWith('--model=')) {
      index = i;
      inline = true;
    }
  }
  if (index === -1) {
    args.push('--model', model);
  } else if (inline) {
    args[index] = `--model=${model}`;
  } else {
    args[index + 1] = model;
  }
}

function filterPicker(
  settings: LaunchSettings,
  selection: string | undefined,
  defaultModels: readonly string[] = [],
) {
  if (selection === undefined) {
    return;
  }
  if (selection === 'all') {
    return;
  }
  const additive = selection.startsWith('+');
  const models = [
    ...new Set(
      (additive ? `${defaultModels.join(',')},${selection.slice(1)}` : selection)
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
  const available = new Map(settings.modelPicker.options.map((option) => [option.model, option]));
  const chosen = new Set<ModelOption>();
  for (const model of models) {
    // A tagged row stays selectable by its plain provider ID and the reverse: a selection
    // saved while the tag was on must still resolve once MULTI_DISABLE_1M_CONTEXT turns it off.
    const native = nativeSpelling(model) ?? model;
    const option = available.get(model) ?? available.get(`${native}[1m]`) ?? available.get(native);
    if (!option) {
      throw new Error(
        `MULTI_MODELS: model is not available from a connected provider in this launcher's picker: ${model}. Check the full ID with --cursor-models or --zen-models, then add it with /multi-core:setup --models <id>.`,
      );
    }
    chosen.add(option);
  }
  settings.modelPicker.options = [...chosen];
}

function approvalProvider(model: string | undefined): 'openai' | 'cursor' | undefined {
  if (model?.startsWith('multi/openai/')) {
    return 'openai';
  }
  if (model?.startsWith('multi/cursor/')) {
    return 'cursor';
  }
  return undefined;
}

async function discoverApprovals(
  authFile: string,
  cursorAvailable: boolean,
  openaiReview: boolean,
) {
  const approvalProviders: ('openai' | 'cursor')[] = cursorAvailable ? ['cursor'] : [];
  if (openaiReview) {
    approvalProviders.push('openai');
  }
  return {
    approvalProviders,
    approvalBridge: openaiReview ? await createOpenAIApproval(authFile, process.cwd()) : undefined,
  };
}

function configureApproval(
  settings: LaunchSettings,
  providers: readonly ('openai' | 'cursor')[],
  selectedModel?: string,
  harnesses: Record<string, unknown> = {},
  anthropic = false,
) {
  const provider = approvalProvider(selectedModel);
  // Antigravity and Grok run their own loop and bring no reviewer of their own.
  const nativeHarness = Object.entries(harnesses).some(
    ([name, harness]) => harness && selectedModel?.startsWith(`multi/${name}/`),
  );
  // Auto mode is a Claude session capability. Keep it available when Claude is
  // authenticated, even if the initial model has no external reviewer; the
  // gateway still rejects unsupported external review requests, while a later
  // switch back to Claude can use its native reviewer.
  if (!anthropic && !nativeHarness && (!provider || !providers.includes(provider))) {
    settings.permissions = { ...settings.permissions, disableAutoMode: 'disable' };
  }
  // Observe tool workspace information for reviewer attribution. This hook never
  // vetoes execution; Claude's checks and the actual reviewer request decide.
  const command = hookCommand(new URL('./gateway/permission-hook.ts', import.meta.url));
  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  settings.hooks = {
    ...hooks,
    PreToolUse: [
      ...(hooks?.PreToolUse ?? []),
      { hooks: [{ type: 'command', command, timeout: 10 }] },
    ],
  };
}

async function handleCommand(command?: string) {
  if (command === '--antigravity-setup') {
    await installAntigravityHook();
    console.log('Antigravity native permission hook installed. Native login remains owned by agy.');
    process.exit(0);
  }
  if (command === '--antigravity-models') {
    console.log(JSON.stringify(await discoverAntigravityModels(), null, 2));
    process.exit(0);
  }
  if (command === '--grok-models') {
    console.log(JSON.stringify(await discoverGrokModels(), null, 2));
    process.exit(0);
  }
  if (command === '--zen-models') {
    console.log(JSON.stringify(ZEN_MODELS, null, 2));
    process.exit(0);
  }
  if (command === '--help') {
    console.log(
      'Usage: node plugins/multi-core/src/launcher.ts [--cursor-login | --cursor-models | --zen-models | --antigravity-models | --antigravity-setup] [-- <claude arguments>]\nLaunch Claude with external models and native coding workers.\n--cursor-login: official Cursor SDK browser sign-in\n--cursor-models: list account model choices\n--zen-models: list supported Zen models and capabilities\nMULTI_ANTIGRAVITY=1: enable native Antigravity models and workers\n--antigravity-setup: install the scoped native permission hook\n--antigravity-models: inspect the official Antigravity CLI catalog (native login required)\n--grok-models: list the Grok Build catalog (native login required)\nMULTI_GROK_MODELS: comma-separated Grok model IDs to show, leaving other providers unchanged\nOPENCODE_API_KEY: Zen key (or use OpenCode /connect)\nMULTI_ZEN_MODELS: comma-separated Zen model IDs to show, leaving other providers unchanged\nMULTI_MODELS: comma-separated full model IDs to show in /model (unset: defaults; empty: hide external rows)\nMULTI_CURSOR_EXTRA_MODELS: comma-separated Cursor model IDs to add to Auto, Grok 4.6, and Composer 2.5 in /model',
    );
    process.exit(0);
  }
  if (command === '--cursor-login') {
    const { Cursor } = await import('@cursor/sdk');
    await Cursor.auth.login({
      apiKeyName: 'cc-multi-cli',
      onLoginUrl: (url) => console.log(`Cursor login: ${url}`),
    });
    console.log('Cursor SDK login saved. Launch the gateway normally to use it.');
    process.exit(0);
  }
}

async function readSettings(value: string) {
  const extra = JSON.parse(
    value.trimStart().startsWith('{') ? value : await readFile(value, 'utf8'),
  );
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new Error('Invalid --settings object');
  }
  return extra;
}

async function savedSelection(args: string[]) {
  let savedModel: string | undefined;
  const sourcesIndex = args.lastIndexOf('--setting-sources');
  const sources = (
    args.findLast((arg) => arg.startsWith('--setting-sources='))?.slice(18) ??
    (sourcesIndex >= 0 ? args[sourcesIndex + 1] : 'user,project,local')
  ).split(',');
  for (const [source, filename] of [
    [
      'user',
      path.join(
        process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
        'settings.json',
      ),
    ],
    ['project', path.join(process.cwd(), '.claude', 'settings.json')],
    ['local', path.join(process.cwd(), '.claude', 'settings.local.json')],
  ] as const) {
    if (!sources.includes(source)) {
      continue;
    }
    try {
      const value = JSON.parse(await readFile(filename, 'utf8'));
      if (typeof value.model === 'string') {
        savedModel = value.model;
      }
    } catch {
      /* Claude handles missing or invalid native settings itself. */
    }
  }
  return savedModel;
}

function printCursorModels(cursorModels: CursorModelOption[], cursorSignedIn: boolean) {
  if (!cursorSignedIn) {
    throw new Error('Run with --cursor-login first.');
  }
  console.log(
    JSON.stringify(
      cursorModels.map(({ model, label, selection }) => ({ model, label, selection })),
      null,
      2,
    ),
  );
}

function selectedCursorOptions(cursorModels: CursorModelOption[], fullCatalog: boolean) {
  if (fullCatalog) {
    return cursorModels;
  }
  return cursorPickerOptions(
    cursorModels,
    cursorModels.length ? process.env.MULTI_CURSOR_EXTRA_MODELS : undefined,
  );
}

/** Client compatibility only, not provider equivalence. Both profiles default to 200K
 * in Claude 2.1.267; newer xhigh profiles imply native 1M and are deliberately not used.
 * Provider validation remains authoritative for every requested effort value. */
function pickerProfile(adjustableEffort: boolean): string {
  return adjustableEffort ? 'claude-sonnet-4-6' : 'claude-haiku-4-5';
}

/**
 * Antigravity families whose native input window is about a million tokens. Gemini 3.x
 * Flash and Pro take 1,048,576. Every other advertised model keeps the conservative
 * default, because its window is smaller or unestablished: GPT-OSS 120B takes 131,072,
 * and the Claude models served here carry no 1M entitlement. The native catalog reports
 * no capacity metadata, so this list is the only place that claim is made.
 */
const ANTIGRAVITY_1M_FAMILIES = /^gemini(?:-|$)/;

/**
 * Claude reads a row's context window from a `[1m]` tag on the model ID before it consults
 * the `behavesAs` profile, and it matches `behavesAs` on the untagged spelling. Tagging a
 * row therefore states the provider's real window without adopting a Claude profile that
 * also advertises effort levels the provider does not have. The harness strips the tag
 * before it resolves the native model. `MULTI_DISABLE_1M_CONTEXT` opts out.
 */
function oneMillionContext(model: string, id: string): string {
  const family = id.replace(/-(low|medium|high)$/, '');
  if (optedOut(process.env.MULTI_DISABLE_1M_CONTEXT) || !ANTIGRAVITY_1M_FAMILIES.test(family)) {
    return model;
  }
  return `${model}[1m]`;
}

/** An opt-out set to an explicit negative reads as off, not as "the variable is present". */
function optedOut(value: string | undefined): boolean {
  return value !== undefined && !['', '0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function pickerSettings(
  codexSignedIn: boolean,
  cursorPicker: CursorModelOption[],
  zen: boolean,
  antigravityModels: AntigravityModel[],
  grokModels: GrokModel[],
  fullCatalog = false,
) {
  let zenOptions = zenPickerOptions('');
  if (zen) {
    zenOptions = fullCatalog ? zenModelOptions() : zenPickerOptions(process.env.MULTI_ZEN_MODELS);
  }
  const settings: LaunchSettings = {
    modelPicker: {
      options: [
        ...Object.values(codexSignedIn ? MODELS : {}).map((model) => ({
          model: `multi/openai/${model}`,
          label: model,
          description: 'OpenAI subscription · native Claude Code harness',
          behavesAs: pickerProfile(true),
        })),
        ...cursorPicker.map(({ model, label, description, catalog }) => ({
          model,
          label,
          description,
          behavesAs: pickerProfile(
            catalog.parameters?.some(({ id }) => ['effort', 'reasoning_effort'].includes(id)) ??
              false,
          ),
        })),
        ...antigravityPickerOptions(antigravityModels).map(({ model, label, id }) => ({
          model: oneMillionContext(model, id),
          label,
          behavesAs: pickerProfile(true),
          description: 'Native Antigravity CLI',
        })),
        ...grokPickerOptions(grokModels, process.env.MULTI_GROK_MODELS).map(({ model, label }) => ({
          model,
          label: `Grok - ${label}`,
          behavesAs: pickerProfile(true),
          description: 'Grok subscription; native Grok Build CLI',
        })),
        ...zenOptions.map(({ model, label, efforts }) => ({
          model,
          label: `Zen · ${label}`,
          behavesAs: pickerProfile(Boolean(efforts?.length)),
          description: `Zen API billing · Claude tools${efforts ? '' : ' · native reasoning; /effort not applicable'}`,
        })),
      ],
    },
  };
  return settings;
}

/**
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also blocks the plugin worker's
 * loopback call to this gateway, which the Mods control plane requires. Keep
 * the user's intent (no updater, telemetry or error reports) with the narrower
 * flags instead of silently running without the mod.
 */
function translateTrafficPolicy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === undefined) {
    return env;
  }
  const { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: _flag, ...rest } = env;
  process.stderr.write(
    'Multi: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC would block the local gateway; using DISABLE_AUTOUPDATER, DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING and DISABLE_BUG_COMMAND instead.\n',
  );
  return {
    ...rest,
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    DISABLE_BUG_COMMAND: '1',
  };
}

function gatewayEnvironment(port: number, token: string, anthropic: boolean, cursor: boolean) {
  const env = translateTrafficPolicy({ ...process.env });
  delete env.OPENCODE_API_KEY;
  return {
    ...env,
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    // Native runs and extended OpenAI reasoning can outlive Claude's default
    // API timer; preserve explicit user limits.
    API_TIMEOUT_MS: process.env.API_TIMEOUT_MS ?? '2147483647',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    // A custom base URL disables Claude's on-demand tool loading unless opted in.
    // We forward Claude tool references; preserve an explicit user preference.
    ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH ?? 'auto',
    MULTI_GATEWAY_TOKEN: token,
    MULTI_CURSOR_DISPLAY_TOOLS: cursor ? '1' : '0',
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    MULTI_MOD_GATEWAY_URL: `http://127.0.0.1:${port}`,
    ...(!anthropic ? { ANTHROPIC_AUTH_TOKEN: token } : {}),
    ANTHROPIC_CUSTOM_HEADERS: [
      process.env.ANTHROPIC_CUSTOM_HEADERS,
      `x-multi-gateway-token: ${token}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

function traceEvent(event: GatewayEvent) {
  if (process.env.MULTI_NATIVE_TRACE === '1') {
    process.stderr.write(`[native] ${JSON.stringify(event)}\n`);
  }
}

async function discoverAntigravity() {
  let antigravityModels: AntigravityModel[] = [];
  if (providerEnabled('antigravity') && process.env.MULTI_ANTIGRAVITY === '1') {
    try {
      resolveExecutable('agy');
      antigravityModels = await discoverAntigravityModels();
    } catch (error) {
      if (!isMissingExecutable(error)) {
        throw error;
      }
      console.error(
        `Antigravity choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (enabledProviders?.includes('antigravity') && antigravityModels.length) {
    await installAntigravityHook();
  }
  return antigravityModels;
}

async function discoverGrok(): Promise<GrokModel[]> {
  if (!providerEnabled('grok')) {
    return [];
  }
  try {
    resolveExecutable('grok');
    return await discoverGrokModels();
  } catch (error) {
    if (!isMissingExecutable(error)) {
      throw error;
    }
    // Silent when the plugin is merely present: only an enabled provider reports.
    if (enabledProviders?.includes('grok')) {
      console.error(
        `Grok choices unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return [];
  }
}

function isMissingExecutable(error: unknown): boolean {
  return recordValue(error)?.code === 'ENOENT';
}

async function findPluginRoot(file: string): Promise<string> {
  for (let directory = path.dirname(path.resolve(file)); ; directory = path.dirname(directory)) {
    try {
      await stat(path.join(directory, '.claude-plugin', 'plugin.json'));
      return directory;
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new Error(`Could not find the Multi plugin root above ${file}`);
      }
    }
  }
}

function hasPluginDirectory(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--plugin-dir' || arg.startsWith('--plugin-dir='));
}

function launcherArguments(
  args: readonly string[],
  settingsFile: string,
  definitions: string,
  inventory: PluginPermissionInventory,
  pluginRoot: string,
): string[] {
  const pluginDirectory =
    !hasPluginDirectory(args) && (!inventory.multiCoreEnabled || hasEmptySettingSources(args))
      ? ['--plugin-dir', pluginRoot]
      : [];
  return ['--settings', settingsFile, '--agents', definitions, ...args, ...pluginDirectory];
}

function hasEmptySettingSources(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--setting-sources' && args[index + 1] === '') {
      return true;
    }
    if (arg === '--setting-sources=') {
      return true;
    }
  }
  return false;
}
