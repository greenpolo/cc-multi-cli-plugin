import assert from 'node:assert/strict';
import test from 'node:test';
import {
  antigravityPermissionPolicy,
  antigravityProtectedRoots,
  antigravityToolDecision,
} from '../../plugins/multi-antigravity/src/permissions.ts';

const ALWAYS_DENIED = [
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'browser_subagent',
  'call_mcp_tool',
  'notebook_execution',
  'schedule',
  'manage_task',
  'send_message',
  'manage_inbox',
  'list_resources',
  'read_resource',
  'generate_image',
  'delete_knowledge',
];

test('Antigravity Auto denies excluded Claude tools and always denies delegation/MCP', () => {
  const auto = antigravityPermissionPolicy({ permissionMode: 'auto', disallowedTools: ['Write'] });
  assert.equal(auto.plan, false);
  assert.match(auto.notice, /Claude Code rules take precedence/);
  assert(auto.notice.includes('No reviewer.'));
  assert(auto.denied.includes('write_to_file'));
  assert(!auto.denied.includes('view_file'));
  for (const name of ALWAYS_DENIED) {
    assert(auto.denied.includes(name), `expected ${name} to always be denied`);
  }
});

test('Bypass carries the same denylist shape as Auto', () => {
  const auto = antigravityPermissionPolicy({ permissionMode: 'auto' });
  const bypass = antigravityPermissionPolicy({ permissionMode: 'bypassPermissions' });
  assert.equal(bypass.plan, false);
  assert.match(bypass.notice, /Claude Code rules take precedence/);
  assert.deepEqual(bypass.denied, ALWAYS_DENIED);
  assert.deepEqual(bypass.denied, auto.denied);
  assert.deepEqual(bypass.allowed, auto.allowed);
  assert.equal(bypass.notice, auto.notice);
});

test('Plan denies shell, edit, write, notebook-edit natives plus delegation/MCP', () => {
  const plan = antigravityPermissionPolicy({ permissionMode: 'plan' });
  assert.equal(plan.plan, true);
  assert.match(plan.notice, /only native read, search and web lookup tools run/);
  for (const name of [
    'run_command',
    'command_status',
    'send_command_input',
    'write_to_file',
    'replace_file_content',
    'multi_replace_file_content',
    'sed_file',
    'notebook_edit',
  ]) {
    assert(plan.denied.includes(name), `expected ${name} to be denied in Plan`);
  }
  for (const name of ['view_file', 'list_dir', 'grep_search', 'find_by_name']) {
    assert(!plan.denied.includes(name), `expected ${name} to remain allowed in Plan`);
    assert(plan.allowed?.includes(name), `expected ${name} on the Plan allowlist`);
  }
  assert(!plan.allowed?.includes('execute_browser_javascript'));
});

test('an explicit tools allowlist denies natives for mapped tools left out of it', () => {
  const policy = antigravityPermissionPolicy({ permissionMode: 'auto', tools: ['Read'] });
  assert(!policy.denied.includes('view_file'));
  assert(!policy.denied.includes('list_dir'));
  assert(policy.denied.includes('run_command'));
  assert(policy.denied.includes('write_to_file'));
  assert(policy.denied.includes('read_url_content'));
  assert(policy.denied.includes('search_web'));
  assert(policy.denied.includes('notebook_edit'));
});

test('outside Plan the policy is an allowlist, so unmapped announced tools stay denied', () => {
  const policy = antigravityPermissionPolicy({
    permissionMode: 'auto',
    tools: ['Read', 'Grep', 'Glob'],
  });
  const allowed = new Set(policy.allowed);
  for (const name of ['view_file', 'list_dir', 'grep_search', 'find_by_name', 'finish', 'wait']) {
    assert(allowed.has(name), `expected ${name} to be allowed`);
  }
  for (const name of [
    'execute_browser_javascript',
    'open_browser_url',
    'read_browser_page',
    'schedule',
    'send_message',
    'manage_inbox',
    'manage_task',
    'delete_knowledge',
    'generate_image',
    'list_resources',
    'read_resource',
    'run_command',
    'write_to_file',
    'a_tool_agy_adds_later',
  ]) {
    assert(!allowed.has(name), `expected ${name} outside the allowlist`);
  }
  const decision = antigravityToolDecision(
    { toolCall: { name: 'a_tool_agy_adds_later' } },
    JSON.stringify(policy.denied),
    JSON.stringify(policy.allowed),
  );
  assert.equal(decision?.decision, 'deny');
});

test('browser tools follow the WebFetch grant', () => {
  const withWeb = antigravityPermissionPolicy({
    permissionMode: 'auto',
    tools: ['Read', 'WebFetch'],
  });
  assert(withWeb.allowed?.includes('open_browser_url'));
  assert(withWeb.allowed?.includes('execute_browser_javascript'));
  const without = antigravityPermissionPolicy({
    permissionMode: 'auto',
    disallowedTools: ['WebFetch'],
  });
  assert(without.denied.includes('open_browser_url'));
});

test('write tools never target the agy hook and settings tree', () => {
  const roots = antigravityProtectedRoots({ platform: 'linux', homedir: '/home/u' });
  const policyJson = JSON.stringify([]);
  const deny = (name: string, parameters: unknown) =>
    antigravityToolDecision(
      { toolCall: { name, parameters } },
      policyJson,
      JSON.stringify([name]),
      { protectedRoots: roots },
    );
  for (const [name, parameters] of [
    ['write_to_file', { TargetFile: '/home/u/.gemini/config/hooks.json' }],
    [
      'replace_file_content',
      { TargetFile: '/home/u/.gemini/../.gemini/antigravity-cli/settings.json' },
    ],
    ['sed_file', { AbsolutePath: '/work/../home/u/.gemini/config/x' }],
  ] as const) {
    assert.equal(deny(name, parameters)?.decision, 'deny', name);
  }
  assert.equal(deny('write_to_file', { TargetFile: '/work/project/a.txt' }), undefined);
  assert.equal(deny('view_file', { AbsolutePath: '/home/u/.gemini/config/hooks.json' }), undefined);
});

test('rejects unsupported permission modes and rule shapes', () => {
  assert.throws(() => antigravityPermissionPolicy({ permissionMode: 'default' }), /unsupported/);
  assert.throws(() => antigravityPermissionPolicy({ permissionMode: 'dontAsk' }), /unsupported/);
  assert.throws(
    () => antigravityPermissionPolicy({ permissionMode: 'auto', tools: ['Bash(git)'] }),
    /cannot enforce/,
  );
  assert.doesNotThrow(() =>
    antigravityPermissionPolicy({ permissionMode: 'auto', tools: ['Agent', 'Task'] }),
  );
});

test('native gate denies whatever is in the serialized denylist and is neutral otherwise', () => {
  const call = (name: string) => ({ toolCall: { name, args: {} } });
  const policy = JSON.stringify(['run_command']);
  assert.equal(antigravityToolDecision(call('view_file'), policy), undefined);
  assert.equal(antigravityToolDecision(call('run_command'), policy)?.decision, 'deny');
  assert.equal(
    antigravityToolDecision(call('invoke_subagent'), JSON.stringify(['invoke_subagent']))?.decision,
    'deny',
  );
  assert.equal(antigravityToolDecision(call('call_mcp_tool'), policy), undefined);
  assert.equal(antigravityToolDecision(call('run_command')), undefined);
  assert.equal(antigravityToolDecision(call('run_command'), 'invalid')?.decision, 'deny');
  assert.equal(antigravityToolDecision({}, policy)?.decision, 'deny');
});
