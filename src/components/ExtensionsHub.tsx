import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { EGG_GROUPS, MINECRAFT_GROUP_IDS, serverGroupId } from "../lib/eggGroups";
import { Blocks, Boxes, Box, Globe2, Lock, PackageSearch, Puzzle, ArrowUpRight, Search } from "lucide-react";

/**
 * One place for every extension, organised by egg.
 * - Pick an egg chip to see which tools/extensions that egg supports.
 * - Your server's own egg is selected by default and its cards are clickable.
 * - Other eggs are shown read-only so you can see what you'd get by switching.
 */

const MINECRAFT_EGGS = MINECRAFT_GROUP_IDS;

interface Tool {
  id: string;
  name: string;
  description: string;
  path: string; // relative to /servers/:id/
  icon: ReactNode;
  eggs: string[];
  kind: "Built-in" | "Extension";
  category: string;
}

const BUILTIN_TOOLS: Tool[] = [
  {
    id: "plugins",
    name: "Plugins",
    description: "Search and install plugins from Modrinth, SpigotMC and Paper Hangar.",
    path: "plugins",
    icon: <Puzzle size={20} />,
    eggs: ["PAPER"],
    kind: "Built-in",
    category: "Core tools",
  },
  {
    id: "mods",
    name: "Mods",
    description: "Browse and install mods for your Forge or Fabric server.",
    path: "mods",
    icon: <Box size={20} />,
    eggs: ["FORGE", "FABRIC"],
    kind: "Built-in",
    category: "Core tools",
  },
  {
    id: "modpacks",
    name: "Modpacks",
    description: "Install a complete modpack in one click.",
    path: "modpacks",
    icon: <PackageSearch size={20} />,
    eggs: ["FORGE", "FABRIC"],
    kind: "Built-in",
    category: "Core tools",
  },
  {
    id: "worlds",
    name: "World Manager",
    description: "Upload, switch, back up and delete worlds.",
    path: "worlds",
    icon: <Globe2 size={20} />,
    eggs: MINECRAFT_EGGS,
    kind: "Built-in",
    category: "Core tools",
  },
  {
    id: "addons",
    name: "Bedrock Addons",
    description: "Manage behaviour and resource packs for your Bedrock world.",
    path: "addons",
    icon: <Puzzle size={20} />,
    eggs: ["BEDROCK"],
    kind: "Built-in",
    category: "Core tools",
  },
  {
    id: "resources",
    name: "Resources",
    description: "Install, enable and remove FiveM / RedM resources and base frameworks.",
    path: "resources",
    icon: <Boxes size={20} />,
    eggs: ["FIVEM", "REDM"],
    kind: "Built-in",
    category: "Core tools",
  },
];

export default function ExtensionsHub({ serverId, server, extensions }: { serverId: string; server: any; extensions: any[] }) {
  const currentEgg = serverGroupId(server) || "";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>(currentEgg || EGG_GROUPS[0].id);

  const tools = useMemo<Tool[]>(() => {
    const uploaded: Tool[] = (extensions || [])
      .filter((e) => e.enabled && ((Array.isArray(e.eggs) && e.eggs.length) || e.appliesTo === "all" || e.appliesTo === "minecraft"))
      .map((e) => ({
        id: e.id,
        name: e.name,
        description: e.description || "Custom extension.",
        path: `ext/${e.id}`,
        icon: <Puzzle size={20} />,
        eggs: Array.isArray(e.eggs) && e.eggs.length ? e.eggs : MINECRAFT_EGGS,
        kind: "Extension" as const,
        category: e.category || "Custom",
      }));
    return [...BUILTIN_TOOLS, ...uploaded];
  }, [extensions]);

  const countFor = (eggId: string) => tools.filter((t) => t.eggs.includes(eggId)).length;
  const q = query.trim().toLowerCase();
  const visible = tools.filter(
    (t) => t.eggs.includes(selected) && (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)),
  );
  const groups = useMemo(() => {
    const map = new Map<string, Tool[]>();
    visible.forEach((t) => map.set(t.category, [...(map.get(t.category) || []), t]));
    const order = ["Core tools", "Admin tools"];
    return [...map.entries()].sort(([a], [b]) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
    });
  }, [visible]);
  const selectedLabel = EGG_GROUPS.find((e) => e.id === selected)?.label ?? selected;
  const isCurrent = selected === currentEgg;

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto w-full">
      <div className="mb-6 flex items-center gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-theme-500/15 text-theme-400 ring-1 ring-theme-500/30">
          <Blocks size={24} />
        </span>
        <div className="min-w-0">
          <h2 className="text-2xl md:text-3xl font-black tracking-tight text-foreground">Extensions</h2>
          <p className="text-sm text-muted-foreground">Everything available for each egg, in one place.</p>
        </div>
      </div>

      {/* egg chips */}
      <div className="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Eggs">
        {EGG_GROUPS.map((egg) => {
          const active = egg.id === selected;
          const mine = egg.id === currentEgg;
          return (
            <button
              key={egg.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSelected(egg.id)}
              className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-medium transition-all active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-theme-500/50 ${
                active
                  ? "border-theme-500/40 bg-theme-500/20 text-theme-300 shadow-[0_0_18px_-6px_rgba(var(--theme-rgb-500),0.6)]"
                  : "border-border-subtle bg-muted-subtle text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {mine && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="Your server's egg" />}
              {egg.label}
              <span className={`rounded-md px-1.5 text-[11px] ${active ? "bg-theme-500/25" : "bg-white/5"}`}>{countFor(egg.id)}</span>
            </button>
          );
        })}
      </div>

      <div className="relative mb-6 max-w-md">
        <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search extensions…"
          className="w-full rounded-xl border border-border-subtle bg-muted-subtle py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none transition-all focus:border-theme-500/50 focus:ring-2 focus:ring-theme-500/20"
        />
      </div>

      {!isCurrent && (
        <div className="mb-5 flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
          <Lock size={16} className="shrink-0" />
          <span>
            Preview only. These tools need the <strong>{selectedLabel}</strong> egg
            {currentEgg ? <> — this server runs <strong>{server?.type}</strong>.</> : "."}
          </span>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="rounded-2xl border border-border-subtle bg-muted-subtle px-6 py-16 text-center text-sm text-muted-foreground">
          {q ? `No extensions match "${query}" for ${selectedLabel}.` : `No extensions available for ${selectedLabel} yet.`}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map(([category, list]) => (
            <section key={`${selected}-${category}`}>
              <h3 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                {category}
                <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold">{list.length}</span>
              </h3>
              <motion.div
                initial="hidden"
                animate="show"
                variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
                className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
              >
                {list.map((tool) => {
                  const card = (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-theme-500/12 text-theme-400 ring-1 ring-theme-500/25">
                          {tool.icon}
                        </span>
                        <span className="rounded-md border border-border-subtle bg-white/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {tool.kind}
                        </span>
                      </div>
                      <h4 className="mt-4 text-base font-semibold text-foreground">{tool.name}</h4>
                      <p className="mt-1 flex-1 text-sm leading-relaxed text-muted-foreground">{tool.description}</p>
                      <div className="mt-4 flex items-center gap-1.5 text-sm font-medium">
                        {isCurrent ? (
                          <span className="inline-flex items-center gap-1 text-theme-400 transition-transform group-hover:translate-x-0.5">
                            Open <ArrowUpRight size={15} />
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                            <Lock size={13} /> Requires {selectedLabel}
                          </span>
                        )}
                      </div>
                    </>
                  );
                  const base = "group flex h-full flex-col rounded-2xl border border-border-subtle bg-muted-subtle p-5 transition-all";
                  return (
                    <motion.div key={tool.id} variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }} transition={{ duration: 0.3 }}>
                      {isCurrent ? (
                        <Link to={`/servers/${serverId}/${tool.path}`} className={`${base} hover:-translate-y-0.5 hover:border-theme-500/40 hover:bg-theme-500/[0.07]`}>
                          {card}
                        </Link>
                      ) : (
                        <div className={`${base} opacity-70`}>{card}</div>
                      )}
                    </motion.div>
                  );
                })}
              </motion.div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
