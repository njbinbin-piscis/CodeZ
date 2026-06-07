import { open } from "@tauri-apps/plugin-dialog";
import type { ChatAttachment } from "../services/tauri/chat";
import type { LlmProviderConfig } from "../services/tauri/settings";
import { ideApi } from "../services/tauri/ide";

export function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    ts: "text/typescript",
    tsx: "text/typescript",
    js: "text/javascript",
    jsx: "text/javascript",
    py: "text/x-python",
    rs: "text/x-rust",
  };
  return map[ext] ?? "application/octet-stream";
}

export function dataUrlToBase64(dataUrl: string): string | null {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : null;
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Map an absolute path to a workspace-relative path when possible. */
export function absPathToProjectRel(absPath: string, projectDir: string): string {
  const normRoot = projectDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const norm = absPath.replace(/\\/g, "/");
  if (norm.startsWith(`${normRoot}/`)) return norm.slice(normRoot.length + 1);
  if (norm.startsWith(normRoot)) return norm.slice(normRoot.length).replace(/^\//, "");
  return norm.split("/").pop() ?? norm;
}

export function modelLabel(p: LlmProviderConfig): string {
  return p.label?.trim() || p.id;
}

/** Short label for the composer trigger — model name only, no provider prefix. */
export function modelDisplayLabel(p: LlmProviderConfig): string {
  if (p.model?.trim()) return p.model.trim();
  return modelLabel(p);
}

/** Short label for the default-model menu entry (settings provider/model). */
export function defaultModelDisplayLabel(provider: string, model: string): string {
  if (model?.trim()) return model.trim();
  return provider?.trim() || "default";
}

export async function pickChatAttachment(): Promise<{
  attachment: ChatAttachment;
  preview: string | null;
} | null> {
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] },
      {
        name: "Files",
        extensions: ["pdf", "txt", "md", "csv", "json", "ts", "tsx", "js", "jsx", "py", "rs"],
      },
      { name: "All", extensions: ["*"] },
    ],
  });
  if (!selected || Array.isArray(selected)) return null;

  const path = selected;
  const filename = path.split(/[/\\]/).pop() ?? path;
  const media_type = guessMime(path);
  let data: string | null = null;
  let preview: string | null = null;

  if (media_type.startsWith("image/")) {
    try {
      const file = await ideApi.readFile(path);
      if (file.preview_data) {
        preview = file.preview_data;
        data = dataUrlToBase64(file.preview_data);
      }
    } catch {
      preview = null;
    }
  }

  return {
    attachment: { media_type, path, data, filename },
    preview,
  };
}

/**
 * Build a chat attachment from an absolute file path (used for drag-and-drop).
 * Reads image bytes for a preview thumbnail; other file types are passed by
 * path so the backend can read them at send time.
 */
export async function attachmentFromPath(path: string): Promise<{
  attachment: ChatAttachment;
  preview: string | null;
}> {
  const filename = path.split(/[/\\]/).pop() ?? path;
  const media_type = guessMime(path);
  let data: string | null = null;
  let preview: string | null = null;

  if (media_type.startsWith("image/")) {
    try {
      const file = await ideApi.readFile(path);
      if (file.preview_data) {
        preview = file.preview_data;
        data = dataUrlToBase64(file.preview_data);
      }
    } catch {
      preview = null;
    }
  }

  return {
    attachment: { media_type, path, data, filename },
    preview,
  };
}
