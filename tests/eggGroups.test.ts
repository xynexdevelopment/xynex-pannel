import { describe, it, expect } from "vitest";
import { serverGroupId, EGG_GROUPS } from "../src/lib/eggGroups";

describe("serverGroupId", () => {
  it("maps minecraft software by type (case-insensitive)", () => {
    expect(serverGroupId({ type: "Paper" })).toBe("PAPER");
    expect(serverGroupId({ type: "fabric" })).toBe("FABRIC");
  });
  it("maps FiveM, source games and coding categories", () => {
    expect(serverGroupId({ type: "FiveM" })).toBe("FIVEM");
    expect(serverGroupId({ type: "Counter-Strike 2" })).toBe("SOURCE");
    expect(serverGroupId({ type: "Node.js Generic", category: "Generic" })).toBe("CODING");
    expect(serverGroupId({ type: "Python", category: "Applications" })).toBe("CODING");
  });
  it("returns undefined for unknown eggs", () => {
    expect(serverGroupId({ type: "Palworld", category: "Games" })).toBeUndefined();
    expect(serverGroupId(null)).toBeUndefined();
  });
  it("has unique group ids", () => {
    const ids = EGG_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
