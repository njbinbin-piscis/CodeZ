import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { GitFileStatus } from "../workspaces/codez/types";
import type { JournalChange } from "../services/tauri/chat";
import { perfCounters } from "../utils/perfCounters";

export interface PendingReview {
  sessionId: string;
  turnId: string;
  changes: JournalChange[];
}

type RefreshKind = "git" | "fileTree";

interface ProjectEdgeContextValue {
  gitChanges: GitFileStatus[];
  setGitChanges: (changes: GitFileStatus[]) => void;
  /** @deprecated Prefer scheduleWorkspaceRefresh({ git: true }) */
  refreshGitChanges: () => void;
  registerRefreshGitChanges: (fn: () => void) => () => void;
  registerWorkspaceRefresh: (kind: RefreshKind, fn: () => void) => () => void;
  scheduleWorkspaceRefresh: (opts?: {
    git?: boolean;
    fileTree?: boolean;
    delayMs?: number;
    /** Bypass agent-turn pause (e.g. turn finished). */
    force?: boolean;
  }) => void;
  agentTurnBusy: boolean;
  setAgentTurnBusy: (busy: boolean) => void;
  artifacts: string[];
  setArtifacts: (paths: string[]) => void;
  pendingReview: PendingReview | null;
  setPendingReview: (review: PendingReview | null) => void;
  previewPath: string | null;
  setPreviewPath: (path: string | null) => void;
  onSelectPath: (path: string) => void;
  registerOnSelectPath: (fn: (path: string) => void) => () => void;
}

const ProjectEdgeContext = createContext<ProjectEdgeContextValue | null>(null);

const DEFAULT_REFRESH_DELAY_MS = 250;

export function ProjectEdgeProvider({ children }: { children: ReactNode }) {
  const [gitChanges, setGitChanges] = useState<GitFileStatus[]>([]);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [pendingReview, setPendingReview] = useState<PendingReview | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [selectHandler, setSelectHandler] = useState<((path: string) => void) | null>(null);
  const [agentTurnBusy, setAgentTurnBusy] = useState(false);

  const refreshHandlers = useRef<Partial<Record<RefreshKind, () => void>>>({});
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRefresh = useRef<{ git: boolean; fileTree: boolean }>({ git: false, fileTree: false });
  const refreshInFlight = useRef(false);

  const flushWorkspaceRefresh = useCallback(() => {
    const { git, fileTree } = pendingRefresh.current;
    pendingRefresh.current = { git: false, fileTree: false };
    refreshTimer.current = null;
    if (!git && !fileTree) return;

    perfCounters.recordWorkspaceRefreshFlushed();
    refreshInFlight.current = true;
    try {
      if (git) refreshHandlers.current.git?.();
      if (fileTree) refreshHandlers.current.fileTree?.();
    } finally {
      refreshInFlight.current = false;
    }
  }, []);

  const scheduleWorkspaceRefresh = useCallback(
    (opts?: { git?: boolean; fileTree?: boolean; delayMs?: number; force?: boolean }) => {
      if (agentTurnBusy && !opts?.force) return;
      perfCounters.recordWorkspaceRefreshScheduled();
      if (opts?.git) pendingRefresh.current.git = true;
      if (opts?.fileTree) pendingRefresh.current.fileTree = true;
      if (!opts || (!opts.git && !opts.fileTree)) {
        pendingRefresh.current.git = true;
        pendingRefresh.current.fileTree = true;
      }

      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      const delay = opts?.delayMs ?? DEFAULT_REFRESH_DELAY_MS;
      refreshTimer.current = setTimeout(flushWorkspaceRefresh, delay);
    },
    [agentTurnBusy, flushWorkspaceRefresh],
  );

  const registerWorkspaceRefresh = useCallback((kind: RefreshKind, fn: () => void) => {
    refreshHandlers.current[kind] = fn;
    return () => {
      if (refreshHandlers.current[kind] === fn) {
        delete refreshHandlers.current[kind];
      }
    };
  }, []);

  const registerRefreshGitChanges = useCallback(
    (fn: () => void) => registerWorkspaceRefresh("git", fn),
    [registerWorkspaceRefresh],
  );

  const refreshGitChanges = useCallback(() => {
    scheduleWorkspaceRefresh({ git: true, delayMs: 0, force: true });
  }, [scheduleWorkspaceRefresh]);

  const registerOnSelectPath = useCallback((fn: (path: string) => void) => {
    setSelectHandler(() => fn);
    return () =>
      setSelectHandler((cur: ((path: string) => void) | null) => (cur === fn ? null : cur));
  }, []);

  const onSelectPath = useCallback(
    (path: string) => {
      setPreviewPath(path);
      selectHandler?.(path);
    },
    [selectHandler],
  );

  const value = useMemo(
    () => ({
      gitChanges,
      setGitChanges,
      refreshGitChanges,
      registerRefreshGitChanges,
      registerWorkspaceRefresh,
      scheduleWorkspaceRefresh,
      agentTurnBusy,
      setAgentTurnBusy,
      artifacts,
      setArtifacts,
      pendingReview,
      setPendingReview,
      previewPath,
      setPreviewPath,
      onSelectPath,
      registerOnSelectPath,
    }),
    [
      gitChanges,
      artifacts,
      pendingReview,
      previewPath,
      onSelectPath,
      registerOnSelectPath,
      refreshGitChanges,
      registerRefreshGitChanges,
      registerWorkspaceRefresh,
      scheduleWorkspaceRefresh,
      agentTurnBusy,
    ],
  );

  return <ProjectEdgeContext.Provider value={value}>{children}</ProjectEdgeContext.Provider>;
}

export function useProjectEdge(): ProjectEdgeContextValue {
  const ctx = useContext(ProjectEdgeContext);
  if (!ctx) throw new Error("useProjectEdge must be used within ProjectEdgeProvider");
  return ctx;
}
