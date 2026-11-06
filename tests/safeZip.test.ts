import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import extract, { stripEscapingSymlinks } from "../src/server/utils/safeZip";
import { makeZip } from "./helpers";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "safezip-")); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const write = (entries: Parameters<typeof makeZip>[0]) => {
  const file = path.join(tmp, "a.zip");
  fs.writeFileSync(file, makeZip(entries));
  return file;
};

describe("safeExtractZip", () => {
  it("extracts normal files and keeps the executable bit", async () => {
    const zip = write([{ name: "dir/hello.txt", data: "hi" }, { name: "dir/run.sh", data: "#!/bin/sh", mode: 0o100755 }]);
    const out = path.join(tmp, "out");
    await extract(zip, { dir: out });
    expect(fs.readFileSync(path.join(out, "dir/hello.txt"), "utf8")).toBe("hi");
    expect(fs.statSync(path.join(out, "dir/run.sh")).mode & 0o111).not.toBe(0);
  });

  it("strips setuid / setgid bits", async () => {
    const zip = write([{ name: "x", data: "x", mode: 0o104755 }]);
    const out = path.join(tmp, "out");
    await extract(zip, { dir: out });
    expect(fs.statSync(path.join(out, "x")).mode & 0o6000).toBe(0);
  });

  it("rejects zip-slip paths and writes nothing outside", async () => {
    const zip = write([{ name: "../escaped.txt", data: "bad" }]);
    const out = path.join(tmp, "out");
    await expect(extract(zip, { dir: out })).rejects.toThrow();
    expect(fs.existsSync(path.join(tmp, "escaped.txt"))).toBe(false);
  });

  it("rejects absolute paths", async () => {
    const zip = write([{ name: "/tmp/abs-escape.txt", data: "bad" }]);
    await expect(extract(zip, { dir: path.join(tmp, "out") })).rejects.toThrow();
  });

  it("never creates symlinks and cannot be tricked into writing through one", async () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    const zip = write([
      { name: "link", data: outside, mode: 0o120777 }, // symlink entry -> outside
      { name: "link/pwned.txt", data: "x" },           // would write through it
    ]);
    const out = path.join(tmp, "out");
    await extract(zip, { dir: out });
    expect(fs.lstatSync(path.join(out, "link")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(outside, "pwned.txt"))).toBe(false);
  });
});

describe("stripEscapingSymlinks", () => {
  it("removes symlinks that point outside, keeps harmless ones", async () => {
    const dir = path.join(tmp, "srv");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "real.txt"), "ok");
    fs.symlinkSync("/etc", path.join(dir, "evil"));
    fs.symlinkSync(path.join(dir, "real.txt"), path.join(dir, "good"));
    expect(await stripEscapingSymlinks(dir)).toBe(1);
    expect(fs.existsSync(path.join(dir, "evil"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "good"))).toBe(true);
  });
});
