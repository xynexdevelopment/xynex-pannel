# Targeted fixes (10/10 pass)

Status legend: PLANNED / DONE / PARTIAL / NOT DONE. Nothing below is marked DONE until its
regression test was actually run (results are recorded in the "Verification log" at the bottom).

## Baseline (measured before any change)

| Check | Command | Result |
|---|---|---|
| Type-check | `npx tsc --noEmit` | exit 0 |
| Lint | `npx eslint .` | exit 0, 0 errors, 105 warnings |
| Tests | `npx vitest run` | 7 files, 41 tests passed |
| Prod dependency audit | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |

## Confirmed issues

| ID | Category | Severity | File(s) | Issue | Intended fix | Status |
|---|---|---|---|---|---|---|
| A1 | Auth | **Critical** | `controllers/auth.ts` (`googleLogin`), `pages/Login.tsx` | `POST /api/auth/google` never verifies a Google/Firebase token. It trusts `email`/`googleId` from the body and also matches existing accounts by *username prefix of the email*. Anyone can log in as any user (including admin) and skip 2FA. Enabled by default (`enableGoogleLogin === false` is the only block). | Verify the Firebase ID token server-side (RS256, Google signing certs, `aud`/`iss`/`exp`/`sub`, `email_verified`). Match only on verified `googleId`/verified email. Client sends `idToken`. Require `enableGoogleLogin === true`. | DONE |
| A2 | Auth / Rate limit | High | `controllers/auth.ts`, `middleware/rateLimit.ts` | Brute-force protection is per-IP only; a distributed attacker has unlimited guesses against one account, and the 2FA step has no per-account limit. | Per-account failure throttle (password + 2FA), `429` + `Retry-After`. | DONE |
| A3 | Auth | Medium | `controllers/auth.ts` | A valid TOTP code can be replayed inside its window (login, disable-2FA). | Remember last accepted time-step per user, reject reuse. | DONE |
| A4 | Auth / Rate limit | Medium | `routes/auth.ts` | Password change, email change, 2FA setup/confirm/disable are not rate limited (password guessing with a stolen session). | Per-user limiter on those routes. | DONE |
| A5 | Auth | Medium | `middleware/auth.ts`, `routes/api-keys.ts` | API key `scopes` are stored but never enforced (documented in SECURITY_AUDIT.md as open). | Enforce: `*`/`write` = full, otherwise read-only methods; validate scopes on creation. | DONE |
| P1 | Path | High | `controllers/servers.ts` `deleteFile` | `path: "/"` resolves to the server root, which `isInside` accepts, so one request deletes the whole server directory. `paths` given as a string is iterated per character. | Refuse the root, require an array of strings. | DONE |
| P2 | Path | Medium | `utils/security.ts` | `isInside` has no NUL-byte guard (only `safeResolve` does). | Reject NUL in both. | DONE |
| P3 | Path / Structure | Medium | `controllers/servers.ts` | Chunk uploads key the `.part` file on `fileName` only (`uploadId` ignored): concurrent uploads of the same name corrupt each other. Multer temp files leak on rejected requests. | Key part file on sanitised `uploadId`; remove temp files on all exits. | DONE |
| P4 | Structure | Low | `controllers/servers.ts` | `path.join(process.cwd(), ".data", "servers", id)` is copy-pasted ~30 times. | One `serverRoot(id)` helper (validates the id). | DONE |
| R1 | Rate limit | Medium | `routes/servers.ts` | No limiter on uploads or resource-heavy endpoints (zip/unzip, backups, modpack/plugin/mod install, server create). Multer has no size cap. | Per-user limiters + `MAX_UPLOAD_BYTES`. | DONE |
| R2 | Rate limit | Medium | `services/sftp.ts` | SFTP password auth (port 6868, all interfaces) has no throttling at all. | Per-IP and per-username failure throttle. | DONE |
| R3 | Rate limit | Info | `middleware/rateLimit.ts` | Counters are in process memory. Correct for the shipped single-instance pm2 setup, **not** shared across instances. | Make the store pluggable; document honestly. No Redis dependency added. | PARTIAL (in-memory only; see limitations) |
| F1 | Features | High | `services/sftp.ts` | SFTP is a stub: login succeeds, every SFTP operation answers `SSH_FX_FAILURE`. The UI hands out credentials that cannot work. | Implement the SFTP file operations jailed to the server directory (every path through `isInside`). | DONE |
| PR1 | Production | Medium | `server.ts` | No health endpoint. | `GET /api/health` (liveness + data-dir readiness). | DONE |
| PR2 | Production | Medium | `server.ts` | No startup config validation (bad `PORT`, `TRUST_PROXY`, `CSP_MODE` etc. are silently accepted). | `config.ts` validation that fails fast with clear messages. | DONE |
| PR3 | Production | Medium | `server.ts`, `services/*scheduler.ts`, `sftp.ts` | Shutdown does not stop schedulers or the SFTP listener; signal handling is registered in two places. | Single idempotent shutdown path. | DONE |
| PR4 | Production | Medium | (missing) | No backup/restore procedure for the JSON data (`users.json`, `servers.json`, ...). | `npm run backup` / `npm run restore` (restore refuses to overwrite without `--force` and keeps the current files). | DONE |
| PR5 | Production | Low | `services/sftp.ts`, `server.ts`, CI | SFTP host key written with default permissions; `crash.log` unbounded; CI does not build the server bundle. | 0600 key, size-capped log, add `npm run build` to CI. | DONE |

## Additional issues found and fixed during the work

| ID | Area | Issue | Fix |
|---|---|---|---|
| X1 | Structure | `docker.ts` / `nativeEngine.ts` imported `io` from `server.ts` (the entry point): importing any router booted the whole panel (port, schedulers, SFTP) and created a circular import. | `services/socket.ts` registry; `server.ts` calls `setIO(io)`. |
| X2 | Path | `isInside` / `safeResolve` tested `rel.startsWith("..")`, wrongly rejecting file names such as `..hidden`. Fails safe, but it was a false denial. | Exact check: `..` or `../` prefix (`escapesBase`). Tests cover both directions. |
| X3 | Cleanup | Dead `exec`/`promisify` imports left in `unzipFile` and git handlers after the earlier execFile migration. | Removed. |

## Round 3b

| ID | Area | Change |
|---|---|---|
| S1 | Structure | File-manager handlers (~440 lines) moved from `controllers/servers.ts` into `controllers/serverFiles.ts`; re-exported, so routes and API are unchanged. `servers.ts` 2,551 -> ~2,130 lines. |
| S2 | Auth | Per-token revocation on logout (`services/tokenRevocation.ts`); client `logout()` now calls `POST /api/auth/logout`. |
| S3 | Production / Rate limit | Startup refuses `NODE_APP_INSTANCE > 0` (several instances would each have their own limits, lockouts and revocation list) unless `ALLOW_MULTI_INSTANCE=true`. |

## Round 3c (cleanup)

- Removed the undocumented `downloadUrl: "dummy"` hook in plugin install (it created an empty jar without downloading anything; nothing in the UI or tests used it).
- Server-side lint warnings fixed (unused variables, `prefer-const`, 15 useless regex escapes - behaviour-neutral by definition, covered by the full test run).
- The 71 remaining warnings are 29 `react-hooks/exhaustive-deps` (changing those arrays can change UI behaviour, so they were left) and dead UI state/handlers in `AdminPanel.tsx`, `ServerSettings.tsx`, `ServerConsole.tsx` etc. (removing them means editing large UI files, which was out of scope).

## Round 4 (structure)

`controllers/servers.ts` (2,551 lines) is now 443 lines of core CRUD plus focused modules, all re-exported from `servers.ts` so
routes, imports and API paths are unchanged: `serverFiles` (435), `serverWorlds` (417), `serverConfig` (400), `serverResources` (282),
`serverLifecycle` (224), `serverMods` (215), `serverAddons` (166), `serverBackups` (108). Verified: `tsc` 0, 105/105 tests, E2E 38/38
on a fresh build, and `madge --circular` reports no circular dependencies in `server.ts` + `src/server` (60 files).

## Round 5

- SFTP `open()` now uses `O_NOFOLLOW`: swapping the final path component for a symlink after the containment check makes the open fail instead of following it. (Swapping a *parent directory* is still racy; Node has no `openat`.)
- SFTP verified with a second, independent implementation (curl/libssh): upload, download, listing, traversal blocked, wrong password rejected (E2E now 43 checks).
- Google login: email auto-link removed, explicit `POST /api/auth/google/link` added (see limitations).

## Dependency audit (re-run later, advisory database had changed)

A later `npm audit` reported `follow-redirects` 1.16.0-1.16.1 (**high**). Fixed with `npm audit fix` (non-breaking): lockfile only,
`follow-redirects` 1.16.1 -> 1.16.2 and `minimatch` 10.2.5 -> 10.2.6; `package.json` untouched; tests/E2E re-run green.
**Still reported: 3 moderate** (`minimatch` < 11.0.1 DoS via `readdir-glob` <- `archiver`). npm's only offered fix downgrades
`archiver` to 4.x (breaking), so it was NOT applied. The panel does not pass user-controlled glob patterns to archiver.

## Deliberately not changed (out of scope / would alter deployment)

- `ecosystem.config.cjs` runs `npm start` under pm2; running `node dist/server.cjs` directly is cleaner for signal handling but changes deployment settings, so it is only recommended.
- 3 MB `playit` / `test_playit` binaries committed to the repo; Docker engine `chmod 777`; these are existing project assets / behaviours.
- No dependency was added or upgraded.

## Verification log

Run in the sandbox (Node 22.22.2) on the final tree:

| Check | Command | Result |
|---|---|---|
| Type-check | `npx tsc --noEmit` | exit 0 |
| Lint | `npx eslint .` | exit 0, 0 errors, 71 warnings (baseline 105) |
| Tests | `npx vitest run` | 14 files, **105 passed** (baseline 41 passed) |
| Production build | `npm run build` | exit 0 (`dist/server.cjs` 391 KB) |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities at the first run; see "Dependency audit" below |

Runtime smoke test of the built bundle (`node dist/server.cjs` from an empty directory):
invalid `PORT` -> exit 1 with message; valid boot -> `/api/health` 200; forged `/api/auth/google` -> 400;
unauthenticated file DELETE -> 401; CSP header present; SFTP port answers `SSH-2.0-`; `jwt.secret` and
`host_rsa` are mode 600; SIGTERM -> exit 0 in <1 s.

New test files: `googleLogin`, `authHardening`, `rateLimit`, `apiKeyScopes`, `pathHardening`, `sftp`, `production`.
The Google bypass (A1) was reproduced on the original code before it was fixed (an unauthenticated request
with only an email returned an admin token for an account with 2FA enabled).

## Real end-to-end run (built bundle, real HTTP + real SSH client)

`npm run test:e2e` (`scripts/e2e-smoke.mjs`) boots `dist/server.cjs` in an empty temp directory and drives it:
38/38 checks passed - register/login/captcha, forged Google login (no token), 2FA with real TOTP codes (seed
encrypted on disk, replay rejected), logout / logout-all revocation, read-only API key (GET ok, write 403, bad
scope 400), file API traversal + tenant isolation + `DELETE /` refusal, real `ssh2` SFTP upload/download/traversal/
wrong password, brute-force login -> 429 + Retry-After, API flood -> 429, SIGTERM -> exit 0 (<20 ms).
Not covered by it: Docker mode, game-server start/stop, browser UI, real Google login.

## Remaining limitations / NOT verified

- **Rate-limit counters are in process memory.** Correct for the shipped single-instance pm2 config; not shared
  across instances and reset on restart. `makeLimiter({ store })` is the seam for a shared (Redis) store, which
  was not added (no new dependency) and is therefore untested. Do not describe the limits as distributed.
- **Google login against real Google/Firebase was not tested** (no network access to Google's certificates here).
  Verification logic is tested with locally generated RSA keys and a mocked certificate fetch. Test once with a
  real account. It requires `enableGoogleLogin: true` and `firebaseProjectId` in the panel settings, and the
  frontend must be rebuilt.
- Google sign-in no longer links to a local account by email (that allowed a pre-registration takeover, because the panel never verifies local emails). Existing local accounts link explicitly with `POST /api/auth/google/link` while logged in. **Compatibility note:** a local user who never linked Google before and signs in with Google now gets a *new* account until they link; the UI has no "Link Google" button yet.
- Per-account lockout can be abused to lock a *known* username out for up to 15 minutes (standard trade-off).
- JWT sessions are stateless (7 days). They are invalidated by password change, user deletion and role change,
  `POST /api/auth/logout-all` now signs out every session of the caller; logout now revokes the presented token (per-`jti` list persisted in `.data/revoked_tokens.json`), so a copied token of a logged-out session stops working. Tokens issued before this change have no `jti` and expire normally.
- 2FA seeds are now AES-256-GCM encrypted at rest with `.data/secret.key` (legacy plaintext seeds are migrated on next successful use). Anyone who can read both `users.json` and `secret.key` can still decrypt them; the key is included in `npm run backup`.
- SFTP was tested with the `ssh2` client only (not FileZilla/WinSCP/OpenSSH); there is a small TOCTOU window
  between the containment check and `open()` for a user who also controls the same folder through another channel.
- Docker mode, real game-server start/stop, the browser UI and the installer scripts were **not run** (no Docker
  or browser here). `install.sh` was reviewed, not modified.
- `ecosystem.config.cjs` still starts via `npm start`; running `node dist/server.cjs` directly gives cleaner signal
  handling but changes deployment settings, so it is only recommended.
- API keys with a non-`*`/`write` scope are now read-only; the UI only ever created `["*"]` keys.
- Single-request uploads are capped at 4 GiB (`MAX_UPLOAD_BYTES`); larger files must use chunked upload.

