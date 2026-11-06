import rateLimit, { type Store } from "express-rate-limit";
import type { Request, Response } from "express";

/* Rate limiting.
   - IP limiters (authLimiter / captchaLimiter / apiLimiter) throttle anonymous traffic. The IP
     comes from Express (`trust proxy` is configured in server.ts), never from a raw header.
   - Per-user limiters (sensitive / upload / heavy) key on the authenticated user id, so users
     sharing one NAT/proxy address do not throttle each other and one user cannot hide behind
     many addresses.
   - AttemptThrottle counts *failed* credential attempts per account (username / user id) across
     all IPs, which per-IP limiters cannot do.

   STORAGE: all counters live in this process's memory. That is correct for the shipped
   single-instance pm2 setup (ecosystem.config.cjs: instances 1) but they are NOT shared between
   several panel instances and reset on restart. `makeLimiter({ store })` and `AttemptThrottle`'s
   `Map` are the seams where a shared store (e.g. Redis) would be plugged in. */

interface LimiterOptions {
  windowMs: number;
  max: number;
  message: string;
  skipSuccessfulRequests?: boolean;
  /** "ip" (default) or "user" (authenticated user id, falling back to the IP). */
  keyBy?: "ip" | "user";
  store?: Store;
}

export function makeLimiter(opts: LimiterOptions) {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true, // RateLimit-* headers; Retry-After is sent on 429
    legacyHeaders: false,
    message: { error: opts.message },
    skipSuccessfulRequests: opts.skipSuccessfulRequests,
    store: opts.store,
    ...(opts.keyBy === "user"
      ? { keyGenerator: (req: Request) => `user:${(req as any).user?.id ?? req.ip}` }
      : {}),
  });
}

// Strict limiter for authentication-sensitive routes (login, register, 2FA verification).
// Keyed by IP; per-account protection is handled by AttemptThrottle below.
export const authLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: "Too many attempts. Please wait a few minutes and try again.",
  skipSuccessfulRequests: true, // don't penalize users for their eventual successful login
});

// Slightly looser: legitimate users may need a few tries / refreshes to solve a captcha.
export const captchaLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: "Too many attempts. Please wait a few minutes and try again.",
});

// General safety net for the whole /api surface. High enough for dashboard polling.
export const apiLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 300,
  message: "Too many requests. Please slow down.",
});

// Password / email / 2FA changes. A stolen session token must not allow unlimited password guessing.
export const sensitiveLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Please wait a few minutes and try again.",
  keyBy: "user",
});

// File uploads (incl. 10 MB chunks: 600 chunks ≈ 6 GB per 10 minutes per user).
export const uploadLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 600,
  message: "Too many uploads. Please wait a moment and try again.",
  keyBy: "user",
});

// Resource-intensive actions: server creation, zip/unzip, backups, modpack/plugin/mod installs.
export const heavyLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many requests for this action. Please slow down.",
  keyBy: "user",
});

/* ── Per-account failed-attempt throttle ────────────────────────────────────
   Sliding window of failure timestamps per key. `check` is called BEFORE verifying a credential;
   `fail` after a wrong one; `reset` after a right one. Unknown usernames are counted too, so the
   response never reveals whether an account exists.
   Trade-off: a determined attacker can lock a known username out for up to `windowMs`; the owner
   can still use the panel again once the window passes, and the admin `createuser` script is unaffected. */
export class AttemptThrottle {
  private hits = new Map<string, number[]>();
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly opts: { max: number; windowMs: number; maxKeys?: number; now?: () => number }
  ) {}

  private now() { return this.opts.now ? this.opts.now() : Date.now(); }

  private live(key: string): number[] {
    const cutoff = this.now() - this.opts.windowMs;
    const arr = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (arr.length) this.hits.set(key, arr); else this.hits.delete(key);
    return arr;
  }

  check(key: string): { blocked: boolean; retryAfterSec: number } {
    const arr = this.live(key);
    if (arr.length < this.opts.max) return { blocked: false, retryAfterSec: 0 };
    const unlockAt = arr[arr.length - this.opts.max] + this.opts.windowMs;
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((unlockAt - this.now()) / 1000)) };
  }

  fail(key: string): void {
    const arr = this.live(key);
    arr.push(this.now());
    this.hits.set(key, arr);
    // Memory bound: an attacker spraying random usernames must not grow the map without limit.
    const cap = this.opts.maxKeys ?? 50_000;
    if (this.hits.size > cap) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    if (!this.timer) {
      this.timer = setInterval(() => { for (const k of [...this.hits.keys()]) this.live(k); }, this.opts.windowMs);
      this.timer.unref();
    }
  }

  reset(key: string): void { this.hits.delete(key); }
  get size(): number { return this.hits.size; }
}

/** Sends the standard 429 response for a blocked AttemptThrottle check. */
export function sendThrottled(res: Response, retryAfterSec: number, message = "Too many failed attempts. Please try again later.") {
  res.setHeader("Retry-After", String(retryAfterSec));
  res.status(429).json({ error: message, retryAfter: retryAfterSec });
}

// Failed password logins per account (any IP), and failed 2FA codes per account.
export const loginAttempts = new AttemptThrottle({ max: 10, windowMs: 15 * 60 * 1000 });
export const twoFactorAttempts = new AttemptThrottle({ max: 5, windowMs: 15 * 60 * 1000 });
