import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const bcrypt = require("bcryptjs"); const speakeasy = require("speakeasy"); const { Client } = require("ssh2");

const PORT = 6796, SFTP = 6896, BASE = `http://127.0.0.1:${PORT}/api`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
const results = []; let proc;
const ok = (name, cond, extra = "") => { results.push([cond, name, extra]); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (method, url, { token, body, headers } = {}) => {
  const r = await fetch(BASE + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data, headers: r.headers };
};
async function boot() {
  proc = spawn("node", [path.resolve("dist/server.cjs")], { cwd: dir, env: { ...process.env, PORT: String(PORT), SFTP_PORT: String(SFTP), NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", () => {}); proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + "/health"); if (r.ok) return; } catch {} await sleep(250); }
  throw new Error("server did not start");
}
async function stop() { const t0 = Date.now(); proc.kill("SIGTERM"); const code = await new Promise((r) => proc.on("exit", r)); return { code, ms: Date.now() - t0 }; }
async function solve() {
  const c = (await j("POST", "/auth/captcha")).data;
  const opt = c.options.find((o) => o.emoji === c.target);
  const v = await j("POST", "/auth/captcha/verify", { body: { challengeId: c.challengeId, optionId: opt.id } });
  if (v.status !== 200) throw new Error("captcha verify failed");
  return c.challengeId;
}
const login = async (username, password) => j("POST", "/auth/login", { body: { username, password, challengeId: await solve() } });

try {
  await boot();
  ok("server boots, /health 200", (await j("GET", "/health")).status === 200);

  // --- register + login
  const reg = await j("POST", "/auth/register", { body: { username: "alice", password: "Str0ng-pass-123", confirmPassword: "Str0ng-pass-123" } });
  ok("register works", reg.status === 200 || reg.status === 201, `status ${reg.status} role=${reg.data?.user?.role}`);
  const l1 = await login("alice", "Str0ng-pass-123");
  ok("login returns token", l1.status === 200 && !!l1.data.token, `status ${l1.status}`);
  const T = l1.data.token;
  ok("/me with token", (await j("GET", "/auth/me", { token: T })).status === 200);
  ok("/me without token = 401", (await j("GET", "/auth/me")).status === 401);
  ok("login without captcha rejected", (await j("POST", "/auth/login", { body: { username: "alice", password: "Str0ng-pass-123" } })).status === 400);

  // --- forged google login
  const g = await j("POST", "/auth/google", { body: { email: "alice@evil.io", googleId: "x" } });
  ok("forged Google login gives NO token", g.status >= 400 && !g.data?.token, `status ${g.status}`);

  // --- 2FA with real TOTP codes
  const setup = await j("POST", "/auth/2fa/setup", { token: T });
  const secret = setup.data?.secret || setup.data?.base32;
  ok("2FA setup returns secret", setup.status === 200 && !!secret, `status ${setup.status}`);
  const code = (off = 0) => speakeasy.totp({ secret, encoding: "base32", time: Date.now() / 1000 + off * 30 });
  const conf = await j("POST", "/auth/2fa/confirm", { token: T, body: { code: code() } });
  ok("2FA confirm", conf.status === 200, `status ${conf.status}`);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, ".data", "users.json"), "utf8"));
  ok("2FA seed is encrypted on disk", String(stored[0].twoFactorSecret).startsWith("enc:v1:") && !JSON.stringify(stored).includes(secret));
  const l2 = await login("alice", "Str0ng-pass-123");
  ok("login now needs 2FA", l2.data?.requires2FA === true);
  const v1 = await j("POST", "/auth/2fa/verify-login", { body: { tempToken: l2.data.tempToken, code: code() } });
  ok("2FA code accepted", v1.status === 200 && !!v1.data.token, `status ${v1.status}`);
  const l3 = await login("alice", "Str0ng-pass-123");
  const replay = await j("POST", "/auth/2fa/verify-login", { body: { tempToken: l3.data.tempToken, code: code() } });
  ok("same 2FA code replay REJECTED", replay.status === 401, `status ${replay.status}`);
  const T2 = v1.data.token;

  // --- logout revokes just that token; logout-all kills the rest
  const l4 = await login("alice", "Str0ng-pass-123");
  const v4 = await j("POST", "/auth/2fa/verify-login", { body: { tempToken: l4.data.tempToken, code: code(1) } });
  const T3 = v4.data?.token;
  ok("second session works", (await j("GET", "/auth/me", { token: T3 })).status === 200);
  await j("POST", "/auth/logout", { token: T3 });
  ok("after logout that token = 401", (await j("GET", "/auth/me", { token: T3 })).status === 401);
  ok("other session still valid", (await j("GET", "/auth/me", { token: T2 })).status === 200);
  await j("POST", "/auth/logout-all", { token: T2 });
  ok("after logout-all old tokens = 401", (await j("GET", "/auth/me", { token: T2 })).status === 401);

  // --- seed a server + sftp user, restart, test file API + real SFTP
  const users = JSON.parse(fs.readFileSync(path.join(dir, ".data", "users.json"), "utf8"));
  const uid = users[0].id;
  // remove 2FA for simpler login afterwards
  users[0].role = "admin"; delete users[0].twoFactorEnabled; delete users[0].twoFactorSecret; delete users[0].twoFactorLastStep;
  fs.writeFileSync(path.join(dir, ".data", "users.json"), JSON.stringify(users));
  fs.writeFileSync(path.join(dir, ".data", "servers.json"), JSON.stringify([{ id: "srv-1", owner: uid, name: "Test" }]));
  fs.mkdirSync(path.join(dir, ".data", "servers", "srv-1", "world"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".data", "servers", "srv-1", "server.properties"), "motd=hello");
  fs.mkdirSync(path.join(dir, ".data", "servers", "other"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".data", "servers", "other", "secret.txt"), "OTHER TENANT");
  fs.writeFileSync(path.join(dir, ".data", "sftp_users.json"), JSON.stringify([{ id: "1", serverId: "srv-1", username: "sftp_alice", passwordHash: bcrypt.hashSync("sftp-pass", 8) }]));
  const down = await stop();
  ok("graceful shutdown (SIGTERM -> exit 0)", down.code === 0, `${down.ms} ms`);
  await boot();
  const T4 = (await login("alice", "Str0ng-pass-123")).data.token;

  // --- API keys + scopes
  const mk = await j("POST", "/admin/api-keys", { token: T4, body: { label: "ro", scopes: ["read"] } });
  const roKey = mk.data?.key || mk.data?.apiKey || mk.data?.token;
  ok("create read-only API key", mk.status < 300 && !!roKey, `status ${mk.status}`);
  if (roKey) {
    ok("read-only key can GET /me", (await j("GET", "/auth/me", { token: roKey })).status === 200);
    ok("read-only key blocked on PUT", (await j("PUT", "/auth/avatar", { token: roKey, body: { avatar: "x" } })).status === 403);
  }
  ok("bad scope rejected (400)", (await j("POST", "/admin/api-keys", { token: T4, body: { label: "x", scopes: ["root"] } })).status === 400);

  const ls = await j("GET", "/servers/srv-1/files?path=/", { token: T4 });
  ok("file list works", ls.status === 200, `status ${ls.status}`);
  ok("traversal list blocked", (await j("GET", "/servers/srv-1/files?path=" + encodeURIComponent("../other"), { token: T4 })).status === 403);
  ok("traversal save blocked", (await j("POST", "/servers/srv-1/files/save", { token: T4, body: { filePath: "../other/pwn.txt", content: "x" } })).status === 403);
  ok("other tenant's secret untouched", !fs.existsSync(path.join(dir, ".data", "servers", "other", "pwn.txt")));
  const sv = await j("POST", "/servers/srv-1/files/save", { token: T4, body: { filePath: "/server.properties", content: "motd=changed" } });
  ok("legit save works", sv.status === 200 && fs.readFileSync(path.join(dir, ".data", "servers", "srv-1", "server.properties"), "utf8") === "motd=changed");
  const delroot = await j("DELETE", "/servers/srv-1/files", { token: T4, body: { paths: ["/"] } });
  ok("DELETE '/' refused, server dir intact", delroot.status === 400 && fs.existsSync(path.join(dir, ".data", "servers", "srv-1", "world")), `status ${delroot.status}`);
  ok("DELETE legit file works", (await j("DELETE", "/servers/srv-1/files", { token: T4, body: { paths: ["/world"] } })).status === 200 && !fs.existsSync(path.join(dir, ".data", "servers", "srv-1", "world")));
  ok("unknown server = 404", (await j("GET", "/servers/nope/files?path=/", { token: T4 })).status === 404);

  // real SFTP
  const sftpConn = (u, p) => new Promise((res, rej) => { const c = new Client(); c.on("ready", () => c.sftp((e, s) => (e ? rej(e) : res({ c, s })))); c.on("error", rej); c.connect({ host: "127.0.0.1", port: SFTP, username: u, password: p, readyTimeout: 5000 }); });
  const pr = (fn) => new Promise((res, rej) => fn((e, v) => (e ? rej(e) : res(v))));
  let sf; try { sf = await sftpConn("sftp_alice", "sftp-pass"); ok("real SFTP login", true); } catch (e) { ok("real SFTP login", false, e.message); }
  if (sf) {
    await pr((cb) => sf.s.writeFile("/uploaded.txt", Buffer.from("via sftp"), cb));
    ok("SFTP upload lands in server folder", fs.readFileSync(path.join(dir, ".data", "servers", "srv-1", "uploaded.txt"), "utf8") === "via sftp");
    const back = await pr((cb) => sf.s.readFile("/server.properties", cb));
    ok("SFTP download", back.toString() === "motd=changed");
    let esc = false; try { await pr((cb) => sf.s.readFile("/../other/secret.txt", cb)); esc = true; } catch {}
    ok("SFTP cannot read other tenant (traversal)", !esc);
    sf.c.end();
  }
  // independent second SFTP implementation: curl (libssh), if this machine has it with sftp support
  const curlOk = spawnSync("curl", ["-V"]).stdout?.toString().includes("sftp");
  if (curlOk) {
    const cu = (args) => spawnSync("curl", ["-sS", "-k", "--max-time", "20", "-u", "sftp_alice:sftp-pass", ...args], { encoding: "utf8" });
    const base = `sftp://127.0.0.1:${SFTP}`;
    const srcFile = path.join(dir, "curl-src.txt"); fs.writeFileSync(srcFile, "from curl/libssh");
    const up = cu(["-T", srcFile, `${base}/curl-up.txt`]);
    ok("curl(libssh) SFTP upload", up.status === 0 && fs.existsSync(path.join(dir, ".data", "servers", "srv-1", "curl-up.txt")), up.stderr.trim().slice(0, 80));
    const dl = cu([`${base}/curl-up.txt`]);
    ok("curl(libssh) SFTP download", dl.status === 0 && dl.stdout === "from curl/libssh");
    const lsr = cu([`${base}/`]);
    ok("curl(libssh) SFTP directory listing", lsr.status === 0 && lsr.stdout.includes("server.properties"));
    const esc = cu([`${base}/../other/secret.txt`]);
    ok("curl(libssh) cannot read other tenant", !esc.stdout.includes("OTHER TENANT"));
    const badpw = spawnSync("curl", ["-sS", "-k", "--max-time", "20", "-u", "sftp_alice:nope", `${base}/server.properties`], { encoding: "utf8" });
    ok("curl(libssh) wrong password rejected", badpw.status !== 0);
  } else console.log("SKIP  curl sftp checks (curl without sftp support)");

  let bad = false; try { await sftpConn("sftp_alice", "wrong"); bad = true; } catch {}
  ok("SFTP wrong password rejected", !bad);

  // --- rate limiting for real
  const ip = {}; let first429 = null, retry = null;
  for (let i = 0; i < 9; i++) { const r = await j("POST", "/auth/login", { body: { username: "alice", password: "bad" + i, challengeId: await solve() } }); if (r.status === 429 && !first429) { first429 = i + 1; retry = r.headers.get("retry-after"); } }
  ok("brute-force login gets 429 + Retry-After", first429 !== null && Number(retry) > 0, `429 at attempt ${first429}, retry-after=${retry}s`);
  let limited = 0, retryApi = null;
  for (let i = 0; i < 330; i++) { const r = await fetch(BASE + "/health"); if (r.status === 429) { limited++; retryApi = r.headers.get("retry-after"); } }
  ok("API flood hits global limit (429)", limited > 0, `${limited} requests limited, retry-after=${retryApi}s`);

  const down2 = await stop();
  ok("final graceful shutdown", down2.code === 0, `${down2.ms} ms`);
} catch (e) {
  ok("script crashed", false, e.stack || e.message);
  try { proc.kill("SIGKILL"); } catch {}
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n==== ${results.length - failed}/${results.length} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
}
