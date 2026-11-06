/**
 * Egg groups = how the panel buckets servers for the Extensions hub.
 * An extension lists group ids in its `eggs` array; a server belongs to the
 * group whose `types` (egg/software name) or `categories` match it.
 */
export interface EggGroup {
  id: string;
  label: string;
  types?: string[];      // matched against server.type (upper-cased)
  categories?: string[]; // matched against server.category (upper-cased)
}

export const EGG_GROUPS: EggGroup[] = [
  { id: "PAPER", label: "Paper", types: ["PAPER"] },
  { id: "SPIGOT", label: "Spigot", types: ["SPIGOT"] },
  { id: "FORGE", label: "Forge", types: ["FORGE"] },
  { id: "FABRIC", label: "Fabric", types: ["FABRIC"] },
  { id: "BEDROCK", label: "Bedrock", types: ["BEDROCK"] },
  { id: "FIVEM", label: "FiveM", types: ["FIVEM"] },
  { id: "REDM", label: "RedM", types: ["REDM"] },
  {
    id: "SOURCE",
    label: "Source Games",
    types: [
      "COUNTER-STRIKE 2", "COUNTER-STRIKE: SOURCE", "COUNTER-STRIKE: GO (LEGACY)", "COUNTER-STRIKE: GLOBAL OFFENSIVE",
      "LEFT 4 DEAD 2", "LEFT 4 DEAD", "GARRY'S MOD", "TEAM FORTRESS 2", "DAY OF DEFEAT: SOURCE", "HALF-LIFE 2: DEATHMATCH",
    ],
  },
  { id: "RUST", label: "Rust", types: ["RUST"] },
  { id: "TERRARIA", label: "Terraria", types: ["TERRARIA"] },
  { id: "FACTORIO", label: "Factorio", types: ["FACTORIO"] },
  { id: "CODING", label: "Coding Servers", categories: ["GENERIC", "APPLICATIONS"] },
];

export const MINECRAFT_GROUP_IDS = ["PAPER", "SPIGOT", "FORGE", "FABRIC", "BEDROCK"];

/** The group a server belongs to, or undefined when it has none. */
export function serverGroupId(server: any): string | undefined {
  const type = String(server?.type || "").trim().toUpperCase();
  const category = String(server?.category || "").trim().toUpperCase();
  return EGG_GROUPS.find((g) => g.types?.includes(type) || (g.categories && g.categories.includes(category)))?.id;
}
