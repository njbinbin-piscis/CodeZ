//! Unified marketplace façade (Phase 4).
//!
//! Aggregates discovery + install across the layered tool system into a single
//! uniform surface so the UI can present Tools / Skills / Agents / Teams /
//! Connectors side by side. Each category resolves through one or more sources:
//!
//! - `clawhub` — remote skill registry (search + install), skills only.
//! - `local`   — install from a local path or a raw-manifest/zip URL (all
//!   categories that ship a manifest: tools / agents / teams / connectors).
//! - `builtin` — already-installed items surfaced for management.
//! - `remote`  — reserved for future hosted registries (tools/agents/teams).
//!
//! Install routes to the relevant per-category command, which lands files in
//! the right `{config}/` dir and refreshes/syncs as a side effect.

use serde::Serialize;
use tauri::AppHandle;

use crate::commands::{agents, clawhub, connectors, teams, user_tools, workbench};

/// A single, source-agnostic marketplace entry rendered as a card.
#[derive(Debug, Clone, Serialize)]
pub struct MarketItem {
    /// Stable identifier within the category (slug / id / name).
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    /// `tool` | `skill` | `agent` | `team` | `connector`.
    pub category: String,
    /// `clawhub` | `local` | `builtin` | `remote`.
    pub source: String,
    pub icon: String,
    /// Free-form sub-category / tag label (e.g. a connector's category).
    pub tag: String,
    pub stars: u64,
    pub installed: bool,
    /// Only meaningful for connectors; true for everything else.
    pub authorized: bool,
}

impl MarketItem {
    fn base(category: &str, source: &str) -> Self {
        MarketItem {
            id: String::new(),
            name: String::new(),
            description: String::new(),
            version: String::new(),
            category: category.into(),
            source: source.into(),
            icon: String::new(),
            tag: String::new(),
            stars: 0,
            installed: false,
            authorized: true,
        }
    }
}

/// Discover items for one category. `query` only applies to searchable sources
/// (currently ClawHub skills); other categories list what is installed.
#[tauri::command]
pub async fn marketplace_search(
    app: AppHandle,
    category: String,
    query: String,
) -> Result<Vec<MarketItem>, String> {
    match category.as_str() {
        "skill" => search_skills(app, query).await,
        "connector" => list_connectors(app).await,
        "tool" => list_tools(app).await,
        "agent" => list_agents(app).await,
        "team" => list_teams(app).await,
        other => Err(format!("unknown marketplace category: {other}")),
    }
}

/// Install an item. `source` selects the pipeline; `identifier` is the slug
/// (ClawHub) or the path/URL (local). `version` is only used by ClawHub.
#[tauri::command]
pub async fn marketplace_install(
    app: AppHandle,
    category: String,
    source: String,
    identifier: String,
    version: Option<String>,
) -> Result<(), String> {
    match (category.as_str(), source.as_str()) {
        ("skill", "clawhub") => {
            clawhub::clawhub_install(app, identifier, version).await.map(|_| ())
        }
        ("tool", _) => user_tools::user_tools_install(app, identifier).await.map(|_| ()),
        ("agent", _) => agents::agents_install(app, identifier).await.map(|_| ()),
        ("team", _) => teams::teams_install(app, identifier).await.map(|_| ()),
        ("connector", "local") | ("connector", "remote") => {
            connectors::connectors_install(app, identifier).await.map(|_| ())
        }
        ("connector", _) => {
            // Built-in (already-installed) connectors: "install" = enable.
            connectors::connectors_set_enabled(app, identifier, true).await
        }
        (cat, src) => Err(format!("unsupported install: category={cat} source={src}")),
    }
}

/// Uninstall by category, routing to the owning command.
#[tauri::command]
pub async fn marketplace_uninstall(
    app: AppHandle,
    category: String,
    id: String,
) -> Result<(), String> {
    match category.as_str() {
        "skill" => workbench::skills_uninstall(app, id),
        "tool" => user_tools::user_tools_uninstall(app, id).await,
        "agent" => agents::agents_uninstall(app, id).await,
        "team" => teams::teams_uninstall(app, id).await,
        "connector" => connectors::connectors_uninstall(app, id).await,
        other => Err(format!("unknown marketplace category: {other}")),
    }
}

// ─── Per-category aggregation ───────────────────────────────────────────────

async fn search_skills(app: AppHandle, query: String) -> Result<Vec<MarketItem>, String> {
    let installed = workbench::skills_list_installed(app.clone()).unwrap_or_default();
    let installed_slugs: std::collections::HashSet<String> =
        installed.iter().map(|s| s.slug.clone()).collect();

    let res = clawhub::clawhub_search(query, Some(30)).await?;
    let mut items: Vec<MarketItem> = res
        .items
        .into_iter()
        .map(|s| {
            let mut it = MarketItem::base("skill", "clawhub");
            it.installed = installed_slugs.contains(&s.slug);
            it.id = s.slug;
            it.name = s.name;
            it.description = s.description;
            it.version = s.version;
            it.stars = s.stars;
            it.icon = "🧩".into();
            it.tag = s.tags.first().cloned().unwrap_or_default();
            it
        })
        .collect();

    // Surface locally-installed skills that aren't in the search results so the
    // user can always manage them from the same tab.
    let listed: std::collections::HashSet<String> = items.iter().map(|i| i.id.clone()).collect();
    for s in installed {
        if !listed.contains(&s.slug) {
            let mut it = MarketItem::base("skill", "local");
            it.installed = true;
            it.id = s.slug;
            it.name = s.name;
            it.description = s.description;
            it.icon = "🧩".into();
            items.push(it);
        }
    }
    Ok(items)
}

async fn list_connectors(app: AppHandle) -> Result<Vec<MarketItem>, String> {
    let infos = connectors::connectors_list(app).await?;
    Ok(infos
        .into_iter()
        .map(|c| {
            let mut it = MarketItem::base("connector", "builtin");
            it.installed = c.enabled;
            it.authorized = c.authorized;
            it.id = c.id;
            it.name = c.name;
            it.description = c.description;
            it.icon = if c.icon.is_empty() { "🔌".into() } else { c.icon };
            it.tag = c.category;
            it
        })
        .collect())
}

async fn list_tools(app: AppHandle) -> Result<Vec<MarketItem>, String> {
    let tools = user_tools::user_tools_list(app).await?;
    Ok(tools
        .into_iter()
        .map(|tdef| {
            let mut it = MarketItem::base("tool", "local");
            it.installed = true;
            it.id = tdef.name.clone();
            it.name = tdef.name;
            it.description = tdef.description;
            it.version = tdef.version;
            it.icon = "🛠️".into();
            it.tag = tdef.runtime;
            it
        })
        .collect())
}

async fn list_agents(app: AppHandle) -> Result<Vec<MarketItem>, String> {
    let list = agents::agents_list(app).await?;
    Ok(list
        .into_iter()
        .map(|a| {
            let mut it = MarketItem::base("agent", "local");
            it.installed = true;
            it.id = a.id;
            it.name = a.name;
            it.description = a.description;
            it.icon = if a.icon.is_empty() { "🤖".into() } else { a.icon };
            it.tag = a.role;
            it
        })
        .collect())
}

async fn list_teams(app: AppHandle) -> Result<Vec<MarketItem>, String> {
    let list = teams::teams_list(app).await?;
    Ok(list
        .into_iter()
        .map(|tm| {
            let mut it = MarketItem::base("team", "local");
            it.installed = true;
            it.id = tm.id;
            it.name = tm.name;
            it.description = tm.description;
            it.icon = "👥".into();
            it.tag = if tm.mode == "workflow" {
                "workflow".to_string()
            } else {
                tm.workflow_hint
            };
            it
        })
        .collect())
}
