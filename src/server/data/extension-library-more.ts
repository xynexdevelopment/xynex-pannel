/**
 * Built-in extension library for everything that isn't Minecraft:
 * FiveM / RedM, Source-engine games, Rust, Terraria, Factorio and coding servers.
 *
 * Button commands are sent to the server's console (stdin), so output shows up in
 * the Console tab. Install items are public GitHub repos / release zips, installed
 * by the panel's resource installer (git clone or zip extract, no shell involved).
 */

const base = { appliesTo: "all", enabled: true, builtin: true, sidebar: false } as const;

const btn = (label: string, commandTemplate: string, inputPlaceholder?: string) =>
  inputPlaceholder ? { label, commandTemplate, inputPlaceholder } : { label, commandTemplate };

type Res = { name: string; folder?: string; gitUrl?: string; zipUrl?: string; description?: string };
const gh = (owner: string, repo: string, name = repo, description?: string): Res => ({ name, folder: repo, gitUrl: `https://github.com/${owner}/${repo}`, description });
const release = (owner: string, repo: string, asset = `${repo}.zip`, name = repo, description?: string): Res => ({
  name, folder: repo, zipUrl: `https://github.com/${owner}/${repo}/releases/latest/download/${asset}`, description,
});

function resourcePack(
  id: string, name: string, category: string, description: string, eggs: string[],
  targetDir: string, items: Res[], opts: { ensure?: boolean; intoRoot?: boolean } = {},
) {
  return {
    ...base, id: `ext-lib-${id}`, name, category, description, eggs,
    sections: [{ title: name, type: "resource_install", targetDir, ensure: !!opts.ensure, intoRoot: !!opts.intoRoot, items }],
  };
}

export const MORE_EXTENSION_LIBRARY = [
  /* ── FiveM / RedM ──────────────────────────────────────────────────────── */
  {
    ...base, id: "ext-lib-fivem-resources", name: "Resource Manager Console", category: "Admin tools",
    description: "Start, stop, restart and refresh resources without typing in the console.", eggs: ["FIVEM", "REDM"],
    sections: [
      { title: "Resources", type: "rcon_buttons", buttons: [
        btn("Refresh Resource List", "refresh"),
        btn("Ensure (start or restart)", "ensure {input}", "resource name"),
        btn("Start", "start {input}", "resource name"), btn("Stop", "stop {input}", "resource name"),
        btn("Restart", "restart {input}", "resource name"),
      ]},
      { title: "Config", type: "rcon_buttons", buttons: [
        btn("Run Config File", "exec {input}", "e.g. server.cfg"),
        btn("Set Convar", "set {input}", "name value, e.g. sv_maxclients 48"),
        btn("Set Server Info", "sets {input}", "key value"),
      ]},
    ],
  },
  {
    ...base, id: "ext-lib-fivem-admin", name: "FiveM Admin Console", category: "Admin tools",
    description: "Players, announcements, kicks and ACE permissions (output appears in the Console tab).", eggs: ["FIVEM", "REDM"],
    sections: [
      { title: "Server", type: "rcon_buttons", buttons: [
        btn("Show Players", "status"), btn("Announce", "say {input}", "message to everyone"),
      ]},
      { title: "Players", type: "rcon_buttons", buttons: [
        btn("Kick", "clientkick {input}", "player id + reason, e.g. 12 AFK"),
      ]},
      { title: "Permissions (ACE)", type: "rcon_buttons", buttons: [
        btn("Add Admin / Group", "add_principal {input}", "identifier.fivem:123456 group.admin"),
        btn("Remove from Group", "remove_principal {input}", "identifier.fivem:123456 group.admin"),
        btn("Allow Command", "add_ace {input}", "group.admin command allow"),
      ]},
    ],
  },
  resourcePack("fivem-ox", "ox Stack", "Resources · Libraries", "overextended's core libraries — install ox_lib and oxmysql first, then the rest.", ["FIVEM"], "resources/[ox]", [
    release("overextended", "ox_lib"), release("overextended", "oxmysql"), release("overextended", "ox_inventory"),
    release("overextended", "ox_target"), release("overextended", "ox_doorlock"),
  ], { ensure: true }),
  resourcePack("fivem-qb-essentials", "QBCore Essentials", "Resources · QBCore", "Menus, HUD, inventory and character flow for QBCore (install qb-core from the Resources tab first).", ["FIVEM"], "resources/[qb]", [
    gh("qbcore-framework", "qb-inventory"), gh("qbcore-framework", "qb-menu"), gh("qbcore-framework", "qb-input"),
    gh("qbcore-framework", "qb-target"), gh("qbcore-framework", "qb-radialmenu"), gh("qbcore-framework", "qb-hud"),
    gh("qbcore-framework", "qb-smallresources"), gh("qbcore-framework", "qb-weathersync"), gh("qbcore-framework", "qb-adminmenu"),
    gh("qbcore-framework", "qb-multicharacter"), gh("qbcore-framework", "qb-spawn"), gh("qbcore-framework", "qb-apartments"),
    gh("qbcore-framework", "qb-clothing"),
  ], { ensure: true }),
  resourcePack("fivem-qb-jobs", "QBCore Jobs & Economy", "Resources · QBCore", "Police, EMS, mechanic, banking, phone, vehicles and housing for QBCore.", ["FIVEM"], "resources/[qb]", [
    gh("qbcore-framework", "qb-policejob"), gh("qbcore-framework", "qb-ambulancejob"), gh("qbcore-framework", "qb-mechanicjob"),
    gh("qbcore-framework", "qb-banking"), gh("qbcore-framework", "qb-phone"), gh("qbcore-framework", "qb-vehicleshop"),
    gh("qbcore-framework", "qb-garages"), gh("qbcore-framework", "qb-doorlock"), gh("qbcore-framework", "qb-management"),
    gh("qbcore-framework", "qb-houses"),
  ], { ensure: true }),
  resourcePack("fivem-project-sloth", "Project Sloth", "Resources · QBCore", "Popular QBCore add-ons: HUD, dispatch, housing and UI.", ["FIVEM"], "resources/[ps]", [
    gh("Project-Sloth", "ps-ui"), gh("Project-Sloth", "ps-hud"), gh("Project-Sloth", "ps-dispatch"), gh("Project-Sloth", "ps-housing"),
  ], { ensure: true }),
  resourcePack("fivem-utilities", "Voice & Utilities", "Resources · Standalone", "Proximity voice, screenshots, menus and Discord integration.", ["FIVEM"], "resources/[standalone]", [
    gh("AvarianKnight", "pma-voice"), gh("citizenfx", "screenshot-basic"), gh("ThymonA", "menuv"), gh("JaredScar", "Badger_Discord_API"),
  ], { ensure: true }),

  /* ── Source-engine games ───────────────────────────────────────────────── */
  {
    ...base, id: "ext-lib-source-console", name: "Source Engine Console", category: "Admin tools",
    description: "Maps, kicks, round restarts and cheats for CS2, CS:S, L4D2, GMod, TF2 and friends.", eggs: ["SOURCE"],
    sections: [
      { title: "Server", type: "rcon_buttons", buttons: [
        btn("Status (players)", "status"), btn("Change Map", "changelevel {input}", "map name, e.g. de_dust2"),
        btn("Say", "say {input}", "message"), btn("Run Config", "exec {input}", "e.g. server.cfg"),
        btn("Restart Round / Game", "mp_restartgame 1"),
      ]},
      { title: "Players", type: "rcon_buttons", buttons: [
        btn("Kick by Name", "kick {input}", "player name"), btn("Kick by User ID", "kickid {input}", "userid [reason]"),
        btn("Ban by User ID", "banid {input}", "minutes userid (0 = permanent)"), btn("Write Ban List", "writeid"),
      ]},
      { title: "Cheats", type: "rcon_buttons", buttons: [btn("Cheats ON", "sv_cheats 1"), btn("Cheats OFF", "sv_cheats 0")] },
    ],
  },

  /* ── Rust ──────────────────────────────────────────────────────────────── */
  {
    ...base, id: "ext-lib-rust-admin", name: "Rust Admin Console", category: "Admin tools",
    description: "Save, announce, kick/ban, wipe timers and Oxide plugin controls.", eggs: ["RUST"],
    sections: [
      { title: "Server", type: "rcon_buttons", buttons: [
        btn("Save World", "server.save"), btn("Write Config", "server.writecfg"), btn("Status (players)", "status"),
        btn("Announce", "say {input}", "message"), btn("Restart (countdown)", "restart {input}", "seconds [reason]"),
        btn("Set Time of Day", "env.time {input}", "0-24, e.g. 12"),
      ]},
      { title: "Players", type: "rcon_buttons", buttons: [
        btn("Kick", "kick {input}", "name or steamid [reason]"), btn("Ban", "ban {input}", "name or steamid [reason]"),
        btn("Unban", "unban {input}", "steamid"),
      ]},
      { title: "Oxide / uMod", type: "rcon_buttons", buttons: [
        btn("List Plugins", "oxide.plugins"), btn("Reload Plugin", "oxide.reload {input}", "plugin name, or *"),
        btn("Load Plugin", "oxide.load {input}", "plugin name"), btn("Unload Plugin", "oxide.unload {input}", "plugin name"),
      ]},
    ],
  },

  /* ── Terraria ──────────────────────────────────────────────────────────── */
  {
    ...base, id: "ext-lib-terraria-console", name: "Terraria Console", category: "Admin tools",
    description: "Save, time of day, kick/ban and announcements.", eggs: ["TERRARIA"],
    sections: [
      { title: "World", type: "rcon_buttons", buttons: [
        btn("Save", "save"), btn("Players Online", "playing"), btn("Say", "say {input}", "message"),
        btn("Dawn", "dawn"), btn("Noon", "noon"), btn("Dusk", "dusk"), btn("Midnight", "midnight"), btn("Settle Water", "settle"),
      ]},
      { title: "Players", type: "rcon_buttons", buttons: [btn("Kick", "kick {input}", "player name"), btn("Ban", "ban {input}", "player name")] },
    ],
  },

  /* ── Factorio ──────────────────────────────────────────────────────────── */
  {
    ...base, id: "ext-lib-factorio-console", name: "Factorio Console", category: "Admin tools",
    description: "Players, saves, admins, bans and whitelist.", eggs: ["FACTORIO"],
    sections: [
      { title: "Server", type: "rcon_buttons", buttons: [btn("Players Online", "/players online"), btn("Save", "/save"), btn("Admins", "/admins")] },
      { title: "Players", type: "rcon_buttons", buttons: [
        btn("Kick", "/kick {input}", "player [reason]"), btn("Ban", "/ban {input}", "player [reason]"), btn("Unban", "/unban {input}", "player"),
        btn("Promote to Admin", "/promote {input}", "player"), btn("Demote", "/demote {input}", "player"),
      ]},
      { title: "Whitelist", type: "rcon_buttons", buttons: [
        btn("Add", "/whitelist add {input}", "player"), btn("Remove", "/whitelist remove {input}", "player"),
      ]},
    ],
  },

  /* ── Coding servers (Node.js, Python, Java, Go, Rust, C#, Deno, Bun…) ──── */
  {
    ...base, id: "ext-lib-coding-process", name: "Process Input", category: "Developer tools",
    description: "Send text to your running app's stdin, or restart nodemon-style apps with 'rs'.", eggs: ["CODING"],
    sections: [
      { title: "Send to process", type: "rcon_buttons", buttons: [btn("Send", "{input}", "text sent to the running program")] },
      { title: "Quick actions", type: "rcon_buttons", buttons: [btn("Restart (nodemon 'rs')", "rs")] },
    ],
  },
  resourcePack("coding-node-samples", "Node.js Sample Projects", "Developer tools", "Full sample apps cloned into their own folder — point your startup file at the folder (e.g. hackathon-starter/app.js).", ["CODING"], "", [
    gh("sahat", "hackathon-starter"), gh("gothinkster", "node-express-realworld-example-app"),
    { name: "Express (with examples/)", folder: "express", gitUrl: "https://github.com/expressjs/express", description: "See the examples/ folder for small runnable apps." },
  ]),
  resourcePack("coding-python-samples", "Python Sample Projects", "Developer tools", "Flask and Discord bot examples cloned into their own folder — set your startup file to the folder's entry script.", ["CODING"], "", [
    gh("miguelgrinberg", "microblog"), gh("miguelgrinberg", "flasky"),
    { name: "discord.py (with examples/)", folder: "discord.py", gitUrl: "https://github.com/Rapptz/discord.py", description: "See the examples/ folder for ready-to-run bots." },
  ]),
];
