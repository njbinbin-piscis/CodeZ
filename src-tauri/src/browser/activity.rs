//! Tracks browser tool usage and in-flight agent turns for close-guard UX.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

const RECENT_BROWSER_WINDOW: Duration = Duration::from_secs(30);

#[derive(Clone, Default)]
pub struct BrowserActivity {
    chat_turn_active: Arc<AtomicBool>,
    last_browser_tool_at: Arc<Mutex<Option<Instant>>>,
}

impl BrowserActivity {
    pub fn set_chat_turn_active(&self, active: bool) {
        self.chat_turn_active.store(active, Ordering::SeqCst);
    }

    pub async fn mark_browser_tool(&self) {
        *self.last_browser_tool_at.lock().await = Some(Instant::now());
    }

    pub async fn close_guard(&self) -> BrowserCloseGuard {
        let agent_active = self.chat_turn_active.load(Ordering::SeqCst);
        let recent_browser = self
            .last_browser_tool_at
            .lock()
            .await
            .map(|t| t.elapsed() < RECENT_BROWSER_WINDOW)
            .unwrap_or(false);

        if agent_active {
            return BrowserCloseGuard {
                can_close: false,
                agent_active: true,
                reason: Some(
                    "An agent turn is in progress and may be using the browser.".into(),
                ),
            };
        }
        if recent_browser {
            return BrowserCloseGuard {
                can_close: false,
                agent_active: false,
                reason: Some(
                    "The browser was used by the agent recently. Closing will end the session."
                        .into(),
                ),
            };
        }
        BrowserCloseGuard {
            can_close: true,
            agent_active: false,
            reason: None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserCloseGuard {
    pub can_close: bool,
    pub agent_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
