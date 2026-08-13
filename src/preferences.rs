use serde::{Deserialize, Serialize};
use std::fs::{read_to_string, write};
use std::path::PathBuf;
use crate::config::under_dir;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Preferences {
    #[serde(default)]
    pub standing_instructions: Vec<String>,
}

pub fn load_preferences(project_local: bool) -> Preferences {
    let path = if project_local {
        PathBuf::from(".underclass").join("preferences.json")
    } else {
        under_dir().join("preferences.json")
    };

    if let Ok(content) = read_to_string(path) {
        if let Ok(prefs) = serde_json::from_str::<Preferences>(&content) {
            return prefs;
        }
    }
    Preferences::default()
}

pub fn remember_preference(text: String, project_local: bool) -> Result<(), String> {
    let mut prefs = load_preferences(project_local);
    if !prefs.standing_instructions.contains(&text) {
        prefs.standing_instructions.push(text);
    }

    let path = if project_local {
        let dir = PathBuf::from(".underclass");
        let _ = std::fs::create_dir_all(&dir);
        dir.join("preferences.json")
    } else {
        under_dir().join("preferences.json")
    };

    let serialized = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    write(path, serialized).map_err(|e| e.to_string())?;
    Ok(())
}
