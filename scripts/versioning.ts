// Release versioning shared by scripts/release.ts, scripts/check-versions.ts,
// scripts/release-notes.ts and their unit tests. package.json owns the version;
// every other field and pin listed here follows it.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const identifier = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
// Semantic Versioning 2.0.0, without a leading "v".
const semver = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
);

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = semver.exec(version);
  if (!match) {
    return undefined;
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function isVersion(version: string): boolean {
  return parseVersion(version) !== undefined;
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Math.sign(Number(left) - Number(right));
  }
  if (leftNumeric !== rightNumeric) {
    // Numeric identifiers have lower precedence than alphanumeric ones.
    return leftNumeric ? -1 : 1;
  }
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function comparePrerelease(left: string[], right: string[]): number {
  // A release outranks any prerelease of the same core version.
  if (left.length === 0 || right.length === 0) {
    return Math.sign(right.length - left.length);
  }
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const order = compareIdentifiers(left[index] ?? '', right[index] ?? '');
    if (order !== 0) {
      return order;
    }
  }
  return Math.sign(left.length - right.length);
}

/** Semver precedence: negative, zero or positive. Build metadata is ignored. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    throw new Error(`Not a semantic version: ${a ? right : left}`);
  }
  for (let index = 0; index < 3; index += 1) {
    const order = Math.sign((a.core[index] ?? 0) - (b.core[index] ?? 0));
    if (order !== 0) {
      return order;
    }
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ManifestKind = 'package' | 'lock' | 'marketplace' | 'plugin';

interface Manifest {
  file: string;
  kind: ManifestKind;
}

/** One version field inside a parsed manifest. Pins are written as `~<version>`. */
interface VersionField {
  label: string;
  value: unknown;
  pin: boolean;
  set: (value: string) => void;
}

function field(owner: Record<string, unknown>, label: string, pin = false): VersionField {
  return {
    label,
    value: owner.version,
    pin,
    set: (value) => {
      owner.version = value;
    },
  };
}

function recordAt(owner: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = owner[key];
  return isRecord(value) ? value : {};
}

function marketplaceFields(json: Record<string, unknown>): VersionField[] {
  const plugins = Array.isArray(json.plugins) ? json.plugins.filter(isRecord) : [];
  return [
    field(recordAt(json, 'metadata'), 'metadata.version'),
    ...plugins.map((plugin) => field(plugin, `plugins[${String(plugin.name)}].version`)),
  ];
}

function pluginFields(json: Record<string, unknown>, ownPlugins: Set<string>): VersionField[] {
  const dependencies = Array.isArray(json.dependencies) ? json.dependencies.filter(isRecord) : [];
  // Only pins on this repository's plugins follow its version.
  const pins = dependencies
    .filter((dependency) => ownPlugins.has(String(dependency.name)))
    .map((dependency) =>
      field(dependency, `dependencies[${String(dependency.name)}].version`, true),
    );
  return [field(json, 'version'), ...pins];
}

function versionFields(
  kind: ManifestKind,
  json: Record<string, unknown>,
  ownPlugins: Set<string>,
): VersionField[] {
  if (kind === 'lock') {
    return [
      field(json, 'version'),
      field(recordAt(recordAt(json, 'packages'), ''), 'packages[""].version'),
    ];
  }
  if (kind === 'marketplace') {
    return marketplaceFields(json);
  }
  if (kind === 'plugin') {
    return pluginFields(json, ownPlugins);
  }
  return [field(json, 'version')];
}

/** A version written inside source text rather than a manifest. */
interface TextSlot {
  file: string;
  pattern: RegExp;
}

const textSlots: TextSlot[] = [
  // The client version Multi reports to the Codex app-server.
  {
    file: 'plugins/multi-openai/src/usage.ts',
    pattern: /(name: 'cc_multi_usage', version: ')([^']*)(')/g,
  },
];

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function listManifests(root: string): Promise<Manifest[]> {
  const manifests: Manifest[] = [
    { file: 'package.json', kind: 'package' },
    { file: 'package-lock.json', kind: 'lock' },
    { file: '.claude-plugin/marketplace.json', kind: 'marketplace' },
    { file: '.claude-plugin/plugin.json', kind: 'plugin' },
  ];
  const plugins = await readdir(path.join(root, 'plugins'), { withFileTypes: true });
  for (const entry of plugins.filter((item) => item.isDirectory()).sort(byName)) {
    const file = `plugins/${entry.name}/.claude-plugin/plugin.json`;
    if (await exists(path.join(root, file))) {
      manifests.push({ file, kind: 'plugin' });
    }
  }
  return manifests;
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}

interface LoadedManifest extends Manifest {
  json: Record<string, unknown>;
}

async function loadManifests(root: string): Promise<LoadedManifest[]> {
  const loaded: LoadedManifest[] = [];
  for (const manifest of await listManifests(root)) {
    const json: unknown = JSON.parse(await readFile(path.join(root, manifest.file), 'utf8'));
    if (!isRecord(json)) {
      throw new Error(`${manifest.file} is not a JSON object`);
    }
    loaded.push({ ...manifest, json });
  }
  return loaded;
}

function ownPluginNames(manifests: LoadedManifest[]): Set<string> {
  const plugins = manifests.find((manifest) => manifest.kind === 'marketplace')?.json.plugins;
  if (!Array.isArray(plugins)) {
    return new Set();
  }
  return new Set(plugins.filter(isRecord).map((plugin) => String(plugin.name)));
}

function packageVersion(manifests: LoadedManifest[]): string {
  const value = manifests.find((manifest) => manifest.kind === 'package')?.json.version;
  if (typeof value !== 'string') {
    throw new Error('package.json has no version');
  }
  return value;
}

export async function readPackageVersion(root: string): Promise<string> {
  const json: unknown = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (!isRecord(json) || typeof json.version !== 'string') {
    throw new Error('package.json has no version');
  }
  return json.version;
}

function expected(version: string, pin: boolean): string {
  return pin ? `~${version}` : version;
}

function slotVersions(slot: TextSlot, text: string): string[] {
  const found = [...text.matchAll(slot.pattern)].map((match) => match[2] ?? '');
  if (found.length === 0) {
    throw new Error(`${slot.file}: version pattern ${slot.pattern.source} not found`);
  }
  return found;
}

const versionHeading = /^## v?(\d+\.\d+\.\d+\S*)(?:\s|$)/;

function changelogProblems(changelog: string, version: string): string[] {
  const release = extractRelease(changelog, version);
  if (!release) {
    return [`CHANGELOG.md: no "## ${version} — <date>" section`];
  }
  if (!release.summary) {
    return [`CHANGELOG.md: the ${version} section has no summary line under its heading`];
  }
  return [];
}

/** Every disagreement between package.json's version and the fields that follow it. */
export async function checkVersions(root: string): Promise<string[]> {
  const manifests = await loadManifests(root);
  const version = packageVersion(manifests);
  if (!isVersion(version)) {
    return [`package.json: version ${version} is not a semantic version`];
  }
  const own = ownPluginNames(manifests);
  const problems: string[] = [];
  for (const manifest of manifests) {
    for (const item of versionFields(manifest.kind, manifest.json, own)) {
      const want = expected(version, item.pin);
      if (item.value !== want) {
        problems.push(`${manifest.file}: ${item.label} is ${String(item.value)}, expected ${want}`);
      }
    }
  }
  for (const slot of textSlots) {
    const text = await readFile(path.join(root, slot.file), 'utf8');
    for (const value of slotVersions(slot, text).filter((found) => found !== version)) {
      problems.push(`${slot.file}: version is ${value}, expected ${version}`);
    }
  }
  problems.push(
    ...changelogProblems(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), version),
  );
  return problems;
}

interface SectionBody {
  summary?: string;
  rest: string[];
}

function isBlockStart(line: string): boolean {
  return /^(?:[-*+>#|]|```|\d+[.)]\s)/.test(line.trimStart());
}

/**
 * Split a section body into its summary and the remaining lines. The summary is
 * a plain paragraph (not a list, heading, quote, table or code) that opens the
 * section; its lines are joined with spaces.
 */
function splitSummary(body: string[]): SectionBody {
  let start = 0;
  while (start < body.length && (body[start] ?? '').trim() === '') {
    start += 1;
  }
  const first = body[start];
  if (first === undefined || isBlockStart(first)) {
    return { rest: body.slice(start) };
  }
  let end = start;
  while (end < body.length && (body[end] ?? '').trim() !== '') {
    end += 1;
  }
  const summary = body
    .slice(start, end)
    .map((line) => line.trim())
    .join(' ');
  return { summary, rest: body.slice(end) };
}

function sectionEnd(lines: string[], heading: number): number {
  const next = lines.findIndex((line, index) => index > heading && line.startsWith('## '));
  return next === -1 ? lines.length : next;
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') {
    start += 1;
  }
  while (end > start && (lines[end - 1] ?? '').trim() === '') {
    end -= 1;
  }
  return lines.slice(start, end);
}

function headingVersion(line: string): string | undefined {
  return versionHeading.exec(line)?.[1];
}

interface Release {
  summary?: string;
  notes: string;
  previous?: string;
}

/** The CHANGELOG section for a version: its summary line, the rest, and the release before it. */
export function extractRelease(changelog: string, version: string): Release | undefined {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const heading = lines.findIndex((line) => headingVersion(line) === version);
  if (heading === -1) {
    return undefined;
  }
  const end = sectionEnd(lines, heading);
  const { summary, rest } = splitSummary(lines.slice(heading + 1, end));
  const previous = lines.slice(end).map(headingVersion).find(Boolean);
  return { summary, notes: trimBlank(rest).join('\n'), previous };
}

/** The GitHub release title, `v<version> — <summary>`, or `v<version>` without one. */
export function releaseTitle(version: string, release: Release): string {
  return release.summary ? `v${version} — ${release.summary}` : `v${version}`;
}

/** Release notes: the section without its summary, plus links when the repository is known. */
export function releaseBody(version: string, release: Release, repository?: string): string {
  if (!repository) {
    return `${release.notes}\n`;
  }
  const base = `https://github.com/${repository}`;
  const links = [`[full changelog](${base}/blob/v${version}/CHANGELOG.md)`];
  if (release.previous) {
    links.push(
      `[changes since v${release.previous}](${base}/compare/v${release.previous}...v${version})`,
    );
  }
  return `${release.notes}\n\nSee the ${links.join(' and ')}.\n`;
}

interface ReleaseOptions {
  version: string;
  date: string;
  summary?: string;
}

function releaseSectionBody(body: string[], summary: string | undefined): string[] {
  const split = splitSummary(body);
  const line = summary?.trim() || split.summary;
  if (!line) {
    throw new Error(
      'The release needs a summary: pass --summary "<text>" or open ## Unreleased with a one-line paragraph',
    );
  }
  if (/[\r\n]/.test(line)) {
    throw new Error('The summary must be one line');
  }
  return [line, '', ...trimBlank(split.rest)];
}

/**
 * Rename `## Unreleased` to `## <version> — <date>` with a summary paragraph under
 * it. No new Unreleased section is left, matching the 0.2.0 and 0.3.0 releases;
 * the next user-facing change adds one.
 */
export function releaseChangelog(changelog: string, options: ReleaseOptions): string {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const heading = lines.findIndex((line) => line.trimEnd() === '## Unreleased');
  if (heading === -1) {
    throw new Error('CHANGELOG.md has no "## Unreleased" section');
  }
  if (lines.some((line) => headingVersion(line) === options.version)) {
    throw new Error(`CHANGELOG.md already has a ${options.version} section`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) {
    throw new Error(`Release date must be YYYY-MM-DD, not ${options.date}`);
  }
  const end = sectionEnd(lines, heading);
  const body = lines.slice(heading + 1, end);
  if (trimBlank(body).length === 0) {
    throw new Error('The "## Unreleased" section is empty');
  }
  const section = [
    `## ${options.version} — ${options.date}`,
    '',
    ...releaseSectionBody(body, options.summary),
  ];
  const after = end < lines.length ? ['', ...lines.slice(end)] : [''];
  return [...lines.slice(0, heading), ...section, ...after].join('\n');
}

function serialize(json: Record<string, unknown>): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** Check a requested version against the current one, throwing with the reason. */
export function assertNextVersion(current: string, next: string): void {
  if (!isVersion(next)) {
    throw new Error(`${next} is not a semantic version (expected x.y.z, without a leading v)`);
  }
  if (compareVersions(next, current) <= 0) {
    throw new Error(`${next} is not greater than the current version ${current}`);
  }
}

/**
 * Set every version field and pin to `options.version` and release the CHANGELOG.
 * Everything is validated before any file is written. Returns the files changed.
 */
export async function release(root: string, options: ReleaseOptions): Promise<string[]> {
  const manifests = await loadManifests(root);
  assertNextVersion(packageVersion(manifests), options.version);
  const writes = new Map<string, string>();
  const changelogFile = path.join(root, 'CHANGELOG.md');
  writes.set('CHANGELOG.md', releaseChangelog(await readFile(changelogFile, 'utf8'), options));
  const own = ownPluginNames(manifests);
  for (const manifest of manifests) {
    for (const item of versionFields(manifest.kind, manifest.json, own)) {
      item.set(expected(options.version, item.pin));
    }
    writes.set(manifest.file, serialize(manifest.json));
  }
  for (const slot of textSlots) {
    const text = await readFile(path.join(root, slot.file), 'utf8');
    slotVersions(slot, text);
    writes.set(slot.file, text.replace(slot.pattern, `$1${options.version}$3`));
  }
  for (const [file, content] of writes) {
    await writeFile(path.join(root, file), content);
  }
  return [...writes.keys()];
}
