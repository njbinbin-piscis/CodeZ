import { useSyncExternalStore } from "react";
import { extensionUiStore, type ExtensionUiSnapshot } from "../extensionUiStore";

export function useExtensionUi(): ExtensionUiSnapshot {
  return useSyncExternalStore(extensionUiStore.subscribe, extensionUiStore.getSnapshot);
}
