/**
 * Embedded browser IPC — drives a headless Chromium over CDP in the Rust host.
 * The same page is shared with the agent's `browser` automation tool.
 */
import { invoke } from "@tauri-apps/api/core";

export interface PickedElement {
  selector: string;
  tag: string;
  text: string;
  html: string;
  id?: string;
  class_name?: string;
  rect_x?: number;
  rect_y?: number;
  rect_width?: number;
  rect_height?: number;
  dom_path?: string;
  react_component?: string;
}

/** Navigate the shared page; returns the final URL. */
export function browserNavigate(url: string): Promise<string> {
  return invoke<string>("browser_navigate", { url });
}

/** Resize the Chromium viewport to match the panel (CSS pixels). */
export function browserSetViewport(width: number, height: number): Promise<[number, number]> {
  return invoke<[number, number]>("browser_set_viewport", { width, height });
}

/** Capture the current page as a base64-encoded PNG (no data: prefix). */
export function browserScreenshot(): Promise<string> {
  return invoke<string>("browser_screenshot");
}

/** Forward a click at viewport coordinates (CSS pixels). */
export function browserClickAt(x: number, y: number): Promise<boolean> {
  return invoke<boolean>("browser_click_at", { x, y });
}

/** Identify the element at viewport coordinates for pick / inspect. */
export function browserPickAt(x: number, y: number): Promise<PickedElement | null> {
  return invoke<PickedElement | null>("browser_pick_at", { x, y });
}

/** Hover-inspect: element + bounding rect at viewport coordinates. */
export function browserInspectAt(x: number, y: number): Promise<PickedElement | null> {
  return invoke<PickedElement | null>("browser_inspect_at", { x, y });
}

export function browserCurrentUrl(): Promise<string> {
  return invoke<string>("browser_current_url");
}

export function browserIsOpen(): Promise<boolean> {
  return invoke<boolean>("browser_is_open");
}

export function browserClose(): Promise<void> {
  return invoke<void>("browser_close");
}

/** Compact chat token for a picked browser element (stored in session history). */
export function browserElementPlaceholder(el: PickedElement): string {
  return `@browser-element(${el.selector})`;
}

/** Short label shown in composer / message chips (Cursor-style). */
export function browserElementChipLabel(el: PickedElement): string {
  if (el.react_component?.trim()) return el.react_component.trim();
  const tag = el.tag?.trim();
  if (tag) return `<${tag}>`;
  return el.selector;
}
