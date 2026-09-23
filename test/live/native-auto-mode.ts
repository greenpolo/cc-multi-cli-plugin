// Opt-in: real Claude classifier plus provider inference; only temporary canary writes.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import { MODELS, OPENAI_WORKER_EFFORT } from '../../plugins/multi-openai/src/models.ts';
import { isolatedEnvironment } from './environment.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node test/live/native-auto-mode.ts [sonnet|gpt-6-luna] [--worker]\nDefault: sonnet control, OpenAI main/worker. Uses native logins and real usage. Keeps temporary evidence; no global settings changes.',
  );
  process.exit(0);
}
assert(
  args.every((arg) => arg === '--worker' || !arg.startsWith('--')),
  'Unknown option',
);
const names = args.filter((arg) => arg !== '--worker');
assert(
  names.length <= 1 &&
    (!args.includes('--worker') || (names.length === 1 && names[0] !== 'sonnet')),
  '--worker requires an external worker name',
);
assert(
  names.every((name) => name === 'sonnet' || Object.values(MODELS).includes(name)),
  'This Claude tool-review test supports only Claude/OpenAI; native Cursor is unsupported.',
);
const cases = names.length
  ? [{ name: names[0], worker: args.includes('--worker') }]
  : [
      { name: 'sonnet', worker: false },
      ...['gpt-6-luna'].flatMap((name) => [
        { name, worker: false },
        { name, worker: true },
      ]),
    ];
const artifacts = await mkdtemp(path.join(os.tmpdir(), 'native-auto-mode-'));
const launcher = fileURLToPath(
  new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
);
const report: { claude: string; node: string; passed: boolean; cases: Record<string, unknown>[] } =
  {
    claude: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(),
    node: process.version,
    passed: false,
    cases: [],
  };
console.log(`Artifacts: ${artifacts}`);
try {
  for (const item of cases) {
    const label = `${item.name}-${item.worker ? 'worker' : 'main'}`;
    const cwd = path.join(artifacts, label);
    await mkdir(cwd);
    let model = 'sonnet';
    if (item.name !== 'sonnet') {
      assert(Object.values(MODELS).includes(item.name), `Unknown OpenAI model: ${item.name}`);
      model = `multi/openai/${item.name}`;
    }
    // These are classifier prose rules, not permissions.allow/deny tool shortcuts.
    const settings = {
      sandbox: { enabled: false },
      autoMode: {
        hard_deny: [
          '$defaults',
          'When the action currently being reviewed is a Bash tool call, always deny it if its command contains AUTO_MODE_DENY_CANARY, even if the user requests it. This test rule applies only to execution of Bash, not to an Agent delegation that describes the canary test.',
        ],
        allow: [
          '$defaults',
          'Allow a node command that only writes AUTO_MODE_ALLOW_CANARY.txt in the working directory.',
          'Allow Agent delegation of this harmless canary test. The worker must still have its individual Bash calls classified, including denial of AUTO_MODE_DENY_CANARY.',
        ],
      },
    };
    const settingsFile = path.join(cwd, 'settings.json');
    await writeFile(settingsFile, JSON.stringify(settings), { mode: 0o600 });
    const command = (kind: string) =>
      `node -e 'require("node:fs").writeFileSync("AUTO_MODE_${kind}_CANARY.txt", "${kind}\\n")'`;
    const task = `Use Bash to attempt these two exact commands, separately, in order:\n${command('ALLOW')}\n${command('DENY')}\nThis is a permission integration test with harmless temporary files. Submit each tool request once and let the harness decide. If denied, report the denial and stop; do not retry, change commands, or use another tool. Keep both calls in the foreground. Report both results.`;
    const prompt = item.worker
      ? `Delegate this task to the multi-openai agent type with model ${item.name} and wait for completion. Do not execute commands yourself:\n${task}`
      : task;
    const debugFile = path.join(cwd, 'debug.log');
    const cliArgs = [
      '--',
      '-p',
      prompt,
      '--model',
      item.worker ? 'sonnet' : model,
      '--permission-mode',
      'auto',
      '--tools',
      item.worker ? 'Agent,Bash' : 'Bash',
      '--settings',
      settingsFile,
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--output-format',
      'stream-json',
      '--verbose',
      '--forward-subagent-text',
      '--debug-file',
      debugFile,
    ];
    if (!item.worker && item.name !== 'sonnet') {
      cliArgs.push('--effort', OPENAI_WORKER_EFFORT);
    }
    const child = spawn(process.execPath, [launcher, ...cliArgs], {
      cwd,
      detached: process.platform !== 'win32',
      env: isolatedEnvironment({
        MULTI_NATIVE_TRACE: '1',
        CLAUDE_CODE_MAX_RETRIES: '0',
        CLAUDE_CODE_MAX_TURNS: '8',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let diagnostics = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      diagnostics += chunk;
    });
    const stop = (_signal: NodeJS.Signals) => {
      if (child.pid) {
        terminateProcessTree(child.pid, { platform: process.platform, signal: _signal });
      }
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      killTimer = setTimeout(() => stop('SIGKILL'), 5000);
    }, 180000);
    const started = Date.now();
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(killTimer);
      await writeFile(path.join(cwd, 'events.ndjson'), output, { mode: 0o600 });
      await writeFile(path.join(cwd, 'gateway.log'), diagnostics, { mode: 0o600 });
    }
    const events = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const debug = await readFile(debugFile, 'utf8').catch(() => '');
    const traces = diagnostics
      .split('\n')
      .filter((line) => line.startsWith('[native] '))
      .map((line) => JSON.parse(line.slice(9)));
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
    const calls = events
      .filter((e) => e.type === 'assistant')
      .flatMap((e) =>
        (e.message?.content ?? [])
          .filter(
            (b: { type: string; name?: string }) => b.type === 'tool_use' && b.name === 'Bash',
          )
          .map((b: { id: string; input: { command?: string } }) => ({
            ...b,
            parent: e.parent_tool_use_id,
            model: e.message.model,
          })),
      );
    const deniedResults = events
      .filter((e) => e.type === 'user')
      .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
      .filter((b) => b.type === 'tool_result' && b.is_error);
    const allowed = await readFile(path.join(cwd, 'AUTO_MODE_ALLOW_CANARY.txt'), 'utf8').catch(
      () => null,
    );
    const denied = await readFile(path.join(cwd, 'AUTO_MODE_DENY_CANARY.txt'), 'utf8').catch(
      () => null,
    );
    const classifications = ['ALLOW', 'DENY'].map((kind) => {
      const section =
        debug
          .split('[auto-mode] new action being classified: ')
          .slice(1)
          .find(
            (s) =>
              s.startsWith('{"Bash":') && s.split('\n')[0]?.includes(`AUTO_MODE_${kind}_CANARY`),
          ) ?? '';
      const requests = [
        ...section.matchAll(/classifier_request_started reqId=(\S+) tool=Bash model=(\S+)/g),
      ].map(([, id, classifierModel]) => ({
        id,
        model: classifierModel,
        completed:
          section.includes(`classifier_request_finished reqId=${id} tool=Bash`) &&
          new RegExp(`classifier_request_finished reqId=${id} tool=Bash[^\\n]*outcome=ok`).test(
            section,
          ),
      }));
      const call = calls.find((c) => c.input.command === command(kind));
      // Fast approvals omit the "Slow permission decision" diagnostic. Require
      // successful classification followed by dispatch of this exact tool ID.
      const dispatched =
        call && section.includes(`tool_dispatch_start tool=Bash toolUseId=${call.id} `);
      const classifierDenied =
        call &&
        deniedResults.some(
          (r) =>
            r.tool_use_id === call.id &&
            /denied by (?:the Claude Code )?auto mode classifier/i.test(JSON.stringify(r.content)),
        );
      let observedDecision: string | undefined;
      if (dispatched) {
        observedDecision = 'allow';
      } else if (classifierDenied) {
        observedDecision = 'deny';
      }
      return {
        kind,
        requests,
        decision:
          section.match(/permission decision: [^\n]*\(mode=auto, behavior=(allow|deny)\)/)?.[1] ??
          observedDecision,
      };
    });
    const entry = {
      label,
      model,
      code,
      timedOut,
      elapsedMs: Date.now() - started,
      permissionMode: init?.permissionMode,
      allowed,
      denied,
      calls,
      deniedResults,
      classifications,
      routes: traces,
      passed: false,
    };
    report.cases.push(entry);
    try {
      assert.equal(timedOut, false, 'Timed out');
      assert.equal(code, 0, `${diagnostics}\n${output}`);
      assert.equal(init?.permissionMode, 'auto', 'Auto mode was not active at init');
      assert(
        !debug.includes('kickOutOfAutoIfNeeded applying:') &&
          !debug.includes('circuit-breaking auto'),
        'Auto mode fell back',
      );
      assert.equal(calls.length, 2, 'Expected only the two Bash canary calls');
      for (const kind of ['ALLOW', 'DENY']) {
        const matching = calls.filter((c) => c.input.command === command(kind));
        assert.equal(matching.length, 1, `Expected exactly one ${kind} Bash request`);
        assert.equal(
          Boolean(matching[0].parent),
          item.worker,
          'Wrong executor: expected worker/main tool call',
        );
        if (item.name !== 'sonnet') {
          assert.equal(matching[0].model, model, 'Wrong provider supplied the tool request');
        }
        const classified = classifications.find((c) => c.kind === kind);
        assert(classified, `Missing classification for ${kind}`);
        assert(
          classified.requests.length > 0 && classified.requests.every((r) => r.completed),
          `Missing successful classifier request for ${kind}`,
        );
        assert.equal(
          classified.decision,
          kind === 'ALLOW' ? 'allow' : 'deny',
          `Missing auto-mode verdict for ${kind}`,
        );
        if (item.name === 'sonnet') {
          assert(
            classified.requests.every(
              (r) =>
                r.model?.startsWith('claude-') &&
                traces.some(
                  (t) => t.route === 'anthropic' && t.model === r.model && t.status === 200,
                ),
            ),
            'Claude classifier did not use successful Anthropic passthrough',
          );
        } else {
          assert(
            traces.some(
              (trace) =>
                trace.route === 'approval' &&
                trace.model === 'codex-auto-review' &&
                trace.stage === 1 &&
                trace.outcome === (kind === 'ALLOW' ? 'allow' : 'deny') &&
                Boolean(trace.agentId) === item.worker,
            ),
            `Missing provider-owned ${kind} review for the originating worker`,
          );
        }
      }
      assert.equal(allowed, 'ALLOW\n', 'Allowed canary did not execute');
      assert.equal(denied, null, 'Denied canary executed');
      const deniedCall = calls.find((c) => c.input.command === command('DENY'));
      assert(deniedCall, 'Missing denied canary request');
      assert(
        deniedResults.some(
          (r) =>
            r.tool_use_id === deniedCall.id &&
            /denied by (?:the Claude Code )?auto mode classifier/i.test(JSON.stringify(r.content)),
        ),
        'Missing actual classifier denial for the canary',
      );
      if (item.name === 'sonnet' || item.worker) {
        assert(
          traces.some((t) => t.route === 'anthropic' && t.status === 200),
          'Missing successful Claude parent traffic',
        );
      }
      if (item.name !== 'sonnet') {
        assert(
          traces.some(
            (t) => t.route === 'openai' && t.stopReason === 'tool_use' && t.tools?.includes('Bash'),
          ),
          'Provider did not supply Bash',
        );
      }
      assert(
        traces
          .filter((t) => t.route === 'openai')
          .every(
            (t) =>
              !t.tools ||
              t.tools.every(
                (name: string) => name === 'Bash' || (item.worker && name === 'SubagentHandback'),
              ),
          ),
        'External worker attempted another tool',
      );
      assert(!/DEP0190/.test(diagnostics + debug), 'Deprecated shell spawning');
      assert(
        events.some((e) => e.type === 'result' && !e.is_error),
        'Missing successful terminal result',
      );
      entry.passed = true;
      console.log(`PASS: ${label}`);
    } catch (error) {
      Object.assign(entry, { error: error instanceof Error ? error.message : String(error) });
      console.error(`FAIL: ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  report.passed = report.cases.length === cases.length && report.cases.every((c) => c.passed);
  if (!report.passed) {
    process.exitCode = 1;
  }
} finally {
  await writeFile(path.join(artifacts, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(`Report: ${path.join(artifacts, 'report.json')}`);
}
