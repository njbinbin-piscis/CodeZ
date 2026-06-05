import { useState } from "react";
import { useExtensionUi } from "./useExtensionUi";
import { extensionService } from "../extensionService";
import TreeView from "./TreeView";
import WebviewHost from "./WebviewHost";
import DebugView from "./DebugView";
import type { TestItemDto } from "../common/dto";

type PanelTab = "views" | "output" | "scm" | "tests" | "debug" | "webviews";

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

/** Bottom dock aggregating all extension-contributed panel surfaces. */
export default function ExtensionPanel({ onClose }: { onClose: () => void }) {
  const ui = useExtensionUi();
  const [tab, setTab] = useState<PanelTab>("views");

  const tabs: [PanelTab, string, number][] = [
    ["views", "Views", ui.treeViews.length],
    ["output", "Output", ui.outputChannels.length],
    ["scm", "Source Control", ui.scm.reduce((n, p) => n + p.groups.reduce((g, gr) => g + gr.resources.length, 0), 0)],
    ["tests", "Testing", ui.tests.length],
    ["debug", "Debug Console", ui.debugOutput.length],
    ["webviews", "Webviews", ui.webviews.length],
  ];

  const activeOutput = ui.outputChannels.find((c) => c.id === ui.activeOutput) ?? ui.outputChannels[0];

  return (
    <div className="codez-ext-panel-dock">
      <div className="codez-ext-panel-tabs">
        {tabs.map(([id, label, count]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
            {label}
            {count > 0 && <span className="codez-ext-panel-count">{count}</span>}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="codez-ext-panel-close" onClick={onClose} title="Hide panel">
          ✕
        </button>
      </div>

      <div className="codez-ext-panel-body">
        {tab === "views" &&
          (ui.treeViews.length === 0 ? (
            <div className="codez-ext-panel-empty">No views contributed.</div>
          ) : (
            ui.treeViews.map((v) => (
              <div key={v.viewId} className="codez-ext-view-section">
                <div className="codez-ext-view-title">{v.viewId}</div>
                <TreeView viewId={v.viewId} roots={v.roots} version={v.version} />
              </div>
            ))
          ))}

        {tab === "output" &&
          (activeOutput ? (
            <div className="codez-ext-output">
              <select value={activeOutput.id} onChange={(e) => extensionUiShow(e.target.value)}>
                {ui.outputChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <pre>{activeOutput.content}</pre>
            </div>
          ) : (
            <div className="codez-ext-panel-empty">No output channels.</div>
          ))}

        {tab === "scm" &&
          (ui.scm.length === 0 ? (
            <div className="codez-ext-panel-empty">No source control providers.</div>
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
          ))}

        {tab === "tests" &&
          (ui.tests.length === 0 ? (
            <div className="codez-ext-panel-empty">No test controllers.</div>
          ) : (
            ui.tests.map((c) => (
              <div key={c.controllerId} className="codez-ext-view-section">
                <div className="codez-ext-view-title">{c.label}</div>
                {c.items.map((item) => (
                  <TestNode key={item.id} item={item} controllerId={c.controllerId} depth={0} />
                ))}
              </div>
            ))
          ))}

        {tab === "debug" && <DebugView />}

        {tab === "webviews" &&
          (ui.webviews.length === 0 ? (
            <div className="codez-ext-panel-empty">No webviews open.</div>
          ) : (
            ui.webviews.map((wv) => (
              <div key={wv.handle} className="codez-ext-webview-section">
                <div className="codez-ext-view-title">{wv.title}</div>
                <WebviewHost webview={wv} />
              </div>
            ))
          ))}
      </div>
    </div>
  );
}

function extensionUiShow(id: string): void {
  // Lazy import avoids a cycle; the store is a singleton.
  import("../extensionUiStore").then((m) => m.extensionUiStore.showOutput(id));
}
