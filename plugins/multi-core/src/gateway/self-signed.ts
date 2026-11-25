// A self-signed TLS certificate for one host, made with Node's own crypto.
//
// The front door (front-door.ts) answers Claude Code's TLS connection to the Anthropic
// API with this certificate, and the launched Claude Code trusts exactly it through
// NODE_EXTRA_CA_CERTS. It is an end-entity certificate, not a CA: it cannot vouch for any
// other host, and it lives only as long as the session (its files are in the session's
// settings directory, removed at exit).
//
// Node has no X.509 writer, so the certificate is encoded here in DER. It carries the
// fields a TLS client checks: the host as subject and subjectAltName, a validity window,
// and serverAuth. It omits keyUsage and key identifiers on purpose: OpenSSL treats a
// self-signed certificate whose keyUsage lacks keyCertSign as untrusted for itself.

import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const OID = {
  commonName: '2.5.4.3',
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
} as const;

function length(size: number): Buffer {
  if (size < 0x80) {
    return Buffer.from([size]);
  }
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...content: Buffer[]) => tlv(0x30, ...content);

function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc % 128];
    for (let value = Math.floor(arc / 128); value > 0; value = Math.floor(value / 128)) {
      groups.unshift((value % 128) | 0x80);
    }
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** A positive 16-byte INTEGER: the top bit clear (positive) and the top byte not 0 (minimal). */
function serialNumber(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] & 0x7f) | 0x40;
  return tlv(0x02, bytes);
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString();
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function name(host: string): Buffer {
  return sequence(tlv(0x31, sequence(oid(OID.commonName), tlv(0x0c, Buffer.from(host, 'utf8')))));
}

function extension(id: string, value: Buffer): Buffer {
  return sequence(oid(id), tlv(0x04, value));
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

export interface ServerCertificate {
  cert: string;
  key: string;
}

/** A P-256 key and a self-signed certificate naming `host`, valid from an hour ago. */
export function selfSignedCertificate(host: string, now = new Date()): ServerCertificate {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const hour = 60 * 60 * 1000;
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    serialNumber(),
    algorithm,
    name(host),
    sequence(
      utcTime(new Date(now.getTime() - hour)),
      utcTime(new Date(now.getTime() + 30 * 24 * hour)),
    ),
    name(host),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(
      0xa3,
      sequence(
        extension(OID.subjectAltName, sequence(tlv(0x82, Buffer.from(host, 'ascii')))),
        extension(OID.extKeyUsage, sequence(oid(OID.serverAuth))),
      ),
    ),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = sequence(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature));
  return {
    cert: pem('CERTIFICATE', certificate),
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
