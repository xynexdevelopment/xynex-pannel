import { describe, it, expect } from "vitest";
import { MINECRAFT_EXTENSION_LIBRARY } from "../src/server/data/extension-library";
import { MORE_EXTENSION_LIBRARY } from "../src/server/data/extension-library-more";
import { EGG_GROUPS } from "../src/lib/eggGroups";

const ALL: any[] = [...MINECRAFT_EXTENSION_LIBRARY, ...MORE_EXTENSION_LIBRARY];
const GROUP_IDS = new Set(EGG_GROUPS.map((g) => g.id));
const SECTION_TYPES = new Set(["rcon_output", "rcon_buttons", "download_install", "resource_install"]);

describe("built-in extension library", () => {
  it("has unique ids and valid metadata", () => {
    const ids = ALL.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of ALL) {
      expect(e.name, e.id).toBeTruthy();
      expect(e.description, e.id).toBeTruthy();
      expect(e.category, e.id).toBeTruthy();
      expect(e.sidebar, e.id).toBe(false);
      expect(Array.isArray(e.eggs) && e.eggs.length > 0, e.id).toBe(true);
      for (const g of e.eggs) expect(GROUP_IDS.has(g), `${e.id} -> unknown egg group ${g}`).toBe(true);
    }
  });

  it("only uses supported section types with complete data", () => {
    for (const e of ALL) for (const s of e.sections) {
      expect(SECTION_TYPES.has(s.type), `${e.id}: ${s.type}`).toBe(true);
      if (s.type === "rcon_buttons") for (const b of s.buttons) {
        expect(b.label && b.commandTemplate, e.id).toBeTruthy();
        if (b.commandTemplate.includes("{input}")) expect(b.inputPlaceholder, `${e.id}: ${b.label}`).toBeTruthy();
      }
      if (s.type === "rcon_output") expect(s.command, e.id).toBeTruthy();
      if (s.type === "download_install") for (const i of s.items) {
        expect(/^[a-zA-Z0-9_-]{2,64}$/.test(i.modrinthProject), `${e.id}: ${i.name}`).toBe(true);
        expect(s.loaders?.length, e.id).toBeGreaterThan(0);
      }
      if (s.type === "resource_install") for (const i of s.items) {
        const url = new URL(i.gitUrl || i.zipUrl);
        expect(url.protocol, `${e.id}: ${i.name}`).toBe("https:");
        expect(["github.com", "gitlab.com"]).toContain(url.hostname);
      }
    }
  });

  it("never smuggles shell/newline characters into button templates", () => {
    for (const e of ALL) for (const s of e.sections) if (s.type === "rcon_buttons") for (const b of s.buttons) {
      expect(/[\r\n;|&`]/.test(b.commandTemplate), `${e.id}: ${b.label}`).toBe(false);
    }
  });
});
