import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { GitFileStatus } from "../workspaces/codez/types";
import type { JournalChange } from "../services/tauri/chat";

export interface PendingReview {
  sessionId: string;
  turnId: string;
  changes: JournalChange[];
}

interface ProjectEdgeContextValue {
  gitChanges: GitFileStatus[];
  setGitChanges: (changes: GitFileStatus[]) => void;
  refreshGitChanges: () => void;
  registerRefreshGitChanges: (fn: () => void) => () => void;
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

export function ProjectEdgeProvider({ children }: { children: ReactNode }) {
  const [gitChanges, setGitChanges] = useState<GitFileStatus[]>([]);
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [pendingReview, setPendingReview] = useState<PendingReview | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [selectHandler, setSelectHandler] = useState<((path: string) => void) | null>(null);
  const [refreshHandler, setRefreshHandler] = useState<(() => void) | null>(null);

  const registerOnSelectPath = useCallback((fn: (path: string) => void) => {
    setSelectHandler(() => fn);
    return () =>
      setSelectHandler((cur: ((path: string) => void) | null) => (cur === fn ? null : cur));
  }, []);

  const registerRefreshGitChanges = useCallback((fn: () => void) => {
    setRefreshHandler(() => fn);
    return () => setRefreshHandler((cur: (() => void) | null) => (cur === fn ? null : cur));
  }, []);

  const refreshGitChanges = useCallback(() => {
    refreshHandler?.();
  }, [refreshHandler]);

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
    ],
  );

  return <ProjectEdgeContext.Provider value={value}>{children}</ProjectEdgeContext.Provider>;
}

export function useProjectEdge(): ProjectEdgeContextValue {
  const ctx = useContext(ProjectEdgeContext);
  if (!ctx) throw new Error("useProjectEdge must be used within ProjectEdgeProvider");
  return ctx;
}
