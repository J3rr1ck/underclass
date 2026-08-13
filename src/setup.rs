use colored::Colorize;
use reqwest::Client;
use std::time::Duration;
use crate::config::{write_models_json, UnderOptions};
use crate::engines::discover_all_local_engines;

pub async fn run_setup() {
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

    println!("\n{}", "Setup Complete!".bold().green());
    println!("Configuration generated at: {}", models_path.display().to_string().cyan());
    println!("Live providers active: {}", live_providers.join(", ").yellow());
    println!("\nTry running a task: {}", "under \"Explain the architecture of this repo\"".bold());
}
