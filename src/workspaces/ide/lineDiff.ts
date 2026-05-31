/** Line-level diff (LCS) used by the Cmd-K inline diff to highlight only the
 *  lines that actually changed instead of the whole replaced block. */

export interface DiffOp {
  type: "equal" | "add" | "remove";
  text: string;
  /** Index into the "new" (b) line array; -1 for removals. */
  bIndex: number;
}

/** Classic LCS back-trace producing equal / add / remove ops. */
export function diffLines(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: b[j], bIndex: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "remove", text: a[i], bIndex: -1 });
      i++;
    } else {
      ops.push({ type: "add", text: b[j], bIndex: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "remove", text: a[i], bIndex: -1 });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", text: b[j], bIndex: j });
    j++;
  }
  return ops;
}
