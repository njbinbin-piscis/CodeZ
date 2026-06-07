import { useCallback, useRef } from "react";

const MAX_ITEMS = 50;

function loadHistory(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    return [];
  }
}

function saveHistory(storageKey: string, items: string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(items.slice(-MAX_ITEMS)));
  } catch {
    /* quota — best effort */
  }
}

/**
 * Shell-style ↑/↓ recall for composer text. Persists per `storageKey`.
 */
export function useInputHistory(storageKey: string) {
  const itemsRef = useRef<string[]>(loadHistory(storageKey));
  const indexRef = useRef(-1);
  const draftRef = useRef("");

  const push = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const items = itemsRef.current;
      if (items[items.length - 1] === trimmed) {
        indexRef.current = -1;
        draftRef.current = "";
        return;
      }
      itemsRef.current = [...items, trimmed].slice(-MAX_ITEMS);
      saveHistory(storageKey, itemsRef.current);
      indexRef.current = -1;
      draftRef.current = "";
    },
    [storageKey],
  );

  const navigate = useCallback((direction: "up" | "down", currentValue: string): string | null => {
    const items = itemsRef.current;
    if (items.length === 0) return null;

    if (direction === "up") {
      if (indexRef.current === -1) {
        draftRef.current = currentValue;
        indexRef.current = items.length - 1;
      } else if (indexRef.current > 0) {
        indexRef.current -= 1;
      }
      return items[indexRef.current] ?? null;
    }

    if (indexRef.current === -1) return null;
    if (indexRef.current < items.length - 1) {
      indexRef.current += 1;
      return items[indexRef.current] ?? null;
    }
    indexRef.current = -1;
    return draftRef.current;
  }, []);

  const resetNavigation = useCallback(() => {
    indexRef.current = -1;
    draftRef.current = "";
  }, []);

  return { push, navigate, resetNavigation };
}
