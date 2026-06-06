//! VS Code `.vsix` contribution-point ingestion.
//!
//! A `.vsix` is a zip whose `extension/package.json` declares `contributes.*`.
//! Per the design (`agentz-design.md` §10) we consume only the **declarative**
//! data — color themes and snippets here — and never execute extension JS.
//! TextMate grammars and LSP servers are handled elsewhere / left for later.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::commands::data_scope::resolve_global_config_dir;

/// A color theme contributed by the extension.
#[derive(Debug, Serialize)]
pub struct VsixTheme {
    pub label: String,
    pub ui_theme: String,
    /// Raw theme JSON (may be JSONC — the frontend parses tolerantly).
    pub content: String,
}

/// A snippet set contributed for a language.
#[derive(Debug, Serialize)]
pub struct VsixSnippetSet {
    pub language: String,
    pub content: String,
}

/// The subset of a `.vsix` manifest AgentZ can consume.
#[derive(Debug, Serialize)]
pub struct VsixManifest {
    pub name: String,
    pub display_name: String,
    pub publisher: String,
    pub version: String,
    pub themes: Vec<VsixTheme>,
    pub snippets: Vec<VsixSnippetSet>,
    /// Language ids declared by `contributes.languages` (informational).
    pub languages: Vec<String>,
}

type Archive = zip::ZipArchive<std::fs::File>;

fn read_entry(archive: &mut Archive, name: &str) -> Option<String> {
    let mut f = archive.by_name(name).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

/// Resolve a `contributes.*.path` (relative to the extension root) to its zip
/// entry name, e.g. `./themes/dark.json` -> `extension/themes/dark.json`.
fn entry_for(path: &str) -> String {
    let clean = path.trim_start_matches("./").trim_start_matches('/');
    format!("extension/{clean}")
}

/// Inspect a `.vsix` and return its consumable contribution points.
#[tauri::command]
pub fn import_vsix(path: String) -> Result<VsixManifest, String> {
    let file = std::fs::File::open(&path).map_err(|e| format!("open {path}: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("not a valid .vsix (zip): {e}"))?;

    let pkg_raw = read_entry(&mut archive, "extension/package.json")
        .ok_or_else(|| "extension/package.json not found in .vsix".to_string())?;
    let pkg: Value = serde_json::from_str(&pkg_raw)
        .map_err(|e| format!("invalid package.json: {e}"))?;

    let str_field = |k: &str| pkg.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let name = str_field("name");
    let display_name = {
        let d = str_field("displayName");
        if d.is_empty() { name.clone() } else { d }
    };
    let publisher = str_field("publisher");
    let version = str_field("version");

    let contributes = pkg.get("contributes");

    let mut themes = Vec::new();
    let mut snippets = Vec::new();
    let mut languages = Vec::new();

    if let Some(c) = contributes {
        if let Some(arr) = c.get("themes").and_then(|v| v.as_array()) {
            for t in arr {
                let label = t.get("label").and_then(|v| v.as_str()).unwrap_or("Theme").to_string();
                let ui_theme = t
                    .get("uiTheme")
                    .and_then(|v| v.as_str())
                    .unwrap_or("vs-dark")
                    .to_string();
                if let Some(p) = t.get("path").and_then(|v| v.as_str()) {
                    if let Some(content) = read_entry(&mut archive, &entry_for(p)) {
                        themes.push(VsixTheme { label, ui_theme, content });
                    }
                }
            }
        }
        if let Some(arr) = c.get("snippets").and_then(|v| v.as_array()) {
            for s in arr {
                let language = s.get("language").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                if let Some(p) = s.get("path").and_then(|v| v.as_str()) {
                    if let Some(content) = read_entry(&mut archive, &entry_for(p)) {
                        snippets.push(VsixSnippetSet { language, content });
                    }
                }
            }
        }
        if let Some(arr) = c.get("languages").and_then(|v| v.as_array()) {
            for l in arr {
                if let Some(id) = l.get("id").and_then(|v| v.as_str()) {
                    languages.push(id.to_string());
                }
            }
        }
    }

    Ok(VsixManifest {
        name,
        display_name,
        publisher,
        version,
        themes,
        snippets,
        languages,
    })
}

// ── Full extension installation (unpack + manage) ───────────────────────────
//
// Unlike `import_vsix` (which only reads declarative theme/snippet data), these
// commands unpack the whole `.vsix` so the Node extension host can require its
// `main` entry and run its JS against the `vscode` API.

/// An installed extension as seen by the extension host.
#[derive(Debug, Serialize, Clone)]
pub struct InstalledExtension {
    pub id: String,
    pub name: String,
    pub publisher: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub main: Option<String>,
    /// Absolute path to the unpacked `extension/` directory.
    pub extension_path: String,
    pub activation_events: Vec<String>,
    pub contributes: Value,
    pub enabled: bool,
}

/// `{config}/extensions`
fn extensions_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = resolve_global_config_dir(app)?.join("extensions");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create extensions dir: {e}"))?;
    Ok(dir)
}

/// Return the extensions root directory (the host scans this on init).
#[tauri::command]
pub fn vsix_extensions_dir(app: AppHandle) -> Result<String, String> {
    Ok(extensions_root(&app)?.display().to_string())
}

fn read_package_json(dir: &Path) -> Option<Value> {
    let pkg = dir.join("package.json");
    let raw = std::fs::read_to_string(pkg).ok()?;
    serde_json::from_str(&raw).ok()
}

fn parse_installed(folder: &Path) -> Option<InstalledExtension> {
    // `.vsix` unpacks with an `extension/` subdir; support flat layout too.
    let inner = folder.join("extension");
    let ext_dir = if inner.join("package.json").exists() { inner } else { folder.to_path_buf() };
    let pkg = read_package_json(&ext_dir)?;
    let s = |k: &str| pkg.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let name = s("name");
    if name.is_empty() {
        return None;
    }
    let publisher = {
        let p = s("publisher");
        if p.is_empty() { "unknown".to_string() } else { p }
    };
    let display = {
        let d = s("displayName");
        if d.is_empty() { name.clone() } else { d }
    };
    let activation_events = pkg
        .get("activationEvents")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| if pkg.get("main").is_some() { vec!["*".into()] } else { vec![] });
    let enabled = !folder.join(".disabled").exists();
    Some(InstalledExtension {
        id: format!("{publisher}.{name}"),
        name,
        publisher,
        version: s("version"),
        display_name: display,
        description: s("description"),
        main: pkg.get("main").and_then(|v| v.as_str()).map(String::from),
        extension_path: ext_dir.display().to_string(),
        activation_events,
        contributes: pkg.get("contributes").cloned().unwrap_or(Value::Null),
        enabled,
    })
}

/// Unpack a `.vsix` into the managed extensions dir and return its descriptor.
#[tauri::command]
pub fn vsix_install(app: AppHandle, path: String) -> Result<InstalledExtension, String> {
    let file = std::fs::File::open(&path).map_err(|e| format!("open {path}: {e}"))?;
    let archive = zip::ZipArchive::new(file).map_err(|e| format!("not a valid .vsix (zip): {e}"))?;
    install_from_archive(&app, archive)
}

/// Download a `.vsix` from a URL (e.g. Open VSX) and install it.
#[tauri::command]
pub async fn vsix_install_from_url(app: AppHandle, url: String) -> Result<InstalledExtension, String> {
    let bytes = reqwest::Client::new()
        .get(&url)
        .header("User-Agent", "AgentZ")
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("read body failed: {e}"))?;
    let cursor = std::io::Cursor::new(bytes.to_vec());
    let archive = zip::ZipArchive::new(cursor).map_err(|e| format!("not a valid .vsix (zip): {e}"))?;
    install_from_archive(&app, archive)
}

/// Shared unpack routine over any seekable zip source.
fn install_from_archive<R: Read + std::io::Seek>(
    app: &AppHandle,
    mut archive: zip::ZipArchive<R>,
) -> Result<InstalledExtension, String> {
    // Read identity first to compute the install folder name (generic over R,
    // so this works for both file-backed and in-memory zip sources).
    let pkg_raw = {
        let mut f = archive
            .by_name("extension/package.json")
            .map_err(|_| "extension/package.json not found in .vsix".to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| format!("read package.json: {e}"))?;
        s
    };
    let pkg: Value = serde_json::from_str(&pkg_raw).map_err(|e| format!("invalid package.json: {e}"))?;
    let name = pkg.get("name").and_then(|v| v.as_str()).unwrap_or("extension");
    let publisher = pkg.get("publisher").and_then(|v| v.as_str()).unwrap_or("unknown");
    let version = pkg.get("version").and_then(|v| v.as_str()).unwrap_or("0.0.0");

    let root = extensions_root(app)?;
    let folder = root.join(format!("{publisher}.{name}-{version}"));
    if folder.exists() {
        std::fs::remove_dir_all(&folder).map_err(|e| format!("clean existing install: {e}"))?;
    }
    std::fs::create_dir_all(&folder).map_err(|e| format!("create install dir: {e}"))?;

    // Extract every entry, preserving the archive's directory layout.
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        let entry_name = entry.name().to_string();
        // Guard against zip-slip.
        if entry_name.contains("..") {
            continue;
        }
        let out_path = folder.join(&entry_name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).ok();
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf).map_err(|e| format!("read {entry_name}: {e}"))?;
        std::fs::write(&out_path, buf).map_err(|e| format!("write {}: {e}", out_path.display()))?;
    }

    parse_installed(&folder).ok_or_else(|| "failed to parse installed extension".to_string())
}

/// List all installed extensions.
#[tauri::command]
pub fn vsix_list(app: AppHandle) -> Result<Vec<InstalledExtension>, String> {
    let root = extensions_root(&app)?;
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(ext) = parse_installed(&entry.path()) {
                    out.push(ext);
                }
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

fn find_install_folder(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let root = extensions_root(app)?;
    for entry in std::fs::read_dir(&root).map_err(|e| format!("read extensions dir: {e}"))?.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if let Some(ext) = parse_installed(&p) {
                if ext.id == id {
                    return Ok(p);
                }
            }
        }
    }
    Err(format!("extension not installed: {id}"))
}

/// Uninstall an extension by id.
#[tauri::command]
pub fn vsix_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    let folder = find_install_folder(&app, &id)?;
    std::fs::remove_dir_all(&folder).map_err(|e| format!("remove {}: {e}", folder.display()))?;
    Ok(())
}

/// Enable/disable an extension (a `.disabled` marker controls activation).
#[tauri::command]
pub fn vsix_set_enabled(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let folder = find_install_folder(&app, &id)?;
    let marker = folder.join(".disabled");
    if enabled {
        let _ = std::fs::remove_file(&marker);
    } else {
        std::fs::write(&marker, b"disabled").map_err(|e| format!("write marker: {e}"))?;
    }
    Ok(())
}
