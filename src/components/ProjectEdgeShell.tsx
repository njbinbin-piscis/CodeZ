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
  const { setGitChanges, registerRefreshGitChanges, pendingReview, setPendingReview } =
    useProjectEdge();
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
    refreshGit();
  }, [refreshGit]);

  useEffect(() => registerRefreshGitChanges(refreshGit), [registerRefreshGitChanges, refreshGit]);

  const undoReview = useCallback(async () => {
    if (!projectDir || !pendingReview) return;
    setUndoing(true);
    try {
      await journalUndoTurn(projectDir, pendingReview.sessionId, pendingReview.turnId);
      setPendingReview(null);
      refreshGit();
    } finally {
      setUndoing(false);
    }
  }, [projectDir, pendingReview, setPendingReview, refreshGit]);

  return (
    <ProjectEdgePanel
      projectDir={projectDir}
      onRefreshGit={refreshGit}
      onUndoReview={undoReview}
      undoing={undoing}
    />
  );
}
