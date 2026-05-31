import "./Agent.css";

interface AgentWorkspaceProps {
  projectDir: string | null;
}

/**
 * Agent mode (≈ Codex) — task-centric workspace placeholder.
 *
 * The full implementation (M4) submits a task, runs the agent autonomously in
 * an isolated git worktree via the pisci-engine kernel, then surfaces the diff
 * for review on a task board. This stub establishes the mode's top-level slot;
 * see `openpisci/docs/codez-design.md` §5.
 */
export default function AgentWorkspace({ projectDir }: AgentWorkspaceProps) {
  return (
    <div className="codez-agent">
      <div className="codez-agent-empty">
        <div className="codez-agent-title">Agent mode</div>
        <p className="codez-agent-sub">
          Task-centric autonomous coding (≈ Codex). Submit a task and the agent
          plans → edits → tests in an isolated git worktree, then you review the
          diff.
        </p>
        <p className="codez-agent-status">
          {projectDir
            ? `Ready on: ${projectDir}`
            : "Open a project folder to start submitting tasks."}
        </p>
        <p className="codez-agent-note">Coming in milestone M4.</p>
      </div>
    </div>
  );
}
