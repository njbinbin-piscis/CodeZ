import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ideApi } from "../../services/tauri/ide";
import Markdown from "../codez/Markdown";
import { isMarkdownPath } from "../codez/FileIcon";

interface AgentFilePreviewProps {
  projectDir: string;
  path: string;
  onClose: () => void;
}

export default function AgentFilePreview({ projectDir, path, onClose }: AgentFilePreviewProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"file" | "diff">("file");
  const [content, setContent] = useState("");
  const [diffOriginal, setDiffOriginal] = useState("");
  const [diffModified, setDiffModified] = useState("");

  const fullPath = `${projectDir.replace(/[/\\]+$/, "")}/${path.replace(/^[/\\]+/, "")}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [file, diff] = await Promise.all([
          ideApi.readFile(fullPath),
          ideApi.gitDiff(projectDir, path).catch(() => null),
        ]);
        if (cancelled) return;
        if (file.is_binary) {
          setError(t("agent.previewBinary"));
          return;
        }
        setContent(file.content);
        if (diff && (diff.original !== diff.modified || diff.hunks.length > 0)) {
          setDiffOriginal(diff.original);
          setDiffModified(diff.modified);
          setMode("diff");
        } else {
          setMode("file");
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fullPath, projectDir, path, t]);

  return (
    <aside className="agentz-workz-preview">
      <div className="agentz-workz-preview-head">
        <span className="agentz-workz-preview-title" title={path}>
          {path.split("/").pop() ?? path}
        </span>
        <div className="agentz-workz-preview-actions">
          {diffOriginal !== diffModified && (
            <>
              <button
                type="button"
                className={mode === "file" ? "active" : ""}
                onClick={() => setMode("file")}
              >
                {t("agent.previewFile")}
              </button>
              <button
                type="button"
                className={mode === "diff" ? "active" : ""}
                onClick={() => setMode("diff")}
              >
                {t("agent.previewDiff")}
              </button>
            </>
          )}
          <button type="button" className="agentz-workz-preview-close" onClick={onClose} title={t("common.close")}>
            ×
          </button>
        </div>
      </div>
      <div className="agentz-workz-preview-body">
        {loading && <div className="agentz-workz-preview-muted">{t("common.loading")}</div>}
        {error && <div className="agentz-workz-preview-error">{error}</div>}
        {!loading && !error && mode === "diff" && (
          <pre className="agentz-workz-preview-diff">
            <del>{diffOriginal}</del>
            {"\n---\n"}
            <ins>{diffModified}</ins>
          </pre>
        )}
        {!loading && !error && mode === "file" && (
          isMarkdownPath(path) ? (
            <div className="agentz-workz-preview-md">
              <Markdown content={content} />
            </div>
          ) : (
            <pre className="agentz-workz-preview-code">{content}</pre>
          )
        )}
      </div>
    </aside>
  );
}
