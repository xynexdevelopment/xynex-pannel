# XyneX Panel - Production readiness audit

Status: **Batch 1 of a multi-batch effort.** This document says what exists, what was verified, what was
changed in this batch, and - just as important - what is **not** done yet. Nothing below is marked done
unless a test or a command run proves it (see "Verification").

> Scope note: the task brief was cut off in the middle of "Phase 10 - Logging & audit". Phases 0-9 were
> received in full; whatever Phase 10 and later asked for was not available and has not been addressed.

## 1. Project inventory (Phase 0)

| Area | What it is |
|---|---|
| Stack | TypeScript, Node 22. Express 4 API + socket.io, React 19 / Vite 6 frontend (served by Express in production), pm2 (`ecosystem.config.cjs`). |
| Entry points | `server.ts` (panel), `scripts/*` (createuser, backup-data, restore-data, e2e-smoke), `install.sh` / `update.sh` / `autostart.sh` / `healthcheck.sh`. |
| Storage | **JSON files in `.data/`** (`users.json`, `servers.json`, `allocations.json`, ...). Atomic writes (temp + rename, 0600), per-file write queue, `updateJSON` read-modify-write helper. There is no SQL database and therefore no migration system. MySQL is only used to provision per-server customer databases. |
| Auth | bcrypt (cost 12), JWT sessions with per-token revocation, TOTP 2FA (replay-protected), per-account + per-IP throttling, API keys with enforced scopes, Google login with server-side Firebase ID-token verification. |
| Execution engines | `docker.ts` (Docker/Podman via dockerode), `nativeEngine.ts` (plain host processes, used automatically when no container socket exists), "sandbox" demo mode. |
| Nodes | Node records, allocations, and a daemon heartbeat endpoint (`lastHeartbeat`). Staleness is computed client-side. |
| Background work | `scheduler.ts` (auto-suspend), `taskScheduler.ts` (Pterodactyl-style schedules), SFTP server (jailed), Discord bot runner. Long operations (install, backup, restore, version change) run inside the request/process - there is no job queue. |
| Tests | Vitest, 17 files / 171 tests (63 added in this batch). |
| Docs | `README.md`, `SECURITY_AUDIT.md` (rounds 1-4), `docs/TARGETED_FIXES.md`. |

## 2. Security mechanisms that already existed (verified in code, not re-done)

Command-injection fixes (`execFile`), `safeZip` extraction, SSRF guard, helmet + CSP, CORS allow-list, trusted-proxy
aware client IP, atomic JSON writes, Google-login bypass fix, per-account lockout, TOTP replay protection, API-key
scope enforcement, path-traversal helpers (`isInside`, `safeResolve`, `serverRoot`), SFTP jail + throttling,
graceful shutdown, `npm run backup` / `restore` for the JSON data. Details: `SECURITY_AUDIT.md`.

## 3. Findings fixed in this batch

| # | Sev. | Finding | Fix | Proof |
|---|---|---|---|---|
| F1 | **High** | **Admin "mounts" had no validation.** `sourcePath` could be `/`, `/etc`, the Docker socket or the panel's own `.data` (users, JWT secret) and a mount applies to *every* server by default. The bind string `src:target:ro` was also built by concatenation, so a `:` in a path injected options. | `validateMountPaths` (blocks system dirs, sockets, the panel data dir and anything containing the install folder, resolves symlinks, rejects `: , NUL` and control chars, reserved container targets, optional `MOUNT_ALLOWED_ROOTS`). Checked when a mount is created **and again when a container is built** - old entries that violate the rules are skipped with a warning, never deleted. | `tests/containerSecurity.test.ts` (30 tests incl. symlink escape + injection) |
| F2 | Med-High | Customer containers had no capability drop, no `no-new-privileges`, no PID limit, no ulimits. | `runtimeHardening()` merged into all 3 runtime container creations; lighter `installerHardening()` for install containers. Defaults chosen so itzg / Pterodactyl images keep working (see 5). | unit tests on the generated options (not run against a live daemon - see 6) |
| F3 | Medium | With no Docker socket the panel **silently** switched to running customer servers as unisolated host processes. | Startup now logs a loud warning naming the risk; `ALLOW_NATIVE_ENGINE=false` refuses native mode. **Default stays "allowed"** so existing installs don't break. | startup log (`describeEngine`) |
| F4 | **High** | *Introduced earlier in this same session:* the new "Restore backup" endpoint had no recovery point, no archive verification, no API-level confirmation and no rollback. | Reworked: explicit `confirm: true` required by the API; archive verified first (checksum + structure); automatic **recovery point** of current data; disk-space check; automatic **rollback** if extraction fails; restore refused while server runs. | `tests/backups.test.ts` (tamper, traversal, mid-extract failure + rollback, no-disk-room; mutation-checked) |
| F5 | Medium | Backups: a crash left a corrupt `.zip` that was listed as a valid backup; no checksums, no size limit, no disk check, no retention. | Write to `.partial` -> verify -> rename; SHA-256 sidecar; `MAX_BACKUP_BYTES`; free-space reserve; `BACKUP_RETENTION_COUNT`; **Verify** button/endpoint (checksum + structure + CRC of every file, nothing written to disk); stale `.partial` cleanup. | `tests/backups.test.ts` |
| F6 | Medium | Nothing stopped conflicting operations (restore vs start vs delete vs backup vs version change). | In-process per-server operation lock with TTL (stale-lock takeover) + router middleware that answers `409` to state-changing requests while restore / reinstall / version-change / delete runs (stop/terminate stay allowed). | `tests/serverLocks.test.ts` |
| F7 | Medium | After a panel restart a server mid-install stayed `installing` **forever** (and the new installing popup would have trapped the user). | `recoverInterruptedOperations()` at startup marks it `install_failed` (Reinstall available) and deletes partial backup files. | `tests/backups.test.ts` |
| F8 | Medium | Version change with "wipe data" deleted the whole server folder with no safety net. | A recovery point is taken first; if it can't be made, nothing is wiped. | covered by shared recovery-point tests; endpoint path not integration-tested |

## 4. Not done yet (honest list)

**Authentication / secrets (Phase 1)** - *not implemented or not verified:* 2FA **recovery codes** do not exist; session
invalidation after password change, admin-enforced 2FA, password-reset flow, OAuth account-linking and API-key
expiry were **not reviewed** in this batch; secrets (Discord bot token, SMTP, etc.) are stored **in plaintext** in the
JSON files (only passwords are hashed) - encryption at rest needs a key-management decision first.
**Isolation (Phase 2):** server folders are still `chmod 777` (per-server UIDs would fix it); **disk limits are not
enforced by the infrastructure** (Docker needs XFS project quotas; today it is only stored/displayed); no network
egress restrictions; native engine has no resource limits at all.
**Data (Phase 3):** JSON files are not a database: multi-file updates (servers + allocations) are not transactional,
there are no migrations/indexes/foreign keys. Moving to SQLite is the right fix but is a project of its own with a
data migration - deliberately **not** attempted in a hardening batch.
**Backups (Phase 4):** scheduled automatic backups (the service layer is ready: `createBackupArchive` +
`applyRetention`, it only needs a schedule-task action), backup encryption, restore progress, failure notifications.
Verification does **not** do a full test-restore into a temp directory; it streams every file through the
decompressor and checks CRC instead (cheaper, no disk use).
**Reliability / jobs / nodes / monitoring (Phases 5-9):** crash detection with bounded restart policy, job progress and
cancellation, a real queue, node maintenance/draining/capacity, offline-node status handling, a monitoring dashboard
and alerting. Only `/api/health` exists. The new operation lock is **in-process only** and does not cover
server-creation installs or socket.io console commands.
**Dependencies:** `npm audit` reports 3 *moderate* findings (`minimatch` ReDoS via archiver -> readdir-glob). The only
offered fix downgrades archiver to 7.x (breaking). The vulnerable pattern matching is fed constant patterns here, but
that was assessed by reading the code, not tested. High/critical: 0.

## 5. Compatibility notes

* No endpoint, page or feature was removed. New API: `POST /api/servers/:id/backups/:file/verify`. **Changed:**
  `POST .../restore` now requires `{ "confirm": true }` (the shipped UI sends it).
* Hardening is on by default. If an unusual image misbehaves: `CONTAINER_HARDENING=off` restores the old behaviour.
  `DAC_OVERRIDE`, `FOWNER` and `NET_BIND_SERVICE` are **kept** by default because standard images chown their data folder
  and drop from root; opt in to dropping them with `CONTAINER_CAP_DROP_STRICT=true`.
* `PidsLimit` 1024 and `nofile` 65536 are generous but new. Raise via `CONTAINER_PIDS_LIMIT` / `CONTAINER_NOFILE_LIMIT`.
  Existing containers pick the new options up the next time they are (re)created.
* Existing `mounts.json` entries that break the new rules are skipped (warning in the log), not removed.
* A restore now needs free disk space for a recovery point (`MIN_FREE_DISK_BYTES`, default 1 GiB reserve).

## 6. Verification (what was actually run)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx eslint` on all changed/new files | 0 errors (5 pre-existing-style `exhaustive-deps` warnings) |
| `npx vitest run` | 17 files, **171 tests passed** |
| `vite build` + esbuild server bundle | both succeed |
| Mutation check | removing the mount-injection check, the recovery point, or the rollback each made tests fail |

**Not verified:** no real Docker/Podman daemon was available, so the container options are validated as objects, not by
starting containers - test one server of each egg type before rolling out. No load or penetration testing was done.
