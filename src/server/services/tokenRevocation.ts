import fs from "fs-extra";
import path from "path";

/* Revocation list for individual session tokens (by `jti`). Logging out adds the token's jti here
   until the token would have expired anyway, so a stolen copy of a logged-out token stops working.
   Persisted to .data/revoked_tokens.json so a restart does not resurrect revoked sessions.
   Tokens issued before this feature have no jti and are unaffected (they still end via
   expiry / password change / logout-all). Single-process, like the rest of the panel's state. */
const revoked = new Map<string, number>(); // jti -> exp (unix seconds)
let loadedFor = "";
const file = () => path.join(process.cwd(), ".data", "revoked_tokens.json");

function load() {
  const f = file();
  if (loadedFor === f) return;
  loadedFor = f;
  revoked.clear();
  try {
    const raw = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number") revoked.set(k, v);
  } catch { /* unreadable file: start empty rather than refuse every login */ }
  prune();
}

function prune() {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, exp] of revoked) if (exp <= now) revoked.delete(k);
}

function persist() {
  try {
    fs.ensureDirSync(path.dirname(file()));
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(revoked)), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch (e) { console.error("[auth] could not persist revoked tokens:", e); }
}

export function revokeToken(jti: string, exp: number): void {
  load(); prune();
  revoked.set(jti, exp);
  persist();
}

export function isRevoked(jti: unknown): boolean {
  if (typeof jti !== "string") return false;
  load();
  return revoked.has(jti);
}
