// Minimal semver range checker for validating `engines.vscode`. Supports the
// subset VS Code extensions actually use: "*", "x", exact, ">=", ">", "<=",
// "<", "^", "~", and the "1.x"/"1.75.x" wildcard forms. Pre-release/build
// metadata is ignored. This is intentionally small (no npm `semver` dep).

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
  if (!target) return true; // wildcard like "1.x" → treat as any in that line

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
      // ^1.2.3 := >=1.2.3 <2.0.0 (major-locked)
      return v.major === target.major && cmp(v, target) >= 0;
    case "~":
      // ~1.2.3 := >=1.2.3 <1.3.0 (minor-locked)
      return v.major === target.major && v.minor === target.minor && cmp(v, target) >= 0;
    default: {
      // exact-ish: a bare "1.75.0" or "1.75" or "1.x"
      const hasMinor = /^\D*\d+\.\d+/.test(m[2]);
      const hasPatch = /^\D*\d+\.\d+\.\d+/.test(m[2]);
      if (!hasMinor) return v.major === target.major;
      if (!hasPatch) return v.major === target.major && v.minor === target.minor;
      return cmp(v, target) === 0;
    }
  }
}

/** Does `version` satisfy the (space-separated AND, "||"-separated OR) range? */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  const orGroups = range.split("||");
  return orGroups.some((group) =>
    group
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((cmpStr) => satisfiesComparator(v, cmpStr)),
  );
}
