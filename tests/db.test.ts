import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xynex-db-"));
const cwd = process.cwd();
let db: typeof import("../src/server/services/db");

beforeAll(async () => {
  process.chdir(tmp);
  db = await import("../src/server/services/db");
});
afterAll(() => { process.chdir(cwd); fs.removeSync(tmp); });

describe("db", () => {
  it("rejects file names that could escape the data directory", async () => {
    await expect(db.writeJSON("../evil.json", {})).rejects.toThrow();
    await expect(db.readJSON("../../etc/passwd")).rejects.toThrow();
  });
  it("round-trips data and leaves no temp files", async () => {
    await db.writeJSON("t.json", [{ a: 1 }]);
    expect(await db.readJSON("t.json")).toEqual([{ a: 1 }]);
    expect(fs.readdirSync(path.join(tmp, ".data")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
  it("writes files owner-only (0600)", async () => {
    await db.writeJSON("perm.json", {});
    const mode = fs.statSync(path.join(tmp, ".data", "perm.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
  it("serialises concurrent updates without losing any", async () => {
    await db.writeJSON("n.json", { n: 0 });
    await Promise.all(Array.from({ length: 25 }, () => db.updateJSON("n.json", { n: 0 }, (c: any) => ({ n: c.n + 1 }))));
    expect((await db.readJSON("n.json")).n).toBe(25);
  });
  it("keeps a copy of a corrupt file instead of silently discarding it", async () => {
    fs.writeFileSync(path.join(tmp, ".data", "bad.json"), "{not json");
    expect(await db.readJSON("bad.json")).toBeNull();
    expect(fs.readdirSync(path.join(tmp, ".data")).some((f) => f.startsWith("bad.json.corrupt-"))).toBe(true);
  });
});
