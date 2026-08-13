use clap::{Parser, Subcommand};
use colored::Colorize;
use reqwest::Client;
use std::fs::read_to_string;
use std::path::PathBuf;
use std::time::Duration;
use underclass::agent::r#loop::{run_agent_loop, AgentSession};
use underclass::config::{pick_model_spec, write_models_json, KNOWN_PROVIDERS, ModelsJson, UnderOptions};
use underclass::doctor::{run_doctor, DoctorOptions};
use underclass::engines::LOCAL_ENGINES;
use underclass::fanout::{commit_and_clean_worktree, create_worktree, FanOutTask};
use underclass::free_models::fetch_free_models;
use underclass::learn::run_learn;
use underclass::preferences::remember_preference;
use underclass::setup::run_setup;
use underclass::stats::print_stats;
use underclass::workflow::runtime::run_workflow_script;

#[derive(Parser)]
#[command(name = "under")]
#[command(version = "0.1.0-alpha.1")]
#[command(about = "Token-efficient, high-performance local-first coding agent (Rust rewrite)", long_about = None)]
struct Cli {
    #[arg(short = 'm', long)]
    model: Option<String>,

    #[arg(long)]
    provider: Option<String>,

    #[arg(long)]
    list_providers: bool,

    #[arg(long)]
    lmstudio: bool,

    #[arg(long)]
    ollama: bool,

    #[arg(long)]
    vllm: bool,

    #[arg(long)]
    huggingface: bool,

    #[arg(long)]
    base_url: Option<String>,

    #[arg(long)]
    api_key: Option<String>,

    #[arg(long)]
    plan: bool,

    #[arg(long)]
    timeout: Option<u64>,

    #[arg(long)]
    tier: Option<String>,

    #[arg(long)]
    tools: Option<String>,

    #[arg(long)]
    free: bool,

    #[arg(long)]
    list_free: bool,

    #[arg(long)]
    list_models: bool,

    /// One-shot prompt text
    #[arg(trailing_var_arg = true)]
    prompt: Vec<String>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Guided first-run setup: scan local engines, test reachability, save config
    Setup,
    /// Phased readiness check for tools, endpoints, model context windows
    Doctor {
        #[arg(long)]
        offline: bool,

        #[arg(long)]
        deep: bool,

        #[arg(long)]
        benchmark: bool,
    },
    /// Spawn parallel agents in isolated git worktrees
    FanOut {
        #[arg(long)]
        task: Vec<String>,

        #[arg(long)]
        tasks: Option<PathBuf>,

        #[arg(long)]
        base: Option<String>,

        #[arg(long)]
        target: Option<String>,

        #[arg(long)]
        no_merge: bool,

        #[arg(long)]
        pr: bool,
    },
    /// Orchestrate multi-phase workflow scripts
    Workflow {
        script: PathBuf,
    },
    /// View recorded token usage, tool metrics, and run history
    Stats {
        #[arg(short, long)]
        verbose: bool,

        #[arg(long)]
        model: Option<String>,

        #[arg(long)]
        since: Option<String>,
    },
    /// Derive model-map verdicts and servedContext recommendations from run logs
    Learn {
        #[arg(long)]
        apply: bool,
    },
    /// Save a standing instruction preference injected into future runs
    Remember {
        text: String,

        #[arg(long)]
        project: bool,
    },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let client_timeout = cli.timeout.unwrap_or(120);
    let client = Client::builder().timeout(Duration::from_secs(client_timeout)).build().unwrap_or_default();

    if cli.list_providers {
        println!("{}", "=== Underclass Supported Providers & Engines ===".bold().cyan());
        for p in KNOWN_PROVIDERS {
            let note = match *p {
                "danger" => "Hosted zero-config gateway (danger.plus)",
                "vllm" => "vLLM High-throughput Engine (localhost:8000)",
                "huggingface" => "Hugging Face Inference Router (router.huggingface.co)",
                "lmstudio" => "LM Studio Local Server (localhost:1234)",
                "ollama" => "Ollama Local Server (localhost:11434)",
                "llamacpp" => "llama.cpp / llama-server (localhost:8080)",
                "jan" => "Jan Desktop AI (localhost:1337)",
                "koboldcpp" => "KoboldCPP Server (localhost:5001)",
                _ => "OpenAI-compatible endpoint",
            };
            println!("  - {:<14} : {}", p.bold(), note);
        }
        return;
    }

    if cli.list_free {
        println!("{}", "=== OpenRouter Free Tool-Capable Models ===".bold().cyan());
        match fetch_free_models(&client).await {
            Ok(models) => {
                for m in models {
                    println!("  - {} (context: {} tokens)", m.id.bold(), m.context_length);
                }
            }
            Err(e) => println!("Error fetching free models: {e}"),
        }
        return;
    }

    let mut provider_choice = cli.provider.clone();
    if cli.lmstudio {
        provider_choice = Some("lmstudio".to_string());
    } else if cli.ollama {
        provider_choice = Some("ollama".to_string());
    } else if cli.vllm {
        provider_choice = Some("vllm".to_string());
    } else if cli.huggingface {
        provider_choice = Some("huggingface".to_string());
    }

    let opts = UnderOptions {
        model: cli.model,
        provider: provider_choice,
        base_url: cli.base_url,
        api_key: cli.api_key,
    };

    let (models_path, live_providers, _) = write_models_json(&client, &opts).await;

    if cli.list_models {
        println!("{}", "=== Resolvable Models & Providers ===".bold().cyan());
        if let Ok(content) = read_to_string(&models_path) {
            if let Ok(mj) = serde_json::from_str::<ModelsJson>(&content) {
                for (p_name, p_cfg) in mj.providers {
                    println!("Provider: {} ({})", p_name.bold(), p_cfg.base_url.cyan());
                    for m in p_cfg.models {
                        println!("  - {} (window: {} tokens)", m.id.yellow(), m.context_window);
                    }
                }
            }
        }
        return;
    }

    if let Some(cmd) = cli.command {
        match cmd {
            Commands::Setup => run_setup().await,
            Commands::Doctor { offline, deep, benchmark } => {
                run_doctor(DoctorOptions { offline, deep, benchmark }).await;
            }
            Commands::FanOut { task, tasks, base, target, no_merge, pr } => {
                let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
                let base_branch = base.unwrap_or_else(|| "main".to_string());
                let target_branch = target.unwrap_or_else(|| base_branch.clone());

                let mut task_specs = Vec::new();
                for t in task {
                    let parts: Vec<&str> = t.splitn(2, ':').collect();
                    if parts.len() == 2 {
                        task_specs.push(FanOutTask {
                            branch: parts[0].to_string(),
                            prompt: parts[1].to_string(),
                            message: None,
                        });
                    }
                }

                if let Some(tasks_file) = tasks {
                    if let Ok(content) = read_to_string(tasks_file) {
                        if let Ok(parsed) = serde_json::from_str::<Vec<FanOutTask>>(&content) {
                            task_specs.extend(parsed);
                        }
                    }
                }

                for t_spec in task_specs {
                    println!("Processing fan-out task branch: {}...", t_spec.branch.bold());
                    if let Ok(wt_dir) = create_worktree(&base_branch, &t_spec.branch, &cwd) {
                        let session = AgentSession {
                            provider: "danger".to_string(),
                            model_id: "minimax-m2.7-jangtq-crack".to_string(),
                            base_url: "https://api.danger.plus/v1".to_string(),
                            api_key: "danger_token_guest_mode".to_string(),
                            context_window: 128000,
                            max_tokens: 8192,
                        };

                        let _ = run_agent_loop(&session, &client, &t_spec.prompt, &wt_dir, 15).await;
                        let report = commit_and_clean_worktree(&t_spec.branch, &target_branch, &wt_dir, &cwd, no_merge, pr);
                        println!("  Result: Branch {} - Success: {}", report.branch, report.success);
                    }
                }
            }
            Commands::Workflow { script } => {
                let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
                let session = AgentSession {
                    provider: "danger".to_string(),
                    model_id: "minimax-m2.7-jangtq-crack".to_string(),
                    base_url: "https://api.danger.plus/v1".to_string(),
                    api_key: "danger_token_guest_mode".to_string(),
                    context_window: 128000,
                    max_tokens: 8192,
                };
                match run_workflow_script(&script, &session, &client, &cwd).await {
                    Ok(rep) => println!("Workflow completed: Success={}", rep.success),
                    Err(e) => eprintln!("Workflow error: {e}"),
                }
            }
            Commands::Stats { verbose, model, since: _ } => {
                print_stats(verbose, model.as_deref());
            }
            Commands::Learn { apply } => {
                run_learn(apply);
            }
            Commands::Remember { text, project } => {
                match remember_preference(text, project) {
                    Ok(_) => println!("{}", "Saved preference successfully.".green()),
                    Err(e) => eprintln!("Failed to save preference: {e}"),
                }
            }
        }
        return;
    }

    let prompt_text = cli.prompt.join(" ");
    if prompt_text.trim().is_empty() {
        println!("{}", "underclass v0.1.0-alpha.1 (Rust) — High-Performance Coding Agent".bold().cyan());
        println!("Pass a prompt or run `under setup` / `under doctor` / `under --help`.");
        return;
    }

    let models_content = std::fs::read_to_string(&models_path).unwrap_or_default();
    let models_json: ModelsJson = serde_json::from_str(&models_content).unwrap_or(ModelsJson { providers: std::collections::HashMap::new() });

    let (selected_provider, selected_model) = match pick_model_spec(&opts, &live_providers, &models_json) {
        Ok((p, m)) => (p, m),
        Err(e) => {
            eprintln!("Model selection error: {e}");
            return;
        }
    };

    let p_config = models_json.providers.get(&selected_provider).unwrap();
    let base_url = p_config.base_url.clone();
    let api_key = p_config.api_key.clone();

    let session = AgentSession {
        provider: selected_provider,
        model_id: selected_model,
        base_url,
        api_key,
        context_window: 128000,
        max_tokens: 8192,
    };

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Err(e) = run_agent_loop(&session, &client, &prompt_text, &cwd, 25).await {
        eprintln!("Agent loop failed: {e}");
    }
}
