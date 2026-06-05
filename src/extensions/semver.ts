// Renderer copy of the host's minimal semver range checker (keep in sync with
// extension-host/src/host/semver.ts) — used to pre-check `engines.vscode` for
// marketplace results before installing.

interface V {
  major: number;
  minor: number;
  patch: number;
}

function parse(version: string): V | null {
  const cleaned = version.trim().replace(/^[v=]+/, "").split(/[-+]/)[0];
  const parts = cleaned.split(".");
  const major = toNum(parts[0]);
  if (major === null) return null;
  return { major, minor: toNum(parts[1]) ?? 0, patch: toNum(parts[2]) ?? 0 };
}

function toNum(s: string | undefined): number | null {
  if (s === undefined || s === "" || s === "x" || s === "X" || s === "*") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cmp(a: V, b: V): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function satisfiesComparator(v: V, raw: string): boolean {
  const range = raw.trim();
  if (range === "" || range === "*" || range === "x" || range === "latest") return true;

  const m = range.match(/^(>=|<=|>|<|\^|~)?\s*(.+)$/);
  if (!m) return false;
  const op = m[1] ?? "";
  const target = parse(m[2]);
  if (!target) return true;

  switch (op) {
    case ">=":
      return cmp(v, target) >= 0;
    case ">":
      return cmp(v, target) > 0;
    case "<=":
      return cmp(v, target) <= 0;
    case "<":
      return cmp(v, target) < 0;
    case "^":
      return v.major === target.major && cmp(v, target) >= 0;
    case "~":
      return v.major === target.major && v.minor === target.minor && cmp(v, target) >= 0;
    default: {
      const hasMinor = /^\D*\d+\.\d+/.test(m[2]);
      const hasPatch = /^\D*\d+\.\d+\.\d+/.test(m[2]);
      if (!hasMinor) return v.major === target.major;
      if (!hasPatch) return v.major === target.major && v.minor === target.minor;
      return cmp(v, target) === 0;
    }
  }
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  return range
    .split("||")
    .some((group) =>
      group
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .every((c) => satisfiesComparator(v, c)),
    );
}
