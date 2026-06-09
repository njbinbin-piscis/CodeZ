use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDefinition {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub lifecycle: String,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub skill_id: String,
    pub instructions: String,
    pub source_path: PathBuf,
}

pub struct SkillLoader {
    skills_dir: PathBuf,
    skills: HashMap<String, SkillDefinition>,
}

impl SkillLoader {
    pub fn new(skills_dir: impl Into<PathBuf>) -> Self {
        Self {
            skills_dir: skills_dir.into(),
            skills: HashMap::new(),
        }
    }

    pub fn load_all(&mut self) -> Result<()> {
        if !self.skills_dir.exists() {
            std::fs::create_dir_all(&self.skills_dir)?;
        }
        let _ = crate::skills::provenance::ensure_evolution_dirs(&self.skills_dir);
        let _ = crate::skills::provenance::migrate_flat_skills_to_installed(&self.skills_dir);

        self.skills.clear();
        let scan_roots = [
            self.skills_dir.clone(),
            crate::skills::provenance::installed_dir(&self.skills_dir),
            crate::skills::provenance::draft_dir(&self.skills_dir),
            crate::skills::provenance::learned_dir(&self.skills_dir),
        ];
        for root in scan_roots {
            if !root.exists() {
                continue;
            }
            let entries = match std::fs::read_dir(&root) {
                Ok(e) => e,
                Err(e) => {
                    warn!("Failed to read skill root {:?}: {}", root, e);
                    continue;
                }
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if crate::skills::provenance::is_reserved_dir_name(&name) {
                    continue;
                }
                let skill_file = path.join("SKILL.md");
                if !skill_file.exists() {
                    continue;
                }
                match self.load_skill(&skill_file) {
                    Ok(skill) => {
                        info!("Loaded skill: {} ({})", skill.name, skill.lifecycle);
                        self.skills.insert(skill.skill_id.clone(), skill);
                    }
                    Err(e) => {
                        warn!("Failed to load skill from {:?}: {}", skill_file, e);
                    }
                }
            }
        }
        Ok(())
    }

    fn load_skill(&self, path: &Path) -> Result<SkillDefinition> {
        let raw = std::fs::read(path).with_context(|| format!("Failed to read {:?}", path))?;
        let raw = if raw.starts_with(b"\xEF\xBB\xBF") {
            &raw[3..]
        } else {
            &raw[..]
        };
        let content = String::from_utf8_lossy(raw).into_owned();
        let (frontmatter, instructions) = parse_frontmatter(&content)?;

        let tools = frontmatter
            .get("tools")
            .and_then(|v| v.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let skill_id = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("unnamed")
            .to_string();
        let lifecycle =
            crate::skills::provenance::infer_lifecycle_from_path(&self.skills_dir, path);

        Ok(SkillDefinition {
            name: frontmatter
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("unnamed")
                .to_string(),
            description: frontmatter
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            version: frontmatter
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("1.0")
                .to_string(),
            tools,
            lifecycle: lifecycle.clone(),
            locked: matches!(
                lifecycle.as_str(),
                crate::skills::provenance::LIFECYCLE_INSTALLED
                    | crate::skills::provenance::LIFECYCLE_ARCHIVED
            ),
            skill_id,
            instructions,
            source_path: path.parent().unwrap_or(path).to_path_buf(),
        })
    }

    pub fn list_skills(&self) -> Vec<&SkillDefinition> {
        self.skills.values().collect()
    }

    pub fn parse_skill_from_content(&self, content: &str) -> Result<SkillDefinition> {
        let (frontmatter, instructions) = parse_frontmatter(content)?;
        let tools = frontmatter
            .get("tools")
            .and_then(|v| v.as_sequence())
            .map(|seq| {
                seq.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let name = frontmatter
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("unnamed")
            .to_string();
        Ok(SkillDefinition {
            name: name.clone(),
            description: frontmatter
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            version: frontmatter
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("1.0")
                .to_string(),
            tools,
            lifecycle: crate::skills::provenance::LIFECYCLE_INSTALLED.to_string(),
            locked: true,
            skill_id: crate::skills::service::sanitize_skill_id(&name),
            instructions,
            source_path: PathBuf::from("."),
        })
    }
}

fn parse_frontmatter(content: &str) -> Result<(serde_yaml::Value, String)> {
    let content = content.trim();
    if let Some(stripped) = content.strip_prefix("---") {
        if let Some(end) = stripped.find("---") {
            let yaml_str = &stripped[..end];
            let instructions = stripped[end + 3..].trim().to_string();
            let frontmatter: serde_yaml::Value = serde_yaml::from_str(yaml_str)
                .with_context(|| "Failed to parse YAML frontmatter")?;
            return Ok((frontmatter, instructions));
        }
    }
    Ok((
        serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        content.to_string(),
    ))
}
