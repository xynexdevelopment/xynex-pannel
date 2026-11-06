import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { validateConfig } from "../src/server/config";
import { backupData, restoreData } from "../src/server/utils/dataBackup";

describe("validateConfig", () => {
  it("accepts a sane configuration and the shipped .env.example values", () => {
    const r = validateConfig({ PORT: "6767", NODE_ENV: "production", TRUST_PROXY: "loopback", CSP_MODE: "enforce", JSON_BODY_LIMIT: "5mb", ALLOWED_ORIGINS: "https://panel.example.com, http://localhost:3000" } as any);
    expect(r.errors).toEqual([]);
  });
  it("reports every problem at once", () => {
    const r = validateConfig({ PORT: "abc", SFTP_PORT: "70000", CSP_MODE: "enfroce", TRUST_PROXY: "true", JSON_BODY_LIMIT: "lots", MAX_UPLOAD_BYTES: "-1", ALLOWED_ORIGINS: "panel.example.com,https://ok.example.com/path" } as any);
    expect(r.errors.length).toBeGreaterThanOrEqual(7);
  });
  it("refuses a second panel instance (state is per process) unless explicitly accepted", () => {
    expect(validateConfig({ NODE_APP_INSTANCE: "1" } as any).errors.join()).toContain("several panel instances");
    expect(validateConfig({ NODE_APP_INSTANCE: "0" } as any).errors).toEqual([]);
    expect(validateConfig({ NODE_APP_INSTANCE: "2", ALLOW_MULTI_INSTANCE: "true" } as any).errors).toEqual([]);
  });
  it("refuses dev auto-login in production, warns about short secrets", () => {
    expect(validateConfig({ NODE_ENV: "production", ALLOW_DEV_AUTO_LOGIN: "true" } as any).errors.length).toBe(1);
    expect(validateConfig({ JWT_SECRET: "short-secret-123456" } as any).warnings.length).toBe(1);
    expect(validateConfig({ PORT: "6868" } as any).errors.join()).toContain("must differ");
  });
});

describe("GET /api/health", () => {
  let http: Server; const cwd = process.cwd(); const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xynex-health-"));
  beforeAll(async () => {
    process.chdir(tmp); fs.ensureDirSync(path.join(tmp, ".data"));
    const router = (await import("../src/server/routes/health")).default;
    const app = express(); app.use("/api", router);
    await new Promise<void>((r) => { http = app.listen(0, "127.0.0.1", () => r()); });
  });
  afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); process.chdir(cwd); fs.removeSync(tmp); });
  const url = () => `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/health`;
  it("is 200 and minimal when the data dir is writable, 503 when it is not", async () => {
    const ok = await fetch(url());
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(Object.keys(body).sort()).toEqual(["dataWritable", "status", "uptimeSeconds"]);
    fs.removeSync(path.join(tmp, ".data")); fs.writeFileSync(path.join(tmp, ".data"), "not a directory");
    expect((await fetch(url())).status).toBe(503);
  });
});

describe("data backup / restore", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xynex-bak-"));
  const data = path.join(tmp, ".data");
  afterAll(() => fs.removeSync(tmp));

  it("round-trips, protects existing files without --force, and saves them aside with --force", async () => {
    fs.ensureDirSync(path.join(data, "servers", "srv-a")); fs.ensureDirSync(path.join(data, "ssh"));
    fs.writeFileSync(path.join(data, "users.json"), JSON.stringify([{ id: "u1" }]));
    fs.writeFileSync(path.join(data, "settings.json"), "{}");
    fs.writeFileSync(path.join(data, "jwt.secret"), "s".repeat(64));
    fs.writeFileSync(path.join(data, "servers", "srv-a", "world.dat"), "GAME DATA"); // must NOT be backed up

    const { file, entries } = await backupData(data, path.join(tmp, "out"));
    expect(entries.sort()).toEqual(["jwt.secret", "settings.json", "users.json"]);
    expect((fs.statSync(file).mode & 0o777)).toBe(0o600);

    fs.writeFileSync(path.join(data, "users.json"), JSON.stringify([{ id: "CHANGED" }]));
    await expect(restoreData(file, data)).rejects.toThrow(/--force/);
    expect(JSON.parse(fs.readFileSync(path.join(data, "users.json"), "utf8"))[0].id).toBe("CHANGED"); // untouched

    const r = await restoreData(file, data, { force: true });
    expect(JSON.parse(fs.readFileSync(path.join(data, "users.json"), "utf8"))[0].id).toBe("u1");
    expect(JSON.parse(fs.readFileSync(path.join(r.savedTo!, "users.json"), "utf8"))[0].id).toBe("CHANGED");
    expect(fs.readFileSync(path.join(data, "servers", "srv-a", "world.dat"), "utf8")).toBe("GAME DATA");
  });

  it("rejects an archive with corrupt JSON or no data and restores nothing", async () => {
    const { makeZip } = await import("./helpers");
    const bad = path.join(tmp, "bad.zip"); fs.writeFileSync(bad, makeZip([{ name: "users.json", data: "{not json" }]));
    const empty = path.join(tmp, "empty.zip"); fs.writeFileSync(empty, makeZip([{ name: "readme.txt", data: "x" }]));
    const target = path.join(tmp, "fresh"); 
    await expect(restoreData(bad, target)).rejects.toThrow(/not valid JSON/);
    await expect(restoreData(empty, target)).rejects.toThrow(/no panel data/);
    expect(fs.existsSync(path.join(target, "users.json"))).toBe(false);
  });

  it("ignores path-traversal entries in a hostile archive", async () => {
    const { makeZip } = await import("./helpers");
    const evil = path.join(tmp, "evil.zip");
    fs.writeFileSync(evil, makeZip([{ name: "../escaped.json", data: "{}" }, { name: "users.json", data: "[]" }]));
    await restoreData(evil, path.join(tmp, "fresh2")).catch(() => undefined);
    expect(fs.existsSync(path.join(tmp, "escaped.json"))).toBe(false);
  });
});
