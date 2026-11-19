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

function providerOf(model: string | undefined): string | undefined {
  const name = /^multi\/([a-z]+)\//.exec(model ?? '')?.[1];
  return name !== undefined && Object.hasOwn(PROVIDERS, name) ? name : undefined;
}

/** The provider's display name, else undefined. */
export function providerLabel(name: string): string | undefined {
  return Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name].label : undefined;
}

/** These providers execute tools outside Claude Code and need policy translation. */
export function isHarnessModel(model: string | undefined): boolean {
  const provider = providerOf(model);
  return provider !== undefined && PROVIDERS[provider].harness;
}

/** Any Multi model: a harness, or a provider whose tool loop Claude Code runs. */
export function isMultiModel(model: string | undefined): boolean {
  return Boolean(model?.startsWith('multi/'));
}
