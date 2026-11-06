import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";
import bcrypt from "bcryptjs";
import ssh2 from "ssh2";
import type { AddressInfo } from "net";

const { Client } = ssh2;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xynex-sftp-"));
const cwd = process.cwd();
let db: typeof import("../src/server/services/db");
let mod: typeof import("../src/server/services/sftp");
let stop: () => Promise<void>;
let port: number;
const PASS = "s3cret-pass!";
const root = () => path.join(tmp, ".data", "servers", "srv-a");

async function connect(username = "srv_test", password = PASS): Promise<{ conn: any; sftp: any }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on("ready", () => conn.sftp((err: any, sftp: any) => (err ? reject(err) : resolve({ conn, sftp }))));
    conn.on("error", reject);
    conn.connect({ host: "127.0.0.1", port, username, password, readyTimeout: 5000 });
  });
}
const p = <T>(fn: (cb: (err: any, v?: T) => void) => void) => new Promise<T>((res, rej) => fn((e, v) => (e ? rej(e) : res(v as T))));

beforeAll(async () => {
  process.chdir(tmp);
  db = await import("../src/server/services/db");
  mod = await import("../src/server/services/sftp");
  const created = await mod.createSftpServer();
  stop = created.stop;
  await new Promise<void>((r) => created.server.listen(0, "127.0.0.1", () => r()));
  port = (created.server.address() as AddressInfo).port;
});
afterAll(async () => { await stop(); process.chdir(cwd); fs.removeSync(tmp); });

beforeEach(async () => {
  fs.removeSync(path.join(tmp, ".data", "servers"));
  fs.ensureDirSync(path.join(root(), "world"));
  fs.writeFileSync(path.join(root(), "server.properties"), "motd=hi");
  fs.ensureDirSync(path.join(tmp, "outside"));
  fs.writeFileSync(path.join(tmp, "outside", "secret.txt"), "TOP SECRET");
  await db.writeJSON("servers.json", [{ id: "srv-a", owner: "x" }]);
  await db.writeJSON("sftp_users.json", [{ id: "1", serverId: "srv-a", username: "srv_test", passwordHash: await bcrypt.hash(PASS, 4) }]);
  for (const t of [mod.sftpIpAttempts, mod.sftpUserAttempts]) { t.reset("ip:127.0.0.1"); t.reset("user:srv_test"); t.reset("user:nobody"); }
});

describe("SFTP server", () => {
  it("rejects wrong passwords and unknown users; accepts the right one", async () => {
    await expect(connect("srv_test", "wrong")).rejects.toBeTruthy();
    await expect(connect("nobody", PASS)).rejects.toBeTruthy();
    const { conn } = await connect(); conn.end();
  });

  it("lists, reads, writes, renames, creates folders and deletes inside the server folder", async () => {
    const { conn, sftp } = await connect();
    const names = (await p<any[]>((cb) => sftp.readdir("/", cb))).map((e) => e.filename).sort();
    expect(names).toEqual(["server.properties", "world"]);
    expect((await p<Buffer>((cb) => sftp.readFile("/server.properties", cb))).toString()).toBe("motd=hi");

    await p((cb) => sftp.writeFile("/world/new.txt", Buffer.from("hello sftp"), cb));
    expect(fs.readFileSync(path.join(root(), "world", "new.txt"), "utf8")).toBe("hello sftp");
    await p((cb) => sftp.mkdir("/plugins", cb));
    await p((cb) => sftp.rename("/world/new.txt", "/plugins/moved.txt", cb));
    expect(fs.existsSync(path.join(root(), "plugins", "moved.txt"))).toBe(true);
    const st = await p<any>((cb) => sftp.stat("/plugins/moved.txt", cb));
    expect(st.size).toBe(10);
    await p((cb) => sftp.unlink("/plugins/moved.txt", cb));
    await p((cb) => sftp.rmdir("/plugins", cb));
    expect(fs.existsSync(path.join(root(), "plugins"))).toBe(false);
    conn.end();
  });

  it("cannot escape the folder: traversal, absolute paths and symlinks", async () => {
    fs.symlinkSync(path.join(tmp, "outside"), path.join(root(), "escape"));
    const { conn, sftp } = await connect();
    await expect(p((cb) => sftp.readFile("/../../outside/secret.txt", cb))).rejects.toBeTruthy();
    await expect(p((cb) => sftp.readFile("/escape/secret.txt", cb))).rejects.toBeTruthy();
    await expect(p((cb) => sftp.writeFile("/escape/planted.txt", Buffer.from("x"), cb))).rejects.toBeTruthy();
    expect(fs.existsSync(path.join(tmp, "outside", "planted.txt"))).toBe(false);
    // the escaping link is not even listed
    const names = (await p<any[]>((cb) => sftp.readdir("/", cb))).map((e) => e.filename);
    expect(names).not.toContain("escape");
    // "/etc/passwd" is resolved INSIDE the jail, so it simply does not exist there
    await expect(p((cb) => sftp.readFile("/etc/passwd", cb))).rejects.toBeTruthy();
    // clients cannot create symlinks to build their own escape
    await expect(p((cb) => sftp.symlink("/etc", "/mylink", cb))).rejects.toBeTruthy();
    expect(fs.existsSync(path.join(root(), "mylink"))).toBe(false);
    conn.end();
  });

  it("O_NOFOLLOW: a path swapped for a symlink after the containment check is refused, not followed", async () => {
    // an in-jail symlink passes the containment check (it points inside); open() must still refuse to follow it
    fs.symlinkSync(path.join(root(), "server.properties"), path.join(root(), "swapped"));
    const { conn, sftp } = await connect();
    await expect(p((cb) => sftp.readFile("/swapped", cb))).rejects.toBeTruthy();
    await expect(p((cb) => sftp.writeFile("/swapped", Buffer.from("x"), cb))).rejects.toBeTruthy();
    expect(fs.readFileSync(path.join(root(), "server.properties"), "utf8")).toBe("motd=hi");
    // regular files are unaffected
    expect((await p<Buffer>((cb) => sftp.readFile("/server.properties", cb))).toString()).toBe("motd=hi");
    conn.end();
  });

  it("protects the root and never overwrites on rename", async () => {
    const { conn, sftp } = await connect();
    await expect(p((cb) => sftp.rmdir("/", cb))).rejects.toBeTruthy();
    await expect(p((cb) => sftp.rename("/", "/world/x", cb))).rejects.toBeTruthy();
    fs.writeFileSync(path.join(root(), "a.txt"), "A");
    fs.writeFileSync(path.join(root(), "b.txt"), "B");
    await expect(p((cb) => sftp.rename("/a.txt", "/b.txt", cb))).rejects.toBeTruthy();
    expect(fs.readFileSync(path.join(root(), "b.txt"), "utf8")).toBe("B");
    conn.end();
  });

  it("throttles repeated bad passwords per account, even for the right password afterwards", async () => {
    for (let i = 0; i < 10; i++) await connect("srv_test", "bad" + i).catch(() => undefined);
    await expect(connect("srv_test", PASS)).rejects.toBeTruthy();
    mod.sftpUserAttempts.reset("user:srv_test");
    mod.sftpIpAttempts.reset("ip:127.0.0.1");
    const { conn } = await connect(); conn.end();
  });

  it("has no shell / exec", async () => {
    const { conn } = await connect();
    await expect(new Promise((res, rej) => conn.exec("id", (e: any, s: any) => (e ? rej(e) : res(s))))).rejects.toBeTruthy();
    conn.end();
  });
});
