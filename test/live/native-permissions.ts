// Opt-in native permission contract. Real providers, real terminal, temporary effects.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { hookCommand } from '../../plugins/multi-core/src/gateway/permission-hook.ts';
import { isolatedEnvironment } from './environment.ts';
import type { HookInput, TranscriptEntry } from './native-events.ts';
import { pty, skipIfPtyUnsupported } from './native-pty.ts';

const { values } = parseArgs({
  options: { model: { type: 'string' }, mode: { type: 'string' }, help: { type: 'boolean' } },
});
const modes = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
if (values.help) {
  console.log(
    'Usage: npm run test:live:permissions -- [--model multi/openai/gpt-6-luna] [--mode MODE]\nDefaults to OpenAI and all five non-auto modes. Requires Claude, provider login, Python 3, Node 24; uses temporary files and real provider usage.',
  );
  process.exit(0);
}
assert(
  !values.model || values.model.startsWith('multi/openai/'),
  'This Claude tool-permission test supports OpenAI; native Cursor is unsupported.',
);
assert(!values.mode || modes.includes(values.mode), 'Unknown permission mode');
if (skipIfPtyUnsupported()) {
  process.exit(0);
}
assert.equal(spawnSync('python3', ['--version']).status, 0, 'Python 3 required');
const root = await mkdtemp(path.join(os.tmpdir(), 'native-permissions-'));
console.log(`Artifacts: ${root}`);
const reports: Record<string, unknown>[] = [];
const models = [values.model ?? 'multi/openai/gpt-6-luna'];
for (const model of models) {
  for (const mode of values.mode ? [values.mode] : modes) {
    const cwd = await mkdtemp(path.join(root, `${mode}-`));
    const config = path.join(cwd, 'config');
    await mkdir(config);
    await writeFile(
      path.join(config, '.claude.json'),
      JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }),
    );
    const seed = path.join(cwd, 'EDIT.txt');
    await writeFile(seed, 'BEFORE\n');
    const eventsFile = path.join(cwd, 'hooks.jsonl');
    const hookFile = path.join(cwd, 'record.mjs');
    await writeFile(
      hookFile,
      `import {readFileSync,appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(eventsFile)},readFileSync(0,'utf8').trim()+'\\n'); console.log('{}');`,
    );
    const hook = { type: 'command', command: hookCommand(pathToFileURL(hookFile)), timeout: 10 };
    const settings = path.join(cwd, 'settings.json');
    // Observation only: no allow/deny/ask rules or permission decisions from hooks.
    await writeFile(
      settings,
      JSON.stringify({
        sandbox: { enabled: false },
        hooks: Object.fromEntries(
          ['PreToolUse', 'PermissionRequest'].map((event) => [event, [{ hooks: [hook] }]]),
        ),
      }),
    );
    const command = (name: string) =>
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').appendFileSync('${name}.txt', '${name}\\n')`)}`;
    const prompt = `This is an authorized, harmless permission integration test in ${cwd}. Use Read on ${seed}, then attempt Edit from BEFORE to AFTER once, then attempt Bash with exactly ${command('ACCEPT')}, then exactly ${command('DENY')}. Submit tools separately in that order, in the foreground. Bash takes command and description only; do not pass cwd or other extra arguments. The harness owns permission enforcement; do not change permission mode or use alternative commands. Do not retry denied calls. Continue to the next step after a tool error. End with PERMISSION_CONTRACT_DONE.`;
    const debugFile = path.join(cwd, 'debug.log');
    const child = spawn(
      'python3',
      [
        '-c',
        pty,
        process.execPath,
        fileURLToPath(new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url)),
        '--',
        prompt,
        '--model',
        model,
        '--effort',
        'high',
        '--permission-mode',
        mode,
        '--tools',
        'Read,Edit,Bash',
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
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: isolatedEnvironment({
          HOME: os.homedir(),
          CODEX_HOME: process.env.CODEX_HOME,
          TERM: 'xterm-256color',
          CLAUDE_CONFIG_DIR: config,
          MULTI_NATIVE_TRACE: '1',
          CLAUDE_CODE_MAX_RETRIES: '0',
        }),
      },
    );
    let output = '';
    let stderr = '';
    let clean = '';
    let trusted = false;
    let bypassConfirmed = false;
    let finishing = false;
    let failure: Error | undefined;
    const answers: string[] = [];
    const readEvents = async (): Promise<HookInput[]> =>
      (await readFile(eventsFile, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    const history = async (): Promise<TranscriptEntry[]> => {
      const events = await readEvents();
      const filename = events.at(-1)?.transcript_path;
      assert(typeof filename === 'string' && filename.startsWith(config + path.sep));
      return (await readFile(filename, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    };
    const stop = () => {
      if (finishing) {
        return;
      }
      finishing = true;
      child.stdin.write('\x03');
      setTimeout(() => child.stdin.write('\x03'), 300);
      setTimeout(() => child.stdin.write('\x03'), 600);
    };
    const timer = setTimeout(() => {
      failure = new Error('Permission contract timed out');
      child.kill('SIGTERM');
    }, 150000);
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.stdout.on('data', (data) => {
      output += data;
      appendFileSync(path.join(cwd, 'terminal.log'), data);
      clean += stripVTControlCharacters(String(data));
      const flat = clean.replace(/\s/g, '');
      if (mode === 'bypassPermissions' && !bypassConfirmed && flat.includes('Yes,Iaccept')) {
        bypassConfirmed = true;
        clean = '';
        setTimeout(() => {
          child.stdin.write('\x1b[B');
          setTimeout(() => child.stdin.write('\r'), 200);
        }, 300);
      }
      if (!trusted && flat.includes('Yes,Itrustthisfolder')) {
        trusted = true;
        clean = '';
        setTimeout(() => {
          child.stdin.write('\x1b[B');
          setTimeout(() => child.stdin.write('\r'), 200);
        }, 500);
      }
      if (flat.includes('Esctocancel') && flat.includes('Tabtoamend')) {
        clean = '';
        void readEvents()
          .then(async (events) => {
            const pending = events.filter((e) => e.hook_event_name === 'PreToolUse').at(-1);
            assert(pending, 'Missing pending tool');
            const label = pendingLabel(pending, command);
            assert(
              ['default', 'acceptEdits', 'plan'].includes(mode) && label,
              'Unexpected permission prompt',
            );
            if (label === 'EDIT') {
              assertEdit(pending, seed);
            }
            if (answers.includes(label)) {
              return; // Native terminal redraws the same prompt.
            }
            answers.push(label);
            assert.equal(
              label === 'EDIT'
                ? await readFile(seed, 'utf8')
                : await readFile(path.join(cwd, `${label}.txt`), 'utf8').catch(() => null),
              label === 'EDIT' ? 'BEFORE\n' : null,
              'Action executed before user approval',
            );
            const allow = mode !== 'plan' && label !== 'DENY';
            setTimeout(() => {
              if (allow) {
                child.stdin.write('\r');
              } else {
                child.stdin.write('\x1b[A');
                setTimeout(() => child.stdin.write('\r'), 200);
              }
            }, 300);
          })
          .catch((error) => {
            failure = error;
            child.kill('SIGTERM');
          });
      }
    });
    const poll = setInterval(() => {
      if (finishing) {
        return;
      }
      void history()
        .then((entries) => {
          const blocks = entries.flatMap((e) =>
            Array.isArray(e.message?.content) ? e.message.content : [],
          );
          if (
            entries.some((e) => e.type === 'assistant' && e.message?.stop_reason === 'end_turn') ||
            blocks.some(
              (b) =>
                b.type === 'tool_result' &&
                b.is_error &&
                /The user doesn't want to proceed/.test(String(b.content)),
            )
          ) {
            stop();
          }
        })
        .catch(() => {}); // Transcripts can be between writes; timeout remains mandatory.
    }, 200);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve);
        child.once('error', reject);
      });
      if (failure) {
        throw failure;
      }
      assert.equal(code, 0, stderr);
      const events = await readEvents();
      const entries = await history();
      const calls = entries
        .filter((e) => e.type === 'assistant')
        .flatMap((e) =>
          (Array.isArray(e.message?.content) ? e.message.content : [])
            .filter((b) => b.type === 'tool_use')
            .map((b) => {
              assert(b.input, 'Tool call has no input');
              return { ...b, input: b.input, model: e.message?.model };
            }),
        );
      const results = entries
        .filter((e) => e.type === 'user')
        .flatMap((e) =>
          Array.isArray(e.message?.content)
            ? e.message.content.filter((b) => b.type === 'tool_result')
            : [],
        );
      assert(
        calls.length > 0 && calls.every((c) => c.model === model),
        'Missing provider-attributed tools',
      );
      assert(
        events.every((e) => e.permission_mode === mode),
        'Permission mode changed',
      );
      assert.equal(new Set(calls.map((c) => c.id)).size, calls.length, 'Duplicate tool IDs');
      assert.deepEqual(
        calls.map((c) => c.id),
        events.filter((e) => e.hook_event_name === 'PreToolUse').map((e) => e.tool_use_id),
      );
      const read = calls.find((c) => c.name === 'Read');
      assert(
        read && results.some((r) => r.tool_use_id === read.id && !r.is_error),
        'Read did not execute',
      );
      const edited = await readFile(seed, 'utf8');
      assert.equal(
        edited,
        ['default', 'acceptEdits', 'bypassPermissions'].includes(mode) ? 'AFTER\n' : 'BEFORE\n',
      );
      for (const name of ['ACCEPT', 'DENY']) {
        const expected =
          mode === 'bypassPermissions' ||
          (name === 'ACCEPT' && ['default', 'acceptEdits'].includes(mode));
        assert.equal(
          await readFile(path.join(cwd, `${name}.txt`), 'utf8').catch(() => null),
          expected ? `${name}\n` : null,
        );
      }
      if (mode !== 'plan') {
        assert.deepEqual(
          calls.map((c) => c.name),
          ['Read', 'Edit', 'Bash', 'Bash'],
        );
        assert.equal(calls[0].input.file_path, seed);
        assert.equal(calls[1].input.file_path, seed);
        assert.equal(calls[1].input.old_string, 'BEFORE');
        assert.equal(calls[1].input.new_string, 'AFTER');
        assert.deepEqual(
          calls.slice(2).map((c) => c.input.command),
          [command('ACCEPT'), command('DENY')],
        );
        for (const [index, call] of calls.entries()) {
          const result = results.find((r) => r.tool_use_id === call.id);
          assert(result, 'Missing actual tool result');
          const denied =
            mode === 'dontAsk' ? index > 0 : mode !== 'bypassPermissions' && index === 3;
          assert.equal(
            Boolean(result.is_error),
            denied,
            'Tool result disagrees with permission outcome',
          );
        }
      }
      if (mode === 'plan') {
        assert(answers.length <= 1, 'Plan mode continued after user denial');
        for (const call of calls.filter(
          (c) =>
            c.name === 'Edit' ||
            (c.name === 'Bash' &&
              [command('ACCEPT'), command('DENY')].includes(c.input.command ?? '')),
        )) {
          assert(
            results.some((r) => r.tool_use_id === call.id && r.is_error),
            'Plan-mode canary write executed',
          );
        }
      } else {
        assert.deepEqual(
          answers,
          (
            { default: ['EDIT', 'ACCEPT', 'DENY'], acceptEdits: ['ACCEPT', 'DENY'] } as Record<
              string,
              string[]
            >
          )[mode] ?? [],
        );
      }
      assert.equal(
        events.filter((e) => e.hook_event_name === 'PermissionRequest').length,
        answers.length,
        'Native permission request count differs from dialogs',
      );
      const trace = [...(output + stderr).matchAll(/\[native\] (\{[^\r\n]+\})/g)].map((m) =>
        JSON.parse(m[1]),
      );
      const debug = await readFile(debugFile, 'utf8');
      assert(
        !trace.some((e) => ['approval', 'anthropic'].includes(e.route)),
        'Unexpected classifier or Anthropic traffic',
      );
      assert(
        !/classifier_request_started|DEP0190/.test(debug + stderr),
        'Unexpected review or deprecated spawn',
      );
      reports.push({
        model,
        mode,
        passed: true,
        cwd,
        calls: calls.length,
        answers,
        ...(mode === 'plan'
          ? {
              canaryWriteAttempts: calls.filter(
                (c) =>
                  c.name === 'Edit' ||
                  (c.name === 'Bash' &&
                    [command('ACCEPT'), command('DENY')].includes(c.input.command ?? '')),
              ).length,
              scope: 'Read-only behavior; no claim of rejecting an unsubmitted write',
            }
          : {}),
      });
      console.log(`PASS ${model} ${mode}`);
    } catch (error) {
      reports.push({ model, mode, passed: false, cwd, error: String(error) });
      console.error(`FAIL ${model} ${mode}: ${error}`);
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
      clearInterval(poll);
      child.kill('SIGTERM');
      await writeFile(path.join(cwd, 'stderr.log'), stderr);
      await writeFile(
        path.join(root, 'report.json'),
        JSON.stringify(
          {
            version: 1,
            claude: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout.trim(),
            node: process.version,
            cases: reports,
          },
          null,
          2,
        ),
      );
    }
  }
}

function pendingLabel(pending: HookInput, command: (name: string) => string) {
  if (pending.tool_name === 'Edit') {
    return 'EDIT';
  }
  if (pending.tool_input.command === command('ACCEPT')) {
    return 'ACCEPT';
  }
  return pending.tool_input.command === command('DENY') ? 'DENY' : '';
}

function assertEdit(pending: HookInput, seed: string) {
  assert.equal(pending.tool_input.file_path, seed);
  assert.equal(pending.tool_input.old_string, 'BEFORE');
  assert.equal(pending.tool_input.new_string, 'AFTER');
  assert(!pending.tool_input.replace_all);
}
