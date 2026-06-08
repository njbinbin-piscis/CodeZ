//! Session namespace tags — CodeZ and WorkZ chat histories are stored in the
//! same project DB but listed and continued separately.

/// IDE sidebar pair-programming chat.
pub const SOURCE_CODEZ: &str = "codez";
/// WorkZ autonomous single-agent tasks.
pub const SOURCE_WORKZ: &str = "workz";
/// WorkZ swarm coordinator sessions (pool tools + org_spec).
pub const SOURCE_WORKZ_TEAM: &str = "workz-team";
/// Koi sub-agent turns spawned inside a pool (not user-facing WorkZ tasks).
pub const SOURCE_POOL: &str = "pool";
/// Pre-isolation sessions (treated as CodeZ for listing).
pub const SOURCE_LEGACY: &str = "agentz";

const GENERIC_WORKZ_TITLES: &[&str] = &["WorkZ task", "WorkZ team task"];
const GENERIC_CODEZ_TITLES: &[&str] = &["CodeZ chat", "New Chat", "Untitled"];

pub fn normalize_source(source: &str) -> &str {
    if source == SOURCE_LEGACY {
        SOURCE_CODEZ
    } else {
        source
    }
}

pub fn sources_compatible(expected: &str, existing: &str) -> bool {
    normalize_source(expected) == normalize_source(existing)
}

/// Returns true when `session_source` should appear in a list filtered by `allowed`.
pub fn source_matches_filter(session_source: &str, allowed: &[String]) -> bool {
    if allowed.is_empty() {
        return true;
    }
    let norm = normalize_source(session_source);
    for a in allowed {
        if normalize_source(a) == norm {
            return true;
        }
        if normalize_source(a) == SOURCE_CODEZ && session_source == SOURCE_LEGACY {
            return true;
        }
    }
    false
}

pub fn default_channel_for(mode: &str) -> &'static str {
    match mode {
        SOURCE_WORKZ_TEAM => SOURCE_WORKZ_TEAM,
        SOURCE_WORKZ => SOURCE_WORKZ,
        _ => SOURCE_CODEZ,
    }
}

/// True when `source` is a WorkZ user task namespace (not Koi pool turns).
pub fn is_workz_task_source(source: &str) -> bool {
    matches!(
        normalize_source(source),
        SOURCE_WORKZ | SOURCE_WORKZ_TEAM
    )
}

/// Pool Koi sessions and IM channels must never appear in the WorkZ task sidebar.
pub fn excluded_from_workz_task_list(source: &str) -> bool {
    source == SOURCE_POOL || source.starts_with("im_")
}

pub fn is_generic_workz_title(title: Option<&str>) -> bool {
    match title.map(str::trim).filter(|s| !s.is_empty()) {
        None => true,
        Some(t) => GENERIC_WORKZ_TITLES.contains(&t),
    }
}

pub fn is_codez_source(source: &str) -> bool {
    normalize_source(source) == SOURCE_CODEZ
}

pub fn is_generic_codez_title(title: Option<&str>) -> bool {
    match title.map(str::trim).filter(|s| !s.is_empty()) {
        None => true,
        Some(t) => GENERIC_CODEZ_TITLES.contains(&t),
    }
}

/// First line of the user prompt for sidebar titles (CodeZ / generic chat).
pub fn prompt_text_for_title(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed.lines().next().unwrap_or(trimmed).trim().to_string()
}

const COORDINATOR_TITLE_PREFIX: &str = "You are the coordinator of team pool";
const SWARM_TASK_MARKER: &str = "\n\nTask:\n";

/// True when the stored title is the coordinator system preamble, not the user's goal.
pub fn is_coordinator_boilerplate_title(title: Option<&str>) -> bool {
    title
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some_and(|t| t.starts_with(COORDINATOR_TITLE_PREFIX))
}

/// Extract the user-visible task goal from a WorkZ user turn (raw text or
/// coordinator-wrapped first-turn prompt).
pub fn workz_goal_text_for_title(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(idx) = trimmed.rfind(SWARM_TASK_MARKER) {
        let goal = trimmed[idx + SWARM_TASK_MARKER.len()..].trim();
        if !goal.is_empty() {
            return goal.lines().next().unwrap_or(goal).trim().to_string();
        }
    }
    if trimmed.starts_with(COORDINATOR_TITLE_PREFIX) {
        return String::new();
    }
    trimmed.lines().next().unwrap_or(trimmed).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_sessions_never_match_workz_filters() {
        let filter = vec![SOURCE_WORKZ.to_string(), SOURCE_WORKZ_TEAM.to_string()];
        assert!(!source_matches_filter(SOURCE_POOL, &filter));
        assert!(excluded_from_workz_task_list(SOURCE_POOL));
    }

    #[test]
    fn legacy_agentz_counts_as_codez() {
        let filter = vec![SOURCE_CODEZ.to_string()];
        assert!(source_matches_filter(SOURCE_LEGACY, &filter));
    }

    #[test]
    fn workz_goal_extracts_after_swarm_task_marker() {
        let raw = "You are the coordinator of team pool \"squad\" (pool_id: abc).\n\nTask:\n写一个猜数字游戏";
        assert_eq!(
            workz_goal_text_for_title(raw),
            "写一个猜数字游戏"
        );
    }

    #[test]
    fn workz_goal_ignores_bare_coordinator_preamble() {
        assert!(workz_goal_text_for_title("You are the coordinator of team pool \"x\".").is_empty());
    }

    #[test]
    fn codez_generic_titles() {
        assert!(is_generic_codez_title(None));
        assert!(is_generic_codez_title(Some("CodeZ chat")));
        assert!(!is_generic_codez_title(Some("查看 AgentZ 源码")));
    }
}
