import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MessagesResponse } from '../../plugins/multi-core/src/gateway/messages.ts';
import { CursorHarness } from '../../plugins/multi-cursor/src/harness.ts';
import { CursorWorkspaces } from '../../plugins/multi-cursor/src/workspaces.ts';
import { removeTemporary } from '../temporary.ts';

test('worktree workers route to their canonical workspace and close all SDK harnesses', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-workspaces-'));
  t.after(() => removeTemporary(root));
  const worktree = path.join(root, 'worktree');
  await mkdir(worktree);
  await symlink(worktree, path.join(root, 'alias'));
  const created: string[] = [];
  const handled: string[] = [];
  const closed: string[] = [];
  const response: MessagesResponse = {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content: [{ type: 'text', text: 'done' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const workspaces = new CursorWorkspaces(
    (cwd) => {
      created.push(cwd);
      const harness = new CursorHarness([], { cwd });
      t.mock.method(harness, 'validate', () => 0);
      t.mock.method(harness, 'handle', async () => {
        handled.push(cwd);
        return response;
      });
      t.mock.method(harness, 'close', async () => {
        closed.push(cwd);
      });
      return harness;
    },
    await realpath(root),
  );
  t.after(() => workspaces.close());
  const body = { model: 'test', messages: [{ role: 'user', content: 'hello' }] };
  const signal = AbortSignal.timeout(5000);
  assert.equal(workspaces.validate(body), 0);
  await workspaces.handle(body, 'main', signal, undefined, { permissionMode: 'auto' });
  for (const cwd of [worktree, path.join(root, 'alias')]) {
    await workspaces.handle(body, 'worker', signal, undefined, { permissionMode: 'plan', cwd });
  }
  assert.deepEqual(created, [await realpath(root), await realpath(worktree)]);
  assert.deepEqual(handled, [created[0], created[1], created[1]]);
  await workspaces.close();
  assert.deepEqual(closed, created);
  await assert.rejects(workspaces.handle(body, 'main', signal), /closed/);
});

test('a recorded reply is read from the workspace that handled it, so a follow-up survives a restart', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cursor-workspaces-recorded-'));
  t.after(() => removeTemporary(root));
  const worktree = path.join(root, 'worktree');
  await mkdir(worktree);
  await symlink(worktree, path.join(root, 'alias'));
  const reply: MessagesResponse = {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content: [{ type: 'text', text: 'recorded' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const asked: string[] = [];
  const workspaces = new CursorWorkspaces(
    (cwd) => {
      const harness = new CursorHarness([], { cwd });
      t.mock.method(harness, 'recordedResponse', async (scope: string) => {
        asked.push(`${cwd}:${scope}`);
        return cwd === (await realpath(worktree)) ? reply : undefined;
      });
      return harness;
    },
    await realpath(root),
  );
  t.after(() => workspaces.close());
  assert.equal(
    await workspaces.recordedResponse('worker', {
      permissionMode: 'plan',
      cwd: path.join(root, 'alias'),
    }),
    reply,
  );
  assert.equal(await workspaces.recordedResponse('worker'), undefined);
  assert.deepEqual(asked, [`${await realpath(worktree)}:worker`, `${await realpath(root)}:worker`]);
});
