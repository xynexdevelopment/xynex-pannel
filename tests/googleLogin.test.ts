import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";
import crypto from "crypto";
import jwt from "jsonwebtoken";

// Isolated data dir: db.ts / security.ts resolve .data from process.cwd() at import time.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xynex-google-"));
const cwd = process.cwd();
const PROJECT = "demo-project";

let auth: typeof import("../src/server/controllers/auth");
let db: typeof import("../src/server/services/db");
let gid: any;

// Throw-away RSA key standing in for Google's securetoken signing key.
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const cert = publicKey.export({ type: "spki", format: "pem" }).toString();
const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

function idToken(claims: Record<string, unknown> = {}, opts: { key?: crypto.KeyObject; kid?: string; aud?: string; iss?: string; expiresIn?: any } = {}) {
  const { sub, ...rest } = claims as any;
  return jwt.sign(
    { email: "alice@example.com", email_verified: true, name: "Alice", ...rest },
    opts.key ?? privateKey,
    {
      algorithm: "RS256",
      keyid: opts.kid ?? "kid1",
      audience: opts.aud ?? PROJECT,
      issuer: opts.iss ?? `https://securetoken.google.com/${PROJECT}`,
      subject: (sub as string) ?? "google-uid-alice",
      expiresIn: opts.expiresIn ?? "1h",
    }
  );
}

function call(body: any) {
  return new Promise<{ status: number; body: any }>((resolve) => {
    let status = 200;
    const res: any = {
      status(c: number) { status = c; return res; },
      json(b: any) { resolve({ status, body: b }); return res; },
    };
    auth.googleLogin({ body, ip: "203.0.113.5", headers: {}, socket: {} } as any, res);
  });
}

beforeAll(async () => {
  process.chdir(tmp);
  process.env.JWT_SECRET = "x".repeat(40);
  db = await import("../src/server/services/db");
  gid = await import("../src/server/services/googleIdToken");
  auth = await import("../src/server/controllers/auth");
});
afterAll(() => { process.chdir(cwd); fs.removeSync(tmp); });

beforeEach(async () => {
  gid.__setCertFetcherForTests?.(async () => ({ certs: { kid1: cert }, maxAgeMs: 60_000 }));
  await db.writeJSON("settings.json", { enableGoogleLogin: true, firebaseProjectId: PROJECT });
  await db.writeJSON("users.json", [
    { id: "u-admin", username: "admin", role: "admin", password: "x", passwordVersion: 0, twoFactorEnabled: true, twoFactorSecret: "S" },
    { id: "u-bob", username: "bob", role: "user", email: "bob@example.com", password: "x", passwordVersion: 0 },
  ]);
});

describe("POST /api/auth/google", () => {
  it("REGRESSION: a forged body (no token) must not log anyone in, not even by username prefix", async () => {
    const r = await call({ email: "admin@evil.example", googleId: "attacker" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.body.token).toBeUndefined();
  });

  it("rejects a token signed with the wrong key", async () => {
    const r = await call({ idToken: idToken({}, { key: otherKey }) });
    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
  });

  it("rejects wrong audience, wrong issuer, expired and unverified-email tokens", async () => {
    expect((await call({ idToken: idToken({}, { aud: "another-project" }) })).status).toBe(401);
    expect((await call({ idToken: idToken({}, { iss: "https://evil.example" }) })).status).toBe(401);
    expect((await call({ idToken: idToken({}, { expiresIn: -10 }) })).status).toBe(401);
    expect((await call({ idToken: idToken({ email_verified: false }) })).status).toBe(401);
  });

  it("rejects an unsigned (alg=none) token", async () => {
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "kid1" })).toString("base64url") + "." +
      Buffer.from(JSON.stringify({ sub: "x", email: "admin@example.com", email_verified: true, aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`, exp: 9999999999 })).toString("base64url") + ".";
    expect((await call({ idToken: none })).status).toBe(401);
  });

  it("is refused unless an admin explicitly enabled Google login", async () => {
    await db.writeJSON("settings.json", { firebaseProjectId: PROJECT });
    expect((await call({ idToken: idToken() })).status).toBe(403);
  });

  it("is refused when no Firebase project is configured (cannot validate audience)", async () => {
    await db.writeJSON("settings.json", { enableGoogleLogin: true });
    expect((await call({ idToken: idToken() })).status).toBeGreaterThanOrEqual(400);
  });

  it("accepts a valid token, creates a user, and never reuses an existing username", async () => {
    // alice@... is a new person; a user called "alice" already exists locally and must not be taken over
    const users = await db.readJSON("users.json");
    users.push({ id: "u-alice-local", username: "alice", role: "admin", password: "x", passwordVersion: 0 });
    await db.writeJSON("users.json", users);

    const r = await call({ idToken: idToken() });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.user.id).not.toBe("u-alice-local");
    expect(r.body.user.role).toBe("user");
    const decoded: any = jwt.verify(r.body.token, process.env.JWT_SECRET!);
    expect(decoded.id).toBe(r.body.user.id);

    // second login with the same Google account maps to the same panel user
    const again = await call({ idToken: idToken() });
    expect(again.body.user.id).toBe(r.body.user.id);
  });

  it("REGRESSION: never auto-links to a local account just because the email matches (pre-registration takeover)", async () => {
    // attacker registered a local account claiming bob's address; bob later signs in with Google
    const r = await call({ idToken: idToken({ email: "bob@example.com", sub: "google-uid-bob" }) });
    expect(r.status).toBe(200);
    expect(r.body.user.id).not.toBe("u-bob");
    const users = await db.readJSON("users.json");
    expect(users.find((u: any) => u.id === "u-bob").googleId).toBeUndefined();
  });

  it("an already-linked Google uid keeps logging into its own account", async () => {
    const users = await db.readJSON("users.json");
    users.find((u: any) => u.id === "u-bob").googleId = "google-uid-bob";
    await db.writeJSON("users.json", users);
    const r = await call({ idToken: idToken({ email: "whatever@example.com", sub: "google-uid-bob" }) });
    expect(r.body.user.id).toBe("u-bob");
  });

  it("explicit linking: a logged-in user links a verified Google identity; duplicates and bad tokens are refused", async () => {
    const link = (body: any, userId = "u-bob") => new Promise<{ status: number; body: any }>((resolve) => {
      let status = 200; const res: any = { status(c: number) { status = c; return res; }, json(b: any) { resolve({ status, body: b }); return res; } };
      auth.linkGoogle({ body, user: { id: userId } } as any, res);
    });
    expect((await link({ idToken: idToken({}, { key: otherKey }) })).status).toBe(401);
    expect((await link({})).status).toBe(400);
    expect((await link({ idToken: idToken({ sub: "google-uid-bob", email: "bob@example.com" }) })).status).toBe(200);
    // the same Google account cannot be attached to a second user
    expect((await link({ idToken: idToken({ sub: "google-uid-bob", email: "bob@example.com" }) }, "u-admin")).status).toBe(409);
    // and now Google sign-in lands in bob's account
    expect((await call({ idToken: idToken({ sub: "google-uid-bob", email: "bob@example.com" }) })).body.user.id).toBe("u-bob");
  });
});
