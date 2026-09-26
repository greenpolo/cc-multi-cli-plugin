import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Real child processes and the production executable resolver; no provider binaries. */
export async function installFakeExecutables(root: string, upstream: string) {
  const bin = path.join(root, 'fake bin with spaces');
  await mkdir(bin);
  const runner = path.join(bin, 'native-runner.mjs');
  await writeFile(
    runner,
    `
const [name, ...args] = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MULTI_ANTIGRAVITY') || key.startsWith('MULTI_GROK')));
const response = await fetch(${JSON.stringify(`${upstream}/native`)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, args, cwd: process.cwd(), env }) });
if (!response.ok) { process.stderr.write('Unscripted native request'); process.exit(91); }
const reply = await response.json();
process.stdout.write(reply.stdout ?? '');
process.stderr.write(reply.stderr ?? '');
process.exitCode = reply.code ?? 0;
`,
  );
  // Block accidental discovery of real native providers, including Codex refresh.
  for (const name of ['agy', 'grok', 'codex']) {
    await writeFile(
      path.join(bin, name),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(runner)} ${shellQuote(name)} "$@"\n`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(bin, `${name}.cmd`),
      `@"${process.execPath.replaceAll('%', '%%')}" "${runner.replaceAll('%', '%%')}" ${name} %*\r\n`,
    );
  }
  return bin;
}
