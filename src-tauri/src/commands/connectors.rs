//! Connectors (Phase 0B) — authenticated external services exposed to the agent
//! as MCP tools (e.g. 通达信 / 腾讯文档 / QQ邮箱 / 飞书·钉钉·企微 的 OA-数据接口).
//!
//! A connector is a curated, friendly wrapper around an MCP server plus an auth
//! method. Manifests live in `{config}/connectors/<id>/connector.json`; the
//! user's credentials live next to them in `credentials.json` (never inside the
//! manifest). At agent-turn time [`resolve_connector_mcp_configs`] turns each
//! enabled + authorized connector into a kernel [`McpServerConfig`], injecting
//! credentials into `env` / `url` / `headers` via `${cred:<id>.<field>}`
//! placeholders.
//!
//! Transports map straight onto the kernel (v0.8.42+): `stdio` for local
//! subprocesses, and `sse` / `http` (streamable HTTP) for remote servers. For
//! remote transports the connector declares `headers` (e.g.
//! `Authorization: Bearer ${cred:foo.token}`) so authenticated / one-click
//! OAuth services work natively without proxying through a subprocess. For
//! `oauth2` connectors the stored `access_token` is auto-injected as a Bearer
//! header when the manifest does not declare an explicit `Authorization`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tracing::{info, warn};

use piscis_kernel::store::settings::McpServerConfig;

use crate::commands::data_scope::resolve_global_config_dir;

// ─── Manifest schema ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorAuthField {
    pub key: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub secret: bool,
    #[serde(default)]
    pub placeholder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectorOAuth {
    #[serde(default)]
    pub authorize_url: String,
    #[serde(default)]
    pub token_url: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub redirect: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorAuth {
    /// "none" | "api_key" | "token" | "oauth2"
    #[serde(default = "default_auth_method")]
    pub method: String,
    #[serde(default)]
    pub fields: Vec<ConnectorAuthField>,
    #[serde(default)]
    pub oauth: Option<ConnectorOAuth>,
}

fn default_auth_method() -> String {
    "none".into()
}

impl Default for ConnectorAuth {
    fn default() -> Self {
        Self {
            method: default_auth_method(),
            fields: Vec::new(),
            oauth: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub description: String,
    /// "mcp" (default). Reserved for future "builtin" native adapters.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// "stdio" | "sse" | "http" (streamable HTTP)
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    /// Environment variables passed to the MCP subprocess. Values may contain
    /// `${cred:<id>.<field>}` placeholders resolved from stored credentials.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// HTTP headers for `sse` / `http` transports. Values may contain
    /// `${cred:<id>.<field>}` placeholders (e.g.
    /// `Authorization: Bearer ${cred:foo.token}`).
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub auth: ConnectorAuth,
    /// Whether this connector is active (its tools are registered into agents).
    #[serde(default)]
    pub enabled: bool,
    /// HTTP method for `kind: api` connectors (GET / POST / PUT).
    #[serde(default = "default_api_method")]
    pub api_method: String,
    /// When the agent should call this API (usage scenario).
    #[serde(default)]
    pub use_case: String,
    /// Parameter documentation or JSON-schema hint for the agent.
    #[serde(default)]
    pub parameters: String,
}

fn default_api_method() -> String {
    "POST".into()
}

fn default_kind() -> String {
    "mcp".into()
}
fn default_transport() -> String {
    "stdio".into()
}

impl ConnectorManifest {
    fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        serde_json::from_str(&text).map_err(|e| format!("invalid connector.json: {e}"))
    }
}

// ─── DTO ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ConnectorInfo {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub color: String,
    pub category: String,
    pub description: String,
    pub kind: String,
    pub transport: String,
    pub auth_method: String,
    pub fields: Vec<ConnectorAuthField>,
    pub enabled: bool,
    /// True when every required secret field has a stored credential (or the
    /// connector needs no auth).
    pub authorized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_case: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<String>,
}

/// Resolved API connector ready for the `api_connector` agent tool.
#[derive(Debug, Clone)]
pub struct ApiConnectorEntry {
    pub id: String,
    pub name: String,
    pub url: String,
    pub method: String,
    pub use_case: String,
    pub parameters: String,
    pub api_key: String,
}

// ─── Paths ───────────────────────────────────────────────────────────────────

fn connectors_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_global_config_dir(app)?.join("connectors"))
}

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .to_lowercase()
}

fn credentials_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(safe_id(id)).join("credentials.json")
}

fn load_credentials(dir: &Path, id: &str) -> HashMap<String, String> {
    let path = credentials_path(dir, id);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<HashMap<String, String>>(&t).ok())
        .unwrap_or_default()
}

fn is_authorized(manifest: &ConnectorManifest, creds: &HashMap<String, String>) -> bool {
    match manifest.auth.method.as_str() {
        "none" => return true,
        // OAuth2 is authorized once a one-click flow has stored an access token.
        "oauth2" => {
            return creds
                .get("access_token")
                .map(|v| !v.is_empty())
                .unwrap_or(false)
        }
        _ => {}
    }
    manifest
        .auth
        .fields
        .iter()
        .filter(|f| f.secret)
        .all(|f| creds.get(&f.key).map(|v| !v.is_empty()).unwrap_or(false))
}

/// Replace `${cred:<id>.<field>}` placeholders in `input` with credential
/// values for this connector.
fn resolve_placeholders(input: &str, id: &str, creds: &HashMap<String, String>) -> String {
    let mut out = input.to_string();
    let prefix = format!("${{cred:{}.", id);
    while let Some(start) = out.find(&prefix) {
        if let Some(rel_end) = out[start..].find('}') {
            let end = start + rel_end;
            let field = &out[start + prefix.len()..end];
            let value = creds.get(field).cloned().unwrap_or_default();
            out.replace_range(start..=end, &value);
        } else {
            break;
        }
    }
    out
}

fn list_manifest_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() && p.join("connector.json").exists() {
                dirs.push(p);
            }
        }
    }
    dirs
}

fn connector_info_from(
    manifest: &ConnectorManifest,
    creds: &HashMap<String, String>,
) -> ConnectorInfo {
    let api_extra = manifest.kind == "api";
    ConnectorInfo {
        authorized: is_authorized(manifest, creds),
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        icon: manifest.icon.clone(),
        color: manifest.color.clone(),
        category: manifest.category.clone(),
        description: manifest.description.clone(),
        kind: manifest.kind.clone(),
        transport: manifest.transport.clone(),
        auth_method: manifest.auth.method.clone(),
        fields: manifest.auth.fields.clone(),
        enabled: manifest.enabled,
        url: api_extra
            .then(|| manifest.url.clone())
            .filter(|u| !u.is_empty()),
        use_case: api_extra
            .then(|| manifest.use_case.clone())
            .filter(|u| !u.is_empty()),
        parameters: api_extra
            .then(|| manifest.parameters.clone())
            .filter(|p| !p.is_empty()),
    }
}

/// List enabled + authorized `kind: api` connectors for the agent tool.
pub fn list_api_connectors(config_dir: &Path) -> Vec<ApiConnectorEntry> {
    let dir = config_dir.join("connectors");
    let mut out = Vec::new();
    for mdir in list_manifest_dirs(&dir) {
        let manifest = match ConnectorManifest::load(&mdir.join("connector.json")) {
            Ok(m) => m,
            Err(e) => {
                warn!("skip connector at {}: {}", mdir.display(), e);
                continue;
            }
        };
        if manifest.kind != "api" || !manifest.enabled {
            continue;
        }
        let creds = load_credentials(&dir, &manifest.id);
        if !is_authorized(&manifest, &creds) || manifest.url.trim().is_empty() {
            continue;
        }
        let api_key = creds.get("api_key").cloned().unwrap_or_default();
        out.push(ApiConnectorEntry {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            url: manifest.url.clone(),
            method: if manifest.api_method.trim().is_empty() {
                "POST".into()
            } else {
                manifest.api_method.clone()
            },
            use_case: manifest.use_case.clone(),
            parameters: manifest.parameters.clone(),
            api_key,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Call an enabled API connector. `body` is sent as JSON for POST/PUT.
pub async fn call_api_connector(
    config_dir: &Path,
    connector_id: &str,
    body: Option<serde_json::Value>,
) -> Result<String, String> {
    let entry = list_api_connectors(config_dir)
        .into_iter()
        .find(|c| c.id == connector_id)
        .ok_or_else(|| format!("API connector '{connector_id}' not found or not enabled"))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let method = entry.method.to_uppercase();
    let mut req = match method.as_str() {
        "GET" => client.get(&entry.url),
        "PUT" => client.put(&entry.url),
        "PATCH" => client.patch(&entry.url),
        "DELETE" => client.delete(&entry.url),
        _ => client.post(&entry.url),
    };
    req = req
        .header("User-Agent", "AgentZ/1.0")
        .header("Accept", "application/json, text/plain, */*");
    if !entry.api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", entry.api_key));
    }
    if method != "GET" && method != "DELETE" {
        req = req.json(&body.unwrap_or(serde_json::json!({})));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    Ok(text)
}

// ─── Public resolver (used by chat turn + IM loop) ──────────────────────────

/// Resolve every enabled + authorized connector into a kernel MCP config so the
/// caller can register their tools alongside regular MCP servers. `config_dir`
/// is the global config directory (`{config}`).
/// Turn one authorized `kind: mcp` connector manifest into a kernel MCP config.
/// Returns `None` for non-MCP or unauthorized connectors.
fn connector_to_mcp_config(dir: &Path, manifest: &ConnectorManifest) -> Option<McpServerConfig> {
    if manifest.kind != "mcp" {
        return None;
    }
    let creds = load_credentials(dir, &manifest.id);
    if !is_authorized(manifest, &creds) {
        return None;
    }
    let env: HashMap<String, String> = manifest
        .env
        .iter()
        .map(|(k, v)| (k.clone(), resolve_placeholders(v, &manifest.id, &creds)))
        .collect();
    let mut headers: HashMap<String, String> = manifest
        .headers
        .iter()
        .map(|(k, v)| (k.clone(), resolve_placeholders(v, &manifest.id, &creds)))
        .collect();
    // For OAuth2 connectors, auto-inject the stored access token as a Bearer
    // header unless the manifest declares its own Authorization header.
    if manifest.auth.method == "oauth2"
        && !headers
            .keys()
            .any(|k| k.eq_ignore_ascii_case("authorization"))
    {
        if let Some(token) = creds.get("access_token").filter(|v| !v.is_empty()) {
            headers.insert("Authorization".into(), format!("Bearer {token}"));
        }
    }
    let url = resolve_placeholders(&manifest.url, &manifest.id, &creds);
    Some(McpServerConfig {
        name: manifest.id.clone(),
        transport: manifest.transport.clone(),
        command: manifest.command.clone(),
        args: manifest.args.clone(),
        url,
        env,
        headers,
        enabled: true,
    })
}

pub fn resolve_connector_mcp_configs(config_dir: &Path) -> Vec<McpServerConfig> {
    let dir = config_dir.join("connectors");
    let mut out = Vec::new();
    for mdir in list_manifest_dirs(&dir) {
        let manifest = match ConnectorManifest::load(&mdir.join("connector.json")) {
            Ok(m) => m,
            Err(e) => {
                warn!("skip connector at {}: {}", mdir.display(), e);
                continue;
            }
        };
        if !manifest.enabled {
            continue;
        }
        if let Some(cfg) = connector_to_mcp_config(&dir, &manifest) {
            out.push(cfg);
        }
    }
    out
}

/// Resolve specific connectors by id into MCP configs, regardless of their
/// global `enabled` flag (an agent explicitly opted into them). Authorization
/// is still required. Used to bind an agent's own connectors for its turn.
pub fn resolve_named_connector_mcp_configs(
    config_dir: &Path,
    ids: &[String],
) -> Vec<McpServerConfig> {
    let wanted: std::collections::HashSet<&str> = ids
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if wanted.is_empty() {
        return Vec::new();
    }
    let dir = config_dir.join("connectors");
    let mut out = Vec::new();
    for mdir in list_manifest_dirs(&dir) {
        let manifest = match ConnectorManifest::load(&mdir.join("connector.json")) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !wanted.contains(manifest.id.as_str()) {
            continue;
        }
        if let Some(cfg) = connector_to_mcp_config(&dir, &manifest) {
            out.push(cfg);
        }
    }
    out
}

/// System-prompt section for user-selected connectors (generic agent mode).
pub fn connectors_prompt_context(config_dir: &Path, ids: &[String]) -> Option<String> {
    let wanted: std::collections::HashSet<&str> = ids
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if wanted.is_empty() {
        return None;
    }
    let dir = config_dir.join("connectors");
    let mut lines = Vec::new();
    for mdir in list_manifest_dirs(&dir) {
        let manifest = match ConnectorManifest::load(&mdir.join("connector.json")) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !wanted.contains(manifest.id.as_str()) {
            continue;
        }
        let creds = load_credentials(&dir, &manifest.id);
        let auth_note = if is_authorized(&manifest, &creds) {
            ""
        } else {
            " (not authorized — ask the user to complete setup in Settings → Connectors)"
        };
        let usage = if manifest.kind == "api" {
            "Use the `api_connector` tool with this connector_id."
        } else {
            "Its MCP tools are registered for this turn."
        };
        lines.push(format!(
            "- **{}** (id: `{}`, kind: {}){} — {}\n  {}",
            manifest.name,
            manifest.id,
            manifest.kind,
            auth_note,
            manifest.description.trim(),
            usage
        ));
    }
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "## Enabled connectors (user-selected for this conversation)\n\
         The user explicitly enabled these connectors. Use only them:\n{}",
        lines.join("\n")
    ))
}

// ─── Commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn connectors_list(app: AppHandle) -> Result<Vec<ConnectorInfo>, String> {
    let dir = connectors_dir(&app)?;
    let mut infos = Vec::new();
    for mdir in list_manifest_dirs(&dir) {
        let manifest = match ConnectorManifest::load(&mdir.join("connector.json")) {
            Ok(m) => m,
            Err(e) => {
                warn!("skip connector at {}: {}", mdir.display(), e);
                continue;
            }
        };
        let creds = load_credentials(&dir, &manifest.id);
        infos.push(connector_info_from(&manifest, &creds));
    }
    infos.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(infos)
}

/// Install a connector from a local `connector.json` path, a directory holding
/// one, or an HTTPS URL to a raw `connector.json`.
#[tauri::command]
pub async fn connectors_install(app: AppHandle, source: String) -> Result<ConnectorInfo, String> {
    let dir = connectors_dir(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;

    let manifest_text = if source.starts_with("http://") || source.starts_with("https://") {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        client
            .get(&source)
            .header("User-Agent", "AgentZ-Desktop/1.0")
            .send()
            .await
            .map_err(|e| format!("Download error: {e}"))?
            .text()
            .await
            .map_err(|e| format!("Read error: {e}"))?
    } else {
        let p = PathBuf::from(&source);
        let file = if p.is_dir() {
            p.join("connector.json")
        } else {
            p
        };
        std::fs::read_to_string(&file).map_err(|e| e.to_string())?
    };

    let mut manifest: ConnectorManifest =
        serde_json::from_str(&manifest_text).map_err(|e| format!("invalid connector.json: {e}"))?;
    if manifest.id.trim().is_empty() {
        return Err("connector.json must declare a non-empty 'id'".into());
    }
    // Installed connectors start disabled until the user authorizes + enables.
    manifest.enabled = false;

    let target = dir.join(safe_id(&manifest.id));
    tokio::fs::create_dir_all(&target)
        .await
        .map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    tokio::fs::write(target.join("connector.json"), pretty)
        .await
        .map_err(|e| e.to_string())?;

    info!("Installed connector '{}'", manifest.id);
    let creds = load_credentials(&dir, &manifest.id);
    Ok(connector_info_from(&manifest, &creds))
}

#[derive(Debug, Deserialize)]
pub struct CreateApiConnectorRequest {
    pub id: String,
    pub name: String,
    pub url: String,
    pub api_key: String,
    #[serde(default)]
    pub use_case: String,
    #[serde(default)]
    pub parameters: String,
    #[serde(default = "default_api_method")]
    pub method: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub description: String,
}

/// Create an inline HTTP API connector (video / ASR / TTS / OCR / custom).
#[tauri::command]
pub async fn connectors_create_api(
    app: AppHandle,
    req: CreateApiConnectorRequest,
) -> Result<ConnectorInfo, String> {
    let dir = connectors_dir(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;

    let id = safe_id(req.id.trim());
    if id.is_empty() {
        return Err("connector id is required".into());
    }
    if req.url.trim().is_empty() {
        return Err("API URL is required".into());
    }
    if req.api_key.trim().is_empty() {
        return Err("API key is required".into());
    }

    let manifest = ConnectorManifest {
        id: id.clone(),
        name: req.name.trim().to_string(),
        icon: if req.icon.trim().is_empty() {
            "🔌".into()
        } else {
            req.icon.trim().to_string()
        },
        color: String::new(),
        category: if req.category.trim().is_empty() {
            "api".into()
        } else {
            req.category.trim().to_string()
        },
        description: req.description.trim().to_string(),
        kind: "api".into(),
        transport: "http".into(),
        command: String::new(),
        args: Vec::new(),
        url: req.url.trim().to_string(),
        env: HashMap::new(),
        headers: HashMap::new(),
        auth: ConnectorAuth {
            method: "api_key".into(),
            fields: vec![ConnectorAuthField {
                key: "api_key".into(),
                label: "API Key".into(),
                secret: true,
                placeholder: String::new(),
            }],
            oauth: None,
        },
        enabled: false,
        api_method: req.method.trim().to_uppercase(),
        use_case: req.use_case.trim().to_string(),
        parameters: req.parameters.trim().to_string(),
    };

    let target = dir.join(&id);
    tokio::fs::create_dir_all(&target)
        .await
        .map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    tokio::fs::write(target.join("connector.json"), pretty)
        .await
        .map_err(|e| e.to_string())?;

    let creds = HashMap::from([("api_key".into(), req.api_key.trim().to_string())]);
    let cred_text = serde_json::to_string_pretty(&creds).map_err(|e| e.to_string())?;
    tokio::fs::write(credentials_path(&dir, &id), cred_text)
        .await
        .map_err(|e| e.to_string())?;

    info!("Created API connector '{}'", id);
    Ok(connector_info_from(&manifest, &creds))
}

#[tauri::command]
pub async fn connectors_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    let dir = connectors_dir(&app)?;
    let target = dir.join(safe_id(&id));
    if !target.exists() {
        return Err(format!("connector '{id}' not found"));
    }
    let canonical = target.canonicalize().map_err(|e| e.to_string())?;
    let base = dir.canonicalize().unwrap_or_else(|_| dir.clone());
    if !canonical.starts_with(&base) {
        return Err("path traversal blocked".into());
    }
    tokio::fs::remove_dir_all(&target)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn connectors_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let dir = connectors_dir(&app)?;
    let path = dir.join(safe_id(&id)).join("connector.json");
    let mut manifest = ConnectorManifest::load(&path)?;
    // Refuse to enable an unauthorized connector.
    if enabled {
        let creds = load_credentials(&dir, &manifest.id);
        if !is_authorized(&manifest, &creds) {
            return Err("connector is not authorized yet (missing credentials)".into());
        }
    }
    manifest.enabled = enabled;
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn connectors_save_credentials(
    app: AppHandle,
    id: String,
    credentials: HashMap<String, String>,
) -> Result<(), String> {
    let dir = connectors_dir(&app)?;
    let target = dir.join(safe_id(&id));
    if !target.join("connector.json").exists() {
        return Err(format!("connector '{id}' not found"));
    }
    // Merge with existing so masked/blank fields don't clobber stored secrets.
    let mut existing = load_credentials(&dir, &id);
    for (k, v) in credentials {
        if v.is_empty() || v == "••••••••" {
            continue;
        }
        existing.insert(k, v);
    }
    let text = serde_json::to_string_pretty(&existing).map_err(|e| e.to_string())?;
    std::fs::write(credentials_path(&dir, &id), text).map_err(|e| e.to_string())?;
    Ok(())
}

/// Return stored credential keys with secret values masked.
#[tauri::command]
pub async fn connectors_get_credentials(
    app: AppHandle,
    id: String,
) -> Result<HashMap<String, String>, String> {
    let dir = connectors_dir(&app)?;
    let creds = load_credentials(&dir, &id);
    let manifest = ConnectorManifest::load(&dir.join(safe_id(&id)).join("connector.json"))?;
    let secret_keys: std::collections::HashSet<&str> = manifest
        .auth
        .fields
        .iter()
        .filter(|f| f.secret)
        .map(|f| f.key.as_str())
        .collect();
    let mut out = HashMap::new();
    for (k, v) in creds {
        if secret_keys.contains(k.as_str()) {
            out.insert(
                k,
                if v.is_empty() {
                    String::new()
                } else {
                    "••••••••".into()
                },
            );
        } else {
            out.insert(k, v);
        }
    }
    Ok(out)
}
