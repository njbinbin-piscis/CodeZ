//! One-time migration of flat `{config}/skills/{slug}/` to quadrant layout.

use crate::commands::skill_evolution_ctx::SkillEvolutionCtx;
use crate::skills::{provenance, service};
use tauri::AppHandle;

#[derive(serde::Serialize)]
pub struct SkillsMigrateResult {
    pub moved: u32,
    pub message: String,
}

#[tauri::command]
pub async fn skills_migrate_legacy_layout(app: AppHandle) -> Result<SkillsMigrateResult, String> {
    let ctx = SkillEvolutionCtx::open(&app)?;
    let root = ctx.skills_root();
    let moved = provenance::migrate_flat_skills_to_installed(&root).map_err(|e| e.to_string())?;

    if moved > 0 {
        let db = ctx.db.lock().await;
        let entries =
            std::fs::read_dir(provenance::installed_dir(&root)).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let skill_id = entry.file_name().to_string_lossy().to_string();
            let skill_md = path.join("SKILL.md");
            let Ok(content) = std::fs::read_to_string(&skill_md) else {
                continue;
            };
            let loader = crate::skills::loader::SkillLoader::new(&root);
            let name = loader
                .parse_skill_from_content(&content)
                .map(|s| s.name)
                .unwrap_or_else(|_| skill_id.clone());
            let meta = provenance::SkillConfigMeta::installed("legacy_migrate", None, None);
            let _ = service::register_skill_db(
                &db,
                &skill_id,
                &name,
                "",
                &meta,
                Some("legacy_migrate"),
            );
        }
    }

    Ok(SkillsMigrateResult {
        moved,
        message: format!("Migrated {moved} skill(s) to skills/installed/"),
    })
}
