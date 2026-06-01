/** SVG file / folder icons for the explorer (separate from filename text). */

interface FileIconProps {
  name?: string;
  isDir?: boolean;
  expanded?: boolean;
}

const EXT_COLORS: Record<string, string> = {
  ts: "#3178c6",
  tsx: "#3178c6",
  js: "#f7df1e",
  jsx: "#f7df1e",
  mjs: "#f7df1e",
  cjs: "#f7df1e",
  rs: "#dea584",
  py: "#3572a5",
  go: "#00add8",
  java: "#b07219",
  json: "#cbcb41",
  yaml: "#cb171e",
  yml: "#cb171e",
  toml: "#9c422d",
  md: "#519aba",
  markdown: "#519aba",
  mdx: "#519aba",
  html: "#e34c26",
  htm: "#e34c26",
  css: "#563d7c",
  scss: "#c6538c",
  less: "#563d7c",
  svg: "#ffb13b",
  png: "#a074c4",
  jpg: "#a074c4",
  jpeg: "#a074c4",
  gif: "#a074c4",
  webp: "#a074c4",
  sh: "#89e051",
  sql: "#e38c00",
  lock: "#6a737d",
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden className="file-tree-chevron">
      <path
        d={open ? "M4 6l4 4 4-4" : "M6 4l4 4-4 4"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderSvg({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      {open ? (
        <>
          <path
            d="M1.5 3.5h5l1.2 1.2H14.5v8H1.5z"
            fill="#c09553"
            stroke="#a67c3d"
            strokeWidth="0.5"
          />
          <path d="M1.5 5.5h13v6H1.5z" fill="#d4a853" />
        </>
      ) : (
        <path
          d="M1.5 3.5h5l1.2 1.2H14.5v8.5H1.5z"
          fill="#c09553"
          stroke="#a67c3d"
          strokeWidth="0.5"
        />
      )}
    </svg>
  );
}

function DocSvg({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <path
        d="M4 1.5h5.5L13 5v9.5H4z"
        fill={color}
        opacity="0.9"
      />
      <path d="M9.5 1.5V5H13" fill="none" stroke="#fff" strokeWidth="0.6" opacity="0.35" />
      <rect x="5.5" y="7.5" width="5" height="0.8" rx="0.2" fill="#fff" opacity="0.5" />
      <rect x="5.5" y="9.2" width="4" height="0.8" rx="0.2" fill="#fff" opacity="0.35" />
    </svg>
  );
}

function ImageSvg() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1" fill="#7c6af7" opacity="0.85" />
      <circle cx="5.5" cy="6.5" r="1.2" fill="#fff" opacity="0.9" />
      <path d="M3 11l3-2.5 2 1.5 2.5-3L13 11H3z" fill="#fff" opacity="0.75" />
    </svg>
  );
}

export default function FileIcon({ name, isDir, expanded }: FileIconProps) {
  if (isDir) {
    return (
      <span className="file-tree-icon-wrap">
        <Chevron open={!!expanded} />
        <FolderSvg open={!!expanded} />
      </span>
    );
  }

  const ext = extOf(name || "");
  const imageExts = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
  if (imageExts.has(ext)) {
    return (
      <span className="file-tree-icon-wrap file-tree-icon-file">
        <span className="file-tree-chevron-spacer" />
        <ImageSvg />
      </span>
    );
  }

  const color = EXT_COLORS[ext] || "#8b8ba8";
  return (
    <span className="file-tree-icon-wrap file-tree-icon-file">
      <span className="file-tree-chevron-spacer" />
      <DocSvg color={color} />
    </span>
  );
}

export function isImagePath(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(name);
}

export function isMarkdownPath(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

export function isHtmlPath(name: string): boolean {
  return /\.(html?|xhtml)$/i.test(name);
}

export function isPreviewablePath(name: string): boolean {
  return isMarkdownPath(name) || isHtmlPath(name);
}
