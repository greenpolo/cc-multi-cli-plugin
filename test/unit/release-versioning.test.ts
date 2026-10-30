import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertNextVersion,
  checkVersions,
  compareVersions,
  extractRelease,
  release,
  releaseBody,
  releaseChangelog,
  releaseTitle,
} from '../../scripts/versioning.ts';
import { removeTemporary } from '../temporary.ts';

const changelog = `# Changelog

Intro prose.

## Unreleased

- **Fix one.** Body text
  wrapped over two lines.
- **Fix two.**

## 0.3.0 — 2026-09-28

Native tool rows and plan mode

- **Old fix.**

## 0.2.1 — 2026-09-22

- Older.
`;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function fixture(t: test.TestContext, version = '0.3.0'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-versioning-'));
  t.after(() => removeTemporary(root));
  const files: Record<string, string> = {
    'package.json': json({ name: 'multi', version, private: true }),
    'package-lock.json': json({
      name: 'multi',
      version,
      lockfileVersion: 3,
      packages: { '': { name: 'multi', version }, 'node_modules/yaml': { version: '0.3.0' } },
    }),
    '.claude-plugin/marketplace.json': json({
      name: 'multi',
      metadata: { version },
      plugins: [
        { name: 'multi-core', source: './', version },
        { name: 'multi-zen', source: './plugins/multi-zen', version },
      ],
    }),
    '.claude-plugin/plugin.json': json({ version, name: 'multi-core' }),
    'plugins/multi-zen/.claude-plugin/plugin.json': json({
      version,
      name: 'multi-zen',
      dependencies: [
        { name: 'multi-core', version: `~${version}` },
        { name: 'someone-else', version: '~0.3.0' },
      ],
    }),
    'plugins/multi-openai/src/usage.ts': `const info = { name: 'cc_multi_usage', version: '${version}' };\n`,
    'CHANGELOG.md': changelog,
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

async function readJson(root: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, file), 'utf8'));
}

test('orders versions by semver precedence and ignores build metadata', () => {
  assert.ok(compareVersions('0.4.0', '0.3.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-beta') < 0);
  assert.ok(compareVersions('1.0.0-2', '1.0.0-10') < 0);
  assert.ok(compareVersions('1.0.0-9', '1.0.0-rc') < 0);
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0);
});

test('refuses a version that is not semver or not greater than the current one', () => {
  for (const bad of ['v0.4.0', '0.4', '01.0.0', '0.4.0-', '0.4.0 ', 'latest']) {
    assert.throws(() => assertNextVersion('0.3.0', bad), /not a semantic version/, bad);
  }
  assert.throws(() => assertNextVersion('0.3.0', '0.3.0'), /not greater than the current version/);
  assert.throws(() => assertNextVersion('0.3.0', '0.2.9'), /not greater/);
  assert.throws(() => assertNextVersion('0.3.0', '0.3.0+rebuild'), /not greater/);
  assert.throws(() => assertNextVersion('0.4.0', '0.4.0-rc.1'), /not greater/);
  assertNextVersion('0.3.0', '0.4.0');
  assertNextVersion('0.4.0-rc.1', '0.4.0');
});

test('renames Unreleased to the release heading with the summary and leaves no new Unreleased', () => {
  const released = releaseChangelog(changelog, {
    version: '0.4.0',
    date: '2026-10-28',
    summary: 'Gateway arbiter and resilient startup',
  });
  assert.equal(
    released,
    changelog.replace(
      '## Unreleased\n\n',
      '## 0.4.0 — 2026-10-28\n\nGateway arbiter and resilient startup\n\n',
    ),
  );
  assert.doesNotMatch(released, /## Unreleased/);
});

test('uses a summary paragraph already under Unreleased, or replaces it when one is passed', () => {
  const drafted = changelog.replace(
    '## Unreleased\n',
    '## Unreleased\n\nDrafted summary\nover two lines\n',
  );
  const kept = releaseChangelog(drafted, { version: '0.4.0', date: '2026-10-28' });
  assert.match(kept, /## 0\.4\.0 — 2026-10-28\n\nDrafted summary over two lines\n\n- \*\*Fix one/);
  const replaced = releaseChangelog(drafted, {
    version: '0.4.0',
    date: '2026-10-28',
    summary: 'Passed summary',
  });
  assert.match(replaced, /## 0\.4\.0 — 2026-10-28\n\nPassed summary\n\n- \*\*Fix one/);
  assert.doesNotMatch(replaced, /Drafted/);
});

test('refuses a CHANGELOG without a usable Unreleased section', () => {
  const options = { version: '0.4.0', date: '2026-10-28', summary: 'Summary' };
  assert.throws(
    () => releaseChangelog(changelog.replace('## Unreleased', '## Next'), options),
    /no "## Unreleased" section/,
  );
  assert.throws(
    () => releaseChangelog('# Changelog\n\n## Unreleased\n\n## 0.3.0 — 2026-09-28\n', options),
    /section is empty/,
  );
  assert.throws(
    () => releaseChangelog(changelog, { version: '0.4.0', date: '2026-10-28' }),
    /needs a summary/,
  );
  assert.throws(
    () => releaseChangelog(changelog, { ...options, version: '0.3.0' }),
    /already has a 0\.3\.0 section/,
  );
  assert.throws(
    () => releaseChangelog(changelog, { ...options, date: '28/10/2026' }),
    /YYYY-MM-DD/,
  );
  assert.throws(() => releaseChangelog(changelog, { ...options, summary: 'a\nb' }), /one line/);
});

test('extracts a release section, its summary title and notes with links', () => {
  const found = extractRelease(changelog, '0.3.0');
  assert.deepEqual(found, {
    summary: 'Native tool rows and plan mode',
    notes: '- **Old fix.**',
    previous: '0.2.1',
  });
  assert.ok(found);
  assert.equal(releaseTitle('0.3.0', found), 'v0.3.0 — Native tool rows and plan mode');
  assert.equal(releaseBody('0.3.0', found), '- **Old fix.**\n');
  assert.equal(
    releaseBody('0.3.0', found, 'greenpolo/cc-multi-cli-plugin'),
    '- **Old fix.**\n\nSee the [full changelog](https://github.com/greenpolo/cc-multi-cli-plugin/blob/v0.3.0/CHANGELOG.md)' +
      ' and [changes since v0.2.1](https://github.com/greenpolo/cc-multi-cli-plugin/compare/v0.2.1...v0.3.0).\n',
  );

  const last = extractRelease(changelog, '0.2.1');
  assert.deepEqual(last, { summary: undefined, notes: '- Older.', previous: undefined });
  assert.ok(last);
  assert.equal(releaseTitle('0.2.1', last), 'v0.2.1');
  assert.equal(extractRelease(changelog, '0.3'), undefined);
  assert.equal(extractRelease(changelog, '9.9.9'), undefined);
});

test('release sets every version field and own pin, then passes the consistency check', async (t) => {
  const root = await fixture(t);
  const files = await release(root, { version: '0.4.0', date: '2026-10-28', summary: 'Next' });
  assert.equal(files.length, 7);
  assert.deepEqual(await checkVersions(root), []);
  assert.deepEqual(await readJson(root, 'plugins/multi-zen/.claude-plugin/plugin.json'), {
    version: '0.4.0',
    name: 'multi-zen',
    dependencies: [
      { name: 'multi-core', version: '~0.4.0' },
      { name: 'someone-else', version: '~0.3.0' },
    ],
  });
  assert.deepEqual(await readJson(root, 'package-lock.json'), {
    name: 'multi',
    version: '0.4.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'multi', version: '0.4.0' },
      'node_modules/yaml': { version: '0.3.0' },
    },
  });
  assert.equal(
    await readFile(path.join(root, 'plugins/multi-openai/src/usage.ts'), 'utf8'),
    "const info = { name: 'cc_multi_usage', version: '0.4.0' };\n",
  );
  assert.match(
    await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'),
    /## 0\.4\.0 — 2026-10-28\n\nNext\n/,
  );
});

test('release writes nothing when it refuses', async (t) => {
  const root = await fixture(t);
  const before = await readFile(path.join(root, 'package.json'), 'utf8');
  await assert.rejects(
    release(root, { version: '0.2.0', date: '2026-10-28', summary: 'x' }),
    /not greater/,
  );
  await assert.rejects(release(root, { version: '0.4.0', date: '2026-10-28' }), /needs a summary/);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), before);
  assert.equal(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), changelog);
});

test('the consistency check names each field or pin that disagrees with package.json', async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await checkVersions(root), []);
  const zen = 'plugins/multi-zen/.claude-plugin/plugin.json';
  const manifest = await readFile(path.join(root, zen), 'utf8');
  await writeFile(path.join(root, zen), manifest.replace('"~0.3.0"', '"~0.2.0"'));
  const market = '.claude-plugin/marketplace.json';
  const marketplace = await readFile(path.join(root, market), 'utf8');
  await writeFile(
    path.join(root, market),
    marketplace.replace('"version": "0.3.0"\n  }', '"version": "0.2.9"\n  }'),
  );
  await writeFile(path.join(root, 'CHANGELOG.md'), changelog.replace('## 0.3.0', '## 0.3.1'));
  assert.deepEqual(await checkVersions(root), [
    '.claude-plugin/marketplace.json: metadata.version is 0.2.9, expected 0.3.0',
    'plugins/multi-zen/.claude-plugin/plugin.json: dependencies[multi-core].version is ~0.2.0, expected ~0.3.0',
    'CHANGELOG.md: no "## 0.3.0 — <date>" section',
  ]);
});

test('the consistency check requires a summary line for the current release', async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, 'CHANGELOG.md'),
    changelog.replace('Native tool rows and plan mode\n\n', ''),
  );
  assert.deepEqual(await checkVersions(root), [
    'CHANGELOG.md: the 0.3.0 section has no summary line under its heading',
  ]);
});
