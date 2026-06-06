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

// ─── Public resolver (used by chat turn + IM loop) ──────────────────────────

/// Resolve every enabled + authorized connector into a kernel MCP config so the
/// caller can register their tools alongside regular MCP servers. `config_dir`
/// is the global config directory (`{config}`).
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
        if !manifest.enabled || manifest.kind != "mcp" {
            continue;
        }
        let creds = load_credentials(&dir, &manifest.id);
        if !is_authorized(&manifest, &creds) {
            continue;
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
            && !headers.keys().any(|k| k.eq_ignore_ascii_case("authorization"))
        {
            if let Some(token) = creds.get("access_token").filter(|v| !v.is_empty()) {
                headers.insert("Authorization".into(), format!("Bearer {token}"));
            }
        }
        let url = resolve_placeholders(&manifest.url, &manifest.id, &creds);
        out.push(McpServerConfig {
            name: manifest.id.clone(),
            transport: manifest.transport.clone(),
            command: manifest.command.clone(),
            args: manifest.args.clone(),
            url,
            env,
            headers,
            enabled: true,
        });
    }
    out
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
        infos.push(ConnectorInfo {
            authorized: is_authorized(&manifest, &creds),
            id: manifest.id,
            name: manifest.name,
            icon: manifest.icon,
            color: manifest.color,
            category: manifest.category,
            description: manifest.description,
            kind: manifest.kind,
            transport: manifest.transport,
            auth_method: manifest.auth.method,
            fields: manifest.auth.fields,
            enabled: manifest.enabled,
        });
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
        let file = if p.is_dir() { p.join("connector.json") } else { p };
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
    Ok(ConnectorInfo {
        authorized: is_authorized(&manifest, &creds),
        id: manifest.id,
        name: manifest.name,
        icon: manifest.icon,
        color: manifest.color,
        category: manifest.category,
        description: manifest.description,
        kind: manifest.kind,
        transport: manifest.transport,
        auth_method: manifest.auth.method,
        fields: manifest.auth.fields,
        enabled: manifest.enabled,
    })
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
            out.insert(k, if v.is_empty() { String::new() } else { "••••••••".into() });
        } else {
            out.insert(k, v);
        }
    }
    Ok(out)
}
