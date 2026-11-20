import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";
import crypto from "crypto";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xynex-keys-"));
const cwd = process.cwd();
let mw: typeof import("../src/server/middleware/auth");
let db: typeof import("../src/server/services/db");

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const KEYS = { full: "xynex-FULLKEY", read: "xynex-READKEY", write: "xynex-WRITEKEY", orphan: "xynex-ORPHAN", revoked: "xynex-REVOKED", legacy: "xynex_LEGACYKEY" };

function run(mwFn: any, token: string, method = "GET") {
  return new Promise<{ status: number; user?: any }>((resolve) => {
    const res: any = { status(c: number) { resolve({ status: c }); return res; }, json() { return res; } };
    const req: any = { method, headers: { authorization: `Bearer ${token}` } };
    mwFn(req, res, () => resolve({ status: 200, user: req.user }));
  });
}

beforeAll(async () => {
  process.chdir(tmp);
  process.env.JWT_SECRET = "k".repeat(40);
  db = await import("../src/server/services/db");
  mw = await import("../src/server/middleware/auth");
});
afterAll(() => { process.chdir(cwd); fs.removeSync(tmp); });
beforeEach(async () => {
  await db.writeJSON("users.json", [{ id: "adm", username: "adm", role: "admin", passwordVersion: 0 }]);
  const mk = (id: string, token: string, extra: any = {}) => ({ id, key_hash: sha(token), label: id, scopes: ["*"], created_by: "adm", revoked: false, expires_at: null, ...extra });
  await db.writeJSON("api_keys.json", [
    mk("full", KEYS.full),
    mk("read", KEYS.read, { scopes: ["read"] }),
    mk("write", KEYS.write, { scopes: ["write"] }),
    mk("orphan", KEYS.orphan, { created_by: "deleted-user" }),
    mk("revoked", KEYS.revoked, { revoked: true }),
    mk("legacy", KEYS.legacy, { scopes: ["*"] }),
  ]);
});

describe("API key scopes", () => {
  it("scopeAllowsMethod: '*' and 'write' are full, anything else is read-only (fail closed)", () => {
    expect(mw.scopeAllowsMethod(["*"], "DELETE")).toBe(true);
    expect(mw.scopeAllowsMethod(["write"], "POST")).toBe(true);
    expect(mw.scopeAllowsMethod(["read"], "GET")).toBe(true);
    expect(mw.scopeAllowsMethod(["read"], "POST")).toBe(false);
    expect(mw.scopeAllowsMethod(["something-unknown"], "PUT")).toBe(false);
    expect(mw.scopeAllowsMethod(undefined, "DELETE")).toBe(false);
    expect(mw.scopeAllowsMethod(undefined, "GET")).toBe(true);
  });

  it("read-only key: GET allowed, every mutating method 403, on requireAuth and requireAdmin", async () => {
    expect((await run(mw.requireAuth, KEYS.read, "GET")).status).toBe(200);
    expect((await run(mw.requireAdmin, KEYS.read, "GET")).status).toBe(200);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await run(mw.requireAuth, KEYS.read, m)).status, m).toBe(403);
      expect((await run(mw.requireAdmin, KEYS.read, m)).status, m).toBe(403);
    }
  });

  it("existing '*' keys (everything the UI ever created) and 'write' keys keep working", async () => {
    for (const k of [KEYS.full, KEYS.legacy, KEYS.write]) {
      expect((await run(mw.requireAuth, k, "POST")).status).toBe(200);
      expect((await run(mw.requireAdmin, k, "DELETE")).status).toBe(200);
    }
  });

  it("still rejects revoked keys and keys whose creator no longer exists", async () => {
    expect((await run(mw.requireAuth, KEYS.revoked)).status).toBe(401);
    expect((await run(mw.requireAuth, KEYS.orphan)).status).toBe(401);
    expect((await run(mw.requireAuth, "xynex-nonexistent")).status).toBe(401);
  });
});
