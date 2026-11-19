/**
 * The providers as the hooks know them. Hooks run inside Claude Code and cannot read a
 * provider folder's `provider.json`, so this is the one copy of each name, label and kind
 * outside those manifests; `npm run check:providers` fails when the two disagree.
 */
export const PROVIDERS: Readonly<Record<string, { label: string; harness: boolean }>> = {
  openai: { label: 'OpenAI', harness: false },
  cursor: { label: 'Cursor', harness: true },
  antigravity: { label: 'Antigravity', harness: true },
  grok: { label: 'Grok', harness: true },
  zen: { label: 'Zen', harness: false },
};

function providerOf(model: string | undefined) {
  return PROVIDERS[/^multi\/([a-z]+)\//.exec(model ?? '')?.[1] ?? ''];
}

/** The provider's display name, else undefined. */
export function providerLabel(name: string): string | undefined {
  return Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name]?.label : undefined;
}

/**
 * The provider a worker type belongs to. A worker's type is its provider's label
 * (`Cursor`); before 0.5 it was `multi-cursor`, which a resumed transcript still names.
 */
export function workerProvider(type: unknown): string | undefined {
  return Object.keys(PROVIDERS).find(
    (name) => type === PROVIDERS[name]?.label || type === `multi-${name}`,
  );
}

export function isProviderWorker(type: unknown): boolean {
  return workerProvider(type) !== undefined;
}

/** These providers execute tools outside Claude Code and need policy translation. */
export function isHarnessModel(model: string | undefined): boolean {
  return providerOf(model)?.harness ?? false;
}

/** Any Multi model: a harness, or a provider whose tool loop Claude Code runs. */
export function isMultiModel(model: string | undefined): boolean {
  return Boolean(model?.startsWith('multi/'));
}
