// Runs the real Claude Code without the enclosing Multi session's gateway
// environment. The launcher puts a `claude` shim that calls this first on the
// session's PATH, so a `claude` started by Claude's own tools is an ordinary run.
import { run, withoutGateway } from './process.ts';

const [claude, ...args] = process.argv.slice(2);
if (!claude) {
  console.error('Multi: nested claude shim needs the real executable path.');
  process.exitCode = 1;
} else {
  void run(claude, args, { env: withoutGateway(process.env) }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`Multi: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
