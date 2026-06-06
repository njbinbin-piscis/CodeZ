//! Host-side context assembly for AgentZ chat turns.
//!
//! Previously AgentZ handed the kernel the latest ~500 DB rows as plain text and
//! relied solely on the kernel's in-loop compaction. This module mirrors
//! openpiscis's host pre-assembly so the *first* request of a (resumed) session
//! is already controlled:
//!
//! 1. Reconstruct each DB row into a real [`LlmMessage`] — honouring
//!    `tool_calls_json` (assistant tool_use) and `tool_results_json`
//!    (tool-result carriers) — so the kernel's Level-1 demotion has structured
//!    blocks to work with, and user-turn boundaries stay detectable.
//! 2. Prepend the persisted rolling summary and the p6 state frame.
//! 3. Window by turn age (full → trimmed) and budget-trim from newest.
//!
//! It is built only on kernel *primitives* (token estimators, message builders,
//! window constants). Compaction *policy* therefore lives here in the host —
//! the direction we want long-term, where hosts assemble their own strategy.

use piscis_kernel::agent::compaction::{
    CTX_COMPACT_AFTER, CTX_FULL_TURNS, CTX_TRIM_HEAD, CTX_TRIM_TAIL,
};
use piscis_kernel::agent::message_utils::rolling_summary_message;
use piscis_kernel::agent::state_frame::{state_frame_message, StateFrame};
use piscis_kernel::llm::{estimate_message_tokens, ContentBlock, LlmMessage, MessageContent};
use piscis_kernel::store::db::ChatMessage;

/// A conversation turn: one real user message and its following agent messages.
struct Turn {
    user: ChatMessage,
    agents: Vec<ChatMessage>,
}

/// A real user turn starts at a `user` row that is *not* a tool-result carrier.
fn is_real_user(m: &ChatMessage) -> bool {
    m.role == "user" && m.tool_results_json.is_none()
}

/// Reconstruct a DB row into the same `LlmMessage` shape the agent loop keeps
/// in memory. Mirrors the kernel's internal reconstruction so the request view
/// is consistent across host assembly and in-loop compaction.
fn reconstruct(msg: &ChatMessage) -> LlmMessage {
    if let Some(json) = msg.tool_results_json.as_deref() {
        let blocks = serde_json::from_str::<Vec<ContentBlock>>(json).unwrap_or_default();
        return LlmMessage {
            role: msg.role.clone(),
            content: MessageContent::Blocks(blocks),
        };
    }
    if let Some(json) = msg.tool_calls_json.as_deref() {
        let mut blocks: Vec<ContentBlock> = Vec::new();
        if !msg.content.is_empty() {
            blocks.push(ContentBlock::Text {
                text: msg.content.clone(),
            });
        }
        if let Ok(calls) = serde_json::from_str::<Vec<ContentBlock>>(json) {
            blocks.extend(calls);
        }
        let content = if blocks.is_empty() {
            MessageContent::text(&msg.content)
        } else {
            MessageContent::Blocks(blocks)
        };
        return LlmMessage {
            role: msg.role.clone(),
            content,
        };
    }
    LlmMessage {
        role: msg.role.clone(),
        content: MessageContent::text(&msg.content),
    }
}

/// Head+tail trim the content of any `ToolResult` blocks in a message — the
/// host-side Level-1 demotion for middle-aged turns.
fn demote_tool_results(msg: &mut LlmMessage) {
    if let MessageContent::Blocks(blocks) = &mut msg.content {
        for block in blocks.iter_mut() {
            if let ContentBlock::ToolResult { content, .. } = block {
                if content.chars().count() > CTX_TRIM_HEAD + CTX_TRIM_TAIL + 32 {
                    let head: String = content.chars().take(CTX_TRIM_HEAD).collect();
                    let tail: String = {
                        let all: Vec<char> = content.chars().collect();
                        all[all.len() - CTX_TRIM_TAIL..].iter().collect()
                    };
                    *content = format!("{head}\n…[trimmed]…\n{tail}");
                }
            }
        }
    }
}

fn split_turns(history: &[ChatMessage]) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    let mut current: Option<Turn> = None;
    for msg in history {
        if is_real_user(msg) {
            if let Some(turn) = current.take() {
                turns.push(turn);
            }
            current = Some(Turn {
                user: msg.clone(),
                agents: Vec::new(),
            });
        } else if let Some(turn) = current.as_mut() {
            turn.agents.push(msg.clone());
        }
        // Rows before the first real user message (rare) are dropped.
    }
    if let Some(turn) = current {
        turns.push(turn);
    }
    turns
}

/// Assemble the LLM context window from DB history + persisted summary/frame.
pub fn build_context_messages(
    history: &[ChatMessage],
    budget: usize,
    rolling_summary: Option<&str>,
    state_frame: Option<&StateFrame>,
) -> Vec<LlmMessage> {
    let summary = rolling_summary.map(str::trim).filter(|s| !s.is_empty());

    let turns = split_turns(history);
    let total = turns.len();
    // Once a summary exists, older turns are represented by it — only keep the
    // most recent `CTX_COMPACT_AFTER` turns verbatim.
    let slice: &[Turn] = if summary.is_some() && total > CTX_COMPACT_AFTER {
        &turns[total - CTX_COMPACT_AFTER..]
    } else {
        &turns[..]
    };

    // Reserve the summary's token cost up front so the budget accounts for it.
    let mut token_est = summary
        .map(|s| estimate_message_tokens(&rolling_summary_message(s)))
        .unwrap_or(0);

    // Build turn groups newest → oldest, then reverse to chronological order.
    let mut groups: Vec<Vec<LlmMessage>> = Vec::new();
    for (age, turn) in slice.iter().rev().enumerate() {
        if token_est >= budget {
            break;
        }
        let mut msgs: Vec<LlmMessage> = vec![LlmMessage {
            role: "user".into(),
            content: MessageContent::text(&turn.user.content),
        }];
        for agent in &turn.agents {
            let mut m = reconstruct(agent);
            if age >= CTX_FULL_TURNS {
                // Middle-aged turn: demote bulky tool results.
                demote_tool_results(&mut m);
            }
            msgs.push(m);
        }
        let group_tokens: usize = msgs.iter().map(estimate_message_tokens).sum();
        // Always keep at least the newest turn even if it alone exceeds budget.
        if token_est + group_tokens > budget && !groups.is_empty() {
            break;
        }
        token_est += group_tokens;
        groups.push(msgs);
    }
    groups.reverse();

    let mut out: Vec<LlmMessage> = Vec::new();
    if let Some(s) = summary {
        out.push(rolling_summary_message(s));
    }
    if let Some(frame) = state_frame {
        // Right after the summary (if any), else at the very top.
        let at = if summary.is_some() {
            1.min(out.len())
        } else {
            0
        };
        out.insert(at, state_frame_message(frame));
    }
    for group in groups {
        out.extend(group);
    }
    out
}
