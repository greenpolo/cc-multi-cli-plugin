import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  antigravityPermissionPolicy,
  antigravityToolDecision,
} from '../../plugins/multi-antigravity/src/permissions.ts';

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const hook = fileURLToPath(
  new URL('../../plugins/multi-antigravity/src/permission-hook.ts', import.meta.url),
);

function runHook(input: string, policy?: string): HookResult {
  const environment = { ...process.env };
  if (policy === undefined) {
    delete environment.MULTI_ANTIGRAVITY_DENY;
  } else {
    environment.MULTI_ANTIGRAVITY_DENY = policy;
  }
  const child = spawnSync(process.execPath, [hook], {
    input,
    encoding: 'utf8',
    env: environment,
  });
  return {
    code: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

test('native Antigravity hook emits no stdout when no gateway policy is present', async () => {
  const result = runHook(JSON.stringify({ toolCall: { name: 'run_command', args: {} } }));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('native Antigravity hook denies excluded and malformed calls', async () => {
  const excluded = runHook(
    JSON.stringify({ toolCall: { name: 'run_command', args: {} } }),
    JSON.stringify(['run_command']),
  );
  assert.equal(excluded.code, 0);
  assert.ok(excluded.stdout, JSON.stringify(excluded));
  assert.deepEqual(JSON.parse(excluded.stdout), {
    decision: 'deny',
    reason: 'Claude session policy excludes this native Antigravity tool.',
  });

  const notExcluded = runHook(
    JSON.stringify({ toolCall: { name: 'view_file', args: {} } }),
    JSON.stringify(['run_command']),
  );
  assert.equal(notExcluded.code, 0);
  assert.equal(notExcluded.stdout, '');

  const malformedPayload = runHook('{malformed}', JSON.stringify(['run_command']));
  assert.equal(malformedPayload.code, 0);
  assert.deepEqual(JSON.parse(malformedPayload.stdout), {
    decision: 'deny',
    reason: 'Antigravity permission hook failed.',
  });

  const malformedPolicy = runHook(
    JSON.stringify({ toolCall: { name: 'view_file', args: {} } }),
    'not-json',
  );
  assert.equal(malformedPolicy.code, 0);
  assert.deepEqual(JSON.parse(malformedPolicy.stdout), {
    decision: 'deny',
    reason: 'Antigravity gateway permission context is invalid.',
  });
});

test('native Antigravity hook denies every tool outside a plan allowlist', () => {
  const deny = JSON.stringify(['run_command']);
  const allow = JSON.stringify(['view_file']);
  const decide = (name: string) =>
    antigravityToolDecision({ toolCall: { name, args: {} } }, deny, allow)?.decision;
  assert.equal(decide('view_file'), undefined);
  for (const tool of ['run_command', 'execute_browser_javascript', 'schedule', 'future_tool']) {
    assert.equal(decide(tool), 'deny', tool);
  }
  assert.equal(
    antigravityToolDecision({ toolCall: { name: 'view_file' } }, deny, '{"not":"a list"}')
      ?.decision,
    'deny',
  );
});

test('plan policy allows only read-only native tools that Claude rules keep', () => {
  const policy = antigravityPermissionPolicy({
    permissionMode: 'plan',
    disallowedTools: ['WebFetch'],
  });
  assert.deepEqual(
    new Set(policy.allowed),
    new Set([
      'view_file',
      'list_dir',
      'grep_search',
      'find_by_name',
      'search_web',
      'finish',
      'wait',
      'wait_5_seconds',
    ]),
  );
});
