/** Global active Monaco editor theme name, shared across editor instances so
 *  an imported VS Code theme applies everywhere (and survives tab switches). */

let current = "vs-dark";
const listeners = new Set<() => void>();

export const themeStore = {
  getSnapshot: () => current,
  subscribe: (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  set: (name: string) => {
    if (name === current) return;
    current = name;
    listeners.forEach((l) => l());
  },
};
