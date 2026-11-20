import { Request, Response, NextFunction } from "express";
import { readJSON, writeJSON } from "../services/db.js";

// Client IP as resolved by Express. X-Forwarded-For is only honoured when the
// direct peer is a trusted proxy (see the "trust proxy" setting in server.ts,
// configurable via TRUST_PROXY), so a client can no longer spoof its address
// to dodge IP bans, rate limits or the activity log. IPv4-mapped IPv6
// addresses (::ffff:1.2.3.4) are normalised so bans match consistently.
export function getClientIp(req: Pick<Request, "ip" | "socket">): string {
  let ip = req.ip || req.socket?.remoteAddress || "";
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  return ip;
}

export type BannedIpEntry = {
  ip: string;
  reason?: string;
  bannedBy?: string;
  bannedAt: string;
};

export async function listBannedIps(): Promise<BannedIpEntry[]> {
  return (await readJSON("banned_ips.json")) || [];
}

export async function isIpBanned(ip: string): Promise<boolean> {
  if (!ip) return false;
  const banned = await listBannedIps();
  return banned.some((b) => b.ip === ip);
}

export async function banIp(ip: string, reason?: string, bannedBy?: string): Promise<void> {
  if (!ip) return;
  const banned = await listBannedIps();
  if (banned.some((b) => b.ip === ip)) return;
  banned.push({ ip, reason: reason || "", bannedBy: bannedBy || "", bannedAt: new Date().toISOString() });
  await writeJSON("banned_ips.json", banned);
}

export async function unbanIp(ip: string): Promise<void> {
  const banned = await listBannedIps();
  await writeJSON("banned_ips.json", banned.filter((b) => b.ip !== ip));
}

// Applied globally, early in the middleware chain, so a banned IP is
// rejected before it can even attempt a login or burn rate-limit quota.
export async function checkIpBanMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const ip = getClientIp(req);
    if (ip && (await isIpBanned(ip))) {
      res.status(403).json({ error: "Your IP address has been banned from accessing this panel." });
      return;
    }
    next();
  } catch (err) {
    // Fail open: a bug in the ban-check itself should never take the whole panel down.
    next();
  }
}
