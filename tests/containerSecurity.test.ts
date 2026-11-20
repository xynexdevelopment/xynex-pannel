import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runtimeHardening, installerHardening, validateMountPaths, hardeningDisabled } from "../src/server/utils/containerSecurity";

describe("container hardening", () => {
  it("applies safe defaults to runtime containers", () => {
    const hc = runtimeHardening({});
    expect(hc.Privileged).toBe(false);
    expect(hc.SecurityOpt).toContain("no-new-privileges:true");
    expect(hc.CapDrop).toEqual(expect.arrayContaining(["NET_RAW", "MKNOD", "SETPCAP", "SETFCAP"]));
    // The images still have to chown /data and drop from root, so these stay available by default.
    expect(hc.CapDrop).not.toContain("DAC_OVERRIDE");
    expect(hc.CapDrop).not.toContain("FOWNER");
    expect(hc.PidsLimit).toBe(1024);
    expect(hc.Ulimits[0]).toMatchObject({ Name: "nofile", Soft: 65536, Hard: 65536 });
    expect(hc.ReadonlyRootfs).toBeUndefined();
  });

  it("strict mode drops the extra capabilities", () => {
    const hc = runtimeHardening({ CONTAINER_CAP_DROP_STRICT: "true" });
    expect(hc.CapDrop).toEqual(expect.arrayContaining(["DAC_OVERRIDE", "FOWNER", "NET_BIND_SERVICE"]));
  });

  it("read-only rootfs is opt-in and brings a tmpfs /tmp", () => {
    const hc = runtimeHardening({ CONTAINER_READONLY_ROOTFS: "true" });
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.Tmpfs["/tmp"]).toContain("nosuid");
  });

  it("numeric limits come from env but ignore junk and out-of-range values", () => {
    expect(runtimeHardening({ CONTAINER_PIDS_LIMIT: "2048" }).PidsLimit).toBe(2048);
    expect(runtimeHardening({ CONTAINER_PIDS_LIMIT: "abc" }).PidsLimit).toBe(1024);
    expect(runtimeHardening({ CONTAINER_PIDS_LIMIT: "3" }).PidsLimit).toBe(1024);
    expect(runtimeHardening({ CONTAINER_NOFILE_LIMIT: "100" }).Ulimits[0].Soft).toBe(65536);
  });

  it("CONTAINER_HARDENING=off is the explicit escape hatch", () => {
    expect(hardeningDisabled({ CONTAINER_HARDENING: "off" })).toBe(true);
    expect(runtimeHardening({ CONTAINER_HARDENING: "OFF" })).toEqual({});
    expect(installerHardening({ CONTAINER_HARDENING: "off" })).toEqual({});
  });

  it("install containers get a lighter profile", () => {
    const hc = installerHardening({});
    expect(hc.SecurityOpt).toContain("no-new-privileges:true");
    expect(hc.CapDrop).toContain("NET_RAW");
    expect(hc.CapDrop).not.toContain("SYS_CHROOT");
    expect(hc.PidsLimit).toBe(2048);
  });
});

describe("mount validation", () => {
  let tmp: string;
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xynex-mount-")); });
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const ok = (src: string, dst: string, opts = {}) => validateMountPaths(src, dst, opts);

  it("accepts an ordinary shared folder", () => {
    const dir = path.join(tmp, "shared-cache");
    fs.mkdirSync(dir);
    const r = ok(dir, "/mnt/shared-cache");
    expect(r.ok).toBe(true);
    expect(r.target).toBe("/mnt/shared-cache");
  });

  it("accepts a folder that does not exist yet (it is created later)", () => {
    expect(ok(path.join(tmp, "new", "deep"), "/mnt/x").ok).toBe(true);
  });

  it.each([
    ["/", "host root"],
    ["/etc", "etc"],
    ["/etc/ssh", "inside etc"],
    ["/root", "root home"],
    ["/proc", "proc"],
    ["/sys/kernel", "sys"],
    ["/dev", "dev"],
    ["/var/run/docker.sock", "docker socket (var/run)"],
    ["/run/docker.sock", "docker socket (run)"],
    ["/var/lib/docker", "docker storage"],
    ["/usr/bin", "usr"],
    ["/opt/some.sock", "any socket"],
  ])("rejects host path %s (%s)", (src) => {
    expect(ok(src, "/mnt/x").ok).toBe(false);
  });

  it("rejects bind-string injection through ':' ',' and control characters", () => {
    expect(ok("/srv/a:/etc:rw", "/mnt/x").ok).toBe(false);
    expect(ok(path.join(tmp, "a"), "/mnt/x:/etc").ok).toBe(false);
    expect(ok("/srv/a,b", "/mnt/x").ok).toBe(false);
    expect(ok("/srv/a\nb", "/mnt/x").ok).toBe(false);
    expect(ok("/srv/a\0b", "/mnt/x").ok).toBe(false);
  });

  it("rejects relative and non-string paths", () => {
    expect(ok("relative/dir", "/mnt/x").ok).toBe(false);
    expect(ok(tmp, "relative").ok).toBe(false);
    expect(validateMountPaths(undefined, "/mnt/x").ok).toBe(false);
    expect(validateMountPaths(tmp, 5).ok).toBe(false);
    expect(ok(tmp, "").ok).toBe(false);
  });

  it("is not fooled by a symlink pointing at a blocked directory", () => {
    const link = path.join(tmp, "innocent");
    fs.symlinkSync("/etc", link);
    expect(ok(link, "/mnt/x").ok).toBe(false);
    expect(ok(path.join(link, "ssh"), "/mnt/x").ok).toBe(false);
  });

  it("protects the panel data directory in both directions, and refuses to contain the install folder", () => {
    const install = path.join(tmp, "panel");
    const data = path.join(install, ".data");
    fs.mkdirSync(path.join(data, "servers"), { recursive: true });
    const policy = { protectedPaths: [data], containmentOnly: [install] };
    expect(ok(data, "/mnt/x", policy).ok).toBe(false);                       // the data dir itself
    expect(ok(path.join(data, "servers"), "/mnt/x", policy).ok).toBe(false);  // inside it
    expect(ok(install, "/mnt/x", policy).ok).toBe(false);                    // contains it
    expect(ok(tmp, "/mnt/x", policy).ok).toBe(false);                        // grandparent contains it
    const sibling = path.join(install, "shared"); fs.mkdirSync(sibling);
    expect(ok(sibling, "/mnt/x", policy).ok).toBe(true);                     // sub-folder of the install dir stays allowed
  });

  it("enforces MOUNT_ALLOWED_ROOTS when configured", () => {
    const allowed = path.join(tmp, "allowed"); fs.mkdirSync(path.join(allowed, "x"), { recursive: true });
    const other = path.join(tmp, "other"); fs.mkdirSync(other);
    expect(ok(path.join(allowed, "x"), "/mnt/x", { allowedRoots: [allowed] }).ok).toBe(true);
    expect(ok(other, "/mnt/x", { allowedRoots: [allowed] }).ok).toBe(false);
  });

  it.each(["/", "/data", "/server", "/mnt/server", "/home/container", "/etc", "/etc/passwd", "/proc/x", "/dev/shm", "/var/run"])(
    "rejects reserved container target %s", (target) => {
      expect(ok(tmp, target).ok).toBe(false);
    });

  it("normalizes the target and rejects '..'", () => {
    expect(ok(tmp, "/mnt//cache/").target).toBe("/mnt/cache");
    expect(ok(tmp, "/mnt/../etc").ok).toBe(false);
  });
});
