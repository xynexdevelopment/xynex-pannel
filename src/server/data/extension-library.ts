/**
 * Built-in Minecraft extension library.
 *
 * Every entry is a declarative extension (same format admins can upload):
 *   rcon_buttons / rcon_output / download_install sections, rendered by ExtensionPanel.
 *
 * - `eggs`     : which eggs it applies to (shown in the egg-aware Extensions hub).
 * - `category` : group heading inside the hub.
 * - `sidebar:false` keeps the sidebar clean — library items live in the Extensions hub only.
 * - download items use Modrinth slugs + a `loaders` filter, so a Paper server never gets a Fabric jar.
 */

type Item = { name: string; modrinthProject: string; description?: string };

const PLUGIN_LOADERS = ["paper", "spigot", "bukkit"];
const FABRIC_LOADERS = ["fabric"];
const FORGE_LOADERS = ["forge", "neoforge"];

const PLUGIN_EGGS = ["PAPER", "SPIGOT"];
const JAVA_EGGS = ["PAPER", "SPIGOT", "FORGE", "FABRIC"];

const base = { appliesTo: "minecraft", enabled: true, builtin: true, sidebar: false } as const;

function pack(
  id: string, name: string, category: string, description: string,
  eggs: string[], targetDir: "plugins" | "mods", loaders: string[], items: Item[],
) {
  return {
    ...base, id: `ext-lib-${id}`, name, category, description, eggs,
    sections: [{ title: name, type: "download_install", targetDir, loaders, items }],
  };
}

const btn = (label: string, commandTemplate: string, inputPlaceholder?: string) =>
  inputPlaceholder ? { label, commandTemplate, inputPlaceholder } : { label, commandTemplate };

export const MINECRAFT_EXTENSION_LIBRARY = [
  /* ── Admin & monitoring (RCON) ─────────────────────────────────────────── */
  {
    ...base, id: "ext-lib-admin-toolkit", name: "Server Admin Toolkit", category: "Admin tools",
    description: "Whitelist, op, kick, ban, broadcast and world saving in one click.", eggs: JAVA_EGGS,
    sections: [
      { title: "Online Players", type: "rcon_output", command: "list", refreshSeconds: 10 },
      { title: "Server", type: "rcon_buttons", buttons: [
        btn("Save World", "save-all"), btn("Save & Flush", "save-all flush"),
        btn("Broadcast", "say {input}", "message to everyone"),
      ]},
      { title: "Whitelist", type: "rcon_buttons", buttons: [
        btn("Whitelist On", "whitelist on"), btn("Whitelist Off", "whitelist off"), btn("Reload", "whitelist reload"),
        btn("Add Player", "whitelist add {input}", "username"), btn("Remove Player", "whitelist remove {input}", "username"),
      ]},
      { title: "Moderation", type: "rcon_buttons", buttons: [
        btn("Op", "op {input}", "username"), btn("Deop", "deop {input}", "username"),
        btn("Kick", "kick {input}", "username [reason]"), btn("Ban", "ban {input}", "username [reason]"),
        btn("Pardon", "pardon {input}", "username"), btn("Ban IP", "ban-ip {input}", "ip or username"),
        btn("Pardon IP", "pardon-ip {input}", "ip"),
      ]},
    ],
  },
  {
    ...base, id: "ext-lib-world-weather", name: "World & Weather Control", category: "Admin tools",
    description: "Time, weather, difficulty, spawn and world border presets.", eggs: JAVA_EGGS,
    sections: [
      { title: "Time", type: "rcon_buttons", buttons: [
        btn("Day", "time set day"), btn("Noon", "time set noon"), btn("Night", "time set night"), btn("Midnight", "time set midnight"),
      ]},
      { title: "Weather", type: "rcon_buttons", buttons: [
        btn("Clear", "weather clear"), btn("Rain", "weather rain"), btn("Thunder", "weather thunder"),
      ]},
      { title: "Difficulty & default mode", type: "rcon_buttons", buttons: [
        btn("Peaceful", "difficulty peaceful"), btn("Easy", "difficulty easy"), btn("Normal", "difficulty normal"), btn("Hard", "difficulty hard"),
        btn("Default: Survival", "defaultgamemode survival"), btn("Default: Creative", "defaultgamemode creative"),
        btn("Default: Adventure", "defaultgamemode adventure"),
      ]},
      { title: "World border & spawn", type: "rcon_buttons", buttons: [
        btn("Set Border Size", "worldborder set {input}", "blocks, e.g. 5000"), btn("Center Border (0,0)", "worldborder center 0 0"),
        btn("Border Info", "worldborder get"), btn("Set World Spawn", "setworldspawn"),
      ]},
    ],
  },
  {
    ...base, id: "ext-lib-gamerules", name: "Gamerule Control Panel", category: "Admin tools",
    description: "Toggle the most-used gamerules without typing commands.", eggs: JAVA_EGGS,
    sections: [
      { title: "Player rules", type: "rcon_buttons", buttons: [
        btn("Keep Inventory: ON", "gamerule keepInventory true"), btn("Keep Inventory: OFF", "gamerule keepInventory false"),
        btn("Instant Respawn: ON", "gamerule doImmediateRespawn true"), btn("Instant Respawn: OFF", "gamerule doImmediateRespawn false"),
        btn("Sleep % needed", "gamerule playersSleepingPercentage {input}", "0-100"),
      ]},
      { title: "World rules", type: "rcon_buttons", buttons: [
        btn("Daylight Cycle: ON", "gamerule doDaylightCycle true"), btn("Daylight Cycle: OFF", "gamerule doDaylightCycle false"),
        btn("Weather Cycle: ON", "gamerule doWeatherCycle true"), btn("Weather Cycle: OFF", "gamerule doWeatherCycle false"),
        btn("Fire Spread: ON", "gamerule doFireTick true"), btn("Fire Spread: OFF", "gamerule doFireTick false"),
        btn("Random Tick Speed", "gamerule randomTickSpeed {input}", "default 3"),
      ]},
      { title: "Mobs", type: "rcon_buttons", buttons: [
        btn("Mob Spawning: ON", "gamerule doMobSpawning true"), btn("Mob Spawning: OFF", "gamerule doMobSpawning false"),
        btn("Mob Griefing: ON", "gamerule mobGriefing true"), btn("Mob Griefing: OFF", "gamerule mobGriefing false"),
      ]},
      { title: "Chat", type: "rcon_buttons", buttons: [
        btn("Announce Advancements: ON", "gamerule announceAdvancements true"), btn("Announce Advancements: OFF", "gamerule announceAdvancements false"),
        btn("Command Feedback: ON", "gamerule sendCommandFeedback true"), btn("Command Feedback: OFF", "gamerule sendCommandFeedback false"),
      ]},
    ],
  },
  {
    ...base, id: "ext-lib-player-actions", name: "Player Actions", category: "Admin tools",
    description: "Gamemode, heal-style effects, items, XP and teleports for a named player.", eggs: JAVA_EGGS,
    sections: [
      { title: "Gamemode", type: "rcon_buttons", buttons: [
        btn("Survival", "gamemode survival {input}", "username"), btn("Creative", "gamemode creative {input}", "username"),
        btn("Adventure", "gamemode adventure {input}", "username"), btn("Spectator", "gamemode spectator {input}", "username"),
      ]},
      { title: "Items & XP", type: "rcon_buttons", buttons: [
        btn("Give Diamonds (x64)", "give {input} minecraft:diamond 64", "username"),
        btn("Give Golden Apples (x16)", "give {input} minecraft:golden_apple 16", "username"),
        btn("Give 10 Levels", "xp add {input} 10 levels", "username"),
        btn("Clear Inventory", "clear {input}", "username"),
      ]},
      { title: "Effects", type: "rcon_buttons", buttons: [
        btn("Speed (10 min)", "effect give {input} minecraft:speed 600 1", "username"),
        btn("Night Vision (10 min)", "effect give {input} minecraft:night_vision 600 0", "username"),
        btn("Regeneration (1 min)", "effect give {input} minecraft:regeneration 60 2", "username"),
        btn("Clear Effects", "effect clear {input}", "username"),
      ]},
      { title: "Teleport & respawn", type: "rcon_buttons", buttons: [
        btn("Teleport to World Spawn", "execute in minecraft:overworld run tp {input} 0 100 0", "username"),
        btn("Set Spawnpoint Here", "spawnpoint {input}", "username"), btn("Kill", "kill {input}", "username"),
      ]},
    ],
  },
  {
    ...base, id: "ext-lib-paper-monitor", name: "Paper Performance Monitor", category: "Admin tools",
    description: "Live TPS, MSPT, plugin list and online players for Paper / Spigot.", eggs: PLUGIN_EGGS,
    sections: [
      { title: "TPS", type: "rcon_output", command: "tps", refreshSeconds: 10 },
      { title: "MSPT", type: "rcon_output", command: "mspt", refreshSeconds: 10 },
      { title: "Online Players", type: "rcon_output", command: "list", refreshSeconds: 10 },
      { title: "Plugins", type: "rcon_output", command: "plugins", refreshSeconds: 60 },
    ],
  },
  {
    ...base, id: "ext-lib-forge-monitor", name: "Forge / NeoForge Monitor", category: "Admin tools",
    description: "Live tick times and online players for Forge and NeoForge.", eggs: ["FORGE"],
    sections: [
      { title: "Forge TPS", type: "rcon_output", command: "forge tps", refreshSeconds: 10 },
      { title: "NeoForge TPS", type: "rcon_output", command: "neoforge tps", refreshSeconds: 10 },
      { title: "Online Players", type: "rcon_output", command: "list", refreshSeconds: 10 },
    ],
  },
  {
    ...base, id: "ext-lib-essentials-toolkit", name: "EssentialsX Toolkit", category: "Admin tools",
    description: "Heal, feed, fly, god, vanish, mute and economy actions (needs EssentialsX installed).", eggs: PLUGIN_EGGS,
    sections: [
      { title: "Player care", type: "rcon_buttons", buttons: [
        btn("Heal", "heal {input}", "username"), btn("Feed", "feed {input}", "username"),
        btn("Fly", "fly {input}", "username"), btn("God Mode", "god {input}", "username"),
        btn("Vanish", "vanish {input}", "username"),
      ]},
      { title: "Moderation", type: "rcon_buttons", buttons: [
        btn("Mute", "mute {input}", "username [time]"), btn("Unmute", "unmute {input}", "username"),
        btn("Broadcast", "broadcast {input}", "message"), btn("Send to Spawn", "spawn {input}", "username"),
      ]},
      { title: "Economy", type: "rcon_buttons", buttons: [
        btn("Give Money", "eco give {input}", "username amount"), btn("Take Money", "eco take {input}", "username amount"),
        btn("Set Balance", "eco set {input}", "username amount"), btn("Check Balance", "balance {input}", "username"),
      ]},
    ],
  },
  {
    ...base, id: "ext-lib-luckperms-toolkit", name: "LuckPerms Toolkit", category: "Admin tools",
    description: "Run LuckPerms commands without opening the console (needs LuckPerms installed).", eggs: JAVA_EGGS,
    sections: [
      { title: "Quick info", type: "rcon_buttons", buttons: [
        btn("List Groups", "lp listgroups"), btn("Sync", "lp sync"), btn("Network Sync", "lp networksync"),
        btn("User Info", "lp user {input} info", "username"), btn("User Permissions", "lp user {input} permission info", "username"),
      ]},
      { title: "Any LuckPerms command", type: "rcon_buttons", buttons: [
        btn("Run", "lp {input}", "e.g. user Steve parent add vip"),
      ]},
    ],
  },

  /* ── Paper / Spigot plugin packs ───────────────────────────────────────── */
  pack("essentials", "Essentials Pack", "Plugins · Essentials", "Core admin plugins almost every server uses.", PLUGIN_EGGS, "plugins", PLUGIN_LOADERS, [
    { name: "EssentialsX", modrinthProject: "essentialsx" }, { name: "LuckPerms", modrinthProject: "luckperms" },
    { name: "PlaceholderAPI", modrinthProject: "placeholderapi" }, { name: "ProtocolLib", modrinthProject: "protocollib" },
    { name: "TAB", modrinthProject: "tab-was-taken" },
  ]),
  pack("protection", "Protection & Anti-Grief", "Plugins · Protection", "Land claims, rollbacks and world editing.", PLUGIN_EGGS, "plugins", PLUGIN_LOADERS, [
    { name: "CoreProtect", modrinthProject: "coreprotect" }, { name: "WorldGuard", modrinthProject: "worldguard" },
    { name: "WorldEdit", modrinthProject: "worldedit" }, { name: "GriefPrevention", modrinthProject: "griefprevention" },
  ]),
  pack("crossplay", "Cross-Play & Version Support", "Plugins · Compatibility", "Let Bedrock players and newer/older clients join.", PLUGIN_EGGS, "plugins", PLUGIN_LOADERS, [
    { name: "Geyser", modrinthProject: "geyser" }, { name: "Floodgate", modrinthProject: "floodgate" },
    { name: "ViaVersion", modrinthProject: "viaversion" }, { name: "ViaBackwards", modrinthProject: "viabackwards" },
    { name: "ViaRewind", modrinthProject: "viarewind" },
  ]),
  pack("maps", "Live Web Maps", "Plugins · Maps", "Browse your world in a web browser.", PLUGIN_EGGS, "plugins", PLUGIN_LOADERS, [
    { name: "Dynmap", modrinthProject: "dynmap" }, { name: "BlueMap", modrinthProject: "bluemap" },
    { name: "squaremap", modrinthProject: "squaremap" },
  ]),
  pack("social", "Chat, Holograms & NPCs", "Plugins · Social", "Discord bridge, holograms and NPCs.", PLUGIN_EGGS, "plugins", PLUGIN_LOADERS, [
    { name: "DiscordSRV", modrinthProject: "discordsrv" }, { name: "DecentHolograms", modrinthProject: "decentholograms" },
    { name: "FancyHolograms", modrinthProject: "fancyholograms" }, { name: "FancyNpcs", modrinthProject: "fancynpcs" },
  ]),
  pack("worlds-minigames", "Worlds & Scripting", "Plugins · Worlds", "Multiple worlds, plots and scripting.", PLUGIN_EGGS, "plugins", PLUGIN_LOADERS, [
    { name: "Multiverse-Core", modrinthProject: "multiverse-core" }, { name: "PlotSquared", modrinthProject: "plotsquared" },
    { name: "Skript", modrinthProject: "skript" },
  ]),
  pack("perf-plugins", "Profiling & Pre-generation", "Plugins · Performance", "Find lag and pre-generate your world.", PLUGIN_EGGS, "plugins", PLUGIN_LOADERS, [
    { name: "spark", modrinthProject: "spark" }, { name: "Chunky", modrinthProject: "chunky" },
  ]),
  pack("voice-votes", "Voice Chat & Votes", "Plugins · Community", "Proximity voice chat and vote listener.", PLUGIN_EGGS, "plugins", PLUGIN_LOADERS, [
    { name: "Simple Voice Chat", modrinthProject: "simple-voice-chat" }, { name: "NuVotifier", modrinthProject: "nuvotifier" },
  ]),

  /* ── Fabric mod packs ──────────────────────────────────────────────────── */
  pack("fabric-performance", "Fabric Performance Pack", "Mods · Fabric", "Server-side optimisation mods.", ["FABRIC"], "mods", FABRIC_LOADERS, [
    { name: "Fabric API", modrinthProject: "fabric-api" }, { name: "Lithium", modrinthProject: "lithium" },
    { name: "FerriteCore", modrinthProject: "ferrite-core" }, { name: "Krypton", modrinthProject: "krypton" },
    { name: "C2ME", modrinthProject: "c2me-fabric" }, { name: "ModernFix", modrinthProject: "modernfix" },
    { name: "Noisium", modrinthProject: "noisium" },
  ]),
  pack("fabric-admin", "Fabric Admin Tools", "Mods · Fabric", "Permissions, rollbacks, profiling and tick control.", ["FABRIC"], "mods", FABRIC_LOADERS, [
    { name: "LuckPerms", modrinthProject: "luckperms" }, { name: "Ledger", modrinthProject: "ledger" },
    { name: "Carpet", modrinthProject: "carpet" }, { name: "spark", modrinthProject: "spark" },
    { name: "Chunky", modrinthProject: "chunky" }, { name: "Essential Commands", modrinthProject: "essential-commands" },
  ]),
  pack("fabric-extras", "Fabric Extras", "Mods · Fabric", "Voice chat, web maps and cross-play for Fabric.", ["FABRIC"], "mods", FABRIC_LOADERS, [
    { name: "Simple Voice Chat", modrinthProject: "simple-voice-chat" }, { name: "Dynmap", modrinthProject: "dynmap" },
    { name: "BlueMap", modrinthProject: "bluemap" }, { name: "Geyser", modrinthProject: "geyser" },
    { name: "Floodgate", modrinthProject: "floodgate" },
  ]),

  /* ── Forge / NeoForge ──────────────────────────────────────────────────── */
  pack("forge-essentials", "Forge & NeoForge Essentials", "Mods · Forge", "Optimisation, profiling, voice chat and maps.", ["FORGE"], "mods", FORGE_LOADERS, [
    { name: "FerriteCore", modrinthProject: "ferrite-core" }, { name: "ModernFix", modrinthProject: "modernfix" },
    { name: "spark", modrinthProject: "spark" }, { name: "Chunky", modrinthProject: "chunky" },
    { name: "Simple Voice Chat", modrinthProject: "simple-voice-chat" }, { name: "Dynmap", modrinthProject: "dynmap" },
  ]),
];
