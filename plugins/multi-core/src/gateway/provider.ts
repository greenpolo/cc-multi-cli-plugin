// The one place that reads a model ID's provider prefix. Every routing, review,
// signal and execution decision derives from `providerOf`.

const HARNESS_PROVIDERS = ['cursor', 'antigravity', 'grok'] as const;
export type HarnessProvider = (typeof HARNESS_PROVIDERS)[number];
type ProviderName = HarnessProvider | 'openai' | 'zen';
export type ProviderRoute = ProviderName | 'anthropic';

const PROVIDERS: readonly ProviderName[] = [...HARNESS_PROVIDERS, 'openai', 'zen'];

/** The provider whose `multi/<provider>/` prefix the model carries, if any. */
function providerOf(model: unknown): ProviderName | undefined {
  if (typeof model !== 'string') {
    return undefined;
  }
  return PROVIDERS.find((provider) => model.startsWith(`multi/${provider}/`));
}

export function isHarnessProvider(provider: string | undefined): provider is HarnessProvider {
  return HARNESS_PROVIDERS.some((name) => name === provider);
}

/** The native harness that runs the model's actions itself. */
export function harnessProvider(model: unknown): HarnessProvider | undefined {
  const provider = providerOf(model);
  return isHarnessProvider(provider) ? provider : undefined;
}

/** An external model with an unrecognized prefix still routes to OpenAI; no model is Claude's. */
export function providerRoute(model: string | null | undefined): ProviderRoute {
  return providerOf(model) ?? (model ? 'openai' : 'anthropic');
}

/**
 * Whose reviewer judges the model's actions: a provider's own, never Zen (whose auto mode
 * is unreviewed) or Claude. An unrecognized `multi/` prefix routes to OpenAI, so it is
 * reviewed like any other external model.
 */
export function providerOwnedReview(model: string): boolean {
  return model.startsWith('multi/') && providerOf(model) !== 'zen';
}

/** Claude's context tag is display metadata, never part of a native model ID. */
export function nativeSpelling(model: string | undefined): string | undefined {
  return model?.replace(/\[1m\]$/i, '');
}

/** The upstream a harness bills through, reported on its completion events. */
export function harnessEndpoint(provider: HarnessProvider): string {
  return { cursor: '@cursor/sdk', antigravity: 'agy', grok: 'grok' }[provider];
}

/** What a request for a harness the gateway does not run is told. */
export const harnessUnavailable: Record<HarnessProvider, string> = {
  cursor: 'Cursor SDK is not signed in. Run the launcher with --cursor-login first.',
  antigravity: 'Antigravity is unavailable. Install and connect the multi-antigravity plugin.',
  grok: 'Grok is unavailable. Install Grok Build, run grok login, and relaunch.',
};
