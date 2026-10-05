/** These providers execute tools outside Claude Code and need policy translation. */
export function isHarnessModel(model: string | undefined): boolean {
  return Boolean(
    model?.startsWith('multi/cursor/') ||
      model?.startsWith('multi/antigravity/') ||
      model?.startsWith('multi/grok/'),
  );
}

/** Any Multi model: a harness, or a provider whose tool loop Claude Code runs. */
export function isMultiModel(model: string | undefined): boolean {
  return Boolean(model?.startsWith('multi/'));
}
