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
import CompatIcon from "./CompatIcon";
import "./ExtensionsPanel.css";

const STORAGE_KEY = "codez.activeTheme";

function themeId(ext: VsixManifest, t: VsixTheme): string {
  return `vsix-${ext.name}-${t.label}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

/**
 * VS Code extension manager: Open VSX marketplace + runtime host extensions,
 * plus a secondary section for theme/snippet-only .vsix imports.
 */
export default function ExtensionsManager() {
  const { t: tr } = useTranslation();
  const monaco = useMonaco();
  const [extensions, setExtensions] = useState<VsixManifest[]>(() => loadExtensions());
  const [activeTheme, setActiveTheme] = useState<string>(themeStore.getSnapshot());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [themesOpen, setThemesOpen] = useState(false);
  const snippetDisposables = useRef<{ dispose: () => void }[]>([]);

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
    <div className="codez-ext-manager">
      {error && <div className="codez-ext-error">{error}</div>}

      {/* ── Open VSX marketplace (primary) ─────────────────────────────── */}
      <div className="codez-ext-marketplace">
        <div className="codez-ext-market-header">
          <div className="codez-ext-market-title">{tr("extensions.marketTitle")}</div>
          <p className="codez-ext-market-hint">{tr("extensions.marketHint")}</p>
        </div>

        <div className="codez-ext-mk-search">
          <input
            type="search"
            placeholder={tr("extensions.searchOpenVsx")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doSearch();
            }}
          />
          <button
            type="button"
            className="codez-ext-btn codez-ext-btn-primary"
            onClick={() => void doSearch()}
            disabled={searching || !query.trim()}
          >
            {searching ? tr("common.loading") : tr("common.search")}
          </button>
          <button
            type="button"
            className="codez-ext-btn codez-ext-btn-primary"
            onClick={() => void installVsixFull()}
            disabled={working === "file"}
            title={tr("extensions.installVsix")}
          >
            {working === "file" ? tr("extensions.installing") : tr("extensions.installVsix")}
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
                    <span className="codez-ext-mk-name">{r.displayName || r.name}</span>
                    <div className="codez-ext-mk-meta">
                      <span className="codez-ext-ver">
                        {r.namespace} · v{r.version}
                      </span>
                      {ec.known ? (
                        <CompatIcon
                          status={ec.ok ? "ok" : "warn"}
                          range={ec.range}
                          hostVersion={HOST_VSCODE_VERSION}
                        />
                      ) : (
                        <CompatIcon status="unknown" />
                      )}
                    </div>
                  </div>
                  {r.description && <div className="codez-ext-mk-desc">{r.description}</div>}
                  <button
                    type="button"
                    className="codez-ext-btn codez-ext-btn-success"
                    disabled={working === id || isInstalled}
                    onClick={() => void installFromMarketplace(r)}
                  >
                    {isInstalled
                      ? tr("extensions.installed")
                      : working === id
                        ? tr("extensions.installing")
                        : tr("extensions.install")}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {installed.length > 0 && (
          <div className="codez-ext-runtime">
            <div className="codez-ext-section-title">{tr("extensions.runtimeInstalled")}</div>
            {installed.map((ext) => (
              <div key={ext.id} className={`codez-ext-runtime-row ${ext.enabled ? "" : "disabled"}`}>
                <span className="codez-ext-runtime-name" title={ext.description}>
                  {ext.display_name}
                  <span className="codez-ext-ver">v{ext.version}</span>
                </span>
                <button
                  type="button"
                  className="codez-ext-btn codez-ext-btn-secondary"
                  onClick={() => void toggleEnabled(ext)}
                  disabled={working === ext.id}
                >
                  {ext.enabled ? tr("extensions.disable") : tr("extensions.enable")}
                </button>
                <button
                  type="button"
                  className="codez-ext-btn codez-ext-btn-secondary"
                  onClick={() => void uninstallRuntime(ext)}
                  disabled={working === ext.id}
                >
                  {tr("extensions.uninstall")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {compat.hostVersion && (
        <div className="codez-compat-report">
          <div className="codez-ext-section-title">
            {tr("extensions.compatTitle")}{" "}
            <span className="codez-ext-ver">{tr("extensions.compatHost", { version: compat.hostVersion })}</span>
          </div>
          {(() => {
            const incompatible = compat.extensions.filter((e) => !e.compatible);
            const proposalUsers = compat.extensions.filter((e) => e.unsupportedProposals?.length);
            if (
              incompatible.length === 0 &&
              proposalUsers.length === 0 &&
              compat.missingApis.length === 0
            ) {
              return (
                <div className="codez-compat-ok">
                  {tr("extensions.compatOk", { count: compat.extensions.length })}
                </div>
              );
            }
            return (
              <>
                {incompatible.length > 0 && (
                  <div className="codez-compat-group">
                    <div className="codez-compat-group-title">{tr("extensions.compatVersion")}</div>
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
                    <div className="codez-compat-group-title">{tr("extensions.compatProposals")}</div>
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
                      {tr("extensions.compatMissingApis", { count: compat.missingApis.length })}
                    </div>
                    <div className="codez-compat-apis">{compat.missingApis.join("  ·  ")}</div>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* ── Theme/snippet-only imports (secondary, collapsible) ─────────── */}
      <details
        className="codez-ext-themes-section"
        open={themesOpen}
        onToggle={(e) => setThemesOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="codez-ext-themes-summary">{tr("extensions.themesSection")}</summary>
        <p className="codez-ext-themes-hint">{tr("extensions.themesSectionHint")}</p>
        <div className="codez-ext-toolbar">
          <button
            type="button"
            className="codez-ext-btn codez-ext-btn-primary"
            onClick={() => void doImport()}
            disabled={busy}
          >
            {busy ? tr("extensions.importing") : tr("extensions.import")}
          </button>
          <button
            type="button"
            className="codez-ext-btn codez-ext-btn-secondary"
            onClick={resetTheme}
            disabled={activeTheme === "vs-dark"}
          >
            {tr("extensions.resetTheme")}
          </button>
        </div>
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
                  title={tr("common.close")}
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
                        type="button"
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
      </details>
    </div>
  );
}
