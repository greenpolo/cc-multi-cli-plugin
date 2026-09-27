import { pathToFileURL } from 'node:url';
import { antigravityToolDecision } from './permissions.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1048576) {
        throw new Error('Native permission input exceeds limit');
      }
    }
    const decision = antigravityToolDecision(
      JSON.parse(input),
      process.env.MULTI_ANTIGRAVITY_DENY,
      process.env.MULTI_ANTIGRAVITY_ALLOW,
    );
    // agy treats even an empty JSON decision as a denial. No stdout is neutral.
    if (decision) {
      console.log(JSON.stringify(decision));
    }
  } catch {
    console.log(
      JSON.stringify({ decision: 'deny', reason: 'Antigravity permission hook failed.' }),
    );
  }
}
