//! Shared post-turn hooks: memory extract + background skill review.

use piscis_kernel::llm::{self, LlmMessage};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

pub async fn run_post_turn_hooks(
    app: &AppHandle,
    project_db: Arc<Mutex<piscis_kernel::store::db::Database>>,
    session_id: String,
    messages: Vec<LlmMessage>,
    provider: String,
    api_key: String,
    base_url: Option<String>,
    model: String,
    max_tokens: u32,
) {
    if messages.is_empty() {
        return;
    }
    let Ok(global_ctx) = crate::commands::skill_evolution_ctx::SkillEvolutionCtx::open(app) else {
        return;
    };
    let mem_client = llm::build_client_with_timeout(&provider, &api_key, base_url.as_deref(), 90);
    crate::commands::memory_extract::auto_extract_memories(
        project_db.clone(),
        session_id.clone(),
        messages.clone(),
        mem_client,
        model.clone(),
        max_tokens,
        "piscis".to_string(),
    )
    .await;
    crate::commands::skill_review::run_background_skill_review(
        global_ctx,
        project_db,
        session_id,
        messages,
        provider,
        api_key,
        base_url,
        model,
        max_tokens,
        "piscis".to_string(),
    )
    .await;
}

/// Load recent session rows as simple user/assistant text messages for review.
pub fn messages_from_db_rows(rows: &[piscis_kernel::store::db::ChatMessage]) -> Vec<LlmMessage> {
    rows.iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| LlmMessage {
            role: m.role.clone(),
            content: llm::MessageContent::text(&m.content),
        })
        .collect()
}
