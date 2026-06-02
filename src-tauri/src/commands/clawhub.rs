//! ClawHub marketplace — search and install SKILL.md packages (from openpiscis).

use std::io::Read;
use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;
use tracing::{info, warn};

use crate::commands::chat::resolve_config_dir;

const CLAWHUB_API: &str = "https://clawhub.ai";

#[derive(Debug, Clone, Serialize)]
pub struct ClawHubSkill {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub stars: u64,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ClawHubSearchResult {
    pub items: Vec<ClawHubSkill>,
    pub total: usize,
    pub query: String,
}

#[derive(Debug, Serialize)]
pub struct ClawHubInstallResult {
    pub slug: String,
    pub name: String,
    pub skill_dir: String,
}

async fn clawhub_get_with_retry(
    client: &reqwest::Client,
    url: &str,
    max_retries: u32,
) -> Result<reqwest::Response, String> {
    let base_delay_ms: u64 = 1000;
    let mut attempt = 0u32;
    loop {
        let resp = client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("network request failed: {e}"))?;
        let status = resp.status();
        if status.is_success() || (status.is_client_error() && status.as_u16() != 429) {
            return Ok(resp);
        }
        if attempt >= max_retries {
            return Ok(resp);
        }
        let retry_after_ms = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .map(|secs| secs * 1000)
            .unwrap_or(0);
        let backoff_ms = if retry_after_ms > 0 {
            retry_after_ms.min(30_000)
        } else {
            (base_delay_ms * (1u64 << attempt.min(4))).min(16_000)
        };
        warn!("ClawHub {status} for '{url}', retry in {backoff_ms}ms");
        tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
        attempt += 1;
    }
}

fn parse_skill_name(content: &str, fallback: &str) -> String {
    if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let fm = &rest[..end];
            for line in fm.lines() {
                if let Some(v) = line.strip_prefix("name:") {
                    let n = v.trim().trim_matches('"').trim_matches('\'');
                    if !n.is_empty() {
                        return n.to_string();
                    }
                }
            }
        }
    }
    for line in content.lines() {
        if let Some(h) = line.strip_prefix("# ") {
            let t = h.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    fallback.to_string()
}

fn sanitize_slug(slug: &str) -> Result<String, String> {
    if !slug
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!("invalid skill slug: '{slug}'"));
    }
    Ok(slug.to_string())
}

fn extract_skill_md_from_zip(zip_bytes: &[u8]) -> Result<String, String> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_lowercase();
        if name == "skill.md" || name.ends_with("/skill.md") {
            let mut content = String::new();
            file.read_to_string(&mut content)
                .map_err(|e| e.to_string())?;
            return Ok(content);
        }
    }
    Err("SKILL.md not found in zip archive".to_string())
}

fn extract_zip_to_dir(zip_bytes: &[u8], dest: &Path) -> Result<String, String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    let mut skill_md = String::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw_name = file.name().to_string();
        let rel = raw_name.trim_start_matches("./");
        if rel.is_empty() || rel.ends_with('/') {
            continue;
        }
        let out_path = dest.join(rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        std::fs::write(&out_path, &buf).map_err(|e| e.to_string())?;
        if rel.eq_ignore_ascii_case("SKILL.md") {
            skill_md = String::from_utf8_lossy(&buf).into_owned();
        }
    }
    if skill_md.is_empty() {
        skill_md = std::fs::read_to_string(dest.join("SKILL.md")).unwrap_or_default();
    }
    if skill_md.is_empty() {
        return Err("SKILL.md not found after zip extract".to_string());
    }
    Ok(skill_md)
}

/// Search ClawHub for skills.
#[tauri::command]
pub async fn clawhub_search(
    query: String,
    limit: Option<u32>,
) -> Result<ClawHubSearchResult, String> {
    let limit = limit.unwrap_or(20).min(50);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("CodeZ-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let q = query.trim().to_string();
    let (url, use_search) = if q.is_empty() {
        (
            format!("{CLAWHUB_API}/api/v1/skills?sort=stars&limit={limit}"),
            false,
        )
    } else {
        (
            format!(
                "{CLAWHUB_API}/api/v1/search?q={}&limit={limit}",
                urlencoding::encode(&q)
            ),
            true,
        )
    };

    let resp = clawhub_get_with_retry(&client, &url, 3)
        .await
        .map_err(|e| format!("cannot reach ClawHub: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ClawHub HTTP {}", resp.status()));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let items: Vec<ClawHubSkill> = if use_search {
        body["results"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|r| {
                let slug = r["slug"].as_str()?.to_string();
                Some(ClawHubSkill {
                    name: r["displayName"].as_str().unwrap_or(&slug).to_string(),
                    description: r["summary"].as_str().unwrap_or("").to_string(),
                    version: r["version"].as_str().unwrap_or("").to_string(),
                    stars: 0,
                    tags: vec![],
                    slug,
                })
            })
            .collect()
    } else {
        body["items"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|item| {
                let slug = item["slug"].as_str()?.to_string();
                let tags: Vec<String> = item["tags"]
                    .as_object()
                    .map(|obj| obj.keys().cloned().collect())
                    .unwrap_or_default();
                Some(ClawHubSkill {
                    name: item["displayName"].as_str().unwrap_or(&slug).to_string(),
                    description: item["summary"].as_str().unwrap_or("").to_string(),
                    version: item["latestVersion"]["version"]
                        .as_str()
                        .unwrap_or("latest")
                        .to_string(),
                    stars: item["stats"]["stars"].as_u64().unwrap_or(0),
                    tags,
                    slug,
                })
            })
            .collect()
    };

    let total = items.len();
    Ok(ClawHubSearchResult {
        items,
        total,
        query: q,
    })
}

/// Install a skill from ClawHub into `{config_dir}/skills/{slug}/`.
#[tauri::command]
pub async fn clawhub_install(
    app: AppHandle,
    slug: String,
    version: Option<String>,
) -> Result<ClawHubInstallResult, String> {
    let slug = sanitize_slug(slug.trim())?;
    let config_dir = resolve_config_dir(&app)?;
    let skills_root = config_dir.join("skills");
    let skill_dir = skills_root.join(&slug);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("CodeZ-Desktop/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    let ver = version
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "latest");
    let file_url = if let Some(v) = ver {
        format!("{CLAWHUB_API}/api/v1/skills/{slug}/file?path=SKILL.md&version={v}")
    } else {
        format!("{CLAWHUB_API}/api/v1/skills/{slug}/file?path=SKILL.md")
    };
    info!("ClawHub install: {file_url}");

    let resp = clawhub_get_with_retry(&client, &file_url, 3).await?;
    let content = if resp.status().is_success() {
        resp.text().await.map_err(|e| e.to_string())?
    } else {
        let zip_url = if let Some(v) = ver {
            format!("{CLAWHUB_API}/api/v1/download?slug={slug}&version={v}")
        } else {
            format!("{CLAWHUB_API}/api/v1/download?slug={slug}")
        };
        let zip_resp = clawhub_get_with_retry(&client, &zip_url, 3).await?;
        if !zip_resp.status().is_success() {
            return Err(format!(
                "ClawHub install failed for '{slug}': HTTP {}",
                zip_resp.status()
            ));
        }
        let bytes = zip_resp.bytes().await.map_err(|e| e.to_string())?;
        if extract_zip_to_dir(&bytes, &skill_dir).is_ok() {
            return Ok(ClawHubInstallResult {
                name: parse_skill_name(
                    &std::fs::read_to_string(skill_dir.join("SKILL.md")).unwrap_or_default(),
                    &slug,
                ),
                slug: slug.clone(),
                skill_dir: skill_dir.display().to_string(),
            });
        }
        extract_skill_md_from_zip(&bytes)?
    };

    std::fs::create_dir_all(&skill_dir).map_err(|e| e.to_string())?;
    std::fs::write(skill_dir.join("SKILL.md"), &content).map_err(|e| e.to_string())?;
    let name = parse_skill_name(&content, &slug);
    Ok(ClawHubInstallResult {
        slug,
        name,
        skill_dir: skill_dir.display().to_string(),
    })
}
