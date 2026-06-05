import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useMonaco } from "@monaco-editor/react";
import {
  importVsix,
  openVsixDialog,
  vsixInstall,
  vsixInstallFromUrl,
  vsixList,
  vsixUninstall,
  vsixSetEnabled,
  openVsxSearch,
  openVsxDownloadUrl,
  openVsxMeta,
  type VsixManifest,
  type VsixTheme,
  type InstalledExtension,
  type OpenVsxResult,
} from "../../services/tauri/vsix";
import { vscodeThemeToMonaco, parseSnippets } from "./vscodeTheme";
import { themeStore } from "./themeStore";
import { loadExtensions, saveExtensions } from "./extensionStore";
import { extensionService } from "../../extensions/extensionService";
import { compatStore } from "../../extensions/compatStore";
import { satisfies } from "../../extensions/semver";
import { HOST_VSCODE_VERSION } from "../../extensions/common/protocol";

const STORAGE_KEY = "codez.activeTheme";

/** Sanitize a label into a Monaco-safe theme id. */
function themeId(ext: VsixManifest, t: VsixTheme): string {
  return `vsix-${ext.name}-${t.label}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

/**
 * Reusable VS Code `.vsix` extension manager body (import, themes, snippets).
 * Rendered both inside the standalone ExtensionsPanel overlay and the Settings
 * "Extensions" tab.
 */
export default function ExtensionsManager() {
  const { t: tr } = useTranslation();
  const monaco = useMonaco();
  const [extensions, setExtensions] = useState<VsixManifest[]>(() => loadExtensions());
  const [activeTheme, setActiveTheme] = useState<string>(themeStore.getSnapshot());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const snippetDisposables = useRef<{ dispose: () => void }[]>([]);

  // Runtime extensions (executed by the extension host) + Open VSX marketplace.
  const [installed, setInstalled] = useState<InstalledExtension[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<OpenVsxResult[]>([]);
  const [engines, setEngines] = useState<Record<string, string | undefined>>({});
  const [searching, setSearching] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const compat = useSyncExternalStore(compatStore.subscribe, compatStore.getSnapshot);

  const refreshInstalled = useCallback(async () => {
    try {
      setInstalled(await vsixList());
    } catch (e) {
      console.error("vsix_list failed", e);
    }
  }, []);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  const restartHost = useCallback(async () => {
    if (extensionService.projectDir) {
      try {
        await extensionService.start(extensionService.projectDir);
      } catch (e) {
        setError(String(e));
      }
    }
  }, []);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    setEngines({});
    try {
      const list = await openVsxSearch(query.trim());
      setResults(list);
      // Pre-check engines.vscode for each result (best-effort, parallel).
      void Promise.all(
        list.map(async (r) => {
          const id = `${r.namespace}.${r.name}`;
          try {
            const meta = await openVsxMeta(r.namespace, r.name, r.version);
            return [id, meta.enginesVscode] as const;
          } catch {
            return [id, undefined] as const;
          }
        }),
      ).then((pairs) => setEngines(Object.fromEntries(pairs)));
    } catch (e) {
      setError(String(e));
    } finally {
      setSearching(false);
    }
  }, [query]);

  const engineCompat = useCallback(
    (id: string): { known: boolean; ok: boolean; range?: string } => {
      const range = engines[id];
      if (!(id in engines)) return { known: false, ok: true };
      if (!range || range === "*") return { known: true, ok: true, range };
      return { known: true, ok: satisfies(HOST_VSCODE_VERSION, range), range };
    },
    [engines],
  );

  const installFromMarketplace = useCallback(
    async (r: OpenVsxResult) => {
      const key = `${r.namespace}.${r.name}`;
      setWorking(key);
      setError(null);
      try {
        const url = r.files?.download ?? (await openVsxDownloadUrl(r.namespace, r.name, r.version));
        await vsixInstallFromUrl(url);
        await refreshInstalled();
        await restartHost();
      } catch (e) {
        setError(String(e));
      } finally {
        setWorking(null);
      }
    },
    [refreshInstalled, restartHost],
  );

  const installVsixFull = useCallback(async () => {
    setError(null);
    try {
      const path = await openVsixDialog();
      if (!path) return;
      setWorking("file");
      await vsixInstall(path);
      await refreshInstalled();
      await restartHost();
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(null);
    }
  }, [refreshInstalled, restartHost]);

  const toggleEnabled = useCallback(
    async (ext: InstalledExtension) => {
      setWorking(ext.id);
      try {
        await vsixSetEnabled(ext.id, !ext.enabled);
        await refreshInstalled();
        await restartHost();
      } catch (e) {
        setError(String(e));
      } finally {
        setWorking(null);
      }
    },
    [refreshInstalled, restartHost],
  );

  const uninstallRuntime = useCallback(
    async (ext: InstalledExtension) => {
      setWorking(ext.id);
      try {
        await vsixUninstall(ext.id);
        await refreshInstalled();
        await restartHost();
      } catch (e) {
        setError(String(e));
      } finally {
        setWorking(null);
      }
    },
    [refreshInstalled, restartHost],
  );

  useEffect(() => {
    if (!monaco) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { id: string; data: unknown };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      monaco.editor.defineTheme(saved.id, saved.data as any);
      monaco.editor.setTheme(saved.id);
      themeStore.set(saved.id);
      setActiveTheme(saved.id);
    } catch {
      // ignore corrupt persisted theme
    }
  }, [monaco]);

  const registerSnippets = useCallback(
    (ext: VsixManifest) => {
      if (!monaco) return;
      for (const set of ext.snippets) {
        if (!set.language) continue;
        let items: ReturnType<typeof parseSnippets> = [];
        try {
          items = parseSnippets(set.content);
        } catch {
          continue;
        }
        if (items.length === 0) continue;
        const d = monaco.languages.registerCompletionItemProvider(set.language, {
          provideCompletionItems: (model, position) => {
            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            return {
              suggestions: items.map((s) => ({
                label: s.prefix,
                kind: monaco.languages.CompletionItemKind.Snippet,
                insertText: s.body,
                insertTextRules:
                  monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                documentation: s.description,
                detail: `${ext.display_name} snippet`,
                range,
              })),
            };
          },
        });
        snippetDisposables.current.push(d);
      }
    },
    [monaco],
  );

  const doImport = useCallback(async () => {
    setError(null);
    try {
      const path = await openVsixDialog();
      if (!path) return;
      setBusy(true);
      const manifest = await importVsix(path);
      setExtensions((prev) => {
        const next = [...prev.filter((e) => e.name !== manifest.name), manifest];
        saveExtensions(next);
        return next;
      });
      registerSnippets(manifest);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [registerSnippets]);

  const removeExtension = useCallback((name: string) => {
    setExtensions((prev) => {
      const next = prev.filter((e) => e.name !== name);
      saveExtensions(next);
      return next;
    });
  }, []);

  const applyTheme = useCallback(
    (ext: VsixManifest, t: VsixTheme) => {
      if (!monaco) return;
      try {
        const data = vscodeThemeToMonaco(t.content, t.ui_theme);
        const id = themeId(ext, t);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        monaco.editor.defineTheme(id, data as any);
        monaco.editor.setTheme(id);
        themeStore.set(id);
        setActiveTheme(id);
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ id, data }));
      } catch (e) {
        setError(tr("extensions.themeFailed", { error: String(e) }));
      }
    },
    [monaco, tr],
  );

  const resetTheme = useCallback(() => {
    if (!monaco) return;
    monaco.editor.setTheme("vs-dark");
    themeStore.set("vs-dark");
    setActiveTheme("vs-dark");
    localStorage.removeItem(STORAGE_KEY);
  }, [monaco]);

  return (
    <>
      <div className="codez-ext-toolbar">
        <button className="codez-ext-import" onClick={() => void doImport()} disabled={busy}>
          {busy ? tr("extensions.importing") : tr("extensions.import")}
        </button>
        <button
          className="codez-ext-reset"
          onClick={resetTheme}
          disabled={activeTheme === "vs-dark"}
        >
          {tr("extensions.resetTheme")}
        </button>
      </div>

      {error && <div className="codez-ext-error">{error}</div>}

      {/* Marketplace (Open VSX) + runtime extension host management */}
      <div className="codez-ext-marketplace">
        <div className="codez-ext-mk-search">
          <input
            type="text"
            placeholder={tr("extensions.searchOpenVsx") || "Search Open VSX…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doSearch();
            }}
          />
          <button onClick={() => void doSearch()} disabled={searching}>
            {searching ? "…" : tr("common.search") || "Search"}
          </button>
          <button onClick={() => void installVsixFull()} disabled={working === "file"} title="Install a local .vsix and run it">
            {working === "file" ? "…" : tr("extensions.installVsix") || "Install .vsix"}
          </button>
        </div>

        {results.length > 0 && (
          <div className="codez-ext-mk-results">
            {results.map((r) => {
              const id = `${r.namespace}.${r.name}`;
              const isInstalled = installed.some((e) => e.id === id);
              const ec = engineCompat(id);
              return (
                <div key={id} className="codez-ext-mk-card">
                  <div className="codez-ext-mk-title">
                    {r.displayName || r.name}
                    <span className="codez-ext-ver">
                      {r.namespace} · v{r.version}
                    </span>
                    {ec.known &&
                      (ec.ok ? (
                        <span className="codez-compat-badge ok" title={`engines.vscode: ${ec.range ?? "*"}`}>
                          兼容
                        </span>
                      ) : (
                        <span
                          className="codez-compat-badge warn"
                          title={`需要 VS Code ${ec.range}，本宿主实现 ${HOST_VSCODE_VERSION}`}
                        >
                          可能不兼容
                        </span>
                      ))}
                  </div>
                  {r.description && <div className="codez-ext-mk-desc">{r.description}</div>}
                  {ec.known && !ec.ok && (
                    <div className="codez-compat-note">
                      需要 VS Code {ec.range}（本宿主 {HOST_VSCODE_VERSION}）
                    </div>
                  )}
                  <button
                    className="codez-ext-mk-install"
                    disabled={working === id || isInstalled}
                    onClick={() => void installFromMarketplace(r)}
                  >
                    {isInstalled ? tr("extensions.installed") || "Installed" : working === id ? "…" : tr("extensions.install") || "Install"}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {installed.length > 0 && (
          <div className="codez-ext-runtime">
            <div className="codez-ext-section-title">{tr("extensions.runtimeInstalled") || "Installed extensions"}</div>
            {installed.map((ext) => (
              <div key={ext.id} className={`codez-ext-runtime-row ${ext.enabled ? "" : "disabled"}`}>
                <span className="codez-ext-runtime-name" title={ext.description}>
                  {ext.display_name}
                  <span className="codez-ext-ver">v{ext.version}</span>
                </span>
                <button onClick={() => void toggleEnabled(ext)} disabled={working === ext.id}>
                  {ext.enabled ? tr("extensions.disable") || "Disable" : tr("extensions.enable") || "Enable"}
                </button>
                <button onClick={() => void uninstallRuntime(ext)} disabled={working === ext.id}>
                  {tr("extensions.uninstall") || "Uninstall"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {compat.hostVersion && (
        <div className="codez-compat-report">
          <div className="codez-ext-section-title">
            兼容性报告 <span className="codez-ext-ver">宿主 VS Code API {compat.hostVersion}</span>
          </div>
          {(() => {
            const incompatible = compat.extensions.filter((e) => !e.compatible);
            const proposalUsers = compat.extensions.filter((e) => e.unsupportedProposals?.length);
            if (
              incompatible.length === 0 &&
              proposalUsers.length === 0 &&
              compat.missingApis.length === 0
            ) {
              return <div className="codez-compat-ok">全部 {compat.extensions.length} 个扩展均通过兼容性检查。</div>;
            }
            return (
              <>
                {incompatible.length > 0 && (
                  <div className="codez-compat-group">
                    <div className="codez-compat-group-title">版本不兼容（已跳过激活）</div>
                    {incompatible.map((e) => (
                      <div key={e.id} className="codez-compat-row warn">
                        <span>{e.displayName || e.id}</span>
                        <span className="codez-compat-reason">{e.reason}</span>
                      </div>
                    ))}
                  </div>
                )}
                {proposalUsers.length > 0 && (
                  <div className="codez-compat-group">
                    <div className="codez-compat-group-title">使用了未支持的 proposed API</div>
                    {proposalUsers.map((e) => (
                      <div key={e.id} className="codez-compat-row">
                        <span>{e.displayName || e.id}</span>
                        <span className="codez-compat-reason">{e.unsupportedProposals?.join(", ")}</span>
                      </div>
                    ))}
                  </div>
                )}
                {compat.missingApis.length > 0 && (
                  <div className="codez-compat-group">
                    <div className="codez-compat-group-title">
                      运行时调用到的未实现 API（{compat.missingApis.length}）
                    </div>
                    <div className="codez-compat-apis">{compat.missingApis.join("  ·  ")}</div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      <div className="codez-ext-body">
        {extensions.length === 0 && <div className="codez-ext-empty">{tr("extensions.empty")}</div>}
        {extensions.map((ext) => (
          <div key={ext.name} className="codez-ext-card">
            <div className="codez-ext-name">
              {ext.display_name}
              <span className="codez-ext-ver">
                {ext.publisher ? `${ext.publisher} · ` : ""}v{ext.version || "?"}
              </span>
              <button
                type="button"
                className="codez-ext-remove"
                onClick={() => removeExtension(ext.name)}
                title={tr("chat.delete")}
              >
                ✕
              </button>
            </div>
            {ext.themes.length > 0 && (
              <div className="codez-ext-section">
                <div className="codez-ext-section-title">{tr("extensions.themes")}</div>
                {ext.themes.map((t) => {
                  const id = themeId(ext, t);
                  return (
                    <button
                      key={id}
                      className={`codez-ext-theme ${id === activeTheme ? "active" : ""}`}
                      onClick={() => applyTheme(ext, t)}
                    >
                      {t.label}
                      {id === activeTheme && (
                        <span className="codez-ext-applied">{tr("extensions.applied")}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {ext.snippets.length > 0 && (
              <div className="codez-ext-section">
                <div className="codez-ext-section-title">
                  {tr("extensions.snippetsFor")}: {ext.snippets.map((s) => s.language).join(", ")}
                </div>
              </div>
            )}
            {ext.languages.length > 0 && (
              <div className="codez-ext-langs">
                {tr("extensions.languages")}: {ext.languages.join(", ")}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
