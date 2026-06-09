//! Session-scoped memory consolidation after repeated L2 compaction.

use piscis_kernel::llm::{build_client_with_timeout, LlmMessage, LlmRequest, MessageContent};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

fn trim_preview(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        text.to_string()
    } else {
        format!("{}...", text.chars().take(limit).collect::<String>())
    }
}

fn build_session_snapshot(db: &piscis_kernel::store::db::Database, session_id: &str) -> String {
    let session = db.get_session(session_id).ok().flatten();
    let memories = db.list_memories_for_owner("piscis").unwrap_or_default();

    let session_line = match session {
        Some(s) => {
            let summary = if s.rolling_summary.trim().is_empty() {
                "no rolling summary".to_string()
            } else {
                trim_preview(&s.rolling_summary.replace('\n', " "), 320)
            };
            format!(
                "- {} msgs={} status={} summary={}",
                s.title.clone().unwrap_or_else(|| s.id.clone()),
                s.message_count,
                s.status,
                summary
            )
        }
        None => format!("- session {} not found", session_id),
    };

    let mem_lines: String = memories
        .iter()
        .take(8)
        .map(|m| format!("- [{}] {}", m.category, trim_preview(&m.content, 120)))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "## Session\n{}\n\n## Recent memories\n{}\n",
        session_line,
        if mem_lines.is_empty() {
            "- none".to_string()
        } else {
            mem_lines
        }
    )
}

pub async fn for_session(
    app: &AppHandle,
    project_db: Arc<Mutex<piscis_kernel::store::db::Database>>,
    session_id: &str,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("session_id is required".into());
    }

    let (provider, api_key, base_url, model, max_tokens) = {
        let ctx = crate::commands::skill_evolution_ctx::SkillEvolutionCtx::open(app)?;
        let s = ctx.settings.lock().await;
        (
            s.provider.clone(),
            s.active_api_key().to_string(),
            s.custom_base_url.clone(),
            s.model.clone(),
            s.max_tokens,
        )
    };
    if api_key.is_empty() {
        return Err("LLM not configured".into());
    }

    let snapshot = {
        let db = project_db.lock().await;
        build_session_snapshot(&db, session_id)
    };

    let prompt = format!(
        "{snapshot}\n\nYou are consolidating session memories. Output 0-3 durable facts as lines:\n\
         [category] fact text\nOr NONE if nothing to consolidate."
    );

    let client = build_client_with_timeout(
        &provider,
        &api_key,
        if base_url.is_empty() {
            None
        } else {
            Some(base_url.as_str())
        },
        90,
    );
    let req = LlmRequest {
        messages: vec![LlmMessage {
            role: "user".to_string(),
            content: MessageContent::Text(prompt),
        }],
        system: Some("Be concise. Only high-signal durable facts.".into()),
        tools: vec![],
        model,
        max_tokens: max_tokens.min(512),
        stream: false,
        vision_override: None,
    };

    let resp = client.complete(req).await.map_err(|e| e.to_string())?;
    if resp.content.trim() == "NONE" {
        return Ok(());
    }

    let db = project_db.lock().await;
    for line in resp.content.lines() {
        let line = line.trim();
        if line.is_empty() || line == "NONE" {
            continue;
        }
        let (category, content) = if line.starts_with('[') {
            if let Some(end) = line.find(']') {
                (&line[1..end], line[end + 1..].trim())
            } else {
                ("general", line)
            }
        } else {
            ("general", line)
        };
        if content.is_empty() {
            continue;
        }
        let _ = db.save_memory_structured(
            content,
            category,
            0.8,
            Some(session_id),
            "piscis",
            "private",
            "piscis",
            None,
            piscis_kernel::store::db::MemorySaveExtras {
                kind: Some("fact".to_string()),
                evidence_session_id: Some(session_id.to_string()),
                evidence_tool_use_id: None,
            },
        );
    }
    Ok(())
}
