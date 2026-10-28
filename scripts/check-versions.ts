// Fails when a version field, a multi-core pin or CHANGELOG.md disagrees with
// package.json's version. Part of npm run check.
import path from 'node:path';
import { checkVersions } from './versioning.ts';

const problems = await checkVersions(path.resolve(import.meta.dirname, '..'));
if (problems.length > 0) {
  console.error(`Version check failed:\n${problems.map((line) => `  ${line}`).join('\n')}`);
  console.error('Run npm run release -- <version> instead of editing versions by hand.');
  process.exitCode = 1;
}
