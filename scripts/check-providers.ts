// Fails when the hooks' provider table disagrees with the provider manifests. Hooks run
// inside Claude Code and cannot read `plugins/multi-<name>/provider.json` themselves.
import { PROVIDERS } from '../plugins/multi-core/hooks/provider.ts';
import { providerManifests } from '../plugins/multi-core/src/gateway/provider.ts';

const expected = Object.fromEntries(
  providerManifests().map(({ name, label, kind }) => [
    name,
    { label, harness: kind === 'harness' },
  ]),
);
if (JSON.stringify(expected) !== JSON.stringify(PROVIDERS)) {
  console.error(
    `plugins/multi-core/hooks/provider.ts must list the provider manifests, in order:\n${JSON.stringify(expected, null, 2)}`,
  );
  process.exit(1);
}
