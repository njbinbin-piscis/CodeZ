//! VS Code `.vsix` contribution-point ingestion.
//!
//! A `.vsix` is a zip whose `extension/package.json` declares `contributes.*`.
//! Per the design (`codez-design.md` §10) we consume only the **declarative**
//! data — color themes and snippets here — and never execute extension JS.
//! TextMate grammars and LSP servers are handled elsewhere / left for later.

use std::io::Read;

use serde::Serialize;
use serde_json::Value;

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

/// The subset of a `.vsix` manifest CodeZ can consume.
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
