import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";
import express from "express";
import jwt from "jsonwebtoken";
import type { AddressInfo } from "net";
import type { Server } from "http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xynex-paths-"));
const cwd = process.cwd();
let sec: typeof import("../src/server/utils/security");
let db: typeof import("../src/server/services/db");
let http: Server;
let base: string;
const SECRET = "z".repeat(40);

const tokenFor = (id: string, role = "user") => jwt.sign({ id, username: id, role, passwordVersion: 0 }, SECRET, { expiresIn: "1h" });
const authz = (id: string) => ({ Authorization: `Bearer ${tokenFor(id)}` });
const serverDir = (id: string) => path.join(tmp, ".data", "servers", id);

beforeAll(async () => {
  process.chdir(tmp);
  process.env.JWT_SECRET = SECRET;
  process.env.MAX_UPLOAD_BYTES = "2048";
  sec = await import("../src/server/utils/security");
  db = await import("../src/server/services/db");
  const router = (await import("../src/server/routes/servers")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/servers", router);
  await new Promise<void>((r) => { http = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/servers`;
});
afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()));
  process.chdir(cwd);
  fs.removeSync(tmp);
});

beforeEach(async () => {
  fs.removeSync(path.join(tmp, ".data", "servers"));
  fs.removeSync(path.join(tmp, "outside"));
  fs.ensureDirSync(path.join(tmp, "outside"));
  fs.writeFileSync(path.join(tmp, "outside", "secret.txt"), "TOP SECRET");
  await db.writeJSON("users.json", [
    { id: "alice", username: "alice", role: "user", passwordVersion: 0 },
    { id: "mallory", username: "mallory", role: "user", passwordVersion: 0 },
  ]);
  await db.writeJSON("servers.json", [
    { id: "srv-a", owner: "alice", name: "A" },
    { id: "srv-b", owner: "mallory", name: "B" },
  ]);
  for (const id of ["srv-a", "srv-b"]) {
    fs.ensureDirSync(path.join(serverDir(id), "world"));
    fs.writeFileSync(path.join(serverDir(id), "server.properties"), "motd=hi");
    fs.writeFileSync(path.join(serverDir(id), "world", "level.dat"), "data");
  }
});

describe("path helpers (adversarial input)", () => {
  const root = () => path.join(tmp, ".data", "servers", "srv-a");

  it("rejects NUL bytes, non-strings and traversal; keeps legitimate paths", () => {
    expect(sec.resolveUserPath(root(), "world/level.dat")).toBe(path.join(root(), "world", "level.dat"));
    expect(sec.resolveUserPath(root(), "/world/level.dat")).toBe(path.join(root(), "world", "level.dat"));
    expect(sec.resolveUserPath(root(), "../srv-b/server.properties")).toBeNull();
    expect(sec.resolveUserPath(root(), "world/../../srv-b")).toBeNull();
    expect(sec.resolveUserPath(root(), "a\0b")).toBeNull();
    expect(sec.resolveUserPath(root(), { toString: () => "x" })).toBeNull();
    expect(sec.resolveUserPath(root(), ["../x"])).toBeNull();
    expect(sec.isInside(root(), path.join(root(), "ok\0.txt"))).toBe(false);
  });

  it("treats absolute paths as relative to the root (no escape) and decodes nothing twice", () => {
    expect(sec.resolveUserPath(root(), "/etc/passwd")).toBe(path.join(root(), "etc", "passwd"));
    // a literal "%2e%2e%2f" is just a filename; only the real decoded "../" is dangerous
    expect(sec.resolveUserPath(root(), decodeURIComponent("%2e%2e%2f%2e%2e%2fsecret"))).toBeNull();
    expect(sec.resolveUserPath(root(), "%2e%2e%2fsecret")).toBe(path.join(root(), "%2e%2e%2fsecret"));
    // backslashes are ordinary characters on Linux, never separators
    expect(sec.resolveUserPath(root(), "..\\..\\secret")).toBe(path.join(root(), "..\\..\\secret"));
  });

  it("file names that merely START with two dots are legitimate; real parent references never are", () => {
    for (const ok of ["..hidden", "...", "..a/b", "dir/..config"]) {
      expect(sec.resolveUserPath(root(), ok), ok).toBe(path.join(root(), ok));
    }
    for (const bad of ["..", "../", "../x", "a/../../x", "./../x", "a/b/../../../x", "..//x", ".//../x"]) {
      expect(sec.resolveUserPath(root(), bad), bad).toBeNull();
    }
    expect(sec.safeResolve(root(), "..hidden")).toBe(path.join(root(), "..hidden"));
    expect(sec.safeResolve(root(), "../x")).toBeNull();
    expect(sec.safeResolve(root(), "a", "..", "..", "x")).toBeNull();
  });

  it("rejects symlink escapes (directory and file), including ones created after the fact", () => {
    fs.ensureDirSync(root());
    fs.symlinkSync(path.join(tmp, "outside"), path.join(root(), "link-dir"));
    fs.symlinkSync(path.join(tmp, "outside", "secret.txt"), path.join(root(), "link-file"));
    expect(sec.resolveUserPath(root(), "link-dir")).toBeNull();
    expect(sec.resolveUserPath(root(), "link-dir/secret.txt")).toBeNull();
    expect(sec.resolveUserPath(root(), "link-dir/new-file-that-does-not-exist")).toBeNull();
    expect(sec.resolveUserPath(root(), "link-file")).toBeNull();
  });

  it("serverRoot refuses ids that are not plain tokens", () => {
    expect(() => sec.serverRoot("../srv-b")).toThrow();
    expect(() => sec.serverRoot("a/b")).toThrow();
    expect(() => sec.serverRoot("")).toThrow();
    expect(sec.serverRoot("srv-a")).toBe(root());
  });
});

describe("DELETE /files", () => {
  const del = (id: string, body: any, user = "alice") =>
    fetch(`${base}/${id}/files`, { method: "DELETE", headers: { ...authz(user), "content-type": "application/json" }, body: JSON.stringify(body) });

  it("REGRESSION: path '/' no longer wipes the whole server directory", async () => {
    for (const p of ["/", "", ".", "./", "world/..", "//"]) {
      const r = await del("srv-a", { paths: [p] });
      expect(r.status, `path ${JSON.stringify(p)}`).toBe(400);
    }
    expect(fs.existsSync(path.join(serverDir("srv-a"), "server.properties"))).toBe(true);
  });

  it("deletes a legitimate file and folder", async () => {
    expect((await del("srv-a", { paths: ["/server.properties", "/world"] })).status).toBe(200);
    expect(fs.existsSync(path.join(serverDir("srv-a"), "server.properties"))).toBe(false);
    expect(fs.existsSync(path.join(serverDir("srv-a"), "world"))).toBe(false);
  });

  it("validates ALL paths first: one bad entry means nothing is deleted", async () => {
    const r = await del("srv-a", { paths: ["/server.properties", "/../srv-b/server.properties"] });
    expect(r.status).toBe(403);
    expect(fs.existsSync(path.join(serverDir("srv-a"), "server.properties"))).toBe(true);
    expect(fs.existsSync(path.join(serverDir("srv-b"), "server.properties"))).toBe(true);
  });

  it("rejects non-array / non-string input (a string used to be iterated per character)", async () => {
    expect((await del("srv-a", { paths: "world" })).status).toBe(400);
    expect((await del("srv-a", { paths: [{ a: 1 }] })).status).toBe(400);
    expect((await del("srv-a", {})).status).toBe(400);
    expect(fs.existsSync(path.join(serverDir("srv-a"), "world"))).toBe(true);
  });

  it("cannot reach through a symlink that points outside the server", async () => {
    fs.symlinkSync(path.join(tmp, "outside"), path.join(serverDir("srv-a"), "escape"));
    const r = await del("srv-a", { paths: ["/escape/secret.txt"] });
    expect(r.status).toBe(403);
    expect(fs.readFileSync(path.join(tmp, "outside", "secret.txt"), "utf8")).toBe("TOP SECRET");
  });

  it("tenant isolation: another user's server is 403, an unknown server 404, a hostile id 400, no token 401", async () => {
    expect((await del("srv-b", { paths: ["/server.properties"] }, "alice")).status).toBe(403);
    expect(fs.existsSync(path.join(serverDir("srv-b"), "server.properties"))).toBe(true);
    expect((await del("nope", { paths: ["/x"] })).status).toBe(404);
    expect((await del("..%2Fsrv-b", { paths: ["/x"] })).status).toBe(400);
    expect((await fetch(`${base}/srv-a/files`, { method: "DELETE" })).status).toBe(401);
  });
});

describe("file listing / save / rename traversal", () => {
  const h = (u = "alice") => ({ ...authz(u), "content-type": "application/json" });

  it("blocks traversal on list, save, create, mkdir and rename", async () => {
    expect((await fetch(`${base}/srv-a/files?path=${encodeURIComponent("../srv-b")}`, { headers: h() })).status).toBe(403);
    expect((await fetch(`${base}/srv-a/files?path=${encodeURIComponent("../../../../etc")}`, { headers: h() })).status).toBe(403);
    for (const [p, body] of [
      ["files/save", { filePath: "../srv-b/pwn.txt", content: "x" }],
      ["files/create", { filePath: "../srv-b/pwn.txt" }],
      ["files/mkdir", { filePath: "../srv-b/pwned" }],
      ["files/rename", { oldPath: "server.properties", newPath: "../srv-b/stolen.txt" }],
    ] as const) {
      const r = await fetch(`${base}/srv-a/${p}`, { method: "POST", headers: h(), body: JSON.stringify(body) });
      expect(r.status, p).toBe(403);
    }
    expect(fs.readdirSync(serverDir("srv-b")).sort()).toEqual(["server.properties", "world"]);
  });

  it("still lets legitimate edits through", async () => {
    const r = await fetch(`${base}/srv-a/files/save`, { method: "POST", headers: h(), body: JSON.stringify({ filePath: "/server.properties", content: "motd=new" }) });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(serverDir("srv-a"), "server.properties"), "utf8")).toBe("motd=new");
  });
});

describe("uploads", () => {
  const form = (fields: Record<string, string>, file?: { name: string; data: string; field: string }) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    if (file) f.append(file.field, new Blob([file.data]), file.name);
    return f;
  };
  const tempLeft = () => (fs.existsSync(path.join(tmp, ".data", "temp")) ? fs.readdirSync(path.join(tmp, ".data", "temp")).length : 0);

  it("single upload: stores the file under its basename inside the server dir only", async () => {
    const r = await fetch(`${base}/srv-a/files/upload`, { method: "POST", headers: authz("alice"), body: form({ path: "/world" }, { field: "file", name: "../../evil.txt", data: "hello" }) });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(serverDir("srv-a"), "world", "evil.txt"), "utf8")).toBe("hello");
    expect(fs.existsSync(path.join(tmp, "evil.txt"))).toBe(false);
  });

  it("single upload: traversal in the target folder is refused and the temp file is cleaned up", async () => {
    const before = tempLeft();
    const r = await fetch(`${base}/srv-a/files/upload`, { method: "POST", headers: authz("alice"), body: form({ path: "../srv-b" }, { field: "file", name: "x.txt", data: "hello" }) });
    expect(r.status).toBe(403);
    expect(fs.existsSync(path.join(serverDir("srv-b"), "x.txt"))).toBe(false);
    expect(tempLeft()).toBe(before);
  });

  it("enforces the single-request size cap with a clean 413", async () => {
    const r = await fetch(`${base}/srv-a/files/upload`, { method: "POST", headers: authz("alice"), body: form({ path: "/" }, { field: "file", name: "big.bin", data: "x".repeat(5000) }) });
    expect(r.status).toBe(413);
    expect(fs.existsSync(path.join(serverDir("srv-a"), "big.bin"))).toBe(false);
  });

  it("REGRESSION: two concurrent chunked uploads of the same file name do not corrupt each other", async () => {
    const chunk = (uploadId: string, i: number, data: string) =>
      fetch(`${base}/srv-a/files/upload-chunk`, { method: "POST", headers: authz("alice"), body: form({ uploadId, chunkIndex: String(i), fileName: "pack.bin", path: "/" }, { field: "chunk", name: "blob", data }) });
    expect((await chunk("up-A", 0, "AAA")).status).toBe(200);
    expect((await chunk("up-B", 0, "BBB")).status).toBe(200);
    expect((await chunk("up-A", 1, "aaa")).status).toBe(200);
    expect((await chunk("up-B", 1, "bbb")).status).toBe(200);
    const done = (uploadId: string) => fetch(`${base}/srv-a/files/upload-complete`, { method: "POST", headers: { ...authz("alice"), "content-type": "application/json" }, body: JSON.stringify({ uploadId, fileName: "pack.bin", path: "/", totalChunks: 2 }) });
    expect((await done("up-A")).status).toBe(200);
    expect(fs.readFileSync(path.join(serverDir("srv-a"), "pack.bin"), "utf8")).toBe("AAAaaa");
    expect((await done("up-B")).status).toBe(200);
    expect(fs.readFileSync(path.join(serverDir("srv-a"), "pack.bin"), "utf8")).toBe("BBBbbb");
  });

  it("chunk upload rejects hostile upload ids / folders and leaves no temp files behind", async () => {
    const before = tempLeft();
    const bad = (fields: Record<string, string>) =>
      fetch(`${base}/srv-a/files/upload-chunk`, { method: "POST", headers: authz("alice"), body: form(fields, { field: "chunk", name: "blob", data: "zzz" }) });
    expect((await bad({ uploadId: "../../x", chunkIndex: "0", fileName: "p.bin", path: "/" })).status).toBe(400);
    expect((await bad({ uploadId: "ok", chunkIndex: "0", fileName: "p.bin", path: "../srv-b" })).status).toBe(403);
    expect(fs.readdirSync(serverDir("srv-b")).sort()).toEqual(["server.properties", "world"]);
    expect(tempLeft()).toBe(before);
  });
});
