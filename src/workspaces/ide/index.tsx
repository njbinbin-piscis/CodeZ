import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import FileTree, { type FileTreeContextMenu } from "./FileTree";
import { ExplorerIcon, SearchIcon, SourceControlIcon, TerminalIcon, ExtensionsIcon } from "./ActivityIcons";
import EditorTabs from "./EditorTabs";
import FileViewer from "./FileViewer";
import GitPanel from "./GitPanel";
import SearchPanel from "./SearchPanel";
import ExtensionsManager from "./ExtensionsManager";
import BottomPanel, { type BottomTab } from "./BottomPanel";
import IdeStatusBar from "./IdeStatusBar";
import ExtensionHostProvider from "../../extensions/ui/ExtensionHostProvider";
import { ideApi, onFileChanged } from "../../services/tauri/ide";
import { openPath } from "../../services/tauri";
import BrowserPanel from "./BrowserPanel";
import { BROWSER_TAB_PATH, isBrowserTab } from "./browserTab";
import { browserClose } from "../../services/tauri/browser";
import type { PickedElement } from "../../services/tauri/browser";
import type { FileNode, OpenTab, GitFileStatus, TabViewMode } from "./types";
import "./IDE.css";

type SidebarTab = "explorer" | "search" | "git" | "extensions";

/** Right-click context menu state (shown over a tab). */
interface TabContextMenu {
  x: number;
  y: number;
  /** Path of the tab that was right-clicked. */
  targetPath: string;
}

interface IDEProps {
  projectDir: string | null;
  onOpenFolder: () => void;
  /** Insert file/dir chips into the chat composer (opens chat if needed). */
  onSendToChat?: (paths: string[]) => void;
  /** Insert a terminal selection chip into the chat composer. */
  onSendTerminalToChat?: (text: string) => void;
  /** Open a workspace-relative file when the path or nonce changes. */
  openPathRequest?: { path: string; nonce: number } | null;
  /** Called after `openPathRequest` has been consumed (clears parent state). */
  onOpenPathRequestHandled?: () => void;
  /** Embedded browser tab (editor area, not overlay). */
  browserOpen?: boolean;
  onBrowserOpenChange?: (open: boolean) => void;
  onSendElementToChat?: (el: PickedElement) => void;
  onScreenshotToChat?: (base64: string) => void;
}

/** Handle to the imperative methods exposed by FileTree via its root ref. */
interface FileTreeHandle {
  deleteSelected?: () => void;
  renameActive?: () => void;
  startCreate?: (isDir: boolean) => void;
}

function collectSelectedPaths(nodes: FileNode[], selected: Set<string>): string[] {
  const out: string[] = [];
  const walk = (list: FileNode[]) => {
    for (const n of list) {
      if (selected.has(n.path)) {
        out.push(n.is_dir ? (n.path.endsWith("/") ? n.path : `${n.path}/`) : n.path);
      }
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export default function IDE({
  projectDir,
  onOpenFolder,
  onSendToChat,
  onSendTerminalToChat,
  openPathRequest,
  onOpenPathRequestHandled,
  browserOpen = false,
  onBrowserOpenChange,
  onSendElementToChat,
  onScreenshotToChat,
}: IDEProps) {
  const { t } = useTranslation();

  // File tree
  const [fileTree, setFileTree] = useState<FileNode[]>([]);

  // Open tabs
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);

  // Pending cursor reveal (search "go to result" / navigation). Applied to the
  // active editor; `nonce` re-triggers reveal even for the same position.
  const [reveal, setReveal] = useState<{
    path: string;
    line: number;
    column: number;
    nonce: number;
  } | null>(null);
  const [fileLoading, setFileLoading] = useState<string | null>(null);
  const [fileLoadError, setFileLoadError] = useState<string | null>(null);

  // Git status
  const [gitModified, setGitModified] = useState<Set<string>>(new Set());
  const [gitAdded, setGitAdded] = useState<Set<string>>(new Set());

  // UI state — unified bottom panel (terminal + extension consoles)
  const [bottomOpen, setBottomOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>("terminal");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("explorer");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Resizable panel widths
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [bottomHeight, setBottomHeight] = useState(240);
  const ideRef = useRef<HTMLDivElement>(null);

  const openBottomPanel = useCallback((tab: BottomTab) => {
    setBottomTab(tab);
    setBottomOpen(true);
  }, []);

  const openExtensionsSidebar = useCallback(() => {
    setSidebarTab("extensions");
    setSidebarCollapsed(false);
  }, []);

  const browserTab = useMemo(
    (): OpenTab => ({
      path: BROWSER_TAB_PATH,
      name: t("browser.tabTitle"),
      language: null,
      content: "",
      isDirty: false,
      isReadOnly: true,
    }),
    [t],
  );

  const headerTabs = useMemo(() => {
    if (browserOpen && projectDir) return [browserTab, ...tabs];
    return tabs;
  }, [browserOpen, projectDir, browserTab, tabs]);

  useEffect(() => {
    if (browserOpen && projectDir) {
      setActiveTabPath(BROWSER_TAB_PATH);
      return;
    }
    setActiveTabPath((cur) =>
      isBrowserTab(cur) ? tabsRef.current[0]?.path ?? null : cur,
    );
  }, [browserOpen, projectDir]);

  // Right-click context menu for tab headers
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenu | null>(null);

  // File tree: selected paths (Ctrl/Cmd multi-select) + right-click menu.
  const [fileTreeSelection, setFileTreeSelection] = useState<Set<string>>(new Set());
  const [fileTreeContextMenu, setFileTreeContextMenu] = useState<FileTreeContextMenu | null>(null);
  const fileTreeRef = useRef<(HTMLDivElement & FileTreeHandle) | null>(null);

  // Stable refs so keyboard shortcuts / beforeunload always read the latest
  // state without re-registering listeners on every render.
  const tabsRef = useRef<OpenTab[]>(tabs);
  tabsRef.current = tabs;
  const activeTabPathRef = useRef<string | null>(activeTabPath);
  activeTabPathRef.current = activeTabPath;
  const projectDirRef = useRef<string | null>(projectDir);
  projectDirRef.current = projectDir;
  const handledOpenPathNonce = useRef(0);
  const openFileRef = useRef<(path: string, readOnly?: boolean) => Promise<void>>(async () => {});

  // Reset editor state when the project folder changes or is closed.
  useEffect(() => {
    handledOpenPathNonce.current = 0;
    setTabs([]);
    setActiveTabPath(null);
    setFileLoadError(null);
    setReveal(null);
    setFileTree([]);
    setGitModified(new Set());
    setGitAdded(new Set());
    setFileTreeSelection(new Set());
    setBottomOpen(false);
    setBottomTab("terminal");
  }, [projectDir]);

  const activeTab = tabs.find((t) => t.path === activeTabPath) || null;

  const switchSidebarTab = useCallback((tab: SidebarTab) => {
    if (sidebarTab === tab && !sidebarCollapsed) {
      setSidebarCollapsed(true);
    } else {
      setSidebarTab(tab);
      setSidebarCollapsed(false);
    }
  }, [sidebarTab, sidebarCollapsed]);

  // ─── Load file tree ──────────────────────────────────────────────
  const loadFileTree = useCallback(async () => {
    if (!projectDir) return;
    try {
      const nodes = await ideApi.listFiles(projectDir, 8);
      setFileTree(nodes);
    } catch (e) {
      console.error("Failed to load file tree:", e);
    }
  }, [projectDir]);

  // ─── Load git status ─────────────────────────────────────────────
  const loadGitStatus = useCallback(async () => {
    if (!projectDir) return;
    try {
      const statuses = await ideApi.gitStatus(projectDir);
      const modified = new Set<string>();
      const added = new Set<string>();
      statuses.forEach((s: GitFileStatus) => {
        if (s.status === "modified") modified.add(s.path);
        else if (s.status === "added" || s.status === "untracked") added.add(s.path);
      });
      setGitModified(modified);
      setGitAdded(added);
    } catch {
      // No git repo or error — ignore
    }
  }, [projectDir]);

  // ─── Panel resize drag handlers ──────────────────────────────────
  const startSidebarResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarWidth;
      const onMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startX;
        setSidebarWidth(Math.min(500, Math.max(220, startW + delta)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth],
  );

  const startBottomResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = bottomHeight;
      const onMove = (ev: MouseEvent) => {
        const delta = startY - ev.clientY;
        setBottomHeight(Math.min(560, Math.max(120, startH + delta)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [bottomHeight],
  );

  // ─── Initialize ──────────────────────────────────────────────────
  // Debounce file-change refreshes: bursty external edits (Koi agents,
  // formatters, watch-mode builds) used to fire `loadFileTree`+`loadGitStatus`
  // dozens of times per second, which on Windows compounded the popup-loop
  // bug that v0.8.0 fixed at the watcher level. 250 ms trailing-edge is
  // slow enough to coalesce a save-burst yet fast enough to feel live.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      loadFileTree();
      loadGitStatus();
    }, 250);
  }, [loadFileTree, loadGitStatus]);

  useEffect(() => {
    if (!projectDir) return;
    loadFileTree();
    loadGitStatus();

    // Start file watcher
    ideApi.startWatcher(projectDir).catch(() => {});

    // Listen for file changes (from Koi agents or external edits)
    const unlistenPromise = onFileChanged((evt) => {
      // Guard: `project_dir` is whatever the caller passed to startWatcher —
      // compare raw. But normalize the path to `/` before comparing with
      // `tab.path`, because `tab.path` is always stored with `/` (that's
      // how `FileTree` node paths come from the backend, and how
      // `openFile` stores them). On Windows, older backend versions emit
      // backslash paths, which silently failed the `===` check and made
      // externally-modified files never reload in the IDE.
      if (evt.project_dir !== projectDir) return;
      const evtPath = evt.path.replace(/\\/g, "/");
      scheduleRefresh();

      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.path === evtPath && !tab.isDirty) {
            const fullPath = `${projectDir}/${evtPath}`;
            ideApi.readFile(fullPath).then((fc) => {
              setTabs((p) =>
                p.map((t) =>
                  t.path === evtPath && !t.isDirty
                    ? { ...t, content: fc.content }
                    : t,
                ),
              );
            }).catch(() => {});
          }
          return tab;
        }),
      );
    });

    return () => {
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
      unlistenPromise.then((fn) => fn());
      ideApi.stopWatcher(projectDir).catch(() => {});
    };
  }, [projectDir, loadFileTree, loadGitStatus, scheduleRefresh]);

  const openFile = useCallback(
    async (path: string, readOnly = false) => {
      const existing = tabs.find((t) => t.path === path);
      if (existing) {
        setActiveTabPath(path);
        return;
      }

      const fullPath = projectDir ? `${projectDir}/${path}` : path;
      setFileLoading(path);
      setFileLoadError(null);
      try {
        const fc = await ideApi.readFile(fullPath);
        if (fc.is_binary && fc.preview_data) {
          const newTab: OpenTab = {
            path,
            name: path.split("/").pop() || path,
            language: null,
            content: "",
            isDirty: false,
            isReadOnly: true,
            viewMode: "image",
            previewData: fc.preview_data,
            fileSize: fc.size,
          };
          setTabs((prev) => [...prev, newTab]);
          setActiveTabPath(path);
          return;
        }
        if (fc.is_binary) {
          setFileLoadError(t("ide.binaryFileError", { name: path.split("/").pop() || path }));
          return;
        }
        const newTab: OpenTab = {
          path,
          name: path.split("/").pop() || path,
          language: fc.language,
          content: fc.content,
          isDirty: false,
          isReadOnly: readOnly,
          viewMode: "editor",
          fileSize: fc.size,
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabPath(path);
      } catch (e) {
        const msg = String(e);
        setFileLoadError(msg);
        console.error("Failed to read file:", e);
      } finally {
        setFileLoading(null);
      }
    },
    [projectDir, tabs, t],
  );

  openFileRef.current = openFile;

  useEffect(() => {
    if (!openPathRequest?.path || !projectDir) return;
    if (openPathRequest.nonce <= handledOpenPathNonce.current) return;
    handledOpenPathNonce.current = openPathRequest.nonce;
    void openFileRef.current(openPathRequest.path).finally(() => {
      onOpenPathRequestHandled?.();
    });
  }, [openPathRequest?.nonce, openPathRequest?.path, projectDir, onOpenPathRequestHandled]);

  const setTabViewMode = useCallback((path: string, mode: TabViewMode) => {
    setTabs((prev) =>
      prev.map((t) => (t.path === path ? { ...t, viewMode: mode } : t)),
    );
  }, []);

  // ─── Open a file and jump to a line/column (search results) ──────
  const revealInFile = useCallback(
    async (path: string, line: number, column: number) => {
      await openFile(path);
      setActiveTabPath(path);
      setReveal({ path, line, column: column || 1, nonce: Date.now() });
    },
    [openFile],
  );

  // ─── Open diff for a file ────────────────────────────────────────
  const openDiff = useCallback(
    async (path: string) => {
      if (!projectDir) return;
      const diffPath = `diff:${path}`;
      const existing = tabs.find((t) => t.path === diffPath);
      if (existing) {
        setActiveTabPath(diffPath);
        return;
      }

      try {
        const diff = await ideApi.gitDiff(projectDir, path);
        const newTab: OpenTab = {
          path: diffPath,
          name: `${path} (diff)`,
          language: null,
          content: diff.modified,
          isDirty: false,
          isReadOnly: true,
          isDiff: true,
          originalContent: diff.original,
        };
        setTabs((prev) => [...prev, newTab]);
        setActiveTabPath(diffPath);
      } catch (e) {
        console.error("Failed to get diff:", e);
      }
    },
    [projectDir, tabs],
  );

  // ─── Handle editor content change ───────────────────────────────
  const handleEditorChange = useCallback(
    (value: string) => {
      if (!activeTabPath) return;
      setTabs((prev) =>
        prev.map((t) =>
          t.path === activeTabPath
            ? { ...t, content: value, isDirty: true }
            : t,
        ),
      );
    },
    [activeTabPath],
  );

  // ─── Save file (Ctrl+S) ──────────────────────────────────────────
  // Uses refs so the latest tab content / projectDir are always used,
  // even if the user's keystrokes raced the React render cycle.
  const saveFile = useCallback(
    async (path: string) => {
      const tab = tabsRef.current.find((t) => t.path === path);
      const dir = projectDirRef.current;
      if (!tab || !dir) return;
      const fullPath = `${dir}/${path}`;
      try {
        await ideApi.writeFile(fullPath, tab.content);
        setTabs((prev) =>
          prev.map((t) => (t.path === path ? { ...t, isDirty: false } : t)),
        );
        loadGitStatus();
      } catch (e) {
        console.error("Failed to save:", e);
      }
    },
    [loadGitStatus],
  );

  // ─── Close tab (no dirty prompt — used internally) ─────────────────
  const removeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        const next = prev.filter((t) => t.path !== path);
        if (activeTabPathRef.current === path) {
          const newActive = next[Math.min(idx, next.length - 1)] || null;
          setActiveTabPath(newActive?.path || null);
        }
        return next;
      });
    },
    [],
  );

  // ─── Close tab (with dirty prompt) ──────────────────────────────────
  const closeTab = useCallback(
    (path: string) => {
      const tab = tabsRef.current.find((t) => t.path === path);
      if (tab?.isDirty) {
        const name = tab.name || path;
        const msg = t("ide.unsavedConfirm", { name })
          || `"${name}" has unsaved changes. Save before closing?`;
        // eslint-disable-next-line no-alert
        const answer = window.confirm(msg);
        if (!answer) return; // cancel — keep tab open
        // User clicked OK — save then close
        const dir = projectDirRef.current;
        if (dir && !tab.isReadOnly && !tab.path.startsWith("diff:")) {
          ideApi.writeFile(`${dir}/${tab.path}`, tab.content)
            .then(() => removeTab(path))
            .catch(() => removeTab(path));
        } else {
          removeTab(path);
        }
      } else {
        removeTab(path);
      }
    },
    [removeTab, t],
  );

  const handleTabClose = useCallback(
    (path: string) => {
      if (isBrowserTab(path)) {
        onBrowserOpenChange?.(false);
        void browserClose().catch(() => {});
        setActiveTabPath((cur) =>
          isBrowserTab(cur) ? tabsRef.current[0]?.path ?? null : cur,
        );
        return;
      }
      closeTab(path);
    },
    [closeTab, onBrowserOpenChange],
  );

  // ─── Context menu actions ─────────────────────────────────────────
  const closeAllTabs = useCallback(async () => {
    const dir = projectDirRef.current;
    const snapshot = tabsRef.current.slice();
    // Save all dirty tabs first (with confirmation)
    const dirty = snapshot.filter((t) => t.isDirty);
    if (dirty.length > 0) {
      // eslint-disable-next-line no-alert
      const msg = t("ide.unsavedBulkConfirm", { count: dirty.length })
        || `${dirty.length} file(s) have unsaved changes. Save all before closing?`;
      // eslint-disable-next-line no-alert
      const save = window.confirm(msg);
      if (save && dir) {
        await Promise.all(
          dirty
            .filter((t) => !t.isReadOnly && !t.path.startsWith("diff:"))
            .map((t) => ideApi.writeFile(`${dir}/${t.path}`, t.content).catch(() => {})),
        );
      }
    }
    setTabs([]);
    setActiveTabPath(null);
    loadGitStatus();
  }, [loadGitStatus, t]);

  const closeSavedTabs = useCallback(() => {
    setTabs((prev) => prev.filter((t) => t.isDirty));
    setActiveTabPath((current) => {
      const remaining = tabsRef.current.filter((t) => t.isDirty);
      if (current && remaining.some((t) => t.path === current)) return current;
      return remaining[0]?.path || null;
    });
  }, []);

  const closeOtherTabs = useCallback(async (keepPath: string) => {
    const dir = projectDirRef.current;
    const snapshot = tabsRef.current.slice();
    const closingDirty = snapshot.filter((t) => t.path !== keepPath && t.isDirty);
    if (closingDirty.length > 0) {
      // eslint-disable-next-line no-alert
      const msg = t("ide.unsavedBulkConfirm", { count: closingDirty.length })
        || `${closingDirty.length} file(s) have unsaved changes. Save before closing?`;
      // eslint-disable-next-line no-alert
      const save = window.confirm(msg);
      if (save && dir) {
        await Promise.all(
          closingDirty
            .filter((t) => !t.isReadOnly && !t.path.startsWith("diff:"))
            .map((t) => ideApi.writeFile(`${dir}/${t.path}`, t.content).catch(() => {})),
        );
      }
    }
    setTabs((prev) => prev.filter((t) => t.path === keepPath));
    setActiveTabPath(keepPath);
    loadGitStatus();
  }, [loadGitStatus, t]);

  const handleTabContextMenu = useCallback(
    (e: React.MouseEvent, path: string) => {
      e.preventDefault();
      e.stopPropagation();
      setTabContextMenu({ x: e.clientX, y: e.clientY, targetPath: path });
    },
    [],
  );

  // ─── File tree: multi-select + context menu ──────────────────────────
  const handleFileTreeSelect = useCallback(
    (path: string, opts: { multi: boolean }) => {
      setFileTreeSelection((prev) => {
        if (opts.multi) {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        }
        return new Set([path]);
      });
    },
    [],
  );

  const handleFileTreeContextMenu = useCallback(
    (menu: FileTreeContextMenu) => {
      setFileTreeContextMenu(menu);
    },
    [],
  );

  // Dismiss file tree context menu on outside click / escape / scroll
  useEffect(() => {
    if (!fileTreeContextMenu) return;
    const dismiss = () => setFileTreeContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [fileTreeContextMenu]);

  // ─── File tree keyboard shortcuts (Delete / F2) ───────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only when the file tree (or a child input inside it) has focus
      const el = fileTreeRef.current;
      if (!el) return;
      if (!el.contains(document.activeElement) && document.activeElement !== el) return;
      // Don't intercept when the user is typing in an inline create/rename input
      if ((document.activeElement as HTMLElement)?.tagName === "INPUT") return;

      if (e.key === "Delete") {
        e.preventDefault();
        el.deleteSelected?.();
      } else if (e.key === "F2") {
        e.preventDefault();
        el.renameActive?.();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Dismiss context menu on outside click / escape / scroll
  useEffect(() => {
    if (!tabContextMenu) return;
    const dismiss = () => setTabContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [tabContextMenu]);

  // ─── Keyboard shortcut: Ctrl+S to save (stable, reads refs) ──────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        const active = activeTabPathRef.current;
        if (active && !active.startsWith("diff:")) {
          saveFile(active);
        }
      } else if ((e.key === "k" || e.key === "K") && e.shiftKey) {
        // Ctrl+Shift+S or Ctrl+K+S — save all
        // (handled below; included for symmetry)
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveFile]);

  // ─── beforeunload: warn if any tab has unsaved changes ────────────
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const hasDirty = tabsRef.current.some((t) => t.isDirty);
      if (hasDirty) {
        e.preventDefault();
        // Modern browsers ignore custom messages but still require returnValue
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  return (
    <div className="pond-ide" ref={ideRef}>
      <div className="ide-body">
      {/* Activity bar (icon strip) */}
      <div className="ide-activity-bar">
        <button
          className={sidebarTab === "explorer" && !sidebarCollapsed ? "active" : ""}
          onClick={() => switchSidebarTab("explorer")}
          title={t("ide.explorer") || "Explorer"}
        >
          <ExplorerIcon />
        </button>
        <button
          className={sidebarTab === "search" && !sidebarCollapsed ? "active" : ""}
          onClick={() => switchSidebarTab("search")}
          title={t("ide.search") || "Search"}
        >
          <SearchIcon />
        </button>
        <button
          className={sidebarTab === "git" && !sidebarCollapsed ? "active" : ""}
          onClick={() => switchSidebarTab("git")}
          title={t("ide.sourceControl") || "Source Control"}
        >
          <SourceControlIcon />
          {(gitModified.size + gitAdded.size) > 0 && (
            <span className="activity-badge">{gitModified.size + gitAdded.size}</span>
          )}
        </button>
        <button
          className={sidebarTab === "extensions" && !sidebarCollapsed ? "active" : ""}
          onClick={() => switchSidebarTab("extensions")}
          title={t("extensions.nav") || "Extensions"}
        >
          <ExtensionsIcon />
        </button>
        <div style={{ flex: 1 }} />
        <button
          className={bottomOpen ? "active" : ""}
          disabled={!projectDir}
          onClick={() => {
            if (!projectDir) return;
            setBottomOpen((v) => !v);
          }}
          title={projectDir ? (t("ide.terminal") || "Terminal") : t("ide.terminalNeedProject")}
        >
          <TerminalIcon />
        </button>
      </div>

      {/* Sidebar content */}
      {!sidebarCollapsed && (
        <div className="ide-sidebar" style={{ width: sidebarWidth }}>
          {sidebarTab === "extensions" ? (
            <div className="ide-sidebar-section ide-extensions-sidebar">
              <div className="ide-sidebar-title">{t("extensions.nav") || "Extensions"}</div>
              <ExtensionsManager />
            </div>
          ) : !projectDir ? (
            <div className="ide-sidebar-empty">
              <div className="ide-sidebar-empty-title">
                {sidebarTab === "explorer" && (t("ide.explorer") || "Explorer")}
                {sidebarTab === "search" && (t("ide.search") || "Search")}
                {sidebarTab === "git" && (t("ide.sourceControl") || "Source Control")}
              </div>
              <p>{t("ide.noProjectDir") || "No folder open."}</p>
              <button type="button" className="ide-open-folder-btn" onClick={onOpenFolder}>
                {t("ide.openFolder") || "Open Folder"}
              </button>
              <p className="ide-sidebar-empty-hint">{t("ide.noProjectDirHint")}</p>
            </div>
          ) : (
            <>
              {sidebarTab === "explorer" && (
                <FileTree
                  nodes={fileTree}
                  activePath={activeTabPath}
                  selectedPaths={fileTreeSelection}
                  gitModified={gitModified}
                  gitAdded={gitAdded}
                  projectDir={projectDir}
                  onFileClick={(node) => openFile(node.path)}
                  onRefresh={() => {
                    loadFileTree();
                    loadGitStatus();
                  }}
                  onSelect={handleFileTreeSelect}
                  onContextMenu={handleFileTreeContextMenu}
                  containerRef={fileTreeRef}
                />
              )}
              {sidebarTab === "search" && (
                <SearchPanel
                  projectDir={projectDir}
                  onResultClick={(path, line, column) => revealInFile(path, line, column)}
                />
              )}
              {sidebarTab === "git" && (
                <GitPanel
                  projectDir={projectDir}
                  onDiffClick={(path) => openDiff(path)}
                  onOpenFile={(path) => openFile(path)}
                  onRefresh={loadGitStatus}
                />
              )}
            </>
          )}
        </div>
      )}

      {/* Sidebar resize handle */}
      {!sidebarCollapsed && (
        <div
          className="ide-resize-handle-h"
          onMouseDown={startSidebarResize}
        />
      )}

      {/* Editor area */}
      <div className="ide-editor-area">
        <EditorTabs
          tabs={headerTabs}
          activeTabPath={activeTabPath}
          onTabClick={setActiveTabPath}
          onTabClose={handleTabClose}
          onSave={saveFile}
          onTabContextMenu={handleTabContextMenu}
          onCloseAll={closeAllTabs}
          onCloseSaved={closeSavedTabs}
          onCloseOther={closeOtherTabs}
          contextMenu={tabContextMenu}
          onDismissContextMenu={() => setTabContextMenu(null)}
        />
        <div className="ide-editor">
          {!projectDir ? (
            <div className="ide-no-project">
              <div className="icon">📂</div>
              <div>{t("ide.noProjectDir") || "No folder open."}</div>
              <button type="button" className="ide-open-folder-btn ide-open-folder-btn-lg" onClick={onOpenFolder}>
                {t("ide.openFolder") || "Open Folder"}
              </button>
              <div style={{ fontSize: 12, opacity: 0.6 }}>{t("ide.noProjectDirHint")}</div>
            </div>
          ) : fileLoading ? (
            <div className="ide-file-loading">
              <div className="ide-file-loading-spinner" />
              <div>{t("ide.openingFile", { name: fileLoading.split("/").pop() || fileLoading })}</div>
            </div>
          ) : fileLoadError ? (
            <div className="ide-file-error">
              <div className="ide-file-error-title">{t("ide.fileErrorTitle")}</div>
              <div className="ide-file-error-msg">{fileLoadError}</div>
              <button type="button" className="ide-open-folder-btn" onClick={() => setFileLoadError(null)}>
                {t("common.dismiss")}
              </button>
            </div>
          ) : isBrowserTab(activeTabPath) && browserOpen ? (
            <BrowserPanel
              onClose={() => handleTabClose(BROWSER_TAB_PATH)}
              onSendElementToChat={(el) => onSendElementToChat?.(el)}
              onScreenshotToChat={(base64) => onScreenshotToChat?.(base64)}
              chatEnabled={Boolean(projectDir)}
            />
          ) : activeTab ? (
            <FileViewer
              tab={activeTab}
              projectDir={projectDir}
              reveal={reveal && reveal.path === activeTab.path ? reveal : null}
              onChange={handleEditorChange}
              onViewModeChange={(mode) => setTabViewMode(activeTab.path, mode)}
              onSave={() => {
                const p = activeTabPathRef.current;
                if (p && !p.startsWith("diff:")) saveFile(p);
              }}
            />
          ) : (
            <div className="ide-editor-welcome">
              <div className="welcome-logo welcome-logo-text">CodeZ</div>
              <div className="welcome-title">
                {t("ide.welcome") || "Select a file to start editing"}
              </div>
              <div className="welcome-hint">{t("ide.welcomeHint")}</div>
            </div>
          )}
        </div>

        {/* Unified bottom panel — terminal + extension consoles, mounted while
            project is open; visibility toggles only */}
        {projectDir && (
          <>
            {bottomOpen && (
              <div
                className="ide-resize-handle-v"
                onMouseDown={startBottomResize}
              />
            )}
            <BottomPanel
              projectDir={projectDir}
              open={bottomOpen}
              activeTab={bottomTab}
              onTabChange={setBottomTab}
              onClose={() => setBottomOpen(false)}
              height={bottomHeight}
              onSendTerminalToChat={onSendTerminalToChat}
            />
          </>
        )}
      </div>
      </div>

      {/* Full-width application status bar */}
      <IdeStatusBar onOpenPanel={openBottomPanel} onOpenExtensions={openExtensionsSidebar} />

      {/* File tree right-click context menu */}
      {fileTreeContextMenu && (
        <div
          className="ide-tab-context-menu"
          style={{ position: "fixed", left: fileTreeContextMenu.x, top: fileTreeContextMenu.y, zIndex: 1000 }}
        >
          <button onClick={() => { openFile(fileTreeContextMenu.targetPath); setFileTreeContextMenu(null); }}>
            {t("ide.openFile") || "Open"}
          </button>
          {onSendToChat && (
            <button
              onClick={() => {
                const paths =
                  fileTreeSelection.size > 1 && fileTreeSelection.has(fileTreeContextMenu.targetPath)
                    ? collectSelectedPaths(fileTree, fileTreeSelection)
                    : [
                        fileTreeContextMenu.isDir
                          ? fileTreeContextMenu.targetPath.endsWith("/")
                            ? fileTreeContextMenu.targetPath
                            : `${fileTreeContextMenu.targetPath}/`
                          : fileTreeContextMenu.targetPath,
                      ];
                if (paths.length > 0) onSendToChat(paths);
                setFileTreeContextMenu(null);
              }}
            >
              {t("ide.sendToChat")}
            </button>
          )}
          <button onClick={() => { fileTreeRef.current?.renameActive?.(); setFileTreeContextMenu(null); }}>
            {t("ide.renameFile") || "Rename"} <span style={{ opacity: 0.5, fontSize: 11, marginLeft: 8 }}>F2</span>
          </button>
          <button onClick={() => { fileTreeRef.current?.deleteSelected?.(); setFileTreeContextMenu(null); }}>
            {t("ide.deleteFile") || "Delete"} <span style={{ opacity: 0.5, fontSize: 11, marginLeft: 8 }}>Del</span>
          </button>
          <div className="ide-tab-context-menu-sep" />
          <button onClick={() => {
            const dir = projectDirRef.current;
            if (dir) navigator.clipboard.writeText(`${dir}/${fileTreeContextMenu.targetPath}`).catch(() => {});
            setFileTreeContextMenu(null);
          }}>
            {t("ide.copyPath") || "Copy Path"}
          </button>
          <button onClick={() => {
            navigator.clipboard.writeText(fileTreeContextMenu.targetPath).catch(() => {});
            setFileTreeContextMenu(null);
          }}>
            {t("ide.copyRelPath") || "Copy Relative Path"}
          </button>
          <button onClick={() => {
            const dir = projectDirRef.current;
            if (dir) openPath(`${dir}/${fileTreeContextMenu.targetPath}`).catch(() => {});
            setFileTreeContextMenu(null);
          }}>
            {t("ide.revealInExplorer") || "Reveal in File Manager"}
          </button>
          <div className="ide-tab-context-menu-sep" />
          <button onClick={() => { fileTreeRef.current?.startCreate?.(false); setFileTreeContextMenu(null); }}>
            {t("ide.newFile") || "New File"}
          </button>
          <button onClick={() => { fileTreeRef.current?.startCreate?.(true); setFileTreeContextMenu(null); }}>
            {t("ide.newFolder") || "New Folder"}
          </button>
        </div>
      )}

      {/* VS Code extension ecosystem: host sidecar + contributed UI surfaces */}
      <ExtensionHostProvider projectDir={projectDir} />
    </div>
  );
}
