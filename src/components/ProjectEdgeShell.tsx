import { useCallback, useEffect, useState } from "react";
import { useProjectEdge } from "../contexts/ProjectEdgeContext";
import { ideApi } from "../services/tauri/ide";
import { journalUndoTurn } from "../services/tauri/chat";
import ProjectEdgePanel from "./ProjectEdgePanel";

interface ProjectEdgeShellProps {
  projectDir: string | null;
}

/** Global git changes + journal review drawer; shared by CodeZ and WorkZ. */
export default function ProjectEdgeShell({ projectDir }: ProjectEdgeShellProps) {
  const {
    setGitChanges,
    registerWorkspaceRefresh,
    scheduleWorkspaceRefresh,
    pendingReview,
    setPendingReview,
  } = useProjectEdge();
  const [undoing, setUndoing] = useState(false);

  const refreshGit = useCallback(() => {
    if (!projectDir) {
      setGitChanges([]);
      return;
    }
    ideApi
      .gitStatus(projectDir)
      .then(setGitChanges)
      .catch(() => setGitChanges([]));
  }, [projectDir, setGitChanges]);

  useEffect(() => {
    registerWorkspaceRefresh("git", refreshGit);
  }, [registerWorkspaceRefresh, refreshGit]);

  useEffect(() => {
    scheduleWorkspaceRefresh({ git: true, force: true, delayMs: 0 });
  }, [projectDir, scheduleWorkspaceRefresh]);

  const undoReview = useCallback(async () => {
    if (!projectDir || !pendingReview) return;
    setUndoing(true);
    try {
      await journalUndoTurn(projectDir, pendingReview.sessionId, pendingReview.turnId);
      setPendingReview(null);
      scheduleWorkspaceRefresh({ git: true, fileTree: true, force: true, delayMs: 0 });
    } finally {
      setUndoing(false);
    }
  }, [projectDir, pendingReview, setPendingReview, scheduleWorkspaceRefresh]);

  return (
    <ProjectEdgePanel
      projectDir={projectDir}
      onRefreshGit={() => scheduleWorkspaceRefresh({ git: true, force: true, delayMs: 0 })}
      onUndoReview={undoReview}
      undoing={undoing}
    />
  );
}
