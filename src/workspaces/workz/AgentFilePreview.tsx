import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ideApi } from "../../services/tauri/ide";
import type { FileContent } from "../codez/types";
import Markdown from "../codez/Markdown";
import ImagePreview from "../codez/ImagePreview";
import { isHtmlPath, isImagePath, isMarkdownPath } from "../codez/FileIcon";
import { resolveArtifactFullPath, isPdfPath } from "./artifactPaths";

interface AgentFilePreviewProps {
  projectDir: string;
  path: string;
  /** Isolated worktree the agent ran in (paths resolve here when set). */
  workspaceDir?: string | null;
  onClose: () => void;
}

type ViewMode = "preview" | "source" | "diff";

function languageForPath(path: string, lang: string | null | undefined): string {
  if (lang?.trim()) return lang;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    rs: "rust",
    py: "python",
    go: "go",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    html: "html",
    css: "css",
    sh: "bash",
    sql: "sql",
  };
  return map[ext] ?? (ext || "text");
}

function HtmlPreviewPane({ content }: { content: string }) {
  return (
    <div className="agentz-workz-preview-html">
      <iframe title="HTML preview" sandbox="allow-same-origin" srcDoc={content} />
    </div>
  );
}

function PdfPreviewPane({ dataUrl }: { dataUrl: string }) {
  return (
    <div className="agentz-workz-preview-pdf">
      <iframe title="PDF preview" src={dataUrl} />
    </div>
  );
}

function CodePreviewPane({ content, language }: { content: string; language: string }) {
  const md = useMemo(
    () => `\`\`\`${language}\n${content.replace(/```/g, "``\\`")}\n\`\`\``,
    [content, language],
  );
  return (
    <div className="agentz-workz-preview-code-wrap">
      <Markdown content={md} />
    </div>
  );
}

export default function AgentFilePreview({
  projectDir,
  path,
  workspaceDir,
  onClose,
}: AgentFilePreviewProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [diffOriginal, setDiffOriginal] = useState("");
  const [diffModified, setDiffModified] = useState("");

  const fullPath = resolveArtifactFullPath(projectDir, path, workspaceDir);
  const fileName = path.split("/").pop() ?? path;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setFile(null);
    setViewMode("preview");

    (async () => {
      try {
        const [read, diff] = await Promise.all([
          ideApi.readFile(fullPath),
          ideApi.gitDiff(projectDir, path).catch(() => null),
        ]);
        if (cancelled) return;
        setFile(read);
        if (diff && (diff.original !== diff.modified || diff.hunks.length > 0)) {
          setDiffOriginal(diff.original);
          setDiffModified(diff.modified);
        } else {
          setDiffOriginal("");
          setDiffModified("");
        }
      } catch (e) {
        if (!cancelled) {
          const msg = String(e);
          setError(msg.includes("directory") ? t("agent.previewDirectory") : msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fullPath, projectDir, path, t]);

  const hasDiff =
    diffOriginal !== diffModified && (diffOriginal.length > 0 || diffModified.length > 0);
  const previewableText = file && !file.is_binary && (isMarkdownPath(path) || isHtmlPath(path));
  const showImage = Boolean(file?.preview_data && isImagePath(path));
  const showPdf = Boolean(file?.preview_data && isPdfPath(path));

  const toolbar = (
    <div className="agentz-workz-preview-actions">
      {hasDiff && (
        <>
          <button
            type="button"
            className={viewMode !== "diff" ? "active" : ""}
            onClick={() => setViewMode(file && previewableText ? "preview" : "source")}
          >
            {t("agent.previewFile")}
          </button>
          <button
            type="button"
            className={viewMode === "diff" ? "active" : ""}
            onClick={() => setViewMode("diff")}
          >
            {t("agent.previewDiff")}
          </button>
        </>
      )}
      {previewableText && viewMode !== "diff" && (
        <>
          <button
            type="button"
            className={viewMode === "preview" ? "active" : ""}
            onClick={() => setViewMode("preview")}
          >
            {t("ide.viewPreview")}
          </button>
          <button
            type="button"
            className={viewMode === "source" ? "active" : ""}
            onClick={() => setViewMode("source")}
          >
            {t("ide.viewSource")}
          </button>
        </>
      )}
      <button type="button" className="agentz-workz-preview-close" onClick={onClose} title={t("common.close")}>
        ×
      </button>
    </div>
  );

  let body: ReactNode = null;
  if (loading) {
    body = <div className="agentz-workz-preview-muted">{t("common.loading")}</div>;
  } else if (error) {
    body = <div className="agentz-workz-preview-error">{error}</div>;
  } else if (file && viewMode === "diff" && hasDiff) {
    body = (
      <pre className="agentz-workz-preview-diff">
        <del>{diffOriginal}</del>
        {"\n---\n"}
        <ins>{diffModified}</ins>
      </pre>
    );
  } else if (file?.preview_data && showImage) {
    body = <ImagePreview src={file.preview_data} name={fileName} size={file.size} />;
  } else if (file?.preview_data && showPdf) {
    body = <PdfPreviewPane dataUrl={file.preview_data} />;
  } else if (file?.is_binary) {
    body = (
      <div className="agentz-workz-preview-muted">
        {t("agent.previewBinary")} ({file.size} B)
      </div>
    );
  } else if (file) {
    const lang = languageForPath(path, file.language);
    if (isMarkdownPath(path) && viewMode === "preview") {
      body = (
        <div className="agentz-workz-preview-md">
          <Markdown content={file.content} />
        </div>
      );
    } else if (isHtmlPath(path) && viewMode === "preview") {
      body = <HtmlPreviewPane content={file.content} />;
    } else if (isMarkdownPath(path) || isHtmlPath(path)) {
      body = <CodePreviewPane content={file.content} language={lang} />;
    } else {
      body = <CodePreviewPane content={file.content} language={lang} />;
    }
  }

  return (
    <aside className="agentz-workz-preview">
      <div className="agentz-workz-preview-head">
        <span className="agentz-workz-preview-title" title={path}>
          {fileName}
        </span>
        {toolbar}
      </div>
      <div className="agentz-workz-preview-body">{body}</div>
    </aside>
  );
}
