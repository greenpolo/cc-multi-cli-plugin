import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { terminateProcessTree } from '../../plugins/multi-core/src/gateway/process-tree.ts';
import { runScenario } from './harness.ts';
import type { TtyDriver } from './tty.ts';
import type { JsonObject } from './types.ts';

// The shared passive observer writes full requests to stderr. A TTY merges stderr
// with rendering, so suppress only that test diagnostic, not gateway responses.
const quietObserver = `const write = process.stderr.write.bind(process.stderr); process.stderr.write = (...args) => String(args[0]).startsWith('E2E_GATEWAY_REQUEST=') ? true : write(...args);`;
const env = {
  MULTI_NATIVE_TRACE: '0',
  NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(quietObserver)}`,
};

const fixtures = {
  'config/.claude.json': JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'dark',
    hasTrustDialogAccepted: true,
  }),
};

const childPids = new WeakMap<TtyDriver, number>();

async function ready(driver: TtyDriver) {
  const startup = await driver.waitFor(/❯ No, exit/, 15000);
  const pid = startup.match(/E2E_CHILD_PID=(\d+)/)?.[1];
  assert.ok(pid, startup);
  childPids.set(driver, Number(pid));
  await setTimeout(1000);
  await driver.key('Down');
  await driver.key('Enter');
  const screen = await driver.waitFor(/custom API key|for shortcuts|plan mode on/, 15000);
  if (/custom API key/.test(screen)) {
    await driver.key('Up');
    await driver.key('Enter');
    await driver.waitFor(/Try |for shortcuts|plan mode on/, 15000);
  }
}

// The shared TTY driver kills tmux before Claude flushes its state. Keep a final
// screenshot and stop the child first so isolated-home cleanup cannot race writes.
function interactive(run: (driver: TtyDriver) => Promise<void>) {
  return async (driver: TtyDriver) => {
    try {
      await run(driver);
    } finally {
      const screen = await driver.capture();
      driver.capture = async () => screen;
      const pid = childPids.get(driver);
      if (pid) {
        terminateProcessTree(pid, { signal: 'SIGTERM' });
        await setTimeout(500);
      }
    }
  };
}

/** The visible screen; a capture also carries scrollback. */
async function visible(driver: TtyDriver) {
  return (await driver.capture()).split('\n').slice(-40).join('\n');
}

/** The input box: the lines between the last two rules. A sent prompt moves above it. */
async function inputBox(driver: TtyDriver) {
  const lines = (await visible(driver)).split('\n');
  const rules = lines.flatMap((line, index) => (line.startsWith('─') ? [index] : []));
  return rules.length < 2 ? '' : lines.slice(rules.at(-2), rules.at(-1)).join('\n');
}

async function submit(driver: TtyDriver, prompt: string) {
  await driver.send(prompt);
  // Claude's paste debounce can consume an immediate Enter, more often under load,
  // leaving the prompt in the input box. Enter again submits it; it never repeats it.
  const head = prompt.slice(0, 24);
  for (let attempt = 0; attempt < 5; attempt++) {
    await setTimeout(150);
    await driver.key('Enter');
    await setTimeout(350);
    if (!(await inputBox(driver)).includes(head)) {
      return;
    }
  }
  assert.fail(`The prompt was never submitted\n${await visible(driver)}`);
}

/**
 * Accept a dialog's highlighted option. Claude Code ignores keys for a moment after a
 * dialog opens, so the keystroke that closed one dialog cannot answer the next.
 */
async function accept(driver: TtyDriver, dialog: RegExp) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await driver.key('Enter');
    await setTimeout(300);
    if (!dialog.test(await visible(driver))) {
      return;
    }
  }
  assert.fail(`The dialog did not accept Enter\n${await visible(driver)}`);
}

for (const approve of [false, true]) {
  test(`interactive permission prompt: ${approve ? 'yes executes' : 'no prevents execution'}`, async (t) => {
    let issued = false;
    const command = `node -e "require('node:fs').writeFileSync('tty-shell.txt', 'executed')"`;
    const prompt = `Use Bash once to run ${command}. Do not retry a denied action. Then reply TTY_PERMISSION_DONE.`;
    const result = await runScenario(t, {
      name: `interactive-permission-${approve}`,
      permissionMode: 'default',
      model: 'multi/openai/gpt-6-astra',
      enabledProviders: ['openai'],
      fixtures,
      env,
      upstream: {
        openai: (request) => {
          if (
            !(request.body.tools as JsonObject[] | undefined)?.some((tool) => tool.name === 'Bash')
          ) {
            return { text: 'Ready.' };
          }
          if (!issued) {
            issued = true;
            return {
              tool: {
                name: 'Bash',
                input: { command, description: 'Write TTY permission canary' },
              },
            };
          }
          return { text: 'TTY_PERMISSION_DONE' };
        },
      },
      driver: {
        kind: 'tty',
        run: interactive(async (driver) => {
          await ready(driver);
          await submit(driver, prompt);
          const screen = await driver.waitFor(/\d\. No/, 15000);
          if (approve) {
            await driver.key('Enter');
          } else {
            const option = screen.match(/(\d)\. No/);
            assert.ok(option, screen);
            await driver.send(String(option[1]));
            await driver.key('Enter');
          }
          await driver.waitFor(approve ? /● TTY_PERMISSION_DONE/ : /Interrupted/, 20000);
        }),
      },
      live: {
        providers: ['openai'],
        purpose: 'permissions',
        prompt,
        maxTurns: 3,
        maxBudgetUsd: 0.15,
      },
    });
    if (!result) {
      return;
    }
    assert.equal(
      await readFile(path.join(result.workspace, 'tty-shell.txt'), 'utf8').catch(() => null),
      approve ? 'executed' : null,
    );
    assert.match(result.stdout, approve ? /● TTY_PERMISSION_DONE/ : /Interrupted/);
    if (!approve) {
      assert.equal(
        result.requests.filter(({ body }) =>
          JSON.stringify(body.input ?? []).includes('function_call_output'),
        ).length,
        0,
      );
    }
  });
}

test('interactive plan: approve ExitPlanMode before the edit executes', async (t) => {
  let planTurn = 0;
  let canaryPath: string | undefined;
  const prompt =
    'Make a short plan to create planned.txt with the exact content approved. Call ExitPlanMode to request approval, then use Write only after approval. Finish with TTY_PLAN_DONE.';
  const result = await runScenario(t, {
    name: 'interactive-plan-approval',
    permissionMode: 'plan',
    model: 'multi/openai/gpt-6-astra',
    enabledProviders: ['openai'],
    fixtures,
    env,
    upstream: {
      openai: (request) => {
        if (
          !(request.body.tools as JsonObject[] | undefined)?.some((tool) => tool.name === 'Write')
        ) {
          return { text: 'Ready.' };
        }
        const index = planTurn++;
        if (index === 0) {
          const planPath = JSON.stringify(request.body).match(
            /create your plan at (.+?\.md) using/,
          );
          assert.ok(planPath?.[1], 'Claude must advertise its writable plan path');
          canaryPath = path.resolve(path.dirname(planPath[1]), '../../workspace/planned.txt');
          return {
            tool: {
              name: 'Write',
              id: 'call_plan_file',
              input: {
                file_path: planPath[1],
                content: 'Create planned.txt containing approved after approval.',
              },
            },
          };
        }
        // Claude defers ExitPlanMode behind ToolSearch, as on a direct connection.
        if (index === 1) {
          return {
            tool: { name: 'ToolSearch', input: { query: 'select:ExitPlanMode', max_results: 1 } },
          };
        }
        if (index === 2) {
          return {
            tool: {
              name: 'ExitPlanMode',
              input: { plan: 'Create planned.txt containing approved after approval.' },
            },
          };
        }
        if (index === 3) {
          return {
            tool: { name: 'Write', input: { file_path: 'planned.txt', content: 'approved' } },
          };
        }
        return { text: 'TTY_PLAN_DONE' };
      },
    },
    driver: {
      kind: 'tty',
      run: interactive(async (driver) => {
        await ready(driver);
        await submit(driver, prompt);
        await driver.waitFor(/\d\.\s*Yes[^\n]*manually approve edits/i, 15000);
        if (canaryPath) {
          await assert.rejects(readFile(canaryPath), { code: 'ENOENT' });
        }
        // Approve the plan, then approve the requested edit in default mode.
        const screen = await driver.capture();
        const option = screen.match(/(\d)\.\s*Yes[^\n]*manually approve edits/i);
        assert.ok(option, screen);
        await setTimeout(150);
        await driver.send(String(option[1]));
        await setTimeout(150);
        await driver.key('Enter');
        const edit = /Do you want to create|Allow.*Write|Do you want to make this edit/i;
        await driver.waitFor(edit, 15000);
        await accept(driver, edit);
        await driver.waitFor(/● TTY_PLAN_DONE/, 20000);
      }),
    },
    live: { providers: ['openai'], purpose: 'plan', prompt, maxTurns: 4, maxBudgetUsd: 0.2 },
  });
  if (!result) {
    return;
  }
  assert.equal(await readFile(path.join(result.workspace, 'planned.txt'), 'utf8'), 'approved');
  assert.match(result.stdout, /TTY_PLAN_DONE/);
});
