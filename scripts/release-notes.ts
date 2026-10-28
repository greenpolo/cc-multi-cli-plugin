// Usage: node scripts/release-notes.ts title|notes
// Prints the GitHub release title or notes for package.json's version from
// CHANGELOG.md. The release workflow uses it; GITHUB_REPOSITORY adds links.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractRelease, readPackageVersion, releaseBody, releaseTitle } from './versioning.ts';

const mode = process.argv[2];
if (mode !== 'title' && mode !== 'notes') {
  console.error('Usage: node scripts/release-notes.ts title|notes');
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, '..');
const version = await readPackageVersion(root);
const release = extractRelease(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), version);
if (!release) {
  console.error(`CHANGELOG.md has no ${version} section`);
  process.exit(1);
}
process.stdout.write(
  mode === 'title'
    ? `${releaseTitle(version, release)}\n`
    : releaseBody(version, release, process.env.GITHUB_REPOSITORY),
);
