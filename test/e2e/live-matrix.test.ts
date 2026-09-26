import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { detectLiveProvider, type LiveProvider, prepareLive } from './live.ts';

const providers: LiveProvider[] = ['anthropic', 'openai', 'zen', 'cursor', 'antigravity', 'grok'];

// Always a dry run, including when MULTI_E2E_LIVE=1. Do not call runScenario here.
for (const provider of providers) {
  test(`live matrix (no inference): ${provider}`, async (t) => {
    const credential = await detectLiveProvider(provider);
    t.diagnostic(
      `${provider}: ${credential.available ? 'WOULD RUN' : 'SKIP'} — ${credential.reason}`,
    );
    if (!credential.available) {
      t.skip(credential.reason);
      return;
    }
    const plan = await prepareLive(t, {
      name: `live-matrix-${provider}`,
      enabledProviders: [provider],
      live: {
        providers: [provider],
        purpose: 'main-session',
        prompt: 'Reply ok. No tools.',
        maxTurns: 1,
        maxBudgetUsd: 0.05,
      },
    });
    assert.ok(plan, 'A detected provider must produce an isolated live plan');
    assert.equal(plan.env.HOME, undefined, 'Never give Claude the native user HOME');
    assert.equal(plan.env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(plan.env.CODEX_HOME, undefined);
    assert.equal(plan.scenario.live?.maxTurns, 1);
    for (const contents of Object.values(plan.fixtures)) {
      assert.ok(!contents.includes('refresh_token'), 'Never copy renewable credentials');
    }
    if (provider === 'grok') {
      assert.equal(plan.env.MULTI_GROK, '1');
      assert.ok(plan.fixtures['.grok/auth.json']);
      assert.equal(plan.env.PATH, process.env.PATH);
    }
    if (provider === 'cursor') {
      assert.ok(plan.env.CURSOR_API_KEY);
      assert.equal(plan.env.MULTI_GROK, '0');
      assert.equal(plan.env.MULTI_ANTIGRAVITY, '0');
    }
  });
}

for (const signedIn of [false, true]) {
  test(`native live credential isolation: ${signedIn ? 'present' : 'absent'} logins (no CLI calls)`, async (t) => {
    const root = await mkdtemp(
      path.join(process.env.MULTI_E2E_SCRATCH ?? os.tmpdir(), 'live-matrix-'),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    await Promise.all(
      ['bin', '.grok', '.cursor/sdk'].map((directory) =>
        mkdir(path.join(root, directory), { recursive: true }),
      ),
    );
    // If detection ever runs the CLI instead of checking presence, this fails.
    await writeFile(
      path.join(root, 'bin', process.platform === 'win32' ? 'grok.cmd' : 'grok'),
      process.platform === 'win32' ? '@exit /b 99\r\n' : '#!/bin/sh\nexit 99\n',
      { mode: 0o700 },
    );
    const source = JSON.stringify({
      account: {
        key: 'fixture-access',
        refresh_token: 'fixture-refresh',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    if (signedIn) {
      await writeFile(path.join(root, '.grok/auth.json'), source);
      await writeFile(
        path.join(root, '.cursor/sdk/auth.json'),
        JSON.stringify({ apiKey: 'fixture-cursor' }),
      );
    }
    const script = `
      import assert from 'node:assert/strict';
      import { detectNativeLiveProvider } from ${JSON.stringify(new URL('./live-native.ts', import.meta.url).href)};
      const grok = await detectNativeLiveProvider('grok');
      const cursor = await detectNativeLiveProvider('cursor');
      assert.equal(grok.available, ${signedIn});
      assert.equal(cursor.available, ${signedIn});
      if (grok.available) {
        const copied = JSON.parse(grok.fixtures['.grok/auth.json']);
        assert.equal(copied.account.key, 'fixture-access');
        assert.equal(copied.account.refresh_token, undefined);
        assert.equal(cursor.env.CURSOR_API_KEY, 'fixture-cursor');
      }
      assert.equal((await detectNativeLiveProvider('antigravity')).available, false);
    `;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        HOME: root,
        USERPROFILE: root,
        PATH: path.join(root, 'bin'),
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        PATHEXT: '.EXE;.CMD',
      },
      timeout: 10000,
    });
    if (signedIn) {
      assert.equal(
        await readFile(path.join(root, '.grok/auth.json'), 'utf8'),
        source,
        'Original native credential must not be rotated or changed',
      );
    }
  });
}
