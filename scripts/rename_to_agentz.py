#!/usr/bin/env python3
"""One-shot rebrand: AgentZ product → AgentZ; IDE mode → AgentZ; Agent mode → WorkZ."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SKIP_DIRS = {
    ".git",
    "node_modules",
    "target",
    "dist",
    "gen",
    ".vite",
}

TEXT_SUFFIXES = {
    ".rs",
    ".ts",
    ".tsx",
    ".css",
    ".json",
    ".toml",
    ".md",
    ".html",
    ".py",
    ".yml",
    ".yaml",
    ".lock",
    ".sh",
    ".svg",
}


def iter_files() -> list[Path]:
    out: list[Path] = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix not in TEXT_SUFFIXES:
            continue
        out.append(path)
    return out


def transform(text: str, path: Path) -> str:
    rel = str(path.relative_to(ROOT))

    # ── Product / package identifiers (longest first) ─────────────────────
    pairs: list[tuple[str, str]] = [
        ("agentz_desktop_lib", "agentz_desktop_lib"),
        ("agentz-desktop", "agentz-desktop"),
        ("agentz-extension-host", "agentz-extension-host"),
        ("AGENTZ_CONFIG_DIR", "AGENTZ_CONFIG_DIR"),
        ("com.agentz.desktop", "com.agentz.desktop"),
        ("agentz-host", "agentz-host"),
        ("agentz-sample", "agentz-sample"),
        ("agentzSample", "agentzSample"),
        ("run_agentz_turn", "run_agentz_turn"),
        ("agentz-smoke-", "agentz-smoke-"),
        ("agentz-browser-shots", "agentz-browser-shots"),
        ("agentz-browser-", "agentz-browser-"),
        ("AgentZ-Desktop", "AgentZ-Desktop"),
        ("AgentZ/1.0", "AgentZ/1.0"),
        ("njbinbin-piscis/AgentZ", "njbinbin-piscis/AgentZ"),
        ("agentz-linux-", "agentz-linux-"),
        ("agentz-macos-", "agentz-macos-"),
        ("agentz-windows-", "agentz-windows-"),
        ("agentz:", "agentz:"),
        (".agentz-worktrees", ".agentz-worktrees"),
        ("workz/task-", "workz/task-"),
        ('PROJECT_DATA_DIR: &str = ".agentz"', 'PROJECT_DATA_DIR: &str = ".agentz"'),
        (".agentz/", ".agentz/"),
        ('".agentz"', '".agentz"'),
        ("`.agentz", "`.agentz"),
        ("agentz-workz-", "agentz-workz-"),
        ("agentz-", "agentz-"),
        ("WorkZWorkspace", "WorkZWorkspace"),
        ("WorkZWorkspaceProps", "WorkZWorkspaceProps"),
        ("AgentZWorkspace", "AgentZWorkspace"),
        ('from "./workspaces/agentz"', 'from "./workspaces/agentz"'),
        ('from "./workspaces/workz"', 'from "./workspaces/workz"'),
        ('"./workspaces/agentz/', '"./workspaces/agentz/'),
        ('"./workspaces/workz/', '"./workspaces/workz/'),
        ('../workspaces/agentz/', '../workspaces/agentz/'),
        ('../workspaces/workz/', '../workspaces/workz/'),
        ('../../workspaces/agentz/', '../../workspaces/agentz/'),
        ('../../workspaces/workz/', '../../workspaces/workz/'),
        ('../../../workspaces/agentz/', '../../../workspaces/agentz/'),
        ('../../../workspaces/workz/', '../../../workspaces/workz/'),
        ("workspaces/agentz/", "workspaces/agentz/"),
        ("workspaces/workz/", "workspaces/workz/"),
        # App mode keys
        ('type Mode = "agentz" | "workz"', 'type Mode = "agentz" | "workz"'),
        ('useState<Mode>("agentz")', 'useState<Mode>("agentz")'),
        ('setMode("agentz")', 'setMode("agentz")'),
        ('setMode("workz")', 'setMode("workz")'),
        ('mode === "agentz"', 'mode === "agentz"'),
        ('mode === "workz"', 'mode === "workz"'),
        ('mode !== "agentz"', 'mode !== "agentz"'),
        ('mode !== "workz"', 'mode !== "workz"'),
        # i18n keys
        ("modeAgentZTitle", "modeAgentZTitle"),
        ("modeWorkZTitle", "modeWorkZTitle"),
        ("modeAgentZ:", "modeAgentZ:"),
        ("modeWorkZ:", "modeWorkZ:"),
        ("app.modeAgentZ", "app.modeAgentZ"),
        ("app.modeWorkZ", "app.modeWorkZ"),
        ('SESSION_SOURCE: &str = "agentz"', 'SESSION_SOURCE: &str = "agentz"'),
        ('"name": "agentz"', '"name": "agentz"'),
        ("AgentZ", "AgentZ"),
        ("agentz", "agentz"),
    ]

    for old, new in pairs:
        text = text.replace(old, new)

    # Restore chat / marketplace protocol tokens accidentally touched by final agentz→agentz.
    restores = [
        ('chatMode: "agent"', 'chatMode: "agent"'),
        ('chat_mode == "agent"', 'chat_mode == "agent"'),
        ('else { "agent" }', 'else { "agent" }'),
        ('else { "agent";', 'else { "agent";'),
        ('"agent" | "plan"', '"agent" | "plan"'),
        ('"agent" | "plan"', '"agent" | "plan"'),  # idempotent
        ('ChatMode = "agent" | "plan"', 'ChatMode = "agent" | "plan"'),
        ('chatMode ?? "agent"', 'chatMode ?? "agent"'),
        ('id: "agent", label: t("chat.modeWorkZ")', 'id: "agent", label: t("chat.modeWorkZ")'),
        ('saved === "plan" ? "plan" : "agent"', 'saved === "plan" ? "plan" : "agent"'),
        ('"skill", "tool", "agent", "team"', '"skill", "tool", "agent", "team"'),
        ('"tool", "agent", "team"', '"tool", "agent", "team"'),
        ('category: "agent"', 'category: "agent"'),
        ('("skill", "agent")', '("skill", "agent")'),
        ('cat_agent', 'cat_agent'),
        ('market.cat_agent', 'market.cat_agent'),
        # Mode display values: IDE mode label should read AgentZ, not AgentZ
        ('modeAgentZ: "AgentZ"', 'modeAgentZ: "AgentZ"'),
        ('modeAgentZTitle: "AgentZ ', 'modeAgentZTitle: "AgentZ '),
        ('Ask AgentZ', 'Ask AgentZ'),  # product placeholder stays AgentZ
    ]
    for old, new in restores:
        text = text.replace(old, new)

    # i18n display strings for modes
    text = re.sub(
        r'(modeAgentZ:\s*)"IDE"',
        r'\1"AgentZ"',
        text,
    )
    text = re.sub(
        r'(modeWorkZ:\s*)"Agent"',
        r'\1"WorkZ"',
        text,
    )
    text = re.sub(
        r'(modeAgentZTitle:\s*)"IDE mode',
        r'\1"AgentZ mode',
        text,
    )
    text = re.sub(
        r'(modeWorkZTitle:\s*)"Agent mode',
        r'\1"WorkZ mode',
        text,
    )
    text = re.sub(
        r'(modeAgentZTitle:\s*)"IDE 模式',
        r'\1"AgentZ 模式',
        text,
    )
    text = re.sub(
        r'(modeWorkZTitle:\s*)"Agent 模式',
        r'\1"WorkZ 模式',
        text,
    )

    return text


def main() -> None:
    changed = 0
    for path in iter_files():
        original = path.read_text(encoding="utf-8", errors="surrogateescape")
        updated = transform(original, path)
        if updated != original:
            path.write_text(updated, encoding="utf-8")
            changed += 1
            print(f"updated: {path.relative_to(ROOT)}")
    print(f"done: {changed} files updated")


if __name__ == "__main__":
    main()
