// Whether the launched Claude Code reaches the gateway as its HTTPS proxy (the front door,
// gateway/front-door.ts) or through ANTHROPIC_BASE_URL, and the files the front door needs.
//
// The front door keeps Claude Code first-party, which is what Remote Control requires, so it
// is used whenever Claude could use Remote Control at all: a claude.ai login, no API key, no
// other provider or base URL of the user's own. Everything else keeps ANTHROPIC_BASE_URL.

import { readFile, writeFile } from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { bypassesProxy, FRONT_DOOR_HOST, openFrontDoor } from '../gateway/front-door.ts';
import { selfSignedCertificate } from '../gateway/self-signed.ts';

/** What the launched Claude Code needs to use the front door. */
export interface FrontDoorFiles {
  /** NODE_EXTRA_CA_CERTS: the user's own extra certificates, then the front door's. */
  trustFile: string;
  /** CLAUDE_ENV_FILE: gives the commands Claude runs the user's own proxy settings back. */
  commandEnvFile: string;
}

/** The variables the front door sets for Claude Code and takes back for its commands. */
const FRONT_DOOR_VARIABLES = [
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_ENV_FILE',
] as const;

const enabled = (value: string | undefined) =>
  value !== undefined && !['', '0', 'false'].includes(value.trim().toLowerCase());

/** Why the session keeps ANTHROPIC_BASE_URL, or undefined when the front door can serve it. */
function baseUrlReason(env: NodeJS.ProcessEnv, anthropic: boolean): string | undefined {
  if (env.MULTI_GATEWAY_TRANSPORT === 'base-url') {
    return 'MULTI_GATEWAY_TRANSPORT=base-url';
  }
  if (!anthropic || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    return 'no claude.ai login';
  }
  if (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_UNIX_SOCKET) {
    return 'a base URL of your own';
  }
  if (Object.keys(env).some((name) => name.startsWith('CLAUDE_CODE_USE_') && enabled(env[name]))) {
    return 'another provider';
  }
  if (bypassesProxy(FRONT_DOOR_HOST, env.NO_PROXY ?? env.no_proxy)) {
    return `NO_PROXY exempts ${FRONT_DOOR_HOST}`;
  }
  return undefined;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * A script Claude Code runs ahead of each Bash command: the user's own values of the
 * variables the front door set, so a command's traffic does not meet the gateway, then the
 * user's own CLAUDE_ENV_FILE, if any.
 */
function commandEnvScript(origin: NodeJS.ProcessEnv): string {
  const lines = FRONT_DOOR_VARIABLES.map((name) => {
    const value = origin[name];
    return value === undefined ? `unset ${name}` : `export ${name}=${quote(value)}`;
  });
  if (origin.CLAUDE_ENV_FILE) {
    lines.push(`[ -f ${quote(origin.CLAUDE_ENV_FILE)} ] && . ${quote(origin.CLAUDE_ENV_FILE)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Open the front door on the gateway's server and write its files, or explain on stderr why
 * the session keeps ANTHROPIC_BASE_URL. Only a failure is reported: the plain reasons
 * (no Claude login, a provider of the user's own) are expected and say nothing.
 */
export async function prepareFrontDoor(
  server: http.Server,
  settingsDir: string,
  origin: NodeJS.ProcessEnv,
  anthropic: boolean,
): Promise<FrontDoorFiles | undefined> {
  if (baseUrlReason(origin, anthropic) !== undefined) {
    return undefined;
  }
  try {
    const certificate = selfSignedCertificate(FRONT_DOOR_HOST);
    const extra = origin.NODE_EXTRA_CA_CERTS
      ? (await readFile(origin.NODE_EXTRA_CA_CERTS, 'utf8')).trimEnd()
      : '';
    const trustFile = path.join(settingsDir, 'front-door-trust.pem');
    const commandEnvFile = path.join(settingsDir, 'command-env.sh');
    await writeFile(trustFile, extra ? `${extra}\n${certificate.cert}` : certificate.cert, {
      mode: 0o600,
    });
    await writeFile(commandEnvFile, commandEnvScript(origin), { mode: 0o600 });
    openFrontDoor(server, certificate, process.env);
    return { trustFile, commandEnvFile };
  } catch (error) {
    process.stderr.write(
      `Multi: Remote Control stays off for this session; the gateway could not be set up as its proxy (${error instanceof Error ? error.message : String(error)}).\n`,
    );
    return undefined;
  }
}
