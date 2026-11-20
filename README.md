# XyneX Panel

Made by TeamXyneX

## Quick Automated Setup (Recommended)

Run the automated management script:

```bash
bash install.sh
```

Menu Options:
1. **Install Panel** (Installs Node.js, Docker/Podman/Native, PM2, dependencies, builds & starts on port 6767)
2. **Update Panel**
3. **Create Admin User**
4. **Restart Panel**
5. **Exit**

During install you'll be asked to pick a server engine:
- **Docker** or **Podman** — servers run as containers (original behavior).
- **Native (no Docker/Podman)** — servers run as plain processes directly on the host. No container runtime needed at all. See [Native mode](#native-mode-no-docker) below.

---

## Manual Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/xynexdevelopment/xynex-pannel.git
   cd xynex-pannel
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the application:
   ```bash
   npm run build
   ```

4. Create an admin user:
   ```bash
   npm run createuser
   ```

5. Start the server (Port 6767):
   ```bash
   npm run start
   ```

## Native mode (no Docker)

The panel can run entirely without Docker or Podman installed. If neither is found on the host, it automatically falls back to running servers as native host processes instead of containers — no extra setup required. To be explicit about it (recommended), add this to your `.env`:

```
XYNEX_ENGINE=native
```

How it works:
- **Uploaded Pterodactyl eggs** work exactly as-is — the egg's own install script runs directly on the host (instead of inside a container), and its `startup` command is launched the same way once installed. This covers any software an egg is written for (Minecraft, Discord bots, Node/Python apps, SteamCMD games, etc.).
- **Quick-create** (no egg) supports **PAPER, PURPUR, VELOCITY, WATERFALL, and VANILLA** out of the box — the panel downloads the correct jar itself via the PaperMC/PurpurMC APIs and Mojang's version manifest. Other quick-create types (Spigot, Forge, Fabric, Bedrock, BungeeCord) need to be added as an uploaded egg in native mode.
- The console, start/stop/restart/kill, live stats, and RCON (`list`, etc.) all work the same as in Docker mode.
- Requirements are whatever the software itself needs — e.g. Java for Minecraft-family servers (`sudo apt install openjdk-21-jre-headless`), Node/Python for JS/Python-based eggs, and so on. `install.sh` offers to install Java automatically when you pick Native mode.
- Per-server database creation (the MySQL feature) still requires Docker/Podman or a manually configured external MySQL server — it isn't part of native mode.

If you want the old fake "sandbox demo" behavior back instead of real native execution (e.g. for a public showcase box where you don't want install scripts executing on the host), set `XYNEX_ENGINE=sandbox` in `.env`.

## Development

To run the panel in development mode on port 3000:

```bash
npm run dev
```

## Production hardening settings

All optional - the defaults are safe. See `PRODUCTION_AUDIT.md` for the reasoning and the list of what is still open.

| Variable | Default | Effect |
|---|---|---|
| `CONTAINER_HARDENING` | on | `off` disables capability drop / `no-new-privileges` / PID + ulimit limits (escape hatch for odd images) |
| `CONTAINER_CAP_DROP_STRICT` | false | also drop `DAC_OVERRIDE`, `FOWNER`, `NET_BIND_SERVICE` |
| `CONTAINER_PIDS_LIMIT` | 1024 | max processes/threads per server container |
| `CONTAINER_NOFILE_LIMIT` | 65536 | open-file limit per container |
| `CONTAINER_READONLY_ROOTFS` | false | read-only root filesystem (+ tmpfs `/tmp`) |
| `ALLOW_NATIVE_ENGINE` | true | `false` refuses to run servers as plain host processes when Docker is missing |
| `MOUNT_ALLOWED_ROOTS` | unset | comma-separated host directories mounts must live under |
| `MAX_BACKUP_BYTES` | 0 (off) | abort backups larger than this |
| `MIN_FREE_DISK_BYTES` | 1 GiB | free space kept when creating backups / restoring |
| `BACKUP_RETENTION_COUNT` | 0 (keep all) | keep only the newest N backups per server |
| `RESTORE_RECOVERY_KEEP` | 3 | automatic pre-restore recovery points kept per server |
