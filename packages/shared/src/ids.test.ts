import { describe, expect, it } from "vitest";
import { ID_PREFIXES, idPrefixOf, newId } from "./ids.js";

describe("ids", () => {
  it("generates prefixed uuidv7 ids", () => {
    const id = newId("act");
    expect(id).toMatch(/^act_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId("flow")));
    expect(ids.size).toBe(1000);
  });

  it("is roughly time-ordered (uuidv7)", () => {
    const before = newId("ep");
    const after = newId("ep");
    expect(after > before).toBe(true);
  });

  it("extracts prefixes", () => {
    expect(idPrefixOf("act_abc")).toBe("act");
    expect(idPrefixOf("flow_abc")).toBe("flow");
    expect(idPrefixOf("nonsense")).toBeUndefined();
    expect(idPrefixOf("badprefix_abc")).toBeUndefined();
  });

  it("covers every entity prefix", () => {
    for (const p of ID_PREFIXES) {
      expect(idPrefixOf(newId(p))).toBe(p);
    }
  });
});
