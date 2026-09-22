// Opt-in, Linux/macOS: real OpenAI review + Claude TUI, isolated Anthropic config.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { NativeApprovalBridge } from '../../plugins/multi-core/src/gateway/approval.ts';
import { hookCommand } from '../../plugins/multi-core/src/gateway/permission-hook.ts';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import type { GatewayEvent } from '../../plugins/multi-core/src/gateway/server.ts';
import { createNativeGateway } from '../../plugins/multi-core/src/gateway/server.ts';
import { readCodexAuth } from '../../plugins/multi-openai/src/auth.ts';
import { readSse } from '../../plugins/multi-openai/src/responses.ts';
import { isolatedEnvironment } from './environment.ts';
import type { HookInput } from './native-events.ts';
import { pty } from './native-pty.ts';

if (process.argv.includes('--help')) {
  console.log(
    'Usage: node test/live/native-provider-approval.ts [--native-escalation | --launcher [--claude-auth-fixture]]\nReal provider review and Claude terminal auto/manual approval. Requires Python 3 (stdlib PTY), Claude, and Node 24. Temporary canaries only.\n--claude-auth-fixture exercises the authenticated launcher branch with an unusable token; no real Claude credentials are copied or used.',
  );
  process.exit(0);
}
const initialModel = 'multi/openai/gpt-6-luna';
const launcher = process.argv.includes('--launcher');
const nativeEscalation = launcher || process.argv.includes('--native-escalation');
const claudeAuthFixture = process.argv.includes('--claude-auth-fixture');
assert(!claudeAuthFixture || launcher, '--claude-auth-fixture requires --launcher');
assert(
  process.argv
    .slice(2)
    .every((arg) => ['--native-escalation', '--launcher', '--claude-auth-fixture'].includes(arg)),
  'Unsupported option; native Cursor has no separate reviewer.',
);
if (process.platform !== 'win32') {
  assert.equal(spawnSync('python3', ['--version']).status, 0, 'Python 3 required');
} else {
  console.warn('SKIP: ConPTY terminal proof is not implemented; running direct non-PTY checks.');
}
const artifacts = await mkdtemp(path.join(os.tmpdir(), 'native-provider-approval-'));
console.log(`Artifacts: ${artifacts}`);
const config = path.join(artifacts, 'claude-config');
await mkdir(config);
// Fresh config has no login, credentials, feature cache, or inherited hooks.
await writeFile(
  path.join(config, '.claude.json'),
  JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }),
  { mode: 0o600 },
);
const authFile = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  'auth.json',
);
const token = randomBytes(32).toString('hex');
const kinds = nativeEscalation
  ? [
      'RULE_ALLOW',
      'RULE_DENY',
      'AUTO',
      ...(launcher ? [] : ['REVIEW_DENY']),
      'MANUAL_ACCEPT',
      'MANUAL_DENY',
    ]
  : ['AUTO', 'MANUAL_ACCEPT', 'MANUAL_DENY'];
const command = (kind: string) =>
  `node -e 'require("node:fs").appendFileSync("${kind}.txt", "${kind}\\n")'`;
const seed = path.join(artifacts, 'CONTROL.txt');
await writeFile(seed, 'BEFORE\n');
const controlPrompt = nativeEscalation
  ? `First use Read on ${seed}, then Edit it from BEFORE to AFTER, then Bash with the exact command pwd. These should need no model review. `
  : '';
const prompt =
  controlPrompt +
  `This is a harmless permission integration test. Submit these exact Bash calls once each, separately, in order:\n${kinds.map(command).join('\n')}\nKeep them in the foreground. Let the harness decide permissions. Continue to the next listed command after a permission denial; never retry or change a denied command. Do not use other tools. End with PROBE_COMPLETE.`;
const policyDir = new URL('../../plugins/multi-openai/src/guardian/', import.meta.url);
const [basePolicy, template] = await Promise.all([
  readFile(new URL('policy.md', policyDir), 'utf8'),
  readFile(new URL('policy-template.md', policyDir), 'utf8'),
]);
const testPolicy =
  '\n## Test auto-review policy\nDeny automatic approval of Bash commands containing MANUAL_ACCEPT, MANUAL_DENY, or REVIEW_DENY: these exact canaries require explicit manual approval in the harness. Allow the AUTO.txt canary. This policy governs automatic approval, not whether the human may subsequently approve the pending call.';
const instructions =
  template
    .replace('{{ tenant_policy_config }}', basePolicy + testPolicy)
    .replace(
      /# Execution Environment[\s\S]*?(?=# Outcome Policy)/,
      '# Execution Environment\nThe calling Claude harness executes tools locally, with its sandbox disabled for this test. You have no execution tools. These exact inline canaries are self-contained. If missing local evidence prevents a decision, deny automatic approval and explain why.\n\n',
    ) +
  '\nYour final message must be strict JSON. For low-risk actions: {"outcome":"allow"}. Otherwise include risk_level (low/medium/high/critical), user_authorization (unknown/low/medium/high), outcome (allow/deny), and a concise rationale.\n';
// ponytail: self-contained canaries only; general actions need Codex's read-only investigation loop and context builder.
const reviews: Record<string, unknown>[] = [];
const routes: GatewayEvent[] = [];
const blocked: string[] = [];
const hookInputs: HookInput[] = [];
const permissionInputs: HookInput[] = [];

async function evaluate(
  input: HookInput,
  transcript: unknown = [{ role: 'user', content: prompt }],
  signal = AbortSignal.timeout(45000),
) {
  const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    headers: {
      ...(await readCodexAuth(authFile)),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      originator: 'cc_multi_native',
      session_id: input.session_id,
    },
    body: JSON.stringify({
      model: 'codex-auto-review',
      instructions,
      input: [
        {
          role: 'user',
          content: JSON.stringify({
            transcript,
            planned_action: { tool: input.tool_name, arguments: input.tool_input },
            cwd: artifacts,
          }),
        },
      ],
      tools: [],
      tool_choice: 'none',
      parallel_tool_calls: false,
      reasoning: { effort: 'low' },
      store: false,
      stream: true,
    }),
  });
  assert(response.ok, `OpenAI reviewer HTTP ${response.status}`);
  assert(response.body);
  let text = '';
  let completed = false;
  for await (const value of readSse(response.body)) {
    assert(value && typeof value === 'object');
    const event = value as { type?: string; delta?: string };
    if (event.type === 'response.output_text.delta') {
      text += event.delta ?? '';
      assert(text.length < 8192);
    }
    if (event.type === 'response.completed') {
      completed = true;
    }
    assert(
      !['response.failed', 'response.incomplete', 'response.refusal.delta', 'error'].includes(
        event.type ?? '',
      ),
      'Reviewer failed/refused',
    );
  }
  assert(completed, 'Reviewer response was incomplete');
  const verdict = JSON.parse(text);
  assert(verdict && ['allow', 'deny'].includes(verdict.outcome), 'Invalid review verdict');
  assert(
    Object.keys(verdict).every((key) =>
      ['outcome', 'risk_level', 'user_authorization', 'rationale'].includes(key),
    ),
  );
  assert(
    verdict.risk_level === undefined ||
      ['low', 'medium', 'high', 'critical'].includes(verdict.risk_level),
  );
  assert(
    verdict.user_authorization === undefined ||
      ['unknown', 'low', 'medium', 'high'].includes(verdict.user_authorization),
  );
  assert(verdict.rationale === undefined || typeof verdict.rationale === 'string');
  const permissionDecision = verdict.outcome === 'allow' ? 'allow' : 'ask';
  reviews.push({
    toolUseId: input.tool_use_id,
    command: input.tool_input.command,
    model: 'codex-auto-review',
    verdict,
    permissionDecision,
  });
  return verdict;
}
const approvalBridge = nativeEscalation
  ? new NativeApprovalBridge(async ({ action, transcript }, signal) => {
      const input = hookInputs.findLast(
        (i) => i.tool_name === 'Bash' && i.tool_input.command === action.Bash,
      );
      assert(input, 'Classifier action has no pending tool');
      const verdict = await evaluate(input, transcript, signal);
      return { model: 'codex-auto-review', outcome: verdict.outcome };
    })
  : undefined;
const gateway = createNativeGateway({
  token,
  authFile,
  approvalBridge,
  onEvent: (e) => routes.push(e),
  fetchImpl: async (url, init) => {
    if (new URL(url).origin !== 'https://chatgpt.com') {
      blocked.push(url);
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'Anthropic forwarding is disabled in this credential-isolated proof.',
          },
        },
        { status: 401 },
      );
    }
    return fetch(url, init);
  },
});
// All review and model traffic enters the same authenticated local gateway.
const server = http.createServer(async (req, res) => {
  if (req.url !== '/approval' && req.url !== '/record' && req.url !== '/permission') {
    gateway.emit('request', req, res);
    return;
  }
  try {
    assert.equal(req.headers['x-multi-gateway-token'], token);
    assert.equal(req.method, 'POST');
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      assert(raw.length < 64000);
    }
    const input = JSON.parse(raw);
    if (req.url === '/permission') {
      permissionInputs.push(input);
      res.setHeader('content-type', 'application/json');
      res.end('{}');
      return;
    }
    hookInputs.push(input);
    if (req.url === '/record') {
      res.setHeader('content-type', 'application/json');
      res.end('{}');
      return;
    }
    assert.equal(input.permission_mode, 'auto');
    assert.equal(input.tool_name, 'Bash');
    assert.equal(input.cwd, artifacts);
    assert.equal(typeof input.tool_use_id, 'string');
    assert(
      kinds.some((kind) => command(kind) === input.tool_input?.command),
      'Unexpected action; never approve it',
    );
    const verdict = await evaluate(input);
    const permissionDecision = verdict.outcome === 'allow' ? 'allow' : 'ask';
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision,
          permissionDecisionReason: `OpenAI automatic review: ${verdict.rationale || verdict.outcome}`,
        },
      }),
    );
  } catch (error) {
    reviews.push({ error: error instanceof Error ? error.message : String(error) });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Provider approval proof failed; action blocked.',
        },
      }),
    );
  }
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const hookFile = path.join(artifacts, 'hook.mjs');
await writeFile(
  hookFile,
  `import {readFileSync} from 'node:fs';
try {
 const input=readFileSync(0,'utf8');
 const event=JSON.parse(input).hook_event_name;
 const endpoint=${nativeEscalation} ? (event==='PermissionRequest'?'/permission':'/record') : '/approval';
 const response=await fetch(${JSON.stringify(base)}+endpoint,{method:'POST',headers:{'x-multi-gateway-token':${JSON.stringify(token)}},body:input,signal:AbortSignal.timeout(50000)});
 if(!response.ok) throw Error('Approval endpoint failed');
 const result=await response.json();
 if(!${nativeEscalation} && !['allow','ask','deny'].includes(result.hookSpecificOutput?.permissionDecision)) throw Error('Invalid decision');
 console.log(JSON.stringify(result));
} catch {console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Approval bridge failed'}}));}
`,
  { mode: 0o600 },
);
const settings = path.join(artifacts, 'settings.json');
const hook = { type: 'command', command: hookCommand(pathToFileURL(hookFile)), timeout: 60 };
await writeFile(
  settings,
  JSON.stringify({
    sandbox: { enabled: false },
    ...(nativeEscalation
      ? {
          permissions: {
            allow: [`Bash(${command('RULE_ALLOW')})`],
            deny: [`Bash(${command('RULE_DENY')})`],
            ask: [`Bash(${command('MANUAL_ACCEPT')})`, `Bash(${command('MANUAL_DENY')})`],
          },
        }
      : {}),
    hooks: {
      PreToolUse: [{ matcher: nativeEscalation ? '' : 'Bash', hooks: [hook] }],
      ...(nativeEscalation ? { PermissionRequest: [{ matcher: 'Bash', hooks: [hook] }] } : {}),
    },
  }),
  { mode: 0o600 },
);
// Python stdlib supplies a real terminal; stdin carries only the test's UI answers.

const debugFile = path.join(artifacts, 'debug.log');
let terminalCommand = 'python3';
if (process.platform === 'win32') {
  terminalCommand = launcher ? process.execPath : 'claude';
}
const terminalArgs = process.platform === 'win32' ? [] : ['-c', pty];
let invocationArgs: string[];
if (launcher) {
  invocationArgs = [
    ...(process.platform === 'win32' ? [] : [process.execPath]),
    fileURLToPath(new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url)),
    '--',
  ];
} else if (process.platform === 'win32') {
  invocationArgs = [];
} else {
  invocationArgs = ['claude'];
}
const child = spawn(
  terminalCommand,
  [
    ...terminalArgs,
    ...invocationArgs,
    prompt,
    '--model',
    initialModel,
    '--effort',
    'high',
    '--permission-mode',
    'auto',
    '--tools',
    nativeEscalation ? 'Read,Edit,Bash' : 'Bash',
    '--settings',
    settings,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--debug-file',
    debugFile,
  ],
  {
    cwd: artifacts,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: isolatedEnvironment({
      TMPDIR: process.env.TMPDIR,
      HOME: os.homedir(),
      TERM: 'xterm-256color',
      CLAUDE_CONFIG_DIR: config,
      // This random token authenticates ONLY our localhost gateway, not Anthropic.
      ...(launcher
        ? {
            MULTI_NATIVE_TRACE: '1',
            MULTI_ENABLED_PROVIDERS: 'openai',
            CODEX_HOME: process.env.CODEX_HOME,
            // Exercise the authenticated branch without copying a real Claude login.
            // This token cannot authenticate upstream; any Anthropic route fails the proof.
            ...(claudeAuthFixture
              ? { ANTHROPIC_AUTH_TOKEN: 'unusable-anthropic-auth-fixture' }
              : {}),
          }
        : {
            ANTHROPIC_AUTH_TOKEN: token,
            ANTHROPIC_BASE_URL: base,
            ANTHROPIC_CUSTOM_HEADERS: `x-multi-gateway-token: ${token}`,
          }),
      CLAUDE_CODE_MAX_RETRIES: '0',
    }),
  },
);
let output = '';
let stderr = '';
let clean = '';
let trustAnswered = false;
let promptCount = 0;
let finishing = false;
let failure: Error | undefined;
const answers: string[] = [];
const timer = setTimeout(() => {
  failure = new Error('Terminal proof timed out');
  if (child.pid) {
    terminateProcessTree(child.pid, { platform: process.platform });
  }
}, 180000);
child.stderr.on('data', (data) => {
  stderr += data;
});
child.stdout.on('data', (data) => {
  output += data;
  appendFileSync(path.join(artifacts, 'terminal.log'), data, { mode: 0o600 });
  clean += stripVTControlCharacters(String(data));
  if (!trustAnswered && clean.replace(/\s/g, '').includes('Yes,Itrustthisfolder')) {
    trustAnswered = true;
    clean = '';
    setTimeout(() => {
      child.stdin.write('\x1b[B');
      setTimeout(() => child.stdin.write('\r'), 200);
    }, 500);
  }
  if (
    clean.replace(/\s/g, '').includes('Esctocancel') &&
    clean.replace(/\s/g, '').includes('Tabtoamend')
  ) {
    clean = '';
    const review = nativeEscalation
      ? { command: hookInputs.at(-1)?.tool_input?.command, permissionDecision: 'ask' }
      : reviews.at(-1);
    const expectedKind = promptCount === 0 ? 'MANUAL_ACCEPT' : 'MANUAL_DENY';
    if (
      promptCount >= 2 ||
      review?.command !== command(expectedKind) ||
      review.permissionDecision !== 'ask'
    ) {
      failure = new Error('Unexpected permission prompt');
      if (child.pid) {
        terminateProcessTree(child.pid, { platform: process.platform });
      }
      return;
    }
    // The exact test actions are already authorized; exercise both native choices.
    answers.push(expectedKind);
    promptCount++;
    setTimeout(() => {
      if (expectedKind === 'MANUAL_ACCEPT') {
        child.stdin.write('\r');
      } else {
        child.stdin.write('\x1b[B');
        setTimeout(() => child.stdin.write('\r'), 200);
      }
    }, 300);
  }
});
const transcript = async () => {
  const filename = hookInputs.at(-1)?.transcript_path;
  assert.equal(typeof filename, 'string');
  assert((filename as string).startsWith(config + path.sep));
  return (await readFile(filename as string, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
const manualDenial = (entries: Awaited<ReturnType<typeof transcript>>, kind = 'MANUAL_DENY') =>
  entries
    .filter((entry) => entry.type === 'user')
    .flatMap((entry) => (Array.isArray(entry.message?.content) ? entry.message.content : []))
    .some(
      (result) =>
        result.type === 'tool_result' &&
        result.tool_use_id ===
          hookInputs.findLast((i) => i.tool_input?.command === command(kind))?.tool_use_id &&
        result.is_error === true &&
        /The user doesn't want to proceed/.test(String(result.content)),
    );
// Wait for the native No decision to be persisted before exiting the terminal.
const completionPoll = setInterval(async () => {
  if (finishing || promptCount < 2) {
    return;
  }
  try {
    const history = await transcript();
    if (manualDenial(history)) {
      finishing = true;
      child.stdin.write('\x03');
      // A running turn consumes the first interrupt; idle Claude needs two to exit.
      setTimeout(() => child.stdin.write('\x03'), 300);
      setTimeout(() => child.stdin.write('\x03'), 600);
    }
  } catch {
    /* Transcript may be between writes; the overall timeout bounds this. */
  }
}, 200);
let code: number | null = null;
try {
  code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (failure) {
    throw failure;
  }
  assert.equal(code, 0, stderr);
  if (process.platform === 'win32') {
    console.log(
      'SKIP: Native accept and deny dialog proof requires ConPTY; direct non-PTY checks passed.',
    );
  } else {
    assert.equal(promptCount, 2, 'Expected native accept and deny dialogs');
  }
  if (launcher) {
    for (const match of output.matchAll(/\[native\] (\{[^\r\n]+\})/g)) {
      routes.push(JSON.parse(match[1]));
    }
  }
  const expectedReviews = nativeEscalation ? 2 : 3;
  assert.equal(reviews.length, launcher ? 0 : expectedReviews);
  const history = await transcript();
  if (process.platform !== 'win32') {
    assert(manualDenial(history), 'Missing actual native user rejection for denied tool');
  }
  const calls = history
    .filter((entry) => entry.type === 'assistant')
    .flatMap((entry) =>
      (entry.message?.content ?? [])
        .filter((block: { type: string }) => block.type === 'tool_use')
        .map((block: { id: string }) => ({ id: block.id, model: entry.message.model })),
    );
  assert.deepEqual(
    calls.map((call) => call.id),
    hookInputs.map((input) => input.tool_use_id),
  );
  assert(calls.every((call) => call.model === initialModel));
  assert.equal(
    await readFile(path.join(config, '.credentials.json'), 'utf8').catch(() => null),
    null,
  );
  if (!launcher) {
    assert.deepEqual(
      reviews.map((r) => r.permissionDecision),
      nativeEscalation ? ['allow', 'ask'] : ['allow', 'ask', 'ask'],
    );
  }
  assert(hookInputs.every((i) => i.permission_mode === 'auto'));
  let expectedCalls = 3;
  if (nativeEscalation) {
    expectedCalls = 9;
  }
  if (launcher) {
    expectedCalls = 8;
  }
  assert.equal(new Set(hookInputs.map((i) => i.tool_use_id)).size, expectedCalls);
  for (const kind of kinds) {
    // Without a PTY there is no dialog, so on Windows only the kinds that
    // need a manual answer produce nothing; rule and auto outcomes still run.
    const needsDialog = process.platform === 'win32' && kind.startsWith('MANUAL_');
    const expectedOutput =
      needsDialog || ['MANUAL_DENY', 'RULE_DENY', 'REVIEW_DENY'].includes(kind)
        ? null
        : `${kind}\n`;
    assert.equal(
      await readFile(path.join(artifacts, `${kind}.txt`), 'utf8').catch(() => null),
      expectedOutput,
    );
  }
  assert.equal(blocked.length, 0, 'Claude attempted Anthropic forwarding');
  assert(!routes.some((r) => r.route === 'anthropic'), 'Anthropic route attempted');
  const debug = await readFile(debugFile, 'utf8');
  if (nativeEscalation) {
    if (!launcher) {
      assert.deepEqual(
        reviews.map((r) => r.command),
        ['AUTO', 'REVIEW_DENY'].map(command),
      );
    }
    const classifications = routes.filter((r) => r.route === 'approval');
    let outcomes = ['allow', 'deny', 'deny'];
    let cached = [false, false, true];
    let classifierRequests = 3;
    if (launcher) {
      outcomes = ['allow'];
      cached = [false];
      classifierRequests = 1;
    }
    assert.deepEqual(
      classifications.map((c) => c.outcome),
      outcomes,
    );
    assert.deepEqual(
      classifications.map((c) => c.cached),
      cached,
    );
    assert.deepEqual(
      permissionInputs.map((i) => i.tool_input.command),
      ['MANUAL_ACCEPT', 'MANUAL_DENY'].map(command),
    );
    assert.equal(await readFile(seed, 'utf8'), 'AFTER\n');
    const results = history
      .filter((e) => e.type === 'user')
      .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []));
    for (const kind of launcher ? ['RULE_DENY'] : ['RULE_DENY', 'REVIEW_DENY']) {
      const id = hookInputs.find((i) => i.tool_input?.command === command(kind))?.tool_use_id;
      assert(
        results.some((r) => r.type === 'tool_result' && r.tool_use_id === id && r.is_error),
        `Missing ${kind} denial`,
      );
    }
    assert.equal([...debug.matchAll(/classifier_request_started /g)].length, classifierRequests);
  } else {
    assert(!debug.includes('classifier_request_started'), 'Native classifier attempted');
  }
  assert(!debug.includes('kickOutOfAutoIfNeeded applying:'), 'Auto mode fell back');
  assert(!/DEP0190/.test(debug + stderr), 'Deprecated shell spawning');
  let message =
    'OpenAI reviewer → native auto / manual accept / manual deny; no Anthropic classifier requests.';
  if (nativeEscalation) {
    message =
      'Native filtering; two OpenAI reviews, zero for native rules/read/edit/pwd; native Yes/No preserved.';
  }
  if (launcher) {
    message = 'Ordinary launcher, runtime OpenAI review, native filtering and manual rules.';
  }
  console.log(`PASS: ${message}`);
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
  process.exitCode = 1;
  console.error(failure.message);
} finally {
  clearTimeout(timer);
  clearInterval(completionPoll);
  if (child.pid) {
    terminateProcessTree(child.pid, { platform: process.platform });
  }
  server.closeAllConnections();
  server.close();
  gateway.closeAllConnections();
  gateway.close();
  await Promise.all([
    writeFile(path.join(artifacts, 'terminal.log'), output, { mode: 0o600 }),
    writeFile(path.join(artifacts, 'stderr.log'), stderr, { mode: 0o600 }),
    writeFile(
      path.join(artifacts, 'report.json'),
      JSON.stringify(
        {
          passed: !failure,
          launcher,
          claudeAuthFixture,
          nativeEscalation,
          permissionInputs,
          code,
          error: failure?.message,
          claude: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(),
          node: process.version,
          reviews,
          routes,
          blocked,
          answers,
          hookInputs,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    ),
  ]);
}
