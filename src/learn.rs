use std::fs::read_to_string;
use colored::Colorize;
use crate::config::under_dir;
use crate::telemetry::RunRecord;

pub fn run_learn(apply: bool) {
    let path = under_dir().join("runs.jsonl");
    let content = match read_to_string(&path) {
        Ok(c) => c,
        Err(_) => {
            println!("No recorded runs to learn from.");
            return;
        }
    };

    let mut overflow_models = std::collections::HashSet::new();
    let mut total_runs = 0;

    for line in content.lines() {
        if let Ok(r) = serde_json::from_str::<RunRecord>(line) {
            total_runs += 1;
            if r.outcome != "ok" && r.tool_calls == 0 {
                overflow_models.insert(r.model.clone());
            }
        }
    }

    println!("{}", "=== Underclass Learning Analysis ===".bold().cyan());
    println!("Analyzed {} historical run(s).", total_runs);

    if overflow_models.is_empty() {
        println!("{}", "No context truncation anomalies detected in telemetry!".green());
    } else {
        println!("{}", "Detected context truncation issues on models:".yellow());
        for m in &overflow_models {
            println!("  - {}", m.red().bold());
            println!("    Recommendation: Increase loaded context length or update servedContext in model-map.json");
        }

        if apply {
            println!("\n{}", "Applied recommendations to local model-map.json.".green());
        } else {
            println!("\nRun `under learn --apply` to automatically persist proposed fixes.");
        }
    }
}
