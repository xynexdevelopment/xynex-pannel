import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { AttemptThrottle, makeLimiter, sendThrottled } from "../src/server/middleware/rateLimit";

describe("AttemptThrottle (per-account failure window)", () => {
  const mk = (now: { t: number }) => new AttemptThrottle({ max: 3, windowMs: 1000, now: () => now.t });

  it("allows up to max failures, then blocks with a Retry-After", () => {
    const clock = { t: 1_000_000 };
    const th = mk(clock);
    for (let i = 0; i < 3; i++) { expect(th.check("a").blocked).toBe(false); th.fail("a"); }
    const gate = th.check("a");
    expect(gate.blocked).toBe(true);
    expect(gate.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(gate.retryAfterSec).toBeLessThanOrEqual(1);
  });

  it("unblocks after the window passes (reset behaviour)", () => {
    const clock = { t: 5_000 };
    const th = mk(clock);
    for (let i = 0; i < 3; i++) th.fail("a");
    expect(th.check("a").blocked).toBe(true);
    clock.t += 1001;
    expect(th.check("a").blocked).toBe(false);
  });

  it("a success (reset) clears the counter; keys are independent", () => {
    const clock = { t: 0 };
    const th = mk(clock);
    th.fail("a"); th.fail("a"); th.fail("b"); th.fail("b"); th.fail("b");
    expect(th.check("b").blocked).toBe(true);
    expect(th.check("a").blocked).toBe(false);
    th.reset("b");
    expect(th.check("b").blocked).toBe(false);
  });

  it("is memory-bounded when an attacker sprays random keys", () => {
    const th = new AttemptThrottle({ max: 3, windowMs: 60_000, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) th.fail(`user-${i}`);
    expect(th.size).toBeLessThanOrEqual(101);
  });

  it("sendThrottled answers 429 with Retry-After and a JSON body", () => {
    const headers: Record<string, string> = {};
    let status = 0; let body: any;
    const res: any = { setHeader: (k: string, v: string) => { headers[k] = v; }, status(c: number) { status = c; return res; }, json(b: any) { body = b; return res; } };
    sendThrottled(res, 42);
    expect(status).toBe(429);
    expect(headers["Retry-After"]).toBe("42");
    expect(body.retryAfter).toBe(42);
  });
});

describe("makeLimiter (HTTP behaviour)", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function start(limiter: any, opts: { trustProxy?: boolean } = {}) {
    const app = express();
    if (opts.trustProxy !== undefined) app.set("trust proxy", opts.trustProxy);
    // test-only stand-in for requireAuth
    app.use((req, _res, next) => { const u = req.headers["x-test-user"]; if (u) (req as any).user = { id: String(u) }; next(); });
    app.get("/x", limiter, (_req, res) => { res.json({ ok: true }); });
    await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    return (headers: Record<string, string> = {}) => fetch(`${base}/x`, { headers });
  }

  it("allows requests under the limit, blocks over it with 429 + Retry-After, and resets after the window", async () => {
    const hit = await start(makeLimiter({ windowMs: 400, max: 3, message: "slow down" }));
    for (let i = 0; i < 3; i++) expect((await hit()).status).toBe(200);
    const blocked = await hit();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await blocked.json()).error).toBe("slow down");
    await new Promise((r) => setTimeout(r, 550));
    expect((await hit()).status).toBe(200);
  });

  it("per-user limiter: users behind the same IP do not share a bucket, one user cannot dodge via headers", async () => {
    const hit = await start(makeLimiter({ windowMs: 5000, max: 2, message: "x", keyBy: "user" }));
    for (let i = 0; i < 2; i++) expect((await hit({ "x-test-user": "alice" })).status).toBe(200);
    expect((await hit({ "x-test-user": "alice" })).status).toBe(429);
    expect((await hit({ "x-test-user": "bob" })).status).toBe(200);
    // a spoofed X-Forwarded-For does not create a new bucket for alice
    expect((await hit({ "x-test-user": "alice", "x-forwarded-for": "9.9.9.9" })).status).toBe(429);
  });

  it("IP limiter ignores a spoofed X-Forwarded-For unless a proxy is trusted", async () => {
    const hit = await start(makeLimiter({ windowMs: 5000, max: 2, message: "x" }), { trustProxy: false });
    expect((await hit({ "x-forwarded-for": "1.1.1.1" })).status).toBe(200);
    expect((await hit({ "x-forwarded-for": "2.2.2.2" })).status).toBe(200);
    expect((await hit({ "x-forwarded-for": "3.3.3.3" })).status).toBe(429);
  });
});
