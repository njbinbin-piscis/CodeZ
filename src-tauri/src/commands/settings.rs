//! LLM / kernel settings — load & save `config.json` for the desktop app.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use piscis_kernel::store::settings::{LlmProviderConfig, McpServerConfig, Settings};

use crate::commands::chat::resolve_config_dir;

/// MCP server config exposed to / from the settings UI (M6).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct McpServerDto {
    pub name: String,
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// For sse / http transports: extra HTTP headers (e.g. Authorization).
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProviderDto {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveLlmSettings {
    pub provider: String,
    pub model: String,
    pub custom_base_url: String,
    pub max_tokens: u32,
    pub context_window: u32,
    pub policy_mode: String,
    pub enable_streaming: bool,
    pub language: String,
    pub vision_enabled: bool,
    pub anthropic_api_key: String,
    pub openai_api_key: String,
    pub deepseek_api_key: String,
    pub qwen_api_key: String,
    pub minimax_api_key: String,
    pub zhipu_api_key: String,
    pub kimi_api_key: String,
    pub llm_providers: Vec<LlmProviderDto>,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerDto>,
}

/// Lean payload returned to the settings UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmSettingsDto {
    pub config_dir: String,
    pub is_configured: bool,
    pub provider: String,
    pub model: String,
    pub custom_base_url: String,
    pub max_tokens: u32,
    pub context_window: u32,
    pub policy_mode: String,
    pub enable_streaming: bool,
    pub language: String,
    pub vision_enabled: bool,
    pub anthropic_api_key: String,
    pub openai_api_key: String,
    pub deepseek_api_key: String,
    pub qwen_api_key: String,
    pub minimax_api_key: String,
    pub zhipu_api_key: String,
    pub kimi_api_key: String,
    pub llm_providers: Vec<LlmProviderDto>,
    pub mcp_servers: Vec<McpServerDto>,
}

fn mcp_to_dto(s: &McpServerConfig) -> McpServerDto {
    McpServerDto {
        name: s.name.clone(),
        transport: s.transport.clone(),
        command: s.command.clone(),
        args: s.args.clone(),
        url: s.url.clone(),
        env: s.env.clone(),
        headers: s.headers.clone(),
        enabled: s.enabled,
    }
}

fn load_settings(app: &AppHandle) -> Result<(Settings, String), String> {
    let config_dir = resolve_config_dir(app)?;
    let config_path = config_dir.join("config.json");
    let mut settings = Settings::load(&config_path).map_err(|e| e.to_string())?;
    settings.config_path = config_path;
    Ok((settings, config_dir.display().to_string()))
}

fn provider_to_dto(p: &LlmProviderConfig) -> LlmProviderDto {
    LlmProviderDto {
        id: p.id.clone(),
        label: p.label.clone(),
        provider: p.provider.clone(),
        model: p.model.clone(),
        api_key: p.api_key.clone(),
        base_url: p.base_url.clone(),
        max_tokens: p.max_tokens,
    }
}

fn to_dto(settings: &Settings, config_dir: String) -> LlmSettingsDto {
    LlmSettingsDto {
        config_dir,
        is_configured: settings.is_configured(),
        provider: settings.provider.clone(),
        model: settings.model.clone(),
        custom_base_url: settings.custom_base_url.clone(),
        max_tokens: settings.max_tokens,
        context_window: settings.context_window,
        policy_mode: settings.policy_mode.clone(),
        enable_streaming: settings.enable_streaming,
        language: settings.language.clone(),
        vision_enabled: settings.vision_enabled,
        anthropic_api_key: settings.anthropic_api_key.clone(),
        openai_api_key: settings.openai_api_key.clone(),
        deepseek_api_key: settings.deepseek_api_key.clone(),
        qwen_api_key: settings.qwen_api_key.clone(),
        minimax_api_key: settings.minimax_api_key.clone(),
        zhipu_api_key: settings.zhipu_api_key.clone(),
        kimi_api_key: settings.kimi_api_key.clone(),
        llm_providers: settings.llm_providers.iter().map(provider_to_dto).collect(),
        mcp_servers: settings.mcp_servers.iter().map(mcp_to_dto).collect(),
    }
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<LlmSettingsDto, String> {
    let (settings, config_dir) = load_settings(&app)?;
    Ok(to_dto(&settings, config_dir))
}

#[tauri::command]
pub async fn is_configured(app: AppHandle) -> Result<bool, String> {
    let (settings, _) = load_settings(&app)?;
    Ok(settings.is_configured())
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    updates: SaveLlmSettings,
) -> Result<LlmSettingsDto, String> {
    let (mut settings, config_dir) = load_settings(&app)?;

    if !updates.anthropic_api_key.is_empty() {
        settings.anthropic_api_key = updates.anthropic_api_key;
    }
    if !updates.openai_api_key.is_empty() {
        settings.openai_api_key = updates.openai_api_key;
    }
    if !updates.deepseek_api_key.is_empty() {
        settings.deepseek_api_key = updates.deepseek_api_key;
    }
    if !updates.qwen_api_key.is_empty() {
        settings.qwen_api_key = updates.qwen_api_key;
    }
    if !updates.minimax_api_key.is_empty() {
        settings.minimax_api_key = updates.minimax_api_key;
    }
    if !updates.zhipu_api_key.is_empty() {
        settings.zhipu_api_key = updates.zhipu_api_key;
    }
    if !updates.kimi_api_key.is_empty() {
        settings.kimi_api_key = updates.kimi_api_key;
    }

    settings.provider = updates.provider;
    settings.model = updates.model;
    settings.custom_base_url = updates.custom_base_url;
    settings.max_tokens = updates.max_tokens;
    settings.context_window = updates.context_window;
    settings.policy_mode = updates.policy_mode;
    settings.enable_streaming = updates.enable_streaming;
    settings.vision_enabled = updates.vision_enabled;
    if updates.language == "zh" || updates.language == "en" {
        settings.language = updates.language;
    }

    let mut providers: Vec<LlmProviderConfig> = Vec::new();
    for item in updates.llm_providers {
        if item.id.trim().is_empty() {
            continue;
        }
        let existing_api_key = settings
            .llm_providers
            .iter()
            .find(|p| p.id == item.id)
            .map(|p| p.api_key.clone())
            .unwrap_or_default();
        providers.push(LlmProviderConfig {
            id: item.id,
            label: item.label,
            provider: item.provider,
            model: item.model,
            api_key: if item.api_key.is_empty() {
                existing_api_key
            } else {
                item.api_key
            },
            base_url: item.base_url,
            max_tokens: item.max_tokens,
        });
    }
    settings.llm_providers = providers;

    settings.mcp_servers = updates
        .mcp_servers
        .into_iter()
        .filter(|m| !m.name.trim().is_empty())
        .map(|m| McpServerConfig {
            name: m.name,
            transport: if m.transport.is_empty() {
                "stdio".to_string()
            } else {
                m.transport
            },
            command: m.command,
            args: m.args,
            url: m.url,
            env: m.env,
            headers: m.headers,
            enabled: m.enabled,
        })
        .collect();

    settings.save().map_err(|e| e.to_string())?;
    Ok(to_dto(&settings, config_dir))
}
