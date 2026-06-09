//! IM gateway commands (Phase 0A "assistants").
//!
//! Ports openpiscis' `commands/chat/gateway.rs` to the AgentZ host. AgentZ keeps
//! no shared in-memory `Settings`, so IM credentials are read from / written to
//! the global `config.json` on demand. The `GatewayManager` lives in
//! [`AppState`]; the inbound consumer loop ([`spawn_inbound_consumer`]) drives a
//! headless agent turn per inbound message and sends the reply back.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;
use tracing::{info, warn};

use piscis_core::host::{EventSink, HeadlessCliMode, HeadlessCliRequest};
use piscis_kernel::agent::tool::ToolRegistry;
use piscis_kernel::headless::{run_piscis_turn, HeadlessDeps};
use piscis_kernel::store::db::{Database, ImSessionBinding, ImSessionBindingUpsert};
use piscis_kernel::store::settings::Settings;
use piscis_kernel::tools::{register_mcp_tools, register_neutral_into, NeutralToolsConfig};

use crate::commands::data_scope::resolve_global_config_dir;
use crate::gateway::{
    dingtalk::{DingtalkChannel, DingtalkConfig},
    discord::{DiscordChannel, DiscordConfig},
    feishu::{FeishuChannel, FeishuConfig},
    matrix::{MatrixChannel, MatrixConfig},
    slack::{SlackChannel, SlackConfig},
    teams::{TeamsChannel, TeamsConfig},
    telegram::{TelegramChannel, TelegramConfig},
    webhook::{WebhookChannel, WebhookConfig},
    wechat::{WechatChannel, WechatConfig},
    wecom::{WecomChannel, WecomConfig},
    ChannelInfo, InboundMessage, OutboundMessage,
};
use crate::state::AppState;

/// Tauri event emitted when an IM-backed session receives a message / reply.
pub const IM_SESSION_UPDATED_EVENT: &str = "agentz:im-session-updated";
pub const GATEWAY_CHANNELS_UPDATED_EVENT: &str = "agentz:gateway-channels-updated";

// ─── Settings helpers ──────────────────────────────────────────────────────

fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    resolve_global_config_dir(app)
}

fn load_settings(app: &AppHandle) -> Result<Settings, String> {
    let path = config_dir(app)?.join("config.json");
    Settings::load(&path).map_err(|e| e.to_string())
}

// ─── IM settings DTO ───────────────────────────────────────────────────────

/// IM credentials / toggles surfaced to the assistants settings UI. Mirrors the
/// IM-related subset of the kernel `Settings`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImSettingsDto {
    pub feishu_app_id: String,
    pub feishu_app_secret: String,
    pub feishu_domain: String,
    pub feishu_enabled: bool,

    pub wecom_bot_id: String,
    pub wecom_bot_secret: String,
    pub wecom_enabled: bool,

    pub dingtalk_app_key: String,
    pub dingtalk_app_secret: String,
    pub dingtalk_robot_code: String,
    pub dingtalk_enabled: bool,

    pub telegram_bot_token: String,
    pub telegram_enabled: bool,

    pub slack_webhook_url: String,
    pub slack_enabled: bool,
    pub discord_webhook_url: String,
    pub discord_enabled: bool,
    pub teams_webhook_url: String,
    pub teams_enabled: bool,

    pub matrix_homeserver: String,
    pub matrix_access_token: String,
    pub matrix_room_id: String,
    pub matrix_enabled: bool,

    pub webhook_outbound_url: String,
    pub webhook_auth_token: String,
    pub webhook_enabled: bool,

    pub wechat_enabled: bool,
    pub wechat_gateway_port: u16,
    pub wechat_bot_id: String,

    pub im_message_mode: String,
}

fn im_to_dto(s: &Settings) -> ImSettingsDto {
    // Secret fields are masked so we never round-trip plaintext to the UI.
    let mask = |v: &str| -> String {
        if v.is_empty() {
            String::new()
        } else {
            "••••••••".into()
        }
    };
    ImSettingsDto {
        feishu_app_id: s.feishu_app_id.clone(),
        feishu_app_secret: mask(&s.feishu_app_secret),
        feishu_domain: s.feishu_domain.clone(),
        feishu_enabled: s.feishu_enabled,
        wecom_bot_id: s.wecom_bot_id.clone(),
        wecom_bot_secret: mask(&s.wecom_bot_secret),
        wecom_enabled: s.wecom_enabled,
        dingtalk_app_key: s.dingtalk_app_key.clone(),
        dingtalk_app_secret: mask(&s.dingtalk_app_secret),
        dingtalk_robot_code: s.dingtalk_robot_code.clone(),
        dingtalk_enabled: s.dingtalk_enabled,
        telegram_bot_token: mask(&s.telegram_bot_token),
        telegram_enabled: s.telegram_enabled,
        slack_webhook_url: s.slack_webhook_url.clone(),
        slack_enabled: s.slack_enabled,
        discord_webhook_url: s.discord_webhook_url.clone(),
        discord_enabled: s.discord_enabled,
        teams_webhook_url: s.teams_webhook_url.clone(),
        teams_enabled: s.teams_enabled,
        matrix_homeserver: s.matrix_homeserver.clone(),
        matrix_access_token: mask(&s.matrix_access_token),
        matrix_room_id: s.matrix_room_id.clone(),
        matrix_enabled: s.matrix_enabled,
        webhook_outbound_url: s.webhook_outbound_url.clone(),
        webhook_auth_token: mask(&s.webhook_auth_token),
        webhook_enabled: s.webhook_enabled,
        wechat_enabled: s.wechat_enabled,
        wechat_gateway_port: s.wechat_gateway_port,
        wechat_bot_id: s.wechat_bot_id.clone(),
        im_message_mode: s.im_message_mode.clone(),
    }
}

#[tauri::command]
pub async fn get_im_settings(app: AppHandle) -> Result<ImSettingsDto, String> {
    Ok(im_to_dto(&load_settings(&app)?))
}

/// Persist IM settings. Empty secret fields (and the masked placeholder) are
/// treated as "unchanged" so we never clobber stored credentials.
#[tauri::command]
pub async fn save_im_settings(
    app: AppHandle,
    updates: ImSettingsDto,
) -> Result<ImSettingsDto, String> {
    const MASK: &str = "••••••••";
    let keep_secret = |new: &str, old: &str| -> String {
        if new.is_empty() || new == MASK {
            old.to_string()
        } else {
            new.to_string()
        }
    };

    let mut s = load_settings(&app)?;

    s.feishu_app_id = updates.feishu_app_id;
    s.feishu_app_secret = keep_secret(&updates.feishu_app_secret, &s.feishu_app_secret);
    s.feishu_domain = if updates.feishu_domain.is_empty() {
        "feishu".into()
    } else {
        updates.feishu_domain
    };
    s.feishu_enabled = updates.feishu_enabled;

    s.wecom_bot_id = updates.wecom_bot_id;
    s.wecom_bot_secret = keep_secret(&updates.wecom_bot_secret, &s.wecom_bot_secret);
    s.wecom_enabled = updates.wecom_enabled;

    s.dingtalk_app_key = updates.dingtalk_app_key;
    s.dingtalk_app_secret = keep_secret(&updates.dingtalk_app_secret, &s.dingtalk_app_secret);
    s.dingtalk_robot_code = updates.dingtalk_robot_code;
    s.dingtalk_enabled = updates.dingtalk_enabled;

    s.telegram_bot_token = keep_secret(&updates.telegram_bot_token, &s.telegram_bot_token);
    s.telegram_enabled = updates.telegram_enabled;

    s.slack_webhook_url = updates.slack_webhook_url;
    s.slack_enabled = updates.slack_enabled;
    s.discord_webhook_url = updates.discord_webhook_url;
    s.discord_enabled = updates.discord_enabled;
    s.teams_webhook_url = updates.teams_webhook_url;
    s.teams_enabled = updates.teams_enabled;

    s.matrix_homeserver = updates.matrix_homeserver;
    s.matrix_access_token = keep_secret(&updates.matrix_access_token, &s.matrix_access_token);
    s.matrix_room_id = updates.matrix_room_id;
    s.matrix_enabled = updates.matrix_enabled;

    s.webhook_outbound_url = updates.webhook_outbound_url;
    s.webhook_auth_token = keep_secret(&updates.webhook_auth_token, &s.webhook_auth_token);
    s.webhook_enabled = updates.webhook_enabled;

    s.wechat_enabled = updates.wechat_enabled;
    if updates.wechat_gateway_port != 0 {
        s.wechat_gateway_port = updates.wechat_gateway_port;
    }

    if updates.im_message_mode == "queue" || updates.im_message_mode == "cancel" {
        s.im_message_mode = updates.im_message_mode;
    }

    s.save().map_err(|e| e.to_string())?;
    Ok(im_to_dto(&s))
}

// ─── Channel lifecycle commands ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GatewayStatus {
    pub channels: Vec<ChannelInfo>,
}

#[tauri::command]
pub async fn list_gateway_channels(state: State<'_, AppState>) -> Result<GatewayStatus, String> {
    Ok(GatewayStatus {
        channels: state.gateway.list_channels().await,
    })
}

/// Register + start every enabled channel from the saved IM settings. Stops any
/// previously registered channels first to avoid duplicate listeners.
#[tauri::command]
pub async fn connect_gateway_channels(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<GatewayStatus, String> {
    let _ = state.gateway.stop_all().await;

    let s = load_settings(&app)?;

    if s.feishu_enabled && !s.feishu_app_id.is_empty() {
        let ch = Box::new(FeishuChannel::new(FeishuConfig {
            app_id: s.feishu_app_id.clone(),
            app_secret: s.feishu_app_secret.clone(),
            domain: s.feishu_domain.clone(),
        }));
        state.gateway.register_channel(ch).await;
    }

    if s.dingtalk_enabled && !s.dingtalk_app_key.is_empty() {
        let ch = Box::new(DingtalkChannel::new(DingtalkConfig {
            app_key: s.dingtalk_app_key.clone(),
            app_secret: s.dingtalk_app_secret.clone(),
            robot_code: if s.dingtalk_robot_code.is_empty() {
                None
            } else {
                Some(s.dingtalk_robot_code.clone())
            },
        }));
        state.gateway.register_channel(ch).await;
    }

    if s.telegram_enabled && !s.telegram_bot_token.is_empty() {
        let ch = Box::new(TelegramChannel::new(TelegramConfig {
            bot_token: s.telegram_bot_token.clone(),
        }));
        state.gateway.register_channel(ch).await;
    }

    if s.slack_enabled && !s.slack_webhook_url.is_empty() {
        let ch = Box::new(SlackChannel::new(SlackConfig {
            webhook_url: s.slack_webhook_url.clone(),
        }));
        state.gateway.register_channel(ch).await;
    }

    if s.discord_enabled && !s.discord_webhook_url.is_empty() {
        let ch = Box::new(DiscordChannel::new(DiscordConfig {
            webhook_url: s.discord_webhook_url.clone(),
        }));
        state.gateway.register_channel(ch).await;
    }

    if s.teams_enabled && !s.teams_webhook_url.is_empty() {
        let ch = Box::new(TeamsChannel::new(TeamsConfig {
            webhook_url: s.teams_webhook_url.clone(),
        }));
        state.gateway.register_channel(ch).await;
    }

    if s.matrix_enabled
        && !s.matrix_homeserver.is_empty()
        && !s.matrix_access_token.is_empty()
        && !s.matrix_room_id.is_empty()
    {
        let ch = Box::new(MatrixChannel::new(MatrixConfig {
            homeserver: s.matrix_homeserver.clone(),
            access_token: s.matrix_access_token.clone(),
            room_id: s.matrix_room_id.clone(),
        }));
        state.gateway.register_channel(ch).await;
    }

    if s.webhook_enabled && !s.webhook_outbound_url.is_empty() {
        let ch = Box::new(WebhookChannel::new(WebhookConfig {
            outbound_url: s.webhook_outbound_url.clone(),
            bearer_token: if s.webhook_auth_token.is_empty() {
                None
            } else {
                Some(s.webhook_auth_token.clone())
            },
        }));
        state.gateway.register_channel(ch).await;
    }

    if s.wechat_enabled {
        let ch = Box::new(WechatChannel::new(WechatConfig {
            gateway_token: s.wechat_gateway_token.clone(),
            port: s.wechat_gateway_port,
            bot_token: s.wechat_bot_token.clone(),
            base_url: s.wechat_base_url.clone(),
        }));
        state.gateway.register_channel(ch).await;
    }

    if s.wecom_enabled && !s.wecom_bot_id.is_empty() && !s.wecom_bot_secret.is_empty() {
        let ch = Box::new(WecomChannel::new(WecomConfig {
            bot_id: s.wecom_bot_id.clone(),
            bot_secret: s.wecom_bot_secret.clone(),
        }));
        state.gateway.register_channel(ch).await;
    }

    state.gateway.start_all().await.map_err(|e| e.to_string())?;

    let channels = state.gateway.list_channels().await;
    let _ = app.emit(
        GATEWAY_CHANNELS_UPDATED_EVENT,
        GatewayStatus {
            channels: channels.clone(),
        },
    );
    Ok(GatewayStatus { channels })
}

#[tauri::command]
pub async fn disconnect_gateway_channels(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.gateway.stop_all().await.map_err(|e| e.to_string())?;
    let _ = app.emit(
        GATEWAY_CHANNELS_UPDATED_EVENT,
        GatewayStatus {
            channels: Vec::new(),
        },
    );
    Ok(())
}

// ─── WeChat QR login ─────────────────────────────────────────────────────────

const ILINK_DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const ILINK_BOT_TYPE: &str = "3";

#[derive(Debug, Serialize, Deserialize)]
pub struct WechatLoginStatus {
    pub qr_data_url: Option<String>,
    pub qrcode_token: Option<String>,
    pub message: String,
    pub connected: bool,
    pub bot_id: Option<String>,
}

#[tauri::command]
pub async fn start_wechat_login() -> Result<WechatLoginStatus, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/ilink/bot/get_bot_qrcode?bot_type={}",
        ILINK_DEFAULT_BASE_URL, ILINK_BOT_TYPE
    );

    let resp = client
        .get(&url)
        .header("iLink-App-ClientVersion", "1")
        .send()
        .await
        .map_err(|e| format!("Network error fetching QR code: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "iLink API returned HTTP {}: {}",
            resp.status(),
            resp.text().await.unwrap_or_default()
        ));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse QR code response: {}", e))?;

    let qrcode_token = body["qrcode"]
        .as_str()
        .ok_or("iLink API response missing 'qrcode' field")?
        .to_string();
    let qrcode_url = body["qrcode_img_content"]
        .as_str()
        .unwrap_or(&qrcode_token)
        .to_string();

    let qr_data_url = generate_qr_data_url(&qrcode_url)?;

    Ok(WechatLoginStatus {
        qr_data_url: Some(qr_data_url),
        qrcode_token: Some(qrcode_token),
        message: "scan_qr".to_string(),
        connected: false,
        bot_id: None,
    })
}

#[tauri::command]
pub async fn poll_wechat_login(
    app: AppHandle,
    qrcode_token: String,
) -> Result<WechatLoginStatus, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "{}/ilink/bot/get_qrcode_status?qrcode={}",
        ILINK_DEFAULT_BASE_URL,
        urlencoding::encode(&qrcode_token)
    );

    let resp = client
        .get(&url)
        .header("iLink-App-ClientVersion", "1")
        .timeout(std::time::Duration::from_secs(38))
        .send()
        .await
        .map_err(|e| format!("Network error polling QR status: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("iLink status API returned HTTP {}", resp.status()));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse status response: {}", e))?;

    let status = body["status"].as_str().unwrap_or("wait");

    match status {
        "confirmed" => {
            let bot_token = body["bot_token"].as_str().unwrap_or("").to_string();
            let bot_id = body["ilink_bot_id"].as_str().unwrap_or("").to_string();
            let base_url = body["baseurl"]
                .as_str()
                .unwrap_or(ILINK_DEFAULT_BASE_URL)
                .to_string();

            let mut s = load_settings(&app)?;
            s.wechat_bot_token = bot_token;
            s.wechat_base_url = base_url;
            s.wechat_bot_id = bot_id.clone();
            s.wechat_enabled = true;
            if let Err(e) = s.save() {
                warn!("Failed to save WeChat credentials: {}", e);
            }

            Ok(WechatLoginStatus {
                qr_data_url: None,
                qrcode_token: None,
                message: "connected".to_string(),
                connected: true,
                bot_id: Some(bot_id),
            })
        }
        "expired" => Ok(status_only("expired")),
        "scaned" => Ok(status_only("scaned")),
        _ => Ok(status_only("wait")),
    }
}

fn status_only(message: &str) -> WechatLoginStatus {
    WechatLoginStatus {
        qr_data_url: None,
        qrcode_token: None,
        message: message.to_string(),
        connected: false,
        bot_id: None,
    }
}

fn generate_qr_data_url(content: &str) -> Result<String, String> {
    use qrcode::render::svg;
    use qrcode::QrCode;

    let code = QrCode::new(content.as_bytes())
        .map_err(|e| format!("Failed to generate QR code: {}", e))?;
    let svg_str = code.render::<svg::Color>().min_dimensions(200, 200).build();

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(svg_str.as_bytes());
    Ok(format!("data:image/svg+xml;base64,{}", b64))
}

// ─── Inbound consumer loop ───────────────────────────────────────────────────

/// Bridges the kernel `EventSink` to AgentZ Tauri chat events (so IM-driven
/// turns stream into the same channel the chat UI listens on).
struct GatewayEventSink {
    app: AppHandle,
}

impl EventSink for GatewayEventSink {
    fn emit_session(&self, session_id: &str, event: &str, payload: Value) {
        let _ = self.app.emit(
            crate::commands::chat::CHAT_EVENT,
            json!({ "sessionId": session_id, "channel": event, "payload": payload }),
        );
    }
    fn emit_broadcast(&self, event: &str, payload: Value) {
        let _ = self.app.emit(
            crate::commands::chat::CHAT_EVENT,
            json!({ "sessionId": Value::Null, "channel": event, "payload": payload }),
        );
    }
}

fn build_im_session_title(msg: &InboundMessage) -> String {
    let label = if msg.is_group {
        msg.group_name
            .as_deref()
            .filter(|v| !v.trim().is_empty())
            .or(msg.sender_name.as_deref())
            .unwrap_or(&msg.sender)
    } else {
        msg.sender_name.as_deref().unwrap_or(&msg.sender)
    };
    format!("{} · {}", msg.channel, label)
}

async fn resolve_or_create_im_binding(
    db: &Arc<Mutex<Database>>,
    msg: &InboundMessage,
) -> Result<ImSessionBinding, String> {
    let source = format!("im_{}", msg.channel);
    let title = build_im_session_title(msg);
    let binding_key = msg.binding_key();
    let external_conversation_key = msg.effective_conversation_key();
    let routing_state_json = msg
        .routing_state
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| e.to_string())?;

    let db_lock = db.lock().await;
    let session_id = if let Some(existing) = db_lock
        .get_im_session_binding(&binding_key)
        .map_err(|e| e.to_string())?
    {
        existing.session_id
    } else {
        format!("im_{}_{}", msg.channel, uuid::Uuid::new_v4())
    };

    let _ = db_lock
        .ensure_im_session(&session_id, &title, &source)
        .map_err(|e| e.to_string())?;
    let _ = db_lock.rename_session(&session_id, &title);

    db_lock
        .upsert_im_session_binding(&ImSessionBindingUpsert {
            binding_key,
            channel: msg.channel.clone(),
            external_conversation_key,
            session_id,
            peer_id: msg.sender.clone(),
            peer_name: msg.sender_name.clone(),
            is_group: msg.is_group,
            group_name: msg.group_name.clone(),
            latest_reply_target: msg.reply_target.clone(),
            routing_state_json,
        })
        .map_err(|e| e.to_string())
}

async fn resolve_im_outbound_route(
    db: &Arc<Mutex<Database>>,
    session_id: &str,
    channel: &str,
    fallback_recipient: &str,
    fallback_routing_state: Option<Value>,
) -> (String, Option<Value>) {
    let db_lock = db.lock().await;
    match db_lock.get_im_session_binding_by_session(session_id, channel) {
        Ok(Some(binding)) => {
            let recipient = if binding.latest_reply_target.trim().is_empty() {
                fallback_recipient.to_string()
            } else {
                binding.latest_reply_target
            };
            let routing_state = binding
                .routing_state_json
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok())
                .or(fallback_routing_state);
            (recipient, routing_state)
        }
        _ => (fallback_recipient.to_string(), fallback_routing_state),
    }
}

/// Per-session locks so multiple messages in the same conversation are
/// processed serially while different conversations run concurrently.
type SessionLocks = Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>;

async fn handle_inbound(
    app: AppHandle,
    db: Arc<Mutex<Database>>,
    sink: Arc<dyn EventSink>,
    config_path: std::path::PathBuf,
    user_tools_dir: std::path::PathBuf,
    msg: InboundMessage,
) {
    let binding = match resolve_or_create_im_binding(&db, &msg).await {
        Ok(b) => b,
        Err(e) => {
            warn!(
                "Failed to resolve IM binding (channel={}, sender={}): {}",
                msg.channel, msg.sender, e
            );
            return;
        }
    };
    let session_id = binding.session_id.clone();
    let _ = app.emit(IM_SESSION_UPDATED_EVENT, &session_id);

    // Reload settings fresh so credential / model edits take effect per message.
    let settings = match Settings::load(&config_path) {
        Ok(s) => Arc::new(Mutex::new(s)),
        Err(e) => {
            warn!("IM turn: failed to load settings: {}", e);
            return;
        }
    };

    let mut registry = ToolRegistry::new();
    let cfg = NeutralToolsConfig {
        db: Some(db.clone()),
        settings: Some(settings.clone()),
        user_tools_dir: Some(user_tools_dir),
        ..Default::default()
    };
    register_neutral_into(&mut registry, &cfg);
    let mcp_servers = { settings.lock().await.mcp_servers.clone() };
    if !mcp_servers.is_empty() {
        register_mcp_tools(&mut registry, &mcp_servers).await;
    }
    if let Some(dir) = config_path.parent() {
        let connector_configs = crate::commands::connectors::resolve_connector_mcp_configs(dir);
        if !connector_configs.is_empty() {
            register_mcp_tools(&mut registry, &connector_configs).await;
        }
    }

    let request = HeadlessCliRequest {
        prompt: msg.content.clone(),
        mode: HeadlessCliMode::Piscis,
        session_id: Some(session_id.clone()),
        session_title: Some(build_im_session_title(&msg)),
        channel: Some(format!("im_{}", msg.channel)),
        ..Default::default()
    };

    {
        let mut s = settings.lock().await;
        crate::commands::chat_turn::materialize_headless_llm_settings(&mut s, &app, None);
    }

    let deps = HeadlessDeps::new(db.clone(), settings.clone(), registry, sink.clone());
    let turn_ok = match run_piscis_turn(request, deps).await {
        Ok(resp) => {
            let reply = if resp.response_text.trim().is_empty() {
                "（Agent 未返回内容）".to_string()
            } else {
                resp.response_text
            };
            let settings_guard = settings.lock().await;
            let provider = settings_guard.provider.clone();
            let api_key = settings_guard.active_api_key().to_string();
            let base_url = if settings_guard.custom_base_url.is_empty() {
                None
            } else {
                Some(settings_guard.custom_base_url.clone())
            };
            let model = settings_guard.model.clone();
            let max_tokens = settings_guard.max_tokens;
            drop(settings_guard);

            let rows = {
                let dbg = db.lock().await;
                dbg.get_messages_latest(&session_id, 40).unwrap_or_default()
            };
            let msgs = crate::commands::post_turn::messages_from_db_rows(&rows);
            let app_bg = app.clone();
            let db_bg = db.clone();
            let sid = session_id.clone();
            tokio::spawn(async move {
                crate::commands::post_turn::run_post_turn_hooks(
                    &app_bg, db_bg, sid, msgs, provider, api_key, base_url, model, max_tokens,
                )
                .await;
            });
            reply
        }
        Err(e) => {
            warn!("IM headless turn failed for {}: {}", session_id, e);
            "（Agent 执行出错，请稍后再试）".to_string()
        }
    };
    let reply_text = turn_ok;

    let (recipient, routing_state) = resolve_im_outbound_route(
        &db,
        &session_id,
        &msg.channel,
        &msg.reply_target,
        msg.routing_state.clone(),
    )
    .await;

    let outbound = OutboundMessage {
        channel: msg.channel.clone(),
        recipient,
        content: reply_text,
        reply_to: Some(msg.id.clone()),
        media: None,
        routing_state,
    };

    let gateway = app.state::<AppState>().gateway.clone();
    match gateway.send(&outbound).await {
        Ok(()) => info!("IM reply sent via {}", msg.channel),
        Err(e) => warn!("Failed to send IM reply via {}: {}", msg.channel, e),
    }
    let _ = app.emit(IM_SESSION_UPDATED_EVENT, &session_id);
}

/// Spawn the long-running inbound consumer. Call once during app setup. Takes
/// the gateway receiver and drives a headless agent turn per inbound message.
pub fn spawn_inbound_consumer(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let gateway = app.state::<AppState>().gateway.clone();
        let Some(mut rx) = gateway.take_receiver().await else {
            warn!("Gateway inbound receiver already taken; consumer not started");
            return;
        };

        let dir = match resolve_global_config_dir(&app) {
            Ok(d) => d,
            Err(e) => {
                warn!("IM consumer: cannot resolve config dir: {}", e);
                return;
            }
        };
        let _ = std::fs::create_dir_all(&dir);
        let db = match Database::open(&dir.join("piscis.db")) {
            Ok(d) => Arc::new(Mutex::new(d)),
            Err(e) => {
                warn!("IM consumer: cannot open DB: {}", e);
                return;
            }
        };
        let config_path = dir.join("config.json");
        let user_tools_dir = dir.join("user-tools");
        let sink: Arc<dyn EventSink> = Arc::new(GatewayEventSink { app: app.clone() });
        let locks: SessionLocks = Arc::new(Mutex::new(HashMap::new()));

        info!("Gateway inbound consumer started");
        while let Some(msg) = rx.recv().await {
            let preview: String = msg.content.chars().take(80).collect();
            info!(
                "Inbound IM from {} via {}: {}",
                msg.sender, msg.channel, preview
            );

            let session_key = msg.binding_key();
            let lock = {
                let mut map = locks.lock().await;
                map.entry(session_key)
                    .or_insert_with(|| Arc::new(Mutex::new(())))
                    .clone()
            };

            let app2 = app.clone();
            let db2 = db.clone();
            let sink2 = sink.clone();
            let cfg_path = config_path.clone();
            let ut_dir = user_tools_dir.clone();
            tauri::async_runtime::spawn(async move {
                // Serialize within a conversation; concurrent across conversations.
                let _guard = lock.lock().await;
                handle_inbound(app2, db2, sink2, cfg_path, ut_dir, msg).await;
            });
        }
        info!("Gateway inbound consumer stopped");
    });
}

// ─── Assistant message panel (IM session history) ───────────────────────────

/// One IM-backed conversation, surfaced in the assistant message panel.
#[derive(Debug, Clone, Serialize)]
pub struct ImSessionMeta {
    pub id: String,
    /// Channel slug parsed from the `im_<channel>` source tag (feishu, telegram…).
    pub channel: String,
    pub title: String,
    pub status: String,
    pub message_count: i64,
    pub updated_at: String,
}

/// A single chat message inside an IM session.
#[derive(Debug, Clone, Serialize)]
pub struct ImMessageDto {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

/// Open the global (headless) DB that the IM consumer writes to.
fn open_global_db(app: &AppHandle) -> Result<Database, String> {
    let dir = resolve_global_config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Database::open(&dir.join("piscis.db")).map_err(|e| e.to_string())
}

fn channel_from_source(source: &str) -> Option<String> {
    source
        .strip_prefix("im_")
        .filter(|c| !c.is_empty())
        .map(|c| c.to_string())
}

/// List every IM-backed conversation (newest first), optionally for one channel.
#[tauri::command]
pub async fn list_im_sessions(
    app: AppHandle,
    channel: Option<String>,
) -> Result<Vec<ImSessionMeta>, String> {
    let want = channel
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    let db = open_global_db(&app)?;
    let sessions = db.list_sessions(500, 0).map_err(|e| e.to_string())?;
    Ok(sessions
        .into_iter()
        .filter_map(|s| {
            let ch = channel_from_source(&s.source)?;
            if let Some(ref w) = want {
                if &ch != w {
                    return None;
                }
            }
            Some(ImSessionMeta {
                id: s.id,
                channel: ch,
                title: s.title.unwrap_or_default(),
                status: s.status,
                message_count: s.message_count,
                updated_at: s.updated_at.to_rfc3339(),
            })
        })
        .collect())
}

/// Load one IM session's messages in chronological order.
#[tauri::command]
pub async fn im_session_messages(
    app: AppHandle,
    session_id: String,
) -> Result<Vec<ImMessageDto>, String> {
    let db = open_global_db(&app)?;
    let msgs = db
        .get_messages(&session_id, 1000, 0)
        .map_err(|e| e.to_string())?;
    Ok(msgs
        .into_iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| ImMessageDto {
            id: m.id,
            role: m.role,
            content: m.content,
            created_at: m.created_at.to_rfc3339(),
        })
        .collect())
}

/// Delete IM conversation history. With `channel`, clears only that channel;
/// otherwise clears every IM session.
#[tauri::command]
pub async fn clear_im_sessions(app: AppHandle, channel: Option<String>) -> Result<usize, String> {
    let want = channel
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    let db = open_global_db(&app)?;
    let sessions = db.list_sessions(1000, 0).map_err(|e| e.to_string())?;
    let mut removed = 0usize;
    for s in sessions {
        let Some(ch) = channel_from_source(&s.source) else {
            continue;
        };
        if let Some(ref w) = want {
            if &ch != w {
                continue;
            }
        }
        if db.delete_session(&s.id).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}
