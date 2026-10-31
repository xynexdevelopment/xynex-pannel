import { describe, it, expect } from "vitest";
import { filterNavItems } from "../src/lib/navSearch";

const items = [
  { id: "tab:users", label: "Users", group: "Users & Access", description: "Accounts, roles, suspension and 2FA resets.", keywords: ["password"] },
  { id: "tab:auth", label: "Login & Auth", group: "Users & Access", description: "Google sign-in and Discord account linking.", keywords: ["oauth"] },
  { id: "tab:activity", label: "Activity Log", group: "Monitoring", description: "Audit trail plus Discord webhook notifications.", keywords: ["webhook"] },
  { id: "general:branding", label: "Branding", group: "General", description: "Name, logo, background", keywords: ["logo"] },
];

describe("filterNavItems", () => {
  it("returns everything in original order for an empty query", () => {
    expect(filterNavItems(items, "  ").map((i) => i.id)).toEqual(items.map((i) => i.id));
  });
  it("matches keywords the label does not contain", () => {
    expect(filterNavItems(items, "logo").map((i) => i.id)).toEqual(["general:branding"]);
  });
  it("ranks label-prefix matches above description matches", () => {
    // "discord" only appears in descriptions; "users" is a label prefix and also in group names
    const r = filterNavItems(items, "users").map((i) => i.id);
    expect(r[0]).toBe("tab:users");
  });
  it("requires every search term to match", () => {
    expect(filterNavItems(items, "discord webhook").map((i) => i.id)).toEqual(["tab:activity"]);
    expect(filterNavItems(items, "discord banana")).toEqual([]);
  });
  it("is case-insensitive", () => {
    expect(filterNavItems(items, "OAUTH").map((i) => i.id)).toEqual(["tab:auth"]);
  });
});
