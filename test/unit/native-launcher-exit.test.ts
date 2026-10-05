import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { removeTemporary } from '../temporary.ts';

test('a Claude that exits before the mod acknowledges ends the launch with its own exit code', {
  skip: process.platform === 'win32',
}, async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'launcher-early-exit-'));
  t.after(() => removeTemporary(cwd));
  await mkdir(path.join(cwd, 'bin'));
  await writeFile(
    path.join(cwd, 'bin', 'claude'),
    `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args.includes('plugin')&&args.includes('list')){console.log('not json');process.exit(1)}
if(args[0]==='--version'){console.log('2.1.287');process.exit(0)}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
process.exit(7);
`,
    { mode: 0o755 },
  );
  const launcher = fileURLToPath(
    new URL('../../plugins/multi-core/src/launcher.ts', import.meta.url),
  );
  const started = Date.now();
  const result = await promisify(execFile)(process.execPath, [launcher, '--', '--version'], {
    cwd,
    timeout: 20000,
    env: {
      PATH: path.join(cwd, 'bin') + path.delimiter + process.env.PATH,
      HOME: cwd,
      CLAUDE_CONFIG_DIR: path.join(cwd, 'claude'),
      CODEX_HOME: cwd,
      MULTI_ENABLED_PROVIDERS: '',
      ANTHROPIC_BASE_URL: 'https://corp.example/anthropic',
    },
  }).then(
    () => ({ code: 0, stderr: '' }),
    (error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
  );
  assert.equal(result.code, 7);
  assert(Date.now() - started < 15000, 'did not wait for the acknowledgement timeout');
  assert(!result.stderr.includes('did not acknowledge'));
  // A failing plugin listing does not abort the launch; a caller base URL is accepted.
  assert.match(result.stderr, /could not list Claude plugins/);
});
