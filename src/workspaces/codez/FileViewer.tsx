import { useTranslation } from "react-i18next";
import CodeEditor from "./CodeEditor";
import ImagePreview from "./ImagePreview";
import MarkdownPreview from "./MarkdownPreview";
import NotebookEditor from "../../extensions/notebook/NotebookEditor";
import { isHtmlPath, isMarkdownPath, isPreviewablePath } from "./FileIcon";
import type { OpenTab, TabViewMode } from "./types";
import "./MarkdownPreview.css";

interface FileViewerProps {
  tab: OpenTab;
  projectDir: string | null;
  reveal?: { line: number; column: number; nonce: number } | null;
  onChange: (value: string) => void;
  onSave?: () => void;
  onViewModeChange: (mode: TabViewMode) => void;
}

function HtmlPreview({ content }: { content: string }) {
  return (
    <div className="agentz-html-preview">
      <iframe
        title="HTML preview"
        sandbox="allow-same-origin"
        srcDoc={content}
      />
    </div>
  );
}

export default function FileViewer({
  tab,
  projectDir,
  reveal,
  onChange,
  onSave,
  onViewModeChange,
}: FileViewerProps) {
  const { t } = useTranslation();

  if (tab.isDiff && tab.originalContent !== undefined) {
    return (
      <CodeEditor
        tab={tab}
        theme="violet"
        projectDir={projectDir}
        reveal={reveal}
        onChange={onChange}
        onSave={onSave}
      />
    );
  }

  if (tab.path.toLowerCase().endsWith(".ipynb") && !tab.isReadOnly) {
    return (
      <div className="agentz-file-view-body">
        <NotebookEditor content={tab.content} onChange={onChange} />
      </div>
    );
  }

  const previewable = isPreviewablePath(tab.path);
  const viewMode = tab.viewMode ?? "editor";

  if (viewMode === "image" && tab.previewData) {
    return (
      <ImagePreview src={tab.previewData} name={tab.name} size={tab.fileSize} />
    );
  }

  return (
    <div className="agentz-file-view-body">
      {previewable && (
        <div className="agentz-file-view-toolbar">
          <button
            type="button"
            className={viewMode === "editor" ? "active" : ""}
            onClick={() => onViewModeChange("editor")}
          >
            {t("ide.viewSource")}
          </button>
          <button
            type="button"
            className={viewMode === "preview" ? "active" : ""}
            onClick={() => onViewModeChange("preview")}
          >
            {t("ide.viewPreview")}
          </button>
        </div>
      )}

      {viewMode === "preview" && previewable ? (
        isMarkdownPath(tab.path) ? (
          <MarkdownPreview content={tab.content} />
        ) : isHtmlPath(tab.path) ? (
          <HtmlPreview content={tab.content} />
        ) : null
      ) : (
        <CodeEditor
          tab={tab}
          theme="violet"
          projectDir={projectDir}
          reveal={reveal}
          onChange={onChange}
          onSave={onSave}
        />
      )}
    </div>
  );
}
