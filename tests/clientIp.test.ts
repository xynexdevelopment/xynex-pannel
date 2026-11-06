import { describe, it, expect } from "vitest";
import { getClientIp } from "../src/server/middleware/ipBan";

describe("getClientIp", () => {
  it("uses the Express-resolved ip and ignores a raw X-Forwarded-For header", () => {
    const req: any = { ip: "203.0.113.9", headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "10.0.0.1" } };
    expect(getClientIp(req)).toBe("203.0.113.9");
  });
  it("normalises IPv4-mapped IPv6 addresses", () => {
    expect(getClientIp({ ip: "::ffff:198.51.100.7", socket: {} } as any)).toBe("198.51.100.7");
  });
  it("falls back to the socket address", () => {
    expect(getClientIp({ ip: undefined, socket: { remoteAddress: "192.0.2.1" } } as any)).toBe("192.0.2.1");
  });
});
