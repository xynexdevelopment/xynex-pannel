import { describe, it, expect, beforeEach } from "vitest";
import { acquireServerLock, getServerLock, busyMessage, _resetServerLocks } from "../src/server/services/serverLocks";

beforeEach(() => _resetServerLocks());

describe("server operation locks", () => {
  it("only one operation per server at a time", () => {
    const a = acquireServerLock("s1", "restore");
    expect(a.ok).toBe(true);
    const b = acquireServerLock("s1", "backup");
    expect(b.ok).toBe(false);
    expect(b.busyWith).toBe("restore");
    expect(getServerLock("s1")?.op).toBe("restore");
  });

  it("different servers do not block each other", () => {
    expect(acquireServerLock("s1", "restore").ok).toBe(true);
    expect(acquireServerLock("s2", "restore").ok).toBe(true);
  });

  it("release frees the server and is idempotent", () => {
    const a = acquireServerLock("s1", "restore");
    a.release();
    a.release();
    expect(getServerLock("s1")).toBeNull();
    expect(acquireServerLock("s1", "backup").ok).toBe(true);
  });

  it("a stale lock expires and can be taken over, and the old holder cannot release the new lock", () => {
    const t0 = 1_000_000;
    const stale = acquireServerLock("s1", "restore", 1000, t0);
    expect(acquireServerLock("s1", "backup", 1000, t0 + 500).ok).toBe(false);   // still held
    expect(getServerLock("s1", t0 + 1500)).toBeNull();                          // expired reads as free
    const fresh = acquireServerLock("s1", "backup", 1000, t0 + 1500);           // takeover
    expect(fresh.ok).toBe(true);
    stale.release();                                                           // late release from the hung task
    expect(getServerLock("s1", t0 + 1600)?.op).toBe("backup");                  // must NOT have dropped the new lock
    fresh.release();
    expect(getServerLock("s1", t0 + 1700)).toBeNull();
  });

  it("failed acquisition returns a harmless release()", () => {
    acquireServerLock("s1", "restore");
    const b = acquireServerLock("s1", "backup");
    b.release();
    expect(getServerLock("s1")?.op).toBe("restore");
  });

  it("explains what is running", () => {
    expect(busyMessage("restore")).toMatch(/restored/);
    expect(busyMessage("custom-op")).toMatch(/custom-op/);
  });
});
