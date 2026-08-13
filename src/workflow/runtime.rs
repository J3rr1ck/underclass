use reqwest::Client;
use std::fs::read_to_string;
use std::path::Path;
use colored::Colorize;
use crate::agent::r#loop::{run_agent_loop, AgentSession};
use crate::workflow::journal::{log_journal_entry, JournalEntry};
use crate::workflow::types::{WorkflowReport, WorkflowSpec};

pub async fn run_workflow_script(
    script_path: &Path,
    session: &AgentSession,
    client: &Client,
    cwd: &Path,
) -> Result<WorkflowReport, String> {
    let content = read_to_string(script_path).map_err(|e| format!("Failed to read workflow script: {e}"))?;
    let spec: WorkflowSpec = if script_path.extension().map_or(false, |ext| ext == "json") {
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON workflow: {e}"))?
    } else {
        serde_yaml::from_str(&content).map_err(|e| format!("Invalid YAML workflow: {e}"))?
    };

    println!("{}", format!("Running Workflow: {}", spec.name).bold().cyan());

    let mut logs = Vec::new();
    let total_steps = spec.steps.len();
    let mut completed_steps = 0;

    for (idx, step) in spec.steps.iter().enumerate() {
        println!("{}", format!("\n[Phase {}/{}] {}", idx + 1, total_steps, step.name).bold().yellow());
        log_journal_entry(&JournalEntry {
            timestamp: chrono::Utc::now().to_rfc3339(),
            workflow_name: spec.name.clone(),
            step_name: step.name.clone(),
            status: "started".to_string(),
            detail: step.prompt.clone(),
        });

        match run_agent_loop(session, client, &step.prompt, cwd, 15).await {
            Ok(res) => {
                completed_steps += 1;
                logs.push(format!("Step {}: OK", step.name));
                log_journal_entry(&JournalEntry {
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    workflow_name: spec.name.clone(),
                    step_name: step.name.clone(),
                    status: "completed".to_string(),
                    detail: res,
                });
            }
            Err(e) => {
                logs.push(format!("Step {}: FAILED ({e})", step.name));
                log_journal_entry(&JournalEntry {
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    workflow_name: spec.name.clone(),
                    step_name: step.name.clone(),
                    status: "failed".to_string(),
                    detail: e.clone(),
                });
                return Ok(WorkflowReport {
                    workflow_name: spec.name,
                    success: false,
                    completed_steps,
                    total_steps,
                    logs,
                });
            }
        }
    }

    Ok(WorkflowReport {
        workflow_name: spec.name,
        success: true,
        completed_steps,
        total_steps,
        logs,
    })
}
