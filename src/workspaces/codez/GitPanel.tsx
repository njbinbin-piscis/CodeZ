import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ideApi } from "../../services/tauri/ide";
import type { GitFileStatus, GitRepoSnapshot, BranchInfo } from "./types";

interface GitPanelProps {
  projectDir: string;
  onDiffClick: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => Promise<void>;
}

interface GitRepoSectionProps {
  projectDir: string;
  repo: GitRepoSnapshot;
  showDivider: boolean;
  onDiffClick: (path: string) => void;
  onOpenFile: (path: string) => void;
  onMutate: () => Promise<void>;
}

function statusBadge(s: string) {
  const map: Record<string, string> = {
    modified: "M",
    added: "A",
    deleted: "D",
    untracked: "U",
    renamed: "R",
  };
  return map[s] || "?";
}

function GitRepoSection({
  projectDir,
  repo,
  showDivider,
  onDiffClick,
  onOpenFile,
  onMutate,
}: GitRepoSectionProps) {
  const { t } = useTranslation();
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const gitRoot = repo.repo_root || null;

  const changed = repo.files.filter((s) => !s.staged);
  const staged = repo.files.filter((s) => s.staged);
  const koiBranches = repo.branches.filter((b) => b.is_koi);
  const mainBranches = repo.branches.filter((b) => !b.is_koi);

  const refreshRepo = useCallback(async () => {
    await onMutate();
  }, [onMutate]);

  const handleStage = useCallback(
    async (path: string) => {
      await ideApi.gitAdd(projectDir, path, gitRoot);
      await refreshRepo();
    },
    [projectDir, gitRoot, refreshRepo],
  );

  const handleStageAll = useCallback(async () => {
    await ideApi.gitAddAll(projectDir, gitRoot);
    await refreshRepo();
  }, [projectDir, gitRoot, refreshRepo]);

  const handleUnstageAll = useCallback(async () => {
    await ideApi.gitResetAll(projectDir, gitRoot);
    await refreshRepo();
  }, [projectDir, gitRoot, refreshRepo]);

  const handleUnstage = useCallback(
    async (path: string) => {
      await ideApi.gitReset(projectDir, path, gitRoot);
      await refreshRepo();
    },
    [projectDir, gitRoot, refreshRepo],
  );

  const handleDiscard = useCallback(
    async (path: string) => {
      const ok = window.confirm(
        (t("ide.discardConfirm", { name: path }) as string) ||
          `Discard all changes in "${path}"? This cannot be undone.`,
      );
      if (!ok) return;
      try {
        await ideApi.gitDiscard(projectDir, path, gitRoot);
        await refreshRepo();
      } catch (e) {
        window.alert(`Discard failed: ${e}`);
      }
    },
    [projectDir, gitRoot, refreshRepo, t],
  );

  const handleDiscardAll = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      const ok = window.confirm(
        (t("ide.discardAllConfirm", { count: paths.length }) as string) ||
          `Discard changes in ${paths.length} file(s)? This cannot be undone.`,
      );
      if (!ok) return;
      for (const p of paths) {
        await ideApi.gitDiscard(projectDir, p, gitRoot).catch(() => {});
      }
      await refreshRepo();
    },
    [projectDir, gitRoot, refreshRepo, t],
  );

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    setCommitting(true);
    try {
      await ideApi.gitCommit(projectDir, commitMsg.trim(), gitRoot);
      setCommitMsg("");
      await refreshRepo();
    } catch (e) {
      console.error("Commit error:", e);
    } finally {
      setCommitting(false);
    }
  }, [projectDir, commitMsg, gitRoot, refreshRepo]);

  const handleCheckout = useCallback(
    async (branch: string) => {
      const dirty = repo.files.length > 0;
      if (dirty) {
        const ok = window.confirm(
          (t("ide.checkoutDirtyWarn") as string) ||
            `Switch to '${branch}'? You have uncommitted changes that may be overwritten.`,
        );
        if (!ok) return;
      }
      try {
        await ideApi.gitCheckout(projectDir, branch, gitRoot);
        await refreshRepo();
      } catch (e) {
        window.alert(`Checkout failed: ${e}`);
      }
    },
    [projectDir, repo.files.length, gitRoot, refreshRepo, t],
  );

  const handleCreateBranch = useCallback(async () => {
    const name = window.prompt(
      (t("ide.newBranchPrompt") as string) || "New branch name (from HEAD):",
      "",
    );
    if (!name?.trim()) return;
    try {
      await ideApi.gitCreateBranch(projectDir, name.trim(), gitRoot);
      await refreshRepo();
    } catch (e) {
      window.alert(`Create branch failed: ${e}`);
    }
  }, [projectDir, gitRoot, refreshRepo, t]);

  const repoLabel = repo.repo_root ? `${repo.name} (${repo.repo_root})` : repo.name;

  return (
    <div className="git-repo-section">
      {showDivider && <div className="git-repo-divider" role="separator" />}
      <div className="git-repo-header">
        <span className="git-repo-title" title={repo.repo_root || projectDir}>
          {repoLabel}
        </span>
      </div>

      <div className="git-commit-area">
        <input
          type="text"
          className="git-commit-input"
          placeholder={t("ide.commitPlaceholder") || "Commit message"}
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.ctrlKey) void handleCommit();
          }}
          disabled={committing}
        />
        <div className="git-commit-actions">
          <button
            className="git-action-btn"
            onClick={() => void handleCommit()}
            disabled={committing || staged.length === 0 || !commitMsg.trim()}
            title={t("ide.commit") || "Commit"}
          >
            {committing ? "…" : "✓"}
          </button>
        </div>
      </div>

      <div className="git-panel-section">
        <div className="git-panel-title">
          {t("ide.stagedChanges") || "Staged Changes"} ({staged.length})
          {staged.length > 0 && (
            <button
              className="git-inline-btn"
              onClick={() => void handleUnstageAll()}
              title={t("ide.unstageAll") || "Unstage All"}
            >
              −
            </button>
          )}
        </div>
        {staged.map((s) => (
          <GitFileRow
            key={`staged-${repo.repo_root}-${s.path}`}
            file={s}
            onDiffClick={onDiffClick}
            onOpenFile={onOpenFile}
            onStage={() => void handleStage(s.path)}
            onUnstage={() => void handleUnstage(s.path)}
            onDiscard={() => void handleDiscard(s.path)}
            staged
          />
        ))}
      </div>

      <div className="git-panel-section">
        <div className="git-panel-title">
          {t("ide.changes") || "Changes"} ({changed.length})
          {changed.length > 0 && (
            <span className="git-title-actions">
              <button
                className="git-inline-btn"
                onClick={() => void handleDiscardAll(changed.map((s) => s.path))}
                title={t("ide.discardAll") || "Discard All Changes"}
              >
                ↺
              </button>
              <button
                className="git-inline-btn"
                onClick={() => void handleStageAll()}
                title={t("ide.stageAll") || "Stage All"}
              >
                +
              </button>
            </span>
          )}
        </div>
        {changed.length === 0 && (
          <div className="git-empty-hint">{t("ide.noChanges") || "No changes detected"}</div>
        )}
        {changed.map((s) => (
          <GitFileRow
            key={`changed-${repo.repo_root}-${s.path}`}
            file={s}
            onDiffClick={onDiffClick}
            onOpenFile={onOpenFile}
            onStage={() => void handleStage(s.path)}
            onUnstage={() => void handleUnstage(s.path)}
            onDiscard={() => void handleDiscard(s.path)}
            staged={false}
          />
        ))}
      </div>

      <div className="git-panel-section">
        <div className="git-panel-title">
          <span>{t("ide.branches") || "Branches"} ({mainBranches.length})</span>
          <button
            className="git-inline-btn"
            onClick={() => void handleCreateBranch()}
            title={(t("ide.newBranch") as string) || "New branch"}
            style={{ opacity: 0.6 }}
          >
            +
          </button>
        </div>
        {mainBranches.length === 0 && (
          <div className="git-empty-hint">{t("ide.noBranches") || "No branches"}</div>
        )}
        {mainBranches.map((b) => (
          <GitBranchRow key={`${repo.repo_root}-${b.name}`} branch={b} onCheckout={handleCheckout} />
        ))}
        {koiBranches.length > 0 && (
          <>
            <div className="git-panel-title" style={{ marginTop: 10 }}>
              Koi {t("ide.koiBranches")} ({koiBranches.length})
            </div>
            {koiBranches.map((b) => (
              <GitBranchRow
                key={`koi-${repo.repo_root}-${b.name}`}
                branch={b}
                onCheckout={handleCheckout}
                koi
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function GitFileRow({
  file,
  onDiffClick,
  onOpenFile,
  onStage,
  onUnstage,
  onDiscard,
  staged,
}: {
  file: GitFileStatus;
  onDiffClick: (path: string) => void;
  onOpenFile: (path: string) => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  staged: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="git-file-item">
      <span className={`git-file-status-badge ${file.status}`}>{statusBadge(file.status)}</span>
      <span className="git-file-path" onClick={() => onDiffClick(file.path)}>
        {file.path}
      </span>
      {!staged && (
        <>
          <button
            className="git-inline-btn"
            onClick={() => onOpenFile(file.path)}
            title={t("ide.openFile") || "Open File"}
          >
            ↗
          </button>
          <button
            className="git-inline-btn"
            onClick={onDiscard}
            title={t("ide.discard") || "Discard Changes"}
          >
            ↺
          </button>
          <button className="git-inline-btn" onClick={onStage} title={t("ide.stage") || "Stage"}>
            +
          </button>
        </>
      )}
      {staged && (
        <button className="git-inline-btn" onClick={onUnstage} title={t("ide.unstage") || "Unstage"}>
          −
        </button>
      )}
    </div>
  );
}

function GitBranchRow({
  branch,
  onCheckout,
  koi,
}: {
  branch: BranchInfo;
  onCheckout: (name: string) => void;
  koi?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={`git-branch-item ${branch.is_current ? "current" : ""} ${koi ? "koi" : ""}`}
      title={branch.is_current ? (branch.last_commit || "") : `Checkout ${branch.name}`}
      onClick={() => {
        if (!branch.is_current) void onCheckout(branch.name);
      }}
    >
      <span className="branch-icon">{branch.is_current ? "●" : "⑂"}</span>
      <span className="branch-name">{branch.name}</span>
      {branch.is_current && (
        <span className="git-branch-current">{t("ide.current") || "current"}</span>
      )}
    </div>
  );
}

export default function GitPanel({
  projectDir,
  onDiffClick,
  onOpenFile,
  onRefresh,
}: GitPanelProps) {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<GitRepoSnapshot[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectDir) return;
    setLoading(true);
    try {
      const snapshots = await ideApi.gitWorkspaceStatus(projectDir);
      setRepos(snapshots);
    } catch (e) {
      console.error("Git status error:", e);
      setRepos([]);
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleMutate = useCallback(async () => {
    await refresh();
    await onRefresh();
  }, [refresh, onRefresh]);

  return (
    <div className="git-panel">
      <div className="ide-sidebar-header">
        <span>{t("ide.sourceControl") || "Source Control"}</span>
        <button
          onClick={() => void refresh()}
          title={t("common.refresh") || "Refresh"}
          disabled={loading}
        >
          {loading ? "…" : "↻"}
        </button>
      </div>

      {repos.length === 0 && !loading && (
        <div className="git-panel-empty">
          {t("ide.noGitRepos") || "No git repositories found in this folder."}
        </div>
      )}

      {repos.map((repo, index) => (
        <GitRepoSection
          key={repo.repo_root || "__root__"}
          projectDir={projectDir}
          repo={repo}
          showDivider={index > 0}
          onDiffClick={onDiffClick}
          onOpenFile={onOpenFile}
          onMutate={handleMutate}
        />
      ))}
    </div>
  );
}
