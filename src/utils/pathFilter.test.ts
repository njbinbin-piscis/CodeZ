import { describe, expect, it } from "vitest";
import { isIgnoredRelPath, shouldWatchPath } from "./pathFilter";

describe("pathFilter", () => {
  it("ignores agentz sqlite and wal files", () => {
    expect(isIgnoredRelPath(".agentz/piscis.db")).toBe(true);
    expect(isIgnoredRelPath(".agentz/piscis.db-wal")).toBe(true);
    expect(shouldWatchPath(".agentz/journal.db")).toBe(false);
  });

  it("allows user source files", () => {
    expect(shouldWatchPath("src/main.rs")).toBe(true);
    expect(shouldWatchPath("lib/utils.ts")).toBe(true);
  });

  it("allows editable root dotfiles", () => {
    expect(shouldWatchPath(".gitignore")).toBe(true);
    expect(shouldWatchPath(".env")).toBe(true);
  });

  it("ignores node_modules at any depth", () => {
    expect(isIgnoredRelPath("node_modules/pkg/index.js")).toBe(true);
  });

  it("ignores build artifacts", () => {
    expect(isIgnoredRelPath("target/debug/foo")).toBe(true);
    expect(isIgnoredRelPath("dist/bundle.js")).toBe(true);
  });
});
