import { describe, expect, it } from "vitest";
import en from "./en";
import zh from "./zh";

function flatten(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return flatten(value as Record<string, unknown>, path);
    }
    return [path];
  });
}

describe("i18n parity", () => {
  it("en and zh expose the same key paths", () => {
    const enKeys = new Set(flatten(en as Record<string, unknown>));
    const zhKeys = new Set(flatten(zh as Record<string, unknown>));
    expect([...enKeys].sort()).toEqual([...zhKeys].sort());
  });

  it("includes explorer expand/collapse tooltips", () => {
    expect(en.ide.expandAll).toBeTruthy();
    expect(zh.ide.expandAll).toBeTruthy();
    expect(en.ide.collapseAll).toBeTruthy();
    expect(zh.ide.collapseAll).toBeTruthy();
  });
});
