import { randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// The gateway token is in the environment of every command Claude runs, so an
// approved `curl` can call the mod control plane with it, including routes that
// set the permission snapshot native harnesses obey. The mod therefore also
// holds a per-session key the gateway mints on the first mod request it sees
// for that session and returns in a response header. The mod keeps it in
// memory, never in the environment, and presents it on every later request.
//
// A session starts enforcing once the mod has presented its key, which any
// mod build that follows the header protocol does with its next request; a
// build that does not never presents one and is never refused. Before that
// first echo a session's requests are admitted, which is the milliseconds
// between the mod's own first request and its second: no tool has run yet.
// ---------------------------------------------------------------------------

export const MOD_KEY_HEADER = 'x-multi-mod-key';
const MAX_SESSIONS = 1024;

interface Entry {
  key: string;
  confirmed: boolean;
}

export type ModKeyVerdict = { refused: true } | { refused: false; issue?: string };

export class ModSessionKeys {
  private readonly entries = new Map<string, Entry>();

  /** Admit or refuse one mod request for `session`; `issue` is a key to return to the mod. */
  check(session: string, presented: string | undefined): ModKeyVerdict {
    const entry = this.entries.get(session) ?? this.mint(session);
    if (presented === undefined) {
      return entry.confirmed ? { refused: true } : { refused: false, issue: entry.key };
    }
    if (!matches(presented, entry.key)) {
      return { refused: true };
    }
    entry.confirmed = true;
    return { refused: false };
  }

  private mint(session: string): Entry {
    if (this.entries.size >= MAX_SESSIONS) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    const entry = { key: randomBytes(24).toString('hex'), confirmed: false };
    this.entries.set(session, entry);
    return entry;
  }
}

function matches(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
