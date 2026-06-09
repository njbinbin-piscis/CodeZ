//! After-turn memory extraction into the project session database.

use piscis_kernel::llm::{self, LlmMessage};
use piscis_kernel::store::db::MemorySaveExtras;
use std::sync::Arc;
use tokio::sync::Mutex;

pub async fn auto_extract_memories(
    db_arc: Arc<Mutex<piscis_kernel::store::db::Database>>,
    session_id: String,
    messages: Vec<LlmMessage>,
    client: Box<dyn llm::LlmClient>,
    model: String,
    max_tokens: u32,
    owner_id: String,
) {
    let assistant_chars: usize = messages
        .iter()
        .filter(|m| m.role == "assistant")
        .map(|m| m.content.as_text().chars().count())
        .sum();

    if assistant_chars < 100 {
        return;
    }

    let relevant_msgs: Vec<_> = messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .collect();
    let start = relevant_msgs.len().saturating_sub(12);
    let conv_summary: String = relevant_msgs[start..]
        .iter()
        .map(|m| {
            let text = m.content.as_text();
            let truncated: String = text.chars().take(400).collect();
            format!("{}: {}", m.role, truncated)
        })
        .collect::<Vec<_>>()
        .join("\n");

    let extraction_prompt = format!(
        "Based on this conversation, extract 0-3 important facts worth remembering about the user \
         (preferences, goals, personal info, project details). \
         If nothing significant was revealed, output exactly: NONE\n\
         Otherwise output one memory per line, prefixed with the category in brackets like:\n\
         [preference] User prefers dark mode\n\
         [project] Working on a Rust desktop app called AgentZ\n\n\
         Conversation:\n{}\n\nMemories (or NONE):",
        conv_summary
    );

    let req = llm::LlmRequest {
        messages: vec![llm::LlmMessage {
            role: "user".into(),
            content: llm::MessageContent::text(&extraction_prompt),
        }],
        system: Some(
            "You are a memory extraction assistant. Be concise and only extract genuinely useful personal information.".into(),
        ),
        tools: vec![],
        model: model.clone(),
        max_tokens: max_tokens.min(512),
        stream: false,
        vision_override: None,
    };

    match client.complete(req).await {
        Ok(resp) if !resp.content.is_empty() && resp.content.trim() != "NONE" => {
            let db = db_arc.lock().await;
            for line in resp.content.lines() {
                let line = line.trim();
                if line.is_empty() || line == "NONE" {
                    continue;
                }

                let (category, content) = if line.starts_with('[') {
                    if let Some(end) = line.find(']') {
                        let cat = &line[1..end];
                        let cont = line[end + 1..].trim();
                        (cat, cont)
                    } else {
                        ("general", line)
                    }
                } else {
                    ("general", line)
                };

                let valid_categories =
                    ["preference", "fact", "task", "person", "project", "general"];
                let category = if valid_categories.contains(&category) {
                    category
                } else {
                    "general"
                };

                if !content.is_empty() {
                    let kind = match category {
                        "preference" => "preference",
                        "task" => "open_item",
                        _ => "fact",
                    };
                    let extras = MemorySaveExtras {
                        kind: Some(kind.to_string()),
                        evidence_session_id: Some(session_id.clone()),
                        evidence_tool_use_id: None,
                    };
                    let _ = db.save_memory_structured(
                        content,
                        category,
                        0.75,
                        Some(&session_id),
                        &owner_id,
                        "private",
                        &owner_id,
                        None,
                        extras,
                    );
                    tracing::info!("Auto-extracted memory [{category}] for {owner_id}: {content}");
                }
            }
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("Memory auto-extraction failed: {}", e),
    }
}
