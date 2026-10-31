import { isRevoked } from "../services/tokenRevocation.js";
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { verifySessionToken } from "../utils/security.js";
import { readJSON, writeJSON } from "../services/db.js";

const isStaffRole = (role: unknown) => role === "admin" || role === "owner";
const isApiKeyToken = (token: string) => token.startsWith("xynex-") || token.startsWith("xynex_");

// How stale `last_used_at` may get before we persist it again. Writing api_keys.json on
// every single request is slow and races with key creation / revocation.
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Scopes understood by the panel: "*" and "write" = full access, "read" = safe methods only
 *  (GET/HEAD/OPTIONS). A key whose scopes grant neither "*" nor "write" is read-only. Keys made by
 *  the UI carry ["*"], so existing keys keep working. */
export const API_KEY_SCOPES = ["*", "read", "write"] as const;
export function scopeAllowsMethod(scopes: unknown, method: string): boolean {
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.includes("*") || list.includes("write")) return true;
  return ["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());
}

type AuthResult =
  | { ok: true; user: any }
  | { ok: false; status: number; error: string };

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

/** Validates an API key. Fails closed: a key whose creator no longer exists is rejected
 *  (it must never silently inherit admin rights). */
async function authenticateApiKey(token: string): Promise<AuthResult> {
  const apiKeys = (await readJSON("api_keys.json")) || [];
  const keyHash = crypto.createHash("sha256").update(token).digest("hex");
  const apiKey = apiKeys.find((k: any) => k.key_hash === keyHash);

  if (!apiKey || apiKey.revoked) return { ok: false, status: 401, error: "Invalid or revoked API key" };
  if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
    return { ok: false, status: 401, error: "API key expired" };
  }

  let role = "admin";
  if (apiKey.created_by !== "temp-admin") {
    const users = (await readJSON("users.json")) || [];
    const creator = users.find((u: any) => u.id === apiKey.created_by);
    if (!creator) return { ok: false, status: 401, error: "API key creator no longer exists" };
    if (creator.suspended) return { ok: false, status: 403, error: "This account has been suspended" };
    role = creator.role || "user";
  }

  const lastUsed = apiKey.last_used_at ? new Date(apiKey.last_used_at).getTime() : 0;
  if (Date.now() - lastUsed > LAST_USED_WRITE_INTERVAL_MS) {
    // Best-effort bookkeeping; never block or fail the request on it. Re-read inside so we
    // don't overwrite changes made since the read above.
    (async () => {
      const fresh = (await readJSON("api_keys.json")) || [];
      const target = fresh.find((k: any) => k.key_hash === keyHash);
      if (target) {
        target.last_used_at = new Date().toISOString();
        await writeJSON("api_keys.json", fresh);
      }
    })().catch(() => undefined);
  }

  return { ok: true, user: { id: apiKey.created_by, role, isApiKey: true, scopes: apiKey.scopes } };
}

/** Validates a session JWT and re-checks it against the user database, so deleted users,
 *  password changes and role changes take effect immediately. */
async function authenticateSession(token: string): Promise<AuthResult> {
  let decoded: any;
  try {
    decoded = verifySessionToken(token);
  } catch {
    return { ok: false, status: 401, error: "Invalid token" };
  }

  if (isRevoked(decoded.jti)) return { ok: false, status: 401, error: "Session expired" };

  if (decoded.id !== "temp-admin") {
    const users = (await readJSON("users.json")) || [];
    const user = users.find((u: any) => u.id === decoded.id);
    if (!user) return { ok: false, status: 401, error: "User not found" };
    if (user.suspended) return { ok: false, status: 403, error: "This account has been suspended" };
    if ((user.passwordVersion || 0) !== (decoded.passwordVersion || 0)) {
      return { ok: false, status: 401, error: "Session expired" };
    }
    // Always trust the DB for the role, not the (up to 7 day old) token claim.
    decoded.role = user.role || "user";
  }
  return { ok: true, user: decoded };
}

async function authenticate(req: Request): Promise<AuthResult> {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: "Unauthorized" };
  try {
    if (!isApiKeyToken(token)) return await authenticateSession(token);
    const result = await authenticateApiKey(token);
    if (result.ok && !scopeAllowsMethod(result.user.scopes, req.method)) {
      return { ok: false, status: 403, error: "This API key is read-only" };
    }
    return result;
  } catch (err) {
    console.error("[auth] unexpected error:", err);
    return { ok: false, status: 500, error: "Internal Server Error" };
  }
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const result = await authenticate(req);
  if (result.ok === false) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  (req as any).user = result.user;
  next();
};

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  const result = await authenticate(req);
  if (result.ok === false) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  if (!isStaffRole(result.user.role)) {
    res.status(403).json({ error: "Forbidden: Admin access only" });
    return;
  }
  (req as any).user = result.user;
  next();
};
