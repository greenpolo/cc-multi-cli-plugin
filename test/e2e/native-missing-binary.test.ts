import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runScenario } from './harness.ts';

test('missing agy executable yields nonretryable 400', {
  skip:
    process.platform === 'win32'
      ? 'Missing-interpreter ENOENT fixture requires POSIX shebang execution'
      : false,
  todo: 'Missing agy executable is mapped to retryable 502 instead of 400',
}, async (t) => {
  const result = await runScenario(t, {
    name: 'native-missing-binary',
    model: 'multi/antigravity/e2e-model',
    enabledProviders: ['antigravity'],
    permissionMode: 'bypassPermissions',
    native: {
      agy: async (request) => {
        assert.equal(
          request.args[0],
          'models',
          'No native prompt may reach the unavailable executable',
        );
        // Discovery succeeds, then the selected executable becomes unavailable. A
        // missing absolute shebang interpreter produces the same OS ENOENT as a
        // missing binary without allowing PATH to fall through to the real agy.
        const root = path.dirname(request.cwd);
        await writeFile(
          path.join(root, 'fake bin with spaces', 'agy'),
          `#!${path.join(root, 'absent-interpreter')}\n`,
        );
        return { stdout: 'e2e-model\tE2E Model\n' };
      },
    },
  });
  if (!result) {
    return;
  }
  assert.equal(result.nativeInvocations.length, 1);
  const terminal = result.transcript.find((event) => event.type === 'result');
  assert.equal(terminal?.is_error, true, result.stdout);
  assert.equal(terminal?.api_error_status, 400, result.stderr + result.stdout);
});
