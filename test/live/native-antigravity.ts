// Opt-in live contract for the official Antigravity CLI. The default run uses
// two paid turns: one native write and one native read, with a cached replay
// between them proving that a saved response does not repeat the write.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type AntigravityRunOptions,
  type AntigravityStreamEvent,
  runAntigravity,
} from '../../plugins/multi-antigravity/src/cli.ts';
import { AntigravityHarness } from '../../plugins/multi-antigravity/src/harness.ts';
import { ensureAntigravityHooks } from '../../plugins/multi-antigravity/src/hooks.ts';
import {
  type AntigravityModel,
  discoverAntigravityModels,
} from '../../plugins/multi-antigravity/src/models.ts';
import { antigravityPermissionPolicy } from '../../plugins/multi-antigravity/src/permissions.ts';
import type {
  MessagesRequest,
  MessagesResponse,
} from '../../plugins/multi-core/src/gateway/messages.ts';
import type { PermissionContext } from '../../plugins/multi-core/src/gateway/mode-hook.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node test/live/native-antigravity.ts [--model MODEL] [--switch MODEL] [--mode auto|acceptEdits|plan|bypassPermissions] [--compact] [--children]\nDefault: two bounded Gemini turns plus a saved-response replay. Requires agy native login, --antigravity-setup, and an advertised Gemini model. Optional checks add one turn each.',
  );
  process.exit(0);
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const requestedModel = option('--model') ?? 'gemini-3.8-flash-low';
const requestedSwitch = option('--switch');
const requestedMode = option('--mode') ?? 'auto';
const compact = args.includes('--compact') || args.includes('--compaction');
const children = args.includes('--children');
const modes = ['auto', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
assert(
  modes.includes(requestedMode as (typeof modes)[number]),
  `Unsupported mode: ${requestedMode}`,
);

function fullModel(value: string): string {
  return value.startsWith('multi/antigravity/') ? value : `multi/antigravity/${value}`;
}

function text(response: MessagesResponse): string {
  return response.content
    .flatMap((block) =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('');
}

const models = await discoverAntigravityModels();
const model = models.find((candidate) => candidate.model === fullModel(requestedModel));
assert(model, `Model is not advertised by agy: ${requestedModel}`);
const switchedModel = requestedSwitch
  ? models.find((candidate) => candidate.model === fullModel(requestedSwitch))
  : undefined;
assert(!requestedSwitch || switchedModel, `Model is not advertised by agy: ${requestedSwitch}`);
assert(
  !switchedModel || switchedModel.model !== model.model,
  '--switch must select a different model',
);

const root = await mkdtemp(path.join(os.tmpdir(), 'native-antigravity-'));
const cwd = path.join(root, 'workspace');
const stateDirectory = path.join(root, 'state');
await mkdir(cwd);
const target = 'native-edit-once.txt';
const nonce = randomBytes(8).toString('hex');
const scope = `live/${randomUUID()}`;
const toolNames: string[] = [];
const runModels: string[] = [];
const eventRecords: Record<string, unknown>[] = [];
const turnRecords: Record<string, unknown>[] = [];
let harness: AntigravityHarness | undefined;

const context: PermissionContext = {
  permissionMode: requestedMode as PermissionContext['permissionMode'],
  cwd,
  tools: ['Read', 'Write'],
};
const checkPermissions = async (runCwd: string, runContext: PermissionContext) => {
  await ensureAntigravityHooks();
  return antigravityPermissionPolicy({ ...runContext, cwd: runCwd });
};
const run = async (options: AntigravityRunOptions) => {
  runModels.push(options.model ?? '');
  const onEvent = options.onEvent;
  const wrapped = (event: AntigravityStreamEvent) => {
    if (event.event === 'init') {
      eventRecords.push({
        event: 'init',
        conversation_id: event.conversation_id,
        model: event.init.model,
      });
    } else if (event.event === 'result') {
      eventRecords.push({
        event: 'result',
        conversation_id: event.result.conversation_id,
        status: event.result.status,
        usage: event.result.usage,
      });
    } else if (
      event.step_update.tool_name &&
      ['DONE', 'ERROR'].includes(event.step_update.state ?? '')
    ) {
      toolNames.push(event.step_update.tool_name);
    }
    onEvent?.(event);
  };
  return runAntigravity({ ...options, onEvent: wrapped });
};

function createHarness() {
  return new AntigravityHarness(models, {
    cwd,
    stateDirectory,
    run,
    checkPermissions,
  });
}

async function turn(
  activeHarness: AntigravityHarness,
  modelOption: AntigravityModel,
  messages: NonNullable<MessagesRequest['messages']>,
  activeContext = context,
): Promise<MessagesResponse> {
  const response = await activeHarness.handle(
    { model: modelOption.model, messages },
    scope,
    AbortSignal.timeout(120000),
    undefined,
    activeContext,
  );
  const responseText = text(response);
  turnRecords.push({ model: modelOption.id, text: responseText });
  console.log(JSON.stringify({ model: modelOption.model, response: responseText }));
  return response;
}

try {
  harness = createHarness();
  const firstPrompt =
    requestedMode === 'plan'
      ? `Use only native read tools to inspect the workspace and report whether ${target} exists. Do not use shell, edits, MCP, or subagents.`
      : `Use the native write_to_file tool exactly once for the normal workspace file ${target}, relative to the current workspace. Use these exact arguments: TargetFile: ${target}; IsArtifact: false; CodeContent: ${nonce}; EmptyFile: false; Overwrite: false. Do not use shell, MCP, or subagents. If it already exists, do not retry.`;
  const firstMessages = [{ role: 'user', content: firstPrompt }];
  const first = await turn(harness, model, firstMessages);
  const firstText = text(first);
  assert(firstText.length > 0, 'First Antigravity turn returned no text');
  if (requestedMode !== 'plan') {
    assert.equal((await readFile(path.join(cwd, target), 'utf8')).trimEnd(), nonce);
  }

  await harness.close();
  harness = createHarness();
  const replay = await turn(harness, model, firstMessages);
  assert.equal(text(replay), firstText);
  assert.equal(runModels.length, 1, 'Saved response replay must not invoke agy again');

  const nextModel = switchedModel ?? model;
  const secondPrompt =
    requestedMode === 'plan'
      ? `Use only native read tools to inspect the workspace once more and report the result. Do not use shell, edits, MCP, or subagents.`
      : `Use a native read tool to read ${target} and report its exact contents. Do not edit it or use shell, MCP, or subagents.`;
  const secondMessages = [
    ...firstMessages,
    { role: 'assistant', content: first.content },
    { role: 'user', content: secondPrompt },
  ];
  const second = await turn(harness, nextModel, secondMessages);
  assert(text(second).length > 0, 'Second Antigravity turn returned no text');
  if (switchedModel) {
    assert(runModels.includes(switchedModel.id), 'Model switch did not reach agy');
  }

  let latestMessages = [...secondMessages, { role: 'assistant', content: second.content }];
  let latestResponse = second;
  if (compact) {
    const compactPrompt =
      requestedMode === 'plan'
        ? 'After outer history compaction, continue with a native read-only status check.'
        : `After outer history compaction, use no tools and recall the exact nonce written to ${target}. Report the nonce from our conversation.`;
    const compactMessages = [{ role: 'user', content: compactPrompt }];
    latestResponse = await turn(harness, nextModel, compactMessages);
    latestMessages = [...compactMessages, { role: 'assistant', content: latestResponse.content }];
    assert(text(latestResponse).length > 0, 'Compaction continuation returned no text');
    if (requestedMode !== 'plan') {
      assert(text(latestResponse).includes(nonce), 'Compaction continuation forgot the nonce');
    }
  }

  if (children) {
    const childPrompt =
      'Attempt exactly one invoke_subagent call for the built-in research agent. Do not use any other tool; report the native denial.';
    const childMessages = [...latestMessages, { role: 'user', content: childPrompt }];
    const child = await turn(harness, nextModel, childMessages);
    assert(toolNames.includes('invoke_subagent'), 'Antigravity did not attempt invoke_subagent');
    assert.match(text(child), /denied|blocked|permission/i);
  }

  if (requestedMode !== 'plan') {
    assert.equal((await readFile(path.join(cwd, target), 'utf8')).trimEnd(), nonce);
    assert.equal(toolNames.filter((name) => name === 'write_to_file').length, 1);
  }
  console.log(
    `PASS: Antigravity native harness completed (${runModels.length} agy turns, ${toolNames.length} terminal tool events).`,
  );
} finally {
  await harness?.close();
  await writeFile(
    path.join(root, 'report.json'),
    JSON.stringify({ models: runModels, events: eventRecords, turns: turnRecords }, null, 2),
    { mode: 0o600 },
  );
  console.log(`Evidence: ${path.join(root, 'report.json')}`);
}
