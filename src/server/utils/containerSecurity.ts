import fs from "fs";
import path from "path";

/* ───────────────────────── Container hardening ─────────────────────────
   Customer workloads are untrusted. These options are merged into every
   runtime container's HostConfig. They are deliberately limited to settings
   that do not break the standard Minecraft/itzg and Pterodactyl "yolks"
   images (which still need to chown their data directory and drop from root
   to an unprivileged user, so CHOWN/SETUID/SETGID/KILL/DAC_OVERRIDE/FOWNER
   stay available unless CONTAINER_CAP_DROP_STRICT=true).

   Environment switches (all optional):
     CONTAINER_HARDENING=off          disable everything below (escape hatch)
     CONTAINER_CAP_DROP_STRICT=true   also drop DAC_OVERRIDE, FOWNER, NET_BIND_SERVICE
     CONTAINER_PIDS_LIMIT=<n>         max processes/threads per container (default 1024)
     CONTAINER_NOFILE_LIMIT=<n>       open-file ulimit (default 65536)
     CONTAINER_READONLY_ROOTFS=true   read-only root filesystem (+ tmpfs /tmp); opt-in
*/

type Env = Record<string, string | undefined>;

const BASE_CAP_DROP = ["NET_RAW", "MKNOD", "AUDIT_WRITE", "SETPCAP", "SETFCAP", "FSETID", "SYS_CHROOT"];
const STRICT_CAP_DROP = ["DAC_OVERRIDE", "FOWNER", "NET_BIND_SERVICE"];
const INSTALLER_CAP_DROP = ["NET_RAW", "MKNOD", "AUDIT_WRITE", "SETPCAP", "SETFCAP"];

const isOn = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v || "").trim().toLowerCase());
const intOr = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = parseInt(v || "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

export function hardeningDisabled(env: Env = process.env): boolean {
  return (env.CONTAINER_HARDENING || "").trim().toLowerCase() === "off";
}

/** HostConfig fragment for long-running customer server containers. */
export function runtimeHardening(env: Env = process.env): Record<string, any> {
  if (hardeningDisabled(env)) return {};
  const hc: Record<string, any> = {
    Privileged: false,
    CapDrop: isOn(env.CONTAINER_CAP_DROP_STRICT) ? [...BASE_CAP_DROP, ...STRICT_CAP_DROP] : [...BASE_CAP_DROP],
    SecurityOpt: ["no-new-privileges:true"],
    PidsLimit: intOr(env.CONTAINER_PIDS_LIMIT, 1024, 64, 4_194_304),
    Ulimits: [{ Name: "nofile", Soft: intOr(env.CONTAINER_NOFILE_LIMIT, 65536, 1024, 1_048_576), Hard: intOr(env.CONTAINER_NOFILE_LIMIT, 65536, 1024, 1_048_576) }],
  };
  if (isOn(env.CONTAINER_READONLY_ROOTFS)) {
    hc.ReadonlyRootfs = true;
    hc.Tmpfs = { "/tmp": "rw,exec,nosuid,size=256m" };
  }
  return hc;
}

/** Lighter profile for one-shot install containers (they run root-owned install scripts). */
export function installerHardening(env: Env = process.env): Record<string, any> {
  if (hardeningDisabled(env)) return {};
  return {
    Privileged: false,
    CapDrop: [...INSTALLER_CAP_DROP],
    SecurityOpt: ["no-new-privileges:true"],
    PidsLimit: intOr(env.CONTAINER_PIDS_LIMIT, 2048, 64, 4_194_304),
  };
}

/* ───────────────────────── Host mount validation ─────────────────────────
   Admin-defined "mounts" are attached to customer containers. A mount that
   exposes the Docker socket, the panel's own data (users.json, jwt.secret) or
   system directories would turn any customer server into a host compromise,
   so they are validated both when created and again when a container is
   built (older mounts.json entries are skipped, never deleted). */

const BLOCKED_SOURCE_PREFIXES = [
  "/etc", "/root", "/boot", "/proc", "/sys", "/dev", "/run", "/var/run",
  "/var/lib/docker", "/var/lib/containers", "/var/lib/kubelet",
  "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/opt/cni",
];
const BLOCKED_TARGET_PREFIXES = ["/proc", "/sys", "/dev", "/etc", "/bin", "/sbin", "/usr", "/lib", "/lib32", "/lib64", "/boot", "/root", "/run", "/var/run"];
const BLOCKED_TARGET_EXACT = new Set(["/", "/data", "/server", "/mnt/server", "/home/container", "/var", "/home", "/mnt", "/opt", "/tmp"]);

const inside = (base: string, p: string) => p === base || p.startsWith(base === "/" ? "/" : base + "/");

/** realpath of the deepest existing ancestor + the not-yet-existing remainder (so symlinks can't hide a blocked path). */
function resolveReal(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(p);
}

// Flat shape (no strictNullChecks in this project, so a discriminated union would not narrow): on failure `error` is set.
export interface MountCheck { ok: boolean; source: string; target: string; error: string }

const fail = (error: string): MountCheck => ({ ok: false, source: "", target: "", error });

export function validateMountPaths(
  sourcePath: unknown,
  targetPath: unknown,
  opts: { protectedPaths?: string[]; containmentOnly?: string[]; allowedRoots?: string[] } = {},
): MountCheck {
  if (typeof sourcePath !== "string" || typeof targetPath !== "string" || !sourcePath || !targetPath) {
    return fail("sourcePath and targetPath must be non-empty strings");
  }
  // The bind string is "source:target[:ro]" - a ':' (or control character) would inject extra options.
  const bad = /[:,\0\r\n]/;
  if (bad.test(sourcePath) || bad.test(targetPath)) {
    return fail("Mount paths may not contain ':', ',' or control characters");
  }
  if (!path.isAbsolute(sourcePath)) return fail("sourcePath must be an absolute host path");
  if (!path.posix.isAbsolute(targetPath)) return fail("targetPath must be an absolute path (e.g. /mnt/shared-cache)");

  const source = resolveReal(sourcePath);
  const target = path.posix.normalize(targetPath).replace(/\/+$/, "") || "/";
  if (target.split("/").includes("..")) return fail("targetPath may not contain '..'");

  if (source === path.parse(source).root) return fail("Mounting the host root filesystem is not allowed");
  if (/\.sock$/i.test(source) || path.basename(source) === "docker.sock") {
    return fail("Mounting a socket (e.g. the Docker socket) into customer containers is not allowed");
  }
  for (const b of BLOCKED_SOURCE_PREFIXES) {
    if (inside(b, source)) return fail(`Mounting ${b} (or anything inside it) from the host is not allowed`);
  }
  // protectedPaths (the panel's .data: users, secrets, every server and backup): the mount may neither be
  // inside nor contain them.
  for (const protectedPath of opts.protectedPaths ?? []) {
    const prot = resolveReal(protectedPath);
    if (inside(source, prot) || inside(prot, source)) {
      return fail("This host path contains (or is inside) the panel's own data and cannot be mounted");
    }
  }
  // containmentOnly (the project folder): a mount may not CONTAIN it (that would expose .env / .data), but
  // sub-folders of it stay allowed so existing setups that keep a shared folder next to the panel keep working.
  for (const containerPath of opts.containmentOnly ?? []) {
    if (inside(source, resolveReal(containerPath))) {
      return fail("This host path contains the panel's installation folder and cannot be mounted");
    }
  }
  if (opts.allowedRoots && opts.allowedRoots.length > 0) {
    const roots = opts.allowedRoots.map((r) => resolveReal(r));
    if (!roots.some((r) => inside(r, source))) {
      return fail("sourcePath is outside the directories allowed by MOUNT_ALLOWED_ROOTS");
    }
  }

  if (BLOCKED_TARGET_EXACT.has(target) || BLOCKED_TARGET_PREFIXES.some((b) => inside(b, target))) {
    return fail(`targetPath ${target} is reserved inside the container`);
  }
  return { ok: true, source, target, error: "" };
}

/** Defaults used by the controller + docker service. */
export function mountPolicy(): { protectedPaths: string[]; containmentOnly: string[]; allowedRoots: string[] } {
  const allowedRoots = (process.env.MOUNT_ALLOWED_ROOTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return { protectedPaths: [path.join(process.cwd(), ".data")], containmentOnly: [process.cwd()], allowedRoots };
}
