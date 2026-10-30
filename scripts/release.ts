// Usage: npm run release -- <version> [--summary "<one line>"] [--date YYYY-MM-DD]
// Sets every version field and multi-core pin, and turns CHANGELOG.md's
// "## Unreleased" into "## <version> — <date>" with the summary line under it.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkVersions, release } from './versioning.ts';

function today(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { summary: { type: 'string' }, date: { type: 'string' } },
});
const [version, ...extra] = positionals;
if (!version || extra.length > 0) {
  console.error('Usage: npm run release -- <version> [--summary "<one line>"] [--date YYYY-MM-DD]');
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, '..');
try {
  const files = await release(root, {
    version,
    date: values.date ?? today(),
    summary: values.summary,
  });
  const problems = await checkVersions(root);
  if (problems.length > 0) {
    throw new Error(`Versions still disagree:\n${problems.join('\n')}`);
  }
  console.log(`Released ${version} in:\n${files.map((file) => `  ${file}`).join('\n')}`);
  console.log('Review the diff, run npm run check, and commit. Merging to main tags it.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
