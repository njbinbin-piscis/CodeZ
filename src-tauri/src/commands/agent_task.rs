//! Agent task isolation (M4) — run autonomous Agent-mode tasks inside an
//! isolated git worktree + branch, then review the resulting diff and either
//! merge it back, open a PR, or discard it. The main project working tree is
//! never written to directly, so a misbehaving agent can't corrupt the user's
//! checkout.
//!
//! Worktrees live under `<project>/../.agentz-worktrees/task-<id>` (a sibling of
//! the project, matching the kernel's `.koi-worktrees` convention) on a fresh
//! `workz/task-<id>` branch.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::process::Command;
use tokio::time::timeout;

use crate::commands::data_scope::require_project_dir;

/// Metadata describing one isolated agent task worktree.
#[derive(Debug, Clone, Serialize)]
pub struct AgentTaskInfo {
    /// Short task id (the suffix used in the branch / worktree names).
    pub id: String,
    /// Branch the worktree is checked out on (`workz/task-<id>`).
    pub branch: String,
    /// Absolute path to the worktree directory.
    pub worktree_path: String,
    /// Base branch the task forked from (for diff / merge).
    pub base: String,
}

/// A single file changed on the task branch relative to its base.
#[derive(Debug, Clone, Serialize)]
pub struct AgentTaskChange {
    pub path: String,
    /// One of: modified, added, deleted, renamed, copied, type_changed, unknown.
    pub status: String,
}

/// Side-by-side content for reviewing one changed file.
#[derive(Debug, Clone, Serialize)]
pub struct AgentTaskFileDiff {
    pub path: String,
    pub original: String,
    pub modified: String,
}

/// Result of attempting to open a pull request.
#[derive(Debug, Clone, Serialize)]
pub struct PrResult {
    pub ok: bool,
    /// PR URL when `gh` succeeded.
    pub url: Option<String>,
    /// Human-readable status / fallback instructions.
    pub message: String,
}

fn worktrees_root(project: &Path) -> PathBuf {
    project
        .parent()
        .unwrap_or(project)
        .join(".agentz-worktrees")
}

fn branch_for(task_id: &str) -> String {
    let safe: String = task_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("workz/task-{safe}")
}

async fn run_git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = timeout(
        Duration::from_secs(60),
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output(),
    )
    .await
    .map_err(|_| "git command timed out".to_string())?
    .map_err(|e| format!("git command failed: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "git error: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn current_branch(project: &Path) -> Result<String, String> {
    let out = run_git(project, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    Ok(out.trim().to_string())
}

async fn has_git_head(project: &Path) -> bool {
    run_git(project, &["rev-parse", "HEAD"])
        .await
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Ensure the project is a git repo with at least one commit so `git worktree add`
/// can fork a task branch. Runs `git init` automatically when `.git` is missing.
async fn ensure_git_repo(project: &Path) -> Result<(), String> {
    if !project.join(".git").exists() {
        run_git(project, &["init"])
            .await
            .map_err(|e| format!("git init failed: {e}"))?;
    }
    if !has_git_head(project).await {
        // Worktree creation needs a valid base ref; allow-empty covers fresh repos.
        run_git(
            project,
            &["commit", "-m", "Initial commit", "--allow-empty"],
        )
        .await
        .map_err(|e| format!("failed to create initial commit: {e}"))?;
    }
    Ok(())
}

fn status_char_to_string(c: char) -> String {
    match c {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'T' => "type_changed",
        _ => "unknown",
    }
    .to_string()
}

/// Create (or reuse) an isolated worktree + branch for an agent task.
#[tauri::command]
pub async fn agent_task_create(
    project_dir: Option<String>,
    task_id: String,
    base: Option<String>,
) -> Result<AgentTaskInfo, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let project = PathBuf::from(project);
    ensure_git_repo(&project).await?;

    let id_safe: String = task_id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let branch = branch_for(&id_safe);
    let base = match base.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()) {
        Some(b) => b,
        None => current_branch(&project).await.unwrap_or_else(|_| "HEAD".into()),
    };

    let wt_dir = worktrees_root(&project).join(format!("task-{id_safe}"));
    std::fs::create_dir_all(worktrees_root(&project))
        .map_err(|e| format!("failed to create worktrees root: {e}"))?;

    // If the worktree already exists, reuse it (idempotent re-open).
    if wt_dir.join(".git").exists() {
        return Ok(AgentTaskInfo {
            id: id_safe,
            branch,
            worktree_path: wt_dir.to_string_lossy().to_string(),
            base,
        });
    }

    let wt_str = wt_dir.to_string_lossy().to_string();
    // `git worktree add -b <branch> <path> <base>` — fresh branch off base.
    run_git(
        &project,
        &["worktree", "add", "-b", &branch, &wt_str, &base],
    )
    .await
    .map_err(|e| format!("failed to create worktree: {e}"))?;

    Ok(AgentTaskInfo {
        id: id_safe,
        branch,
        worktree_path: wt_str,
        base,
    })
}

/// List existing AgentZ agent task worktrees.
#[tauri::command]
pub async fn agent_task_list(project_dir: Option<String>) -> Result<Vec<AgentTaskInfo>, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let project = PathBuf::from(project);
    if !project.join(".git").exists() {
        return Ok(vec![]);
    }
    let out = run_git(&project, &["worktree", "list", "--porcelain"])
        .await
        .unwrap_or_default();

    let mut tasks = Vec::new();
    let mut cur_path: Option<String> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            let branch = b.trim().trim_start_matches("refs/heads/").to_string();
            if branch.starts_with("workz/task-") {
                if let Some(path) = cur_path.clone() {
                    let id = branch.trim_start_matches("workz/task-").to_string();
                    tasks.push(AgentTaskInfo {
                        id,
                        branch,
                        worktree_path: path,
                        base: String::new(),
                    });
                }
            }
        } else if line.is_empty() {
            cur_path = None;
        }
    }
    Ok(tasks)
}

/// List files changed on `branch` relative to `base`.
#[tauri::command]
pub async fn agent_task_changed_files(
    project_dir: Option<String>,
    branch: String,
    base: String,
) -> Result<Vec<AgentTaskChange>, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let project = PathBuf::from(project);
    let range = format!("{base}...{branch}");
    let out = run_git(&project, &["diff", "--name-status", &range])
        .await
        .unwrap_or_default();

    let mut changes = Vec::new();
    for line in out.lines() {
        let mut parts = line.split('\t');
        let Some(status) = parts.next() else { continue };
        let Some(path) = parts.next_back() else { continue };
        let c = status.chars().next().unwrap_or('?');
        changes.push(AgentTaskChange {
            path: path.to_string(),
            status: status_char_to_string(c),
        });
    }
    Ok(changes)
}

/// Side-by-side content for one changed file (base vs branch).
#[tauri::command]
pub async fn agent_task_file_diff(
    project_dir: Option<String>,
    branch: String,
    base: String,
    path: String,
) -> Result<AgentTaskFileDiff, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let project = PathBuf::from(project);
    let original = run_git(&project, &["show", &format!("{base}:{path}")])
        .await
        .unwrap_or_default();
    let modified = run_git(&project, &["show", &format!("{branch}:{path}")])
        .await
        .unwrap_or_default();
    Ok(AgentTaskFileDiff {
        path,
        original,
        modified,
    })
}

/// Merge a finished task branch back into its base (no-ff, with a message).
/// Aborts cleanly on conflict and surfaces the conflict text.
#[tauri::command]
pub async fn agent_task_merge(
    project_dir: Option<String>,
    branch: String,
    base: String,
) -> Result<String, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let project = PathBuf::from(project);

    let original = current_branch(&project).await.unwrap_or_default();
    run_git(&project, &["checkout", &base])
        .await
        .map_err(|e| format!("failed to checkout base '{base}': {e}"))?;

    let msg = format!("Merge agent task {branch}");
    let merge = run_git(&project, &["merge", "--no-ff", &branch, "-m", &msg]).await;
    match merge {
        Ok(out) => Ok(out),
        Err(e) => {
            // Best-effort abort so the base checkout stays clean.
            let _ = run_git(&project, &["merge", "--abort"]).await;
            if !original.is_empty() && original != base {
                let _ = run_git(&project, &["checkout", &original]).await;
            }
            Err(format!("merge failed (conflicts?): {e}"))
        }
    }
}

/// Remove a task worktree and delete its branch (discard the work).
#[tauri::command]
pub async fn agent_task_discard(
    project_dir: Option<String>,
    worktree_path: String,
    branch: String,
) -> Result<(), String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let project = PathBuf::from(project);

    let _ = run_git(
        &project,
        &["worktree", "remove", &worktree_path, "--force"],
    )
    .await;
    // Delete the branch (force — it may be unmerged on a discard).
    let _ = run_git(&project, &["branch", "-D", &branch]).await;
    Ok(())
}

/// Open a pull request for the task branch via the GitHub `gh` CLI.
/// Falls back to a copy-the-branch message when `gh` is unavailable.
#[tauri::command]
pub async fn agent_task_open_pr(
    project_dir: Option<String>,
    branch: String,
    base: String,
    title: String,
    body: Option<String>,
) -> Result<PrResult, String> {
    let project = require_project_dir(project_dir.as_deref())?;
    let project = PathBuf::from(project);

    // gh present?
    let gh_ok = Command::new("gh")
        .arg("--version")
        .current_dir(&project)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !gh_ok {
        return Ok(PrResult {
            ok: false,
            url: None,
            message: format!(
                "GitHub CLI (`gh`) not found. Push branch `{branch}` and open a PR manually."
            ),
        });
    }

    // Push the branch first (best effort — origin may not exist).
    let _ = run_git(&project, &["push", "-u", "origin", &branch]).await;

    let body = body.unwrap_or_default();
    let output = Command::new("gh")
        .args([
            "pr", "create", "--base", &base, "--head", &branch, "--title", &title, "--body",
            &body,
        ])
        .current_dir(&project)
        .output()
        .await
        .map_err(|e| format!("failed to run gh: {e}"))?;

    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(PrResult {
            ok: true,
            url: Some(url.clone()),
            message: format!("Pull request created: {url}"),
        })
    } else {
        Ok(PrResult {
            ok: false,
            url: None,
            message: format!(
                "gh pr create failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        })
    }
}
