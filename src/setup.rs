use colored::Colorize;
use reqwest::Client;
use std::time::Duration;
use crate::config::{write_models_json, UnderOptions};
use crate::engines::discover_all_local_engines;
use crate::shell::install::{detect_installed_shells, install_shell_plugin, ShellType};

pub async fn run_setup(shell_choice: Option<String>) {
    println!("{}", "=== Underclass Guided Setup ===".bold().cyan());
    println!("Scanning for active local inference engines and model endpoints...\n");

    let client = Client::builder().timeout(Duration::from_secs(4)).build().unwrap_or_default();
    let discovered = discover_all_local_engines(&client).await;

    if !discovered.is_empty() {
        println!("{}", "Found active local engine(s):".bold().green());
        for (i, eng) in discovered.iter().enumerate() {
            println!("  [{}] {} at {}", i + 1, eng.name.bold(), eng.base_url.cyan());
            for m in &eng.available_models {
                println!("      - {}", m.id);
            }
        }
    } else {
        println!("{}", "No active local servers detected on standard ports.".yellow());
        println!("You can start LM Studio (port 1234), Ollama (port 11434), vLLM (port 8000), llama.cpp (port 8080), Jan (port 1337), or KoboldCPP (port 5001).");
    }

    let opts = UnderOptions::default();
    let (models_path, live_providers, _) = write_models_json(&client, &opts).await;

    println!("\n{}", "[Shell Integrations Configuration]".bold().cyan());
    let target_shells = match shell_choice.as_deref() {
        Some("all") => vec![ShellType::Zsh, ShellType::Bash, ShellType::Fish, ShellType::Nushell],
        Some(s) => {
            if let Some(parsed) = ShellType::parse(s) {
                vec![parsed]
            } else {
                eprintln!("Unknown shell '{s}', auto-detecting installed user shells.");
                detect_installed_shells()
            }
        }
        None => detect_installed_shells(),
    };

    for shell in &target_shells {
        if let Err(e) = install_shell_plugin(*shell, false) {
            eprintln!("Failed to install {shell} integration: {e}");
        }
    }

    println!("\n{}", "Setup Complete!".bold().green());
    println!("Configuration generated at: {}", models_path.display().to_string().cyan());
    println!("Live providers active: {}", live_providers.join(", ").yellow());
    println!("Shell integrations configured: {}", target_shells.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(", ").cyan());
    println!("\nTry running a task: {}", "under \"Explain the architecture of this repo\"".bold());
}
