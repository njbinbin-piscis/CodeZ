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
}

/** Navigate the shared page; returns the final URL. */
export function browserNavigate(url: string): Promise<string> {
  return invoke<string>("browser_navigate", { url });
}

/** Capture the current page as a base64-encoded PNG (no data: prefix). */
export function browserScreenshot(): Promise<string> {
  return invoke<string>("browser_screenshot");
}

/** Forward a click at viewport coordinates (CSS pixels). */
export function browserClickAt(x: number, y: number): Promise<boolean> {
  return invoke<boolean>("browser_click_at", { x, y });
}

/** Identify the element at viewport coordinates for "pick element". */
export function browserPickAt(x: number, y: number): Promise<PickedElement | null> {
  return invoke<PickedElement | null>("browser_pick_at", { x, y });
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
