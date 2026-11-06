import "dotenv/config";
import path from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} from "discord.js";

const env = (k, d = "") => (process.env[k] ?? d).trim();
const need = (k) => { const v = env(k); if (!v) { console.error(`[bot] Missing ${k} in .env`); process.exit(1); } return v; };
const list = (k) => new Set(env(k).split(",").map((s) => s.trim()).filter(Boolean));

const PANEL_URL = need("PANEL_URL").replace(/\/+$/, "");
const PANEL_KEY = need("PANEL_API_KEY");
const POLL_MS = Math.max(10, Number(env("POLL_SECONDS", "30")) || 30) * 1000;
const LOADING_MS = Math.max(0, Number(env("LOADING_MS", "2000"))); // minimum "loading" time before a card appears

// Token, IDs and permissions come from the panel: Admin -> API Keys -> Discord Bot.
// Values in .env (DISCORD_TOKEN, ALLOWED_USER_IDS ...) still work as a fallback for older setups.
let TOKEN = "", CLIENT_ID = "", GUILD_ID = "", NOTIFY_CHANNEL_ID = "", LOG_CHANNEL_ID = "";
let ALLOWED = { users: new Set(), roles: new Set() };
let ADMINS = { users: new Set(), roles: new Set() };

/* --------------------------------- theme --------------------------------- */
const BRAND = 0x7c5cff, GOOD = 0x2ecc71, BAD = 0xff5d5d, WARN = 0xfab005;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ephemeral = MessageFlags.Ephemeral;

/* ------------------------------ custom emojis ------------------------------ */
// The bot draws its own emoji set (./emojis/*.png|gif) and uploads them as *application emojis*
// on first start. If that ever fails it silently falls back to normal unicode emojis.
const EMOJI_DIR = fileURLToPath(new URL("./emojis/", import.meta.url));
const FALLBACK = {
  online: "🟢", offline: "🔴", idle: "🟡", start: "▶️", stop: "⏹️", restart: "🔄", kill: "☠️", refresh: "🔁",
  players: "👥", console: "⌨️", backup: "💾", cpu: "⚙️", ram: "🧠", disk: "💽", network: "📡", globe: "🌐",
  cube: "🧩", gauge: "📦", clock: "⏳", check: "✅", cross: "❌", server: "🖥️", loading: "⏳",
};
const EM = Object.fromEntries(Object.entries(FALLBACK).map(([k, v]) => [k, { text: v, btn: v }]));
const e = (k) => EM[k]?.text ?? "";   // for embed text
const eb = (k) => EM[k]?.btn ?? "";   // for buttons / select menus
const statusKey = (s) => (s === "online" ? "online" : s === "offline" ? "offline" : "idle");

async function loadEmojis() {
  let existing;
  try { existing = await client.application.emojis.fetch(); }
  catch (err) { console.warn(`[bot] Custom emojis unavailable (${err.message}) - using unicode emojis.`); return; }
  let ok = 0;
  for (const file of readdirSync(EMOJI_DIR)) {
    const m = file.match(/^([a-z_]+)\.(png|gif)$/);
    if (!m || !(m[1] in FALLBACK)) continue;
    const name = `xn_${m[1]}`;
    try {
      let em = existing.find((x) => x.name === name);
      if (!em) em = await client.application.emojis.create({ attachment: path.join(EMOJI_DIR, file), name });
      EM[m[1]] = { text: `<${em.animated ? "a" : ""}:${em.name}:${em.id}>`, btn: { id: em.id, name: em.name, animated: !!em.animated } };
      ok++;
    } catch (err) { console.warn(`[bot] Emoji ${name} failed: ${err.message}`); }
  }
  console.log(`[bot] Custom emojis ready: ${ok}/${Object.keys(FALLBACK).length}`);
}

/* ------------------------------ panel client ------------------------------ */
async function panel(path, { method = "GET", body, timeout = 20000 } = {}) {
  let res;
  try {
    res = await fetch(`${PANEL_URL}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${PANEL_KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new Error(`Panel unreachable at ${PANEL_URL} (${err.cause?.code || err.name})`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Panel rejected the API key (invalid, revoked or expired).");
  if (!res.ok) throw new Error(data.error || `Panel returned HTTP ${res.status}`);
  return data;
}

let cache = { at: 0, servers: [] };
async function getServers(force = false) {
  if (!force && Date.now() - cache.at < 8000) return cache.servers;
  const servers = await panel("/servers");
  cache = { at: Date.now(), servers: Array.isArray(servers) ? servers : [] };
  return cache.servers;
}
async function resolveServer(input) {
  const servers = await getServers();
  const q = String(input).trim().toLowerCase();
  return servers.find((s) => s.id === input) || servers.find((s) => s.name?.toLowerCase() === q)
    || servers.find((s) => s.name?.toLowerCase().includes(q));
}

/* ------------------------------ permissions ------------------------------ */
function memberRoleIds(interaction) {
  const r = interaction.member?.roles;
  if (!r) return [];
  return Array.isArray(r) ? r : [...(r.cache?.keys?.() ?? [])];
}
const inSet = (interaction, set) =>
  set.users.has(interaction.user.id) || memberRoleIds(interaction).some((id) => set.roles.has(id));
const isAdmin = (i) => inSet(i, ADMINS);
const isAllowed = (i) => isAdmin(i) || inSet(i, ALLOWED);

/* -------------------------------- visuals -------------------------------- */
const fmtMB = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`);
const bar = (pct) => {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const n = Math.round(p / 10);
  const c = p >= 85 ? "🟥" : p >= 60 ? "🟨" : "🟩";
  return c.repeat(n) + "⬛".repeat(10 - n);
};
const base = (color = BRAND) => new EmbedBuilder()
  .setColor(color)
  .setAuthor({ name: "XyneX Panel", iconURL: client.user?.displayAvatarURL() })
  .setTimestamp();

const loadingView = (text) => ({
  content: "",
  embeds: [base(BRAND).setDescription(`${e("loading")}  **${text}**\n-# Please wait a moment…`)],
  components: [],
});

/** Shows an animated loading card, runs `work`, and keeps the loader up for at least LOADING_MS. */
async function withLoading(i, text, work) {
  await i.editReply(loadingView(text));
  const [res] = await Promise.all([work(), sleep(LOADING_MS)]);
  return res;
}

const ACTIONS = {
  start: { path: "start", past: "started", doing: "Starting", admin: false },
  stop: { path: "stop", past: "stopped", doing: "Stopping", admin: false },
  restart: { path: "restart", past: "restarted", doing: "Restarting", admin: false },
  kill: { path: "terminate", past: "force-killed", doing: "Force-killing", admin: true },
};

function controls(id, status) {
  const on = status === "online";
  const b = (key, label, style, disabled = false) =>
    new ButtonBuilder().setCustomId(`act:${key}:${id}`).setLabel(label).setEmoji(eb(key)).setStyle(style).setDisabled(disabled);
  return [
    new ActionRowBuilder().addComponents(
      b("start", "Start", ButtonStyle.Success, on),
      b("restart", "Restart", ButtonStyle.Primary, !on),
      b("stop", "Stop", ButtonStyle.Danger, !on),
      b("kill", "Kill", ButtonStyle.Secondary, !on),
    ),
    new ActionRowBuilder().addComponents(
      b("refresh", "Refresh", ButtonStyle.Secondary),
      b("players", "Players", ButtonStyle.Secondary, !on),
      new ButtonBuilder().setCustomId(`console:${id}`).setLabel("Console").setEmoji(eb("console")).setStyle(ButtonStyle.Secondary).setDisabled(!on),
      b("backup", "Backup", ButtonStyle.Secondary),
    ),
  ];
}

/** Full server card: details + live usage + every control button. */
async function serverView(id) {
  const [server, stats, players, backups] = await Promise.all([
    panel(`/servers/${id}`),
    panel(`/servers/${id}/stats`).catch(() => null),
    panel(`/servers/${id}/players`).catch(() => null),
    panel(`/servers/${id}/backups`).catch(() => null),
  ]);
  const online = server.status === "online";
  const label = (server.status || "unknown").toUpperCase();
  const address = `${server.ipAlias || "—"}:${server.port ?? "—"}`;
  const color = server.suspended ? WARN : online ? GOOD : BAD;

  const embed = base(color)
    .setTitle(`${e("server")}  ${server.name}`)
    .setDescription(
      `${e(statusKey(server.status))}  **${label}**${server.suspended ? "  ·  ⛔ Suspended" : ""}\n` +
      `> ${e("globe")} \`${address}\`  ${e("cube")} **${server.type || "—"}**${server.version ? ` ${server.version}` : ""}`)
    .setFooter({ text: `ID ${server.id}` });

  if (online && stats) {
    const cpuPct = stats.limitCpu ? (stats.cpu / stats.limitCpu) * 100 : stats.cpu;
    const ramPct = stats.limitRam ? (stats.ram / stats.limitRam) * 100 : 0;
    const diskPct = stats.limitDisk ? (stats.disk / stats.limitDisk) * 100 : 0;
    embed.addFields(
      { name: `${e("cpu")} CPU`, value: `${bar(cpuPct)}\n**${Number(stats.cpu).toFixed(1)}%**`, inline: true },
      { name: `${e("ram")} RAM`, value: `${bar(ramPct)}\n**${fmtMB(stats.ram)}** / ${fmtMB(stats.limitRam)}`, inline: true },
      { name: `${e("disk")} Disk`, value: `${bar(diskPct)}\n**${Number(stats.disk).toFixed(2)}** / ${stats.limitDisk} GB`, inline: true },
      { name: `${e("network")} Network`, value: `⬇️ **${Number(stats.netIn || 0).toFixed(1)}** KB/s   ⬆️ **${Number(stats.netOut || 0).toFixed(1)}** KB/s`, inline: false },
    );
  } else if (!online) {
    embed.addFields({ name: "​", value: "-# Server is offline — live stats appear when it is running.", inline: false });
  }

  embed.addFields(
    { name: `${e("players")} Players`, value: online && players ? `**${(players.players || []).length}** online` : "—", inline: true },
    { name: `${e("backup")} Backups`, value: Array.isArray(backups) ? `**${backups.length}** saved` : "—", inline: true },
    { name: `${e("gauge")} Limits`, value: `RAM **${server.ram ?? "?"} GB** · CPU **${server.cpu ?? "?"}%** · Disk **${server.disk ?? "?"} GB**`, inline: true },
  );
  if (server.expirationDate) embed.addFields({ name: `${e("clock")} Expires`, value: `**${String(server.expirationDate).slice(0, 10)}**`, inline: true });

  return { content: "", embeds: [embed], components: controls(server.id, server.status) };
}

const playersView = (name, players) => ({
  content: "",
  embeds: [base(BRAND)
    .setTitle(`${e("players")}  Players on ${name}`)
    .setDescription(players.length ? players.map((p) => `${e("online")} **${p.name}**`).join("\n") : "-# Nobody is online right now.")
    .setFooter({ text: `${players.length} online` })],
  components: [],
});

async function audit(interaction, text) {
  console.log(`[audit] ${interaction.user.tag} (${interaction.user.id}): ${text}`);
  if (!LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    await ch.send({ embeds: [base(BRAND).setDescription(`${e("check")} <@${interaction.user.id}> ${text}`)] });
  } catch { /* log channel is best-effort */ }
}

async function runPower(interaction, actionKey, id) {
  const a = ACTIONS[actionKey];
  if (!a) throw new Error("Unknown action.");
  if (a.admin && !isAdmin(interaction)) throw new Error("Only bot admins can do that.");
  const server = (await getServers()).find((s) => s.id === id);
  await panel(`/servers/${id}/${a.path}`, { method: "POST" });
  cache.at = 0;
  await audit(interaction, `**${a.past}** server **${server?.name || id}**`);
  return server?.name || id;
}

async function runBackup(interaction, id) {
  const server = (await getServers()).find((s) => s.id === id);
  const r = await panel(`/servers/${id}/backups`, { method: "POST", timeout: 10 * 60 * 1000 });
  await audit(interaction, `created backup of **${server?.name || id}** (\`${r.filename || "ok"}\`)`);
  return r.filename;
}

async function runConsole(interaction, id, raw) {
  if (!isAdmin(interaction)) throw new Error("Only bot admins can send console commands.");
  const command = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (!command) throw new Error("Empty command.");
  const server = (await getServers()).find((s) => s.id === id);
  await panel(`/servers/${id}/command`, { method: "POST", body: { command } });
  await audit(interaction, `ran console command on **${server?.name || id}**: \`${command.replace(/`/g, "'")}\``);
  return command;
}

/* ------------------------------- commands ------------------------------- */
const serverOpt = (o) => o.setName("server").setDescription("Server name").setRequired(true).setAutocomplete(true);
const withServer = (name, desc) => new SlashCommandBuilder().setName(name).setDescription(desc).addStringOption(serverOpt);
const commands = [
  new SlashCommandBuilder().setName("servers").setDescription("List all servers (pick one from the menu to open it)"),
  withServer("server", "Full details of a server + all control buttons"),
  withServer("start", "Start a server"),
  withServer("stop", "Stop a server"),
  withServer("restart", "Restart a server"),
  withServer("kill", "Force-kill a server (admin)"),
  withServer("players", "Who is online on a server"),
  withServer("backup", "Create a backup of a server"),
  new SlashCommandBuilder().setName("command").setDescription("Send a console command to a server (admin)")
    .addStringOption(serverOpt)
    .addStringOption((o) => o.setName("command").setDescription("e.g. say Hello / whitelist add Steve").setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder().setName("panel").setDescription("Panel health and server summary"),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`[bot] Registered ${commands.length} slash commands in guild ${GUILD_ID}`);
    return;
  }
  // No server ID set: register instantly in every server the bot is in (no 1h global delay).
  const guildIds = [...client.guilds.cache.keys()];
  if (!guildIds.length) {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log(`[bot] Registered ${commands.length} slash commands globally (can take up to 1h - invite the bot to a server for instant commands)`);
    return;
  }
  for (const gid of guildIds) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, gid), { body: commands });
  }
  // remove stale global copies so commands don't show up twice
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] }).catch(() => {});
  console.log(`[bot] Registered ${commands.length} slash commands in ${guildIds.length} server(s)`);
}

async function serversView() {
  const servers = await getServers(true);
  if (!servers.length) return { content: `${e("cross")} No servers found for this API key.`, embeds: [], components: [] };
  const online = servers.filter((s) => s.status === "online").length;
  const embed = base(BRAND)
    .setTitle(`${e("server")}  Servers`)
    .setDescription(servers.slice(0, 40).map((s) => `${e(statusKey(s.status))}  **${s.name}**  ·  ${s.status || "unknown"}`).join("\n"))
    .setFooter({ text: `${online}/${servers.length} online · pick one below or use /server` });
  const menu = new StringSelectMenuBuilder().setCustomId("pick").setPlaceholder("Open a server…").addOptions(
    servers.slice(0, 25).map((s) => ({ label: s.name.slice(0, 100), value: s.id, description: s.status || "unknown", emoji: eb(statusKey(s.status)) })));
  return { content: "", embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

async function panelView() {
  const [health, servers] = await Promise.all([panel("/health").catch((err) => ({ status: `error: ${err.message}` })), getServers(true)]);
  const ok = health.status === "ok";
  const up = health.uptimeSeconds != null ? `${Math.floor(health.uptimeSeconds / 3600)}h ${Math.floor((health.uptimeSeconds % 3600) / 60)}m` : "—";
  return {
    content: "",
    embeds: [base(ok ? GOOD : BAD).setTitle(`${e("server")}  Panel status`).addFields(
      { name: `${e(ok ? "online" : "offline")} Health`, value: `**${health.status}**`, inline: true },
      { name: `${e("clock")} Uptime`, value: `**${up}**`, inline: true },
      { name: `${e("server")} Servers online`, value: `**${servers.filter((s) => s.status === "online").length}** / ${servers.length}`, inline: true })],
    components: [],
  };
}

async function handleCommand(i) {
  const name = i.commandName;
  await i.deferReply();

  if (name === "servers") return i.editReply(await withLoading(i, "Loading servers…", serversView));
  if (name === "panel") return i.editReply(await withLoading(i, "Checking panel…", panelView));

  const server = await resolveServer(i.options.getString("server"));
  if (!server) return i.editReply({ content: `${e("cross")} Server not found. Use the autocomplete list or \`/servers\`.`, embeds: [], components: [] });

  if (name === "server") return i.editReply(await withLoading(i, `Loading ${server.name}…`, () => serverView(server.id)));

  if (name === "players") {
    return i.editReply(await withLoading(i, "Fetching players…", async () => playersView(server.name, (await panel(`/servers/${server.id}/players`)).players || [])));
  }

  if (ACTIONS[name]) {
    const view = await withLoading(i, `${ACTIONS[name].doing} ${server.name}…`, async () => {
      await runPower(i, name, server.id);
      await sleep(2500); // let the container change state before drawing the card
      return serverView(server.id);
    });
    return i.editReply({ ...view, content: `${e("check")} **${server.name}** ${ACTIONS[name].past}.` });
  }

  if (name === "backup") {
    await i.editReply(loadingView(`Creating backup of ${server.name}… this can take a while`));
    const file = await runBackup(i, server.id);
    return i.editReply({ ...(await serverView(server.id)), content: `${e("check")} Backup created${file ? `: \`${file}\`` : ""}` });
  }

  if (name === "command") {
    const command = await runConsole(i, server.id, i.options.getString("command"));
    return i.editReply({ content: `${e("check")} Sent to **${server.name}**: \`${command.replace(/`/g, "'")}\``, embeds: [], components: [] });
  }
}

async function handleButton(i) {
  // console:<id> opens a modal
  if (i.customId.startsWith("console:")) {
    if (!isAdmin(i)) return i.reply({ content: `${e("cross")} Only bot admins can use the console.`, flags: ephemeral });
    const id = i.customId.split(":")[1];
    const modal = new ModalBuilder().setCustomId(`cmd:${id}`).setTitle("Console command").addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("command").setLabel("Command (no leading /)")
        .setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true)));
    return i.showModal(modal);
  }

  // confirmed force-kill (button lives on an ephemeral confirm message)
  if (i.customId.startsWith("killok:")) {
    const id = i.customId.split(":")[1];
    await i.deferUpdate();
    await i.editReply(loadingView("Force-killing…"));
    const name = await runPower(i, "kill", id);
    return i.editReply({ content: `☠️ **${name}** force-killed.`, embeds: [], components: [] });
  }

  const [, action, id] = i.customId.split(":");

  if (action === "kill") {
    if (!isAdmin(i)) return i.reply({ content: `${e("cross")} Only bot admins can force-kill.`, flags: ephemeral });
    return i.reply({
      content: "⚠️ Force-kill can corrupt world data. Are you sure?", flags: ephemeral,
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`killok:${id}`).setLabel("Yes, kill it").setEmoji(eb("kill")).setStyle(ButtonStyle.Danger))],
    });
  }

  if (action === "players") {
    await i.deferReply({ flags: ephemeral });
    const view = await withLoading(i, "Fetching players…", async () => {
      const server = (await getServers()).find((s) => s.id === id);
      return playersView(server?.name || id, (await panel(`/servers/${id}/players`)).players || []);
    });
    return i.editReply(view);
  }

  if (action === "backup") {
    await i.deferReply({ flags: ephemeral });
    await i.editReply(loadingView("Creating backup… this can take a while"));
    const file = await runBackup(i, id);
    return i.editReply({ content: `${e("check")} Backup created${file ? `: \`${file}\`` : ""}`, embeds: [], components: [] });
  }

  // refresh / start / stop / restart: update the card in place (loader -> fresh card)
  await i.deferUpdate();
  try {
    const view = await withLoading(i, ACTIONS[action] ? `${ACTIONS[action].doing}…` : "Refreshing…", async () => {
      if (ACTIONS[action]) { await runPower(i, action, id); await sleep(2500); } else cache.at = 0;
      return serverView(id);
    });
    return await i.editReply(view);
  } catch (err) {
    const back = await serverView(id).catch(() => ({ embeds: [], components: [] }));
    return i.editReply({ ...back, content: `${e("cross")} ${err.message}` });
  }
}

/* --------------------------------- client --------------------------------- */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("interactionCreate", async (i) => {
  try {
    if (i.isAutocomplete()) {
      if (!isAllowed(i)) return i.respond([]);
      const q = String(i.options.getFocused()).toLowerCase();
      const servers = await getServers();
      return i.respond(servers.filter((s) => s.name?.toLowerCase().includes(q)).slice(0, 25)
        .map((s) => ({ name: `${s.status === "online" ? "🟢" : "🔴"} ${s.name}`.slice(0, 100), value: s.id })));
    }
    if (!(i.isChatInputCommand() || i.isButton() || i.isStringSelectMenu() || i.isModalSubmit())) return;
    if (!isAllowed(i)) return i.reply({ content: `${e("cross")} You are not allowed to use this bot.`, flags: ephemeral });

    if (i.isChatInputCommand()) return await handleCommand(i);
    if (i.isButton()) return await handleButton(i);
    if (i.isStringSelectMenu()) {
      await i.deferReply();
      const id = i.values[0];
      return await i.editReply(await withLoading(i, "Loading server…", () => serverView(id)));
    }
    if (i.isModalSubmit()) {
      await i.deferReply({ flags: ephemeral });
      const id = i.customId.split(":")[1];
      const command = await runConsole(i, id, i.fields.getTextInputValue("command"));
      return await i.editReply(`${e("check")} Sent: \`${command.replace(/`/g, "'")}\``);
    }
  } catch (err) {
    console.error("[bot] error:", err.message);
    const msg = `${e("cross")} ${err.message}`.slice(0, 1900);
    try {
      if (i.deferred) await i.editReply({ content: msg, embeds: [], components: [] });
      else if (i.replied) await i.followUp({ content: msg, flags: ephemeral });
      else await i.reply({ content: msg, flags: ephemeral });
    } catch { /* interaction expired */ }
  }
});

/* ------------------- online/offline notifications (optional) ------------------- */
let lastStatus = null;
async function pollStatuses() {
  try {
    const servers = await getServers(true);
    const now = new Map(servers.map((s) => [s.id, s]));
    if (lastStatus && (NOTIFY_CHANNEL_ID || LOG_CHANNEL_ID)) {
      const ch = await client.channels.fetch(NOTIFY_CHANNEL_ID || LOG_CHANNEL_ID).catch(() => null);
      for (const [id, s] of now) {
        const before = lastStatus.get(id);
        if (before && before !== s.status && ch) {
          await ch.send({ embeds: [base(s.status === "online" ? GOOD : BAD)
            .setDescription(`${e(statusKey(s.status))}  **${s.name}** is now **${s.status}**`)] }).catch(() => {});
        }
      }
    }
    lastStatus = new Map([...now].map(([id, s]) => [id, s.status]));
  } catch (err) {
    console.warn("[bot] status poll failed:", err.message);
  }
}

/* ------------------------- config from the panel ------------------------- */
const idSet = (arr, envKey) => (Array.isArray(arr) && arr.length ? new Set(arr.map(String)) : list(envKey));
const clientIdFromToken = (tok) => { try { const id = Buffer.from(tok.split(".")[0], "base64").toString("utf8"); return /^\d{5,25}$/.test(id) ? id : ""; } catch { return ""; } };

function applyConfig(r) {
  r = r || {};
  TOKEN = r.token || env("DISCORD_TOKEN");
  CLIENT_ID = r.clientId || env("DISCORD_CLIENT_ID") || (TOKEN ? clientIdFromToken(TOKEN) : "");
  GUILD_ID = r.guildId || env("GUILD_ID");
  NOTIFY_CHANNEL_ID = r.notifyChannelId || env("NOTIFY_CHANNEL_ID");
  LOG_CHANNEL_ID = r.logChannelId || env("LOG_CHANNEL_ID");
  ALLOWED = { users: idSet(r.allowedUserIds, "ALLOWED_USER_IDS"), roles: idSet(r.allowedRoleIds, "ALLOWED_ROLE_IDS") };
  ADMINS = { users: idSet(r.adminUserIds, "ADMIN_USER_IDS"), roles: idSet(r.adminRoleIds, "ADMIN_ROLE_IDS") };
}

/** null = this panel has no bot-settings endpoint (old version) -> .env only. Throws if the panel can't be reached. */
async function fetchRemoteConfig() {
  try { return await panel("/admin/discord-bot/bot-config"); }
  catch (err) { if (/HTTP 404/.test(err.message)) return null; throw err; }
}

let botState = "waiting", botError = null;
async function heartbeat() {
  await panel("/admin/discord-bot/heartbeat", {
    method: "POST",
    body: { state: botState, tag: client.user?.tag, guilds: client.guilds.cache.size, error: botError },
  }).catch(() => {});
}

client.once("ready", async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);
  botState = "online"; botError = null; heartbeat();
  if (!ALLOWED.users.size && !ALLOWED.roles.size && !ADMINS.users.size && !ADMINS.roles.size) {
    console.warn("[bot] WARNING: no allowed/admin IDs configured (panel -> API Keys -> Discord Bot) - nobody can use the bot yet.");
  }
  await loadEmojis();
  try { await registerCommands(); } catch (err) { console.error("[bot] command registration failed:", err.message); }
  try { const s = await getServers(true); console.log(`[bot] Panel OK - ${s.length} server(s) visible to this API key`); }
  catch (err) { console.error("[bot] Panel check failed:", err.message); }
  await pollStatuses();
  setInterval(pollStatuses, POLL_MS);
});

process.on("unhandledRejection", (err) => console.error("[bot] unhandled:", err));

async function main() {
  // 1) get settings from the panel (retry until the panel is reachable)
  let remote;
  for (;;) {
    try { remote = await fetchRemoteConfig(); break; }
    catch (err) { console.error(`[bot] Can't load settings from the panel: ${err.message} - retrying in 10s`); await sleep(10000); }
  }
  applyConfig(remote);
  const rev = remote?.rev ?? 0;
  const enabled = remote ? remote.enabled !== false : true;

  // 2) watch for changes made in the panel -> exit; PM2 restarts us with the new settings
  setInterval(async () => {
    try {
      const r = await fetchRemoteConfig();
      if (r && (r.rev ?? 0) !== rev) { console.log("[bot] Settings changed in the panel - restarting to apply them."); process.exit(0); }
    } catch { /* panel temporarily unreachable */ }
  }, 15000);
  setInterval(heartbeat, 30000);

  // 3) connect to Discord
  if (!enabled) { botState = "disabled"; console.log("[bot] Disabled in the panel - idle."); return heartbeat(); }
  if (!TOKEN) { botState = "waiting"; console.log("[bot] No Discord token yet - add it in Panel -> Admin -> API Keys -> Discord Bot. Waiting…"); return heartbeat(); }
  if (!CLIENT_ID) { botState = "error"; botError = "Could not detect the application ID - set it in the panel."; console.error("[bot]", botError); return heartbeat(); }
  try { await client.login(TOKEN); }
  catch (err) {
    botState = "error"; botError = /token/i.test(err.message) ? "Discord rejected the token (invalid or reset)." : err.message;
    console.error("[bot] Login failed:", err.message);
    heartbeat();
  }
}
main();
