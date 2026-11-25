// ---------------------------------------------------------------------------
// The gateway's front door: an HTTPS proxy on the gateway's own port.
//
// Claude Code turns Remote Control (and other claude.ai features) off whenever
// ANTHROPIC_BASE_URL names anything but api.anthropic.com. So a session signed in to
// Claude reaches the gateway as its HTTPS proxy instead, with the base URL left alone:
//
// - CONNECT to the Anthropic API host is answered here. The TLS connection ends at the
//   gateway with a self-signed certificate (self-signed.ts) that only the launched Claude
//   Code trusts, and the requests inside go to the gateway's ordinary request handler.
// - CONNECT to any other host is a byte tunnel, through the user's own HTTPS proxy when
//   one is set for that host. The gateway reads none of it.
//
// A decrypted request that carries the session's gateway token is Claude Code's own and
// is handled as it would be through ANTHROPIC_BASE_URL. Any other request is passed to
// Anthropic untouched (see server.ts), so a program that merely inherited the proxy
// settings still reaches Anthropic.
// ---------------------------------------------------------------------------

import type http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import type { ServerCertificate } from './self-signed.ts';

/** The host whose traffic the front door opens: Claude Code's first-party API host. */
export const FRONT_DOOR_HOST = 'api.anthropic.com';

const frontDoorSockets = new WeakSet<object>();

/** A request that arrived through the front door's TLS, not on the gateway's loopback port. */
export function viaFrontDoor(req: http.IncomingMessage): boolean {
  return frontDoorSockets.has(req.socket);
}

interface ProxyTarget {
  host: string;
  port: number;
}

function connectTarget(authority: string | undefined): ProxyTarget | undefined {
  if (!authority) {
    return undefined;
  }
  try {
    const url = new URL(`http://${authority}`);
    const port = Number(url.port || 443);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host && Number.isInteger(port) && port > 0 ? { host, port } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether NO_PROXY (curl's rules: `*`, exact names, and domain suffixes) exempts `host`. */
export function bypassesProxy(host: string, noProxy: string | undefined): boolean {
  const name = host.toLowerCase();
  return (noProxy ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') {
        return true;
      }
      const domain = entry.replace(/^\*?\./, '');
      return name === domain || name.endsWith(`.${domain}`);
    });
}

/** The user's own proxy for an HTTPS host, if they set one and NO_PROXY does not exempt it. */
function upstreamProxy(host: string, env: NodeJS.ProcessEnv): URL | undefined {
  const value = env.HTTPS_PROXY || env.https_proxy;
  if (!value || bypassesProxy(host, env.NO_PROXY ?? env.no_proxy)) {
    return undefined;
  }
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Read a CONNECT reply's head; resolve with any bytes that followed it. */
function awaitConnectReply(socket: Duplex): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) {
        if (received.length > 16384) {
          finish(new Error('upstream proxy sent an oversized reply'));
        }
        return;
      }
      const status = Number(received.subarray(0, end).toString('latin1').split(' ')[1]);
      if (status >= 200 && status < 300) {
        finish(undefined, received.subarray(end + 4));
      } else {
        finish(new Error(`upstream proxy refused CONNECT (${status || 'no status'})`));
      }
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error('upstream proxy closed the connection'));
    const finish = (error?: Error, rest?: Buffer) => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) {
        reject(error);
      } else {
        resolve(rest ?? Buffer.alloc(0));
      }
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/** A socket to `target`, directly or through the user's proxy, ready for bytes. */
async function openTunnel(target: ProxyTarget, env: NodeJS.ProcessEnv): Promise<Duplex> {
  const proxy = upstreamProxy(target.host, env);
  if (!proxy) {
    const socket = net.connect(target.port, target.host);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return socket;
  }
  const proxyPort = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
  const socket: Duplex =
    proxy.protocol === 'https:'
      ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
      : net.connect(proxyPort, proxy.hostname);
  const authority = target.host.includes(':')
    ? `[${target.host}]:${target.port}`
    : `${target.host}:${target.port}`;
  const credentials = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
    : '';
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${credentials}\r\n`);
  const rest = await awaitConnectReply(socket);
  if (rest.length > 0) {
    socket.unshift(rest);
  }
  return socket;
}

function refuse(socket: Duplex, status: string) {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Serve CONNECT on the gateway's server. `env` is the launcher's own environment, whose
 * proxy settings the tunnels honor.
 */
export function openFrontDoor(
  server: http.Server,
  certificate: ServerCertificate,
  env: NodeJS.ProcessEnv,
) {
  const context = tls.createSecureContext({ cert: certificate.cert, key: certificate.key });
  server.on('connect', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const target = connectTarget(req.url);
    if (!target) {
      refuse(socket, '400 Bad Request');
      return;
    }
    if (target.host === FRONT_DOOR_HOST && target.port === 443) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        socket.unshift(head);
      }
      const secure = new tls.TLSSocket(socket, {
        isServer: true,
        secureContext: context,
        ALPNProtocols: ['http/1.1'],
      });
      secure.on('error', () => secure.destroy());
      frontDoorSockets.add(secure);
      server.emit('connection', secure);
      return;
    }
    void openTunnel(target, env).then(
      (upstream) => {
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          upstream.write(head);
        }
        socket.pipe(upstream);
        upstream.pipe(socket);
      },
      () => refuse(socket, '502 Bad Gateway'),
    );
  });
}
