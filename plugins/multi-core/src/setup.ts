import path from 'node:path';
import {
  claudeSettingsFile,
  DEFAULT_COMMAND,
  type InstallationOptions,
  previousExtraCerts,
  setup,
  trustFrontDoor,
} from './install/installation.ts';
import { installCertificate } from './launch/certificate.ts';
import { refreshPickerRows } from './launch/desktop.ts';

function detectedShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  if (platform === 'win32') {
    if (env.PSModulePath || env.ComSpec) {
      return env.PSModulePath ? 'powershell' : 'cmd';
    }
    throw new Error('Cannot detect a Windows shell. Set PSModulePath or ComSpec, or pass --shell.');
  }
  return path.basename(env.SHELL ?? '');
}

const USAGE =
  'Usage: setup.ts [--shell bash|zsh|fish|powershell|cmd] [--claude /absolute/path] [--command name] [--models all|none|<id,id,...>|+<id,id,...>]';

function parseArguments(args: string[]) {
  let shell = detectedShell(process.env, process.platform);
  let claude: string | undefined;
  const options: InstallationOptions = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const value = args[++index];
    if (value === undefined) {
      throw new Error(USAGE);
    }
    if (argument === '--shell') {
      shell = value;
    } else if (argument === '--claude') {
      claude = value;
    } else if (argument === '--command') {
      options.command = value;
    } else if (argument === '--models') {
      options.models = value;
    } else {
      throw new Error(USAGE);
    }
  }
  return { shell, claude, options };
}

function describeModels(models: string | undefined) {
  if (models === undefined) {
    return '/model shows the launcher defaults for connected providers.';
  }
  if (models === '') {
    return '/model hides external rows; Claude models remain available.';
  }
  if (models === 'all') {
    return '/model shows the full connected model catalog.';
  }
  if (models.startsWith('+')) {
    return `/model shows the curated defaults plus: ${models.slice(1).split(',').join(', ')}.`;
  }
  return `/model shows only: ${models.split(',').join(', ')}.`;
}

async function main() {
  const { shell, claude, options } = parseArguments(process.argv.slice(2));
  const state = await setup(shell, claude, options);
  await setUpDesktop();
  const command = state.command ?? DEFAULT_COMMAND;
  if (command === 'claude') {
    console.warn(
      'Warning: the launch command is named claude, so Multi now shadows the plain claude command on PATH. Every launch, including scripts, editors and agents that run claude, starts the Multi gateway first. Nested runs inside a Multi session pass through to plain Claude. Re-run setup with --command claude-multi to restore the default.',
    );
  }
  console.log(
    `Multi startup installed in ${state.shellFile}. Open a new terminal, run multi status, then start ${command}. ${describeModels(state.models)} New Claude desktop app sessions start Multi themselves.`,
  );
}

/**
 * Desktop sessions take Multi from Claude's own user settings: the front door's trust file
 * and the connected providers' `/model` rows (launch/desktop.ts).
 */
async function setUpDesktop() {
  const settingsFile = claudeSettingsFile();
  const previous = await previousExtraCerts(settingsFile);
  const trustFile = await installCertificate(previous);
  await trustFrontDoor({
    settingsFile,
    trustFile,
    ...(previous === undefined ? {} : { previousExtraCerts: previous }),
  });
  await refreshPickerRows();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
