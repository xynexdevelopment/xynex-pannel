import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";
import bcrypt from "bcryptjs";
import speakeasy from "speakeasy";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xynex-auth-"));
const cwd = process.cwd();
let auth: typeof import("../src/server/controllers/auth");
let db: typeof import("../src/server/services/db");
let captcha: typeof import("../src/server/services/captcha");
let rl: typeof import("../src/server/middleware/rateLimit");
let jwt: typeof import("jsonwebtoken");

const SECRET = speakeasy.generateSecret({ length: 20 }).base32;
const PASSWORD = "correct-horse-battery";

function invoke(fn: any, body: any, ip = "198.51.100.1") {
  return new Promise<{ status: number; body: any; headers: Record<string, string> }>((resolve) => {
    let status = 200; const headers: Record<string, string> = {};
    const res: any = {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      status(c: number) { status = c; return res; },
      json(b: any) { resolve({ status, body: b, headers }); return res; },
    };
    fn({ body, ip, headers: {}, socket: {} } as any, res);
  });
}
function solvedCaptcha() {
  const c = captcha.createChallenge();
  const opt = c.options.find((o) => o.emoji === c.target)!;
  expect(captcha.verifyChallenge(c.challengeId, opt.id)).toBe(true);
  return c.challengeId;
}
const login = (username: string, password: string, ip?: string) => invoke(auth.login, { username, password, challengeId: solvedCaptcha() }, ip);
const code = (offsetSteps = 0) => speakeasy.totp({ secret: SECRET, encoding: "base32", time: Date.now() / 1000 + offsetSteps * 30 });

beforeAll(async () => {
  process.chdir(tmp);
  process.env.JWT_SECRET = "y".repeat(40);
  process.env.NODE_ENV = "test";
  db = await import("../src/server/services/db");
  captcha = await import("../src/server/services/captcha");
  rl = await import("../src/server/middleware/rateLimit");
  auth = await import("../src/server/controllers/auth");
  jwt = (await import("jsonwebtoken")).default as any;
});
afterAll(() => { process.chdir(cwd); fs.removeSync(tmp); });

beforeEach(async () => {
  await db.writeJSON("settings.json", {});
  await db.writeJSON("users.json", [
    { id: "u1", username: "victim", role: "user", password: await bcrypt.hash(PASSWORD, 4), passwordVersion: 0 },
    { id: "u2", username: "other", role: "user", password: await bcrypt.hash(PASSWORD, 4), passwordVersion: 0 },
    { id: "u3", username: "twofa", role: "user", password: await bcrypt.hash(PASSWORD, 4), passwordVersion: 0, twoFactorEnabled: true, twoFactorSecret: SECRET },
  ]);
  for (const k of ["login:victim", "login:other", "login:ghost", "2fa:u3"]) { rl.loginAttempts.reset(k); rl.twoFactorAttempts.reset(k); }
});

describe("per-account login throttle", () => {
  it("locks an account after repeated failures from MANY different IPs (per-IP limits cannot do this)", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await login("victim", "wrong-" + i, `203.0.113.${i + 1}`);
      expect(r.status).toBe(401);
    }
    const blocked = await login("victim", PASSWORD, "203.0.113.200"); // even the right password, from a fresh IP
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThan(0);
    expect(blocked.body.token).toBeUndefined();
  });

  it("does not affect other accounts, and counts unknown usernames without revealing them", async () => {
    for (let i = 0; i < 10; i++) await login("victim", "nope", "203.0.113.9");
    expect((await login("other", PASSWORD)).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await login("ghost", "x")).status).toBe(401);
    expect((await login("ghost", "x")).status).toBe(429); // same behaviour as a real account
  });

  it("a successful login resets the failure counter", async () => {
    for (let i = 0; i < 9; i++) await login("victim", "nope");
    expect((await login("victim", PASSWORD)).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await login("victim", "nope")).status).toBe(401);
    expect((await login("victim", PASSWORD)).status).toBe(200);
  });
});

describe("2FA hardening", () => {
  async function tempToken() {
    const r = await login("twofa", PASSWORD);
    expect(r.body.requires2FA).toBe(true);
    return r.body.tempToken as string;
  }

  it("accepts a valid code once and rejects the same code again (replay)", async () => {
    const c = code();
    const first = await invoke(auth.verifyTwoFactorLogin, { tempToken: await tempToken(), code: c });
    expect(first.status).toBe(200);
    expect(first.body.token).toBeTruthy();
    const replay = await invoke(auth.verifyTwoFactorLogin, { tempToken: await tempToken(), code: c });
    expect(replay.status).toBe(401);
    // the next time-step's code is still fine
    const next = await invoke(auth.verifyTwoFactorLogin, { tempToken: await tempToken(), code: code(1) });
    expect(next.status).toBe(200);
  });

  it("throttles wrong codes per account, even with fresh temp tokens and IPs", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await invoke(auth.verifyTwoFactorLogin, { tempToken: await tempToken(), code: "000000" }, `192.0.2.${i + 1}`);
      expect(r.status).toBe(401);
    }
    const blocked = await invoke(auth.verifyTwoFactorLogin, { tempToken: await tempToken(), code: code() }, "192.0.2.99");
    expect(blocked.status).toBe(429);
  });

  it("a pre-auth (2FA stage) token is not a session token", async () => {
    const { verifySessionToken } = await import("../src/server/utils/security");
    const t = await tempToken();
    expect(() => verifySessionToken(t)).toThrow();
  });
});

describe("session invalidation", () => {
  it("changing the password bumps passwordVersion so existing tokens stop working", async () => {
    const before = await login("victim", PASSWORD);
    const decoded: any = jwt.verify(before.body.token, process.env.JWT_SECRET!);
    // changePassword reads req.user, so call it with a user attached
    const res2 = await new Promise<any>((resolve) => {
      const res: any = { status() { return res; }, json(b: any) { resolve(b); return res; } };
      auth.changePassword({ body: { oldPassword: PASSWORD, newPassword: "a-new-long-password" }, user: { id: decoded.id } } as any, res);
    });
    expect(res2.success).toBe(true);
    const users = await db.readJSON("users.json");
    expect(users.find((u: any) => u.id === "u1").passwordVersion).toBe(1);
    const { requireAuth } = await import("../src/server/middleware/auth");
    const out = await new Promise<number>((resolve) => {
      const res: any = { status(c: number) { resolve(c); return res; }, json() { return res; } };
      requireAuth({ headers: { authorization: `Bearer ${before.body.token}` } } as any, res, () => resolve(200));
    });
    expect(out).toBe(401);
  });
});

describe("2FA seed encryption at rest + logout-all", () => {
  it("seals new seeds, still reads legacy plaintext, migrates it on use, and rejects tampering", async () => {
    const sec = await import("../src/server/utils/security");
    const sealed = sec.sealSecret(SECRET);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(sealed).not.toContain(SECRET);
    expect(sec.openSecret(sealed)).toBe(SECRET);
    expect(sec.openSecret(SECRET)).toBe(SECRET); // legacy
    const parts = sealed.split(":"); parts[4] = Buffer.from("tampered!!!!").toString("base64");
    expect(() => sec.openSecret(parts.join(":"))).toThrow();

    // legacy plaintext user logs in with 2FA -> stored seed becomes sealed
    const r = await login("twofa", PASSWORD);
    const ok = await invoke(auth.verifyTwoFactorLogin, { tempToken: r.body.tempToken, code: code() });
    expect(ok.status).toBe(200);
    const stored = (await db.readJSON("users.json")).find((u: any) => u.id === "u3").twoFactorSecret;
    expect(sec.isSealed(stored)).toBe(true);
    // ... and the sealed seed keeps working
    const r2 = await login("twofa", PASSWORD);
    expect((await invoke(auth.verifyTwoFactorLogin, { tempToken: r2.body.tempToken, code: code(1) })).status).toBe(200);
  });

  it("a tampered stored seed never validates a code", async () => {
    const users = await db.readJSON("users.json");
    users.find((u: any) => u.id === "u3").twoFactorSecret = "enc:v1:AAAA:AAAA:AAAA";
    await db.writeJSON("users.json", users);
    const r = await login("twofa", PASSWORD);
    expect((await invoke(auth.verifyTwoFactorLogin, { tempToken: r.body.tempToken, code: code(2) })).status).toBe(401);
  });

  it("logout-all invalidates every existing token of that user only", async () => {
    const a = await login("victim", PASSWORD); const b = await login("victim", PASSWORD); const o = await login("other", PASSWORD);
    await new Promise<void>((resolve) => { const res: any = { status() { return res; }, json() { resolve(); return res; } }; auth.logoutAll({ user: { id: "u1" } } as any, res); });
    const { requireAuth } = await import("../src/server/middleware/auth");
    const status = (t: string) => new Promise<number>((resolve) => { const res: any = { status(c: number) { resolve(c); return res; }, json() { return res; } }; requireAuth({ headers: { authorization: `Bearer ${t}` }, method: "GET" } as any, res, () => resolve(200)); });
    expect(await status(a.body.token)).toBe(401);
    expect(await status(b.body.token)).toBe(401);
    expect(await status(o.body.token)).toBe(200);
  });
});

describe("per-token revocation (logout)", () => {
  const status = async (t: string) => {
    const { requireAuth } = await import("../src/server/middleware/auth");
    return new Promise<number>((resolve) => { const res: any = { status(c: number) { resolve(c); return res; }, json() { return res; } }; requireAuth({ headers: { authorization: `Bearer ${t}` }, method: "GET" } as any, res, () => resolve(200)); });
  };
  const doLogout = (t: string) => new Promise<void>((resolve) => { const res: any = { json() { resolve(); return res; }, status() { return res; } }; auth.logout({ headers: { authorization: `Bearer ${t}` } } as any, res); });

  it("logout kills only that token; other sessions of the same user keep working; survives a cache reload", async () => {
    const a = await login("victim", PASSWORD); const b = await login("victim", PASSWORD);
    expect((jwt.decode(a.body.token) as any).jti).toBeTruthy();
    expect(await status(a.body.token)).toBe(200);
    await doLogout(a.body.token);
    expect(await status(a.body.token)).toBe(401);
    expect(await status(b.body.token)).toBe(200);
    // persisted on disk, so a restart does not bring the token back
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, ".data", "revoked_tokens.json"), "utf8"));
    expect(Object.keys(saved)).toContain((jwt.decode(a.body.token) as any).jti);
    expect((fs.statSync(path.join(tmp, ".data", "revoked_tokens.json")).mode & 0o777)).toBe(0o600);
  });

  it("logging out with garbage or no token is harmless", async () => {
    await doLogout("not-a-token");
    await new Promise<void>((resolve) => { const res: any = { json() { resolve(); return res; }, status() { return res; } }; auth.logout({ headers: {} } as any, res); });
  });
});
