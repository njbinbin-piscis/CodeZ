import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import TerminalPanel from "./Terminal";
import { useExtensionUi } from "../../extensions/ui/useExtensionUi";
import { extensionService } from "../../extensions/extensionService";
import { extensionUiStore } from "../../extensions/extensionUiStore";
import TreeView from "../../extensions/ui/TreeView";
import WebviewHost from "../../extensions/ui/WebviewHost";
import DebugView from "../../extensions/ui/DebugView";
import type { TestItemDto } from "../../extensions/common/dto";

export type BottomTab = "terminal" | "output" | "debug" | "scm" | "tests" | "views" | "webviews";

interface BottomPanelProps {
  projectDir: string;
  open: boolean;
  activeTab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  onClose: () => void;
  height: number;
  onSendTerminalToChat?: (text: string) => void;
}

function TestNode({ item, controllerId, depth }: { item: TestItemDto; controllerId: string; depth: number }) {
  return (
    <div>
      <div className="codez-tree-row" style={{ paddingLeft: 8 + depth * 14 }}>
        <button
          className="codez-test-run"
          title="Run test"
          onClick={() => void extensionService.runTests(controllerId, [item.id])}
        >
          ▶
        </button>
        <span className="codez-tree-label">{item.label}</span>
      </div>
      {item.children?.map((c) => <TestNode key={c.id} item={c} controllerId={controllerId} depth={depth + 1} />)}
    </div>
  );
}

/**
 * Unified bottom dock. Hosts the terminal alongside all extension-contributed
 * console/panel surfaces (output, debug, SCM, tests, views, webviews) in one
 * tabbed, theme-aware panel — replacing the old separate terminal + floating
 * extension dock.
 */
export default function BottomPanel({
  projectDir,
  open,
  activeTab,
  onTabChange,
  onClose,
  height,
  onSendTerminalToChat,
}: BottomPanelProps) {
  const { t } = useTranslation();
  const ui = useExtensionUi();

  const scmCount = ui.scm.reduce((n, p) => n + p.groups.reduce((g, gr) => g + gr.resources.length, 0), 0);

  // Terminal is always available; extension tabs surface only when populated.
  const tabs = useMemo(() => {
    const list: { id: BottomTab; label: string; count?: number; dot?: boolean }[] = [
      { id: "terminal", label: t("ide.terminal") || "Terminal" },
    ];
    if (ui.outputChannels.length) list.push({ id: "output", label: t("ide.output") || "Output", count: ui.outputChannels.length });
    if (ui.debugOutput.length || ui.running) list.push({ id: "debug", label: t("ide.debugConsole") || "Debug Console", count: ui.debugOutput.length });
    if (ui.treeViews.length) list.push({ id: "views", label: t("ide.views") || "Views", count: ui.treeViews.length });
    if (ui.scm.length) list.push({ id: "scm", label: t("ide.sourceControl") || "Source Control", count: scmCount });
    if (ui.tests.length) list.push({ id: "tests", label: t("ide.testing") || "Testing", count: ui.tests.length });
    if (ui.webviews.length) list.push({ id: "webviews", label: t("ide.webviews") || "Webviews", count: ui.webviews.length });
    return list;
  }, [t, ui.outputChannels.length, ui.debugOutput.length, ui.running, ui.treeViews.length, ui.scm.length, ui.tests.length, ui.webviews.length, scmCount]);

  // If the active tab disappears (extension unloaded), fall back to terminal.
  const current = tabs.some((tb) => tb.id === activeTab) ? activeTab : "terminal";
  const activeOutput = ui.outputChannels.find((c) => c.id === ui.activeOutput) ?? ui.outputChannels[0];

  return (
    <div className={`ide-bottom-panel${open ? "" : " is-hidden"}`} style={open ? { height } : undefined} aria-hidden={!open}>
      <div className="ide-bottom-tabs">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            className={`ide-bottom-tab${current === tb.id ? " active" : ""}`}
            onClick={() => onTabChange(tb.id)}
          >
            {tb.label}
            {tb.count ? <span className="ide-bottom-count">{tb.count}</span> : null}
          </button>
        ))}
        <div className="ide-bottom-tabs-spacer" />
        <button className="ide-bottom-close" onClick={onClose} title={t("ide.terminalHidePanel") || "Hide panel"}>
          ✕
        </button>
      </div>

      <div className="ide-bottom-body">
        {/* Terminal stays mounted to preserve PTY sessions; just hidden. */}
        <div className="ide-bottom-pane" style={{ display: current === "terminal" ? "flex" : "none" }}>
          <TerminalPanel
            projectDir={projectDir}
            visible={open && current === "terminal"}
            onHide={onClose}
            embedded
            onSendSelectionToChat={onSendTerminalToChat}
          />
        </div>

        {current === "output" && (
          <div className="ide-bottom-pane scroll">
            {activeOutput ? (
              <div className="codez-ext-output">
                <select value={activeOutput.id} onChange={(e) => extensionUiStore.showOutput(e.target.value)}>
                  {ui.outputChannels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <pre>{activeOutput.content}</pre>
              </div>
            ) : (
              <div className="codez-ext-panel-empty">{t("extensions.noOutput") || "No output channels."}</div>
            )}
          </div>
        )}

        {current === "debug" && (
          <div className="ide-bottom-pane scroll">
            <DebugView />
          </div>
        )}

        {current === "views" && (
          <div className="ide-bottom-pane scroll">
            {ui.treeViews.length === 0 ? (
              <div className="codez-ext-panel-empty">{t("extensions.noViews") || "No views contributed."}</div>
            ) : (
              ui.treeViews.map((v) => (
                <div key={v.viewId} className="codez-ext-view-section">
                  <div className="codez-ext-view-title">{v.viewId}</div>
                  <TreeView viewId={v.viewId} roots={v.roots} version={v.version} />
                </div>
              ))
            )}
          </div>
        )}

        {current === "scm" && (
          <div className="ide-bottom-pane scroll">
            {ui.scm.length === 0 ? (
              <div className="codez-ext-panel-empty">{t("extensions.noScm") || "No source control providers."}</div>
            ) : (
              ui.scm.map((p) => (
                <div key={p.handle} className="codez-ext-view-section">
                  <div className="codez-ext-view-title">{p.label}</div>
                  {p.groups.map((g) => (
                    <div key={g.handle} className="codez-scm-group">
                      <div className="codez-scm-group-label">
                        {g.label} <span className="codez-ext-panel-count">{g.resources.length}</span>
                      </div>
                      {g.resources.map((r) => (
                        <div key={r.handle} className="codez-scm-resource" title={r.tooltip}>
                          {r.resourceUri.path.split("/").pop()}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {current === "tests" && (
          <div className="ide-bottom-pane scroll">
            {ui.tests.length === 0 ? (
              <div className="codez-ext-panel-empty">{t("extensions.noTests") || "No test controllers."}</div>
            ) : (
              ui.tests.map((c) => (
                <div key={c.controllerId} className="codez-ext-view-section">
                  <div className="codez-ext-view-title">{c.label}</div>
                  {c.items.map((item) => (
                    <TestNode key={item.id} item={item} controllerId={c.controllerId} depth={0} />
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {current === "webviews" && (
          <div className="ide-bottom-pane scroll">
            {ui.webviews.length === 0 ? (
              <div className="codez-ext-panel-empty">{t("extensions.noWebviews") || "No webviews open."}</div>
            ) : (
              ui.webviews.map((wv) => (
                <div key={wv.handle} className="codez-ext-webview-section">
                  <div className="codez-ext-view-title">{wv.title}</div>
                  <WebviewHost webview={wv} />
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
