/* Per-server operation lock.
   Long-running operations (install, reinstall, restore, backup, version change,
   delete) must never run concurrently on the same server - e.g. a restore
   extracting files while the server is started, or a delete during a backup.

   The lock is in-process (the panel refuses multi-instance mode, see config.ts).
   Every lock has a TTL: a crashed/hung task can never block a server forever;
   once the TTL has passed the lock is treated as stale and may be taken over
   (and that takeover is logged). */

interface Held { op: string; since: number; ttlMs: number }

const held = new Map<string, Held>();

export const DEFAULT_LOCK_TTL_MS = 2 * 60 * 60 * 1000; // 2 h

// Flat shape on purpose (the project does not enable strictNullChecks, so a discriminated union would not narrow).
// When ok is false, busyWith/sinceMs describe the holder and release() is a harmless no-op.
export interface LockResult { ok: boolean; release: () => void; busyWith: string; sinceMs: number }

export function acquireServerLock(serverId: string, op: string, ttlMs = DEFAULT_LOCK_TTL_MS, now = Date.now()): LockResult {
  const cur = held.get(serverId);
  if (cur) {
    if (now - cur.since < cur.ttlMs) return { ok: false, release: () => {}, busyWith: cur.op, sinceMs: now - cur.since };
    console.warn(`[locks] stale '${cur.op}' lock on server ${serverId} (older than ${Math.round(cur.ttlMs / 60000)} min) - taking over for '${op}'`);
  }
  const mine: Held = { op, since: now, ttlMs };
  held.set(serverId, mine);
  let released = false;
  return {
    ok: true,
    busyWith: "",
    sinceMs: 0,
    release: () => {
      if (released) return;
      released = true;
      // Only drop our own lock - a stale takeover may have replaced it.
      if (held.get(serverId) === mine) held.delete(serverId);
    },
  };
}

/** Which operation (if any) currently holds the server. Expired locks read as free. */
export function getServerLock(serverId: string, now = Date.now()): { op: string; sinceMs: number } | null {
  const cur = held.get(serverId);
  if (!cur || now - cur.since >= cur.ttlMs) return null;
  return { op: cur.op, sinceMs: now - cur.since };
}

/** Human readable 409 message. */
export function busyMessage(busyWith: string): string {
  const nice: Record<string, string> = {
    restore: "a backup is being restored",
    backup: "a backup is being created",
    reinstall: "the server is being reinstalled",
    "version-change": "the server version is being changed",
    delete: "the server is being deleted",
  };
  return `Server is busy: ${nice[busyWith] || busyWith}. Try again when it has finished.`;
}

/** Test helper. */
export function _resetServerLocks() { held.clear(); }
