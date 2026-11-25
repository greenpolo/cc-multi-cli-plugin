// The front door's installed certificate (gateway/front-door.ts): one per installation, made
// by setup and trusted by Claude Code through the `NODE_EXTRA_CA_CERTS` its settings name.
// A session started by the Claude desktop app reads that variable once, at its own start,
// before any mod runs, so a gateway the mod starts can be its proxy only with a certificate
// Claude already trusts. A launch that finds none makes a certificate of its own.

import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FRONT_DOOR_HOST } from '../gateway/front-door.ts';
import { type ServerCertificate, selfSignedCertificate } from '../gateway/self-signed.ts';
import { installationDirectory } from '../install/installation.ts';

/** How long an installed certificate lasts; setup makes a new one when it nears its end. */
const VALID_DAYS = 397;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1000;
/** The least time a session may still use it: a session that outlives it loses its proxy. */
const SERVE_BEFORE_MS = 24 * 60 * 60 * 1000;

export function certificateFiles(directory = installationDirectory()) {
  const folder = path.join(directory, 'front-door');
  return {
    folder,
    cert: path.join(folder, 'cert.pem'),
    key: path.join(folder, 'key.pem'),
    trust: path.join(folder, 'trust.pem'),
  };
}

async function optional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function remainingMs(cert: string): number {
  try {
    return new X509Certificate(cert).validToDate.getTime() - Date.now();
  } catch {
    return 0;
  }
}

/** The installed certificate while it has at least a day left, else undefined. */
export async function installedCertificate(
  directory = installationDirectory(),
): Promise<ServerCertificate | undefined> {
  const files = certificateFiles(directory);
  const [cert, key] = await Promise.all([optional(files.cert), optional(files.key)]);
  if (!cert || !key || remainingMs(cert) < SERVE_BEFORE_MS) {
    return undefined;
  }
  return { cert, key };
}

/** Whether a session whose `NODE_EXTRA_CA_CERTS` names `trustFile` trusts `certificate`. */
export async function trusts(
  trustFile: string | undefined,
  certificate: ServerCertificate,
): Promise<boolean> {
  const trusted = trustFile ? await optional(trustFile) : undefined;
  return trusted?.includes(certificate.cert.trim()) ?? false;
}

/**
 * Keep the installed certificate, or make one when there is none or it nears its end, and
 * write the trust file: the user's own extra certificates (`extraCerts`, the file they had
 * named), then this one. Returns the trust file for Claude's settings to name.
 */
export async function installCertificate(
  extraCerts: string | undefined,
  directory = installationDirectory(),
): Promise<string> {
  const files = certificateFiles(directory);
  await mkdir(files.folder, { recursive: true, mode: 0o700 });
  let cert = await optional(files.cert);
  if (!cert || !(await optional(files.key)) || remainingMs(cert) < RENEW_BEFORE_MS) {
    const made = selfSignedCertificate(FRONT_DOOR_HOST, new Date(), VALID_DAYS);
    await writeFile(files.key, made.key, { mode: 0o600 });
    await writeFile(files.cert, made.cert, { mode: 0o600 });
    cert = made.cert;
  }
  const extra = extraCerts ? (await optional(extraCerts))?.trimEnd() : undefined;
  if (extraCerts && extra === undefined) {
    throw new Error(`Cannot read the certificates NODE_EXTRA_CA_CERTS names (${extraCerts}).`);
  }
  await writeFile(`${files.trust}.tmp`, extra ? `${extra}\n${cert}` : cert, { mode: 0o600 });
  await rename(`${files.trust}.tmp`, files.trust);
  return files.trust;
}
