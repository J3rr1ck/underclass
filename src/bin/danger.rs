use clap::{Parser, Subcommand};
use colored::Colorize;
use reqwest::Client;
use std::process::Command;
use std::time::Duration;
use underclass::agent::r#loop::{run_agent_loop, AgentSession};
use underclass::shell::assist::run_assist;
use underclass::shell::install::{install_zsh_plugin, uninstall_zsh_plugin};

#[derive(Parser)]
#[command(name = "danger")]
#[command(version = "0.1.0-alpha.1")]
#[command(about = "AI-assisted command runner and zsh shell integration (Rust rewrite)", long_about = None)]
struct Cli {
    #[arg(long)]
    yolo: bool,

    #[arg(long)]
    explain: bool,

    #[arg(long, default_value_t = 1)]
    retries: usize,

    #[arg(long)]
    yes: bool,

    #[arg(trailing_var_arg = true)]
    cmd_args: Vec<String>,

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Explain the last command failure from environment or argument
    Why {
        status: Option<i32>,
        cmd: Option<String>,
    },
    /// Edit a file based on plain text description
    Edit {
        file: String,
        change: String,

        #[arg(long)]
        yes: bool,
    },
    /// Assist subshell command helper
    Assist {
        input: String,

        #[arg(long)]
        hint: bool,
    },
    /// Subshell with danger integration enabled
    Shell,
    /// Install zsh integration into ~/.zshrc
    Init {
        #[arg(long)]
        login_shell: bool,
    },
    /// Uninstall zsh integration from ~/.zshrc
    UninstallShell,
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    if let Some(cmd) = cli.command {
        match cmd {
            Commands::Why { status, cmd } => {
                let env_cmd = std::env::var("DANGER_LAST_CMD").ok().or(cmd);
                let env_status = std::env::var("DANGER_LAST_STATUS").ok().and_then(|s| s.parse().ok()).or(status);

                if let (Some(cmdline), Some(stat)) = (env_cmd, env_status) {
                    println!("{}", format!("Diagnosing failure of: {} (exit code {})", cmdline.bold(), stat).cyan());
                    let client = Client::builder().timeout(Duration::from_secs(10)).build().unwrap_or_default();
                    let session = AgentSession {
                        provider: "danger".to_string(),
                        model_id: "minimax-m2.7-jangtq-crack".to_string(),
                        base_url: "https://api.danger.plus/v1".to_string(),
                        api_key: "danger_token_guest_mode".to_string(),
                        context_window: 128000,
                        max_tokens: 8192,
                    };
                    let cwd = std::env::current_dir().unwrap_or_default();
                    let prompt = format!("Command failed: {}\nExit status: {}\nExplain why it failed and how to fix it.", cmdline, stat);
                    let _ = run_agent_loop(&session, &client, &prompt, &cwd, 10).await;
                } else {
                    println!("No recorded command failure found in environment.");
                }
            }
            Commands::Edit { file, change, yes: _ } => {
                let cwd = std::env::current_dir().unwrap_or_default();
                let client = Client::builder().timeout(Duration::from_secs(10)).build().unwrap_or_default();
                let session = AgentSession {
                    provider: "danger".to_string(),
                    model_id: "minimax-m2.7-jangtq-crack".to_string(),
                    base_url: "https://api.danger.plus/v1".to_string(),
                    api_key: "danger_token_guest_mode".to_string(),
                    context_window: 128000,
                    max_tokens: 8192,
                };
                let prompt = format!("Edit file '{}' according to instruction: '{}'", file, change);
                let _ = run_agent_loop(&session, &client, &prompt, &cwd, 10).await;
            }
            Commands::Assist { input, hint } => {
                run_assist(&input, hint).await;
            }
            Commands::Shell => {
                println!("{}", "Spawning zsh subshell with danger integration...".cyan());
                let _ = Command::new("zsh").status();
            }
            Commands::Init { login_shell } => {
                if let Err(e) = install_zsh_plugin(login_shell) {
                    eprintln!("Failed to install zsh plugin: {e}");
                }
            }
            Commands::UninstallShell => {
                if let Err(e) = uninstall_zsh_plugin() {
                    eprintln!("Failed to uninstall zsh plugin: {e}");
                }
            }
        }
        return;
    }

    if cli.cmd_args.is_empty() {
        println!("{}", "danger v0.1.0-alpha.1 (Rust) — your shell, with help built in".bold().cyan());
        println!("Usage: danger <command> [args...]");
        println!("Run `danger --help` for available options.");
        return;
    }

    let cmd = &cli.cmd_args[0];
    let args = &cli.cmd_args[1..];

    for attempt in 1..=cli.retries.max(1) {
        println!("Executing (attempt {attempt}/{}): {} {}", cli.retries.max(1), cmd, args.join(" "));

        let status = Command::new(cmd).args(args).status();
        match status {
            Ok(s) => {
                if s.success() {
                    println!("{}", "Command succeeded!".bold().green());
                    break;
                } else {
                    let code = s.code().unwrap_or(-1);
                    println!("\n{}", format!("Command failed with exit code {code}").red().bold());
                    if cli.explain || cli.yolo {
                        let cwd = std::env::current_dir().unwrap_or_default();
                        let client = Client::builder().timeout(Duration::from_secs(10)).build().unwrap_or_default();
                        let session = AgentSession {
                            provider: "danger".to_string(),
                            model_id: "minimax-m2.7-jangtq-crack".to_string(),
                            base_url: "https://api.danger.plus/v1".to_string(),
                            api_key: "danger_token_guest_mode".to_string(),
                            context_window: 128000,
                            max_tokens: 8192,
                        };
                        let prompt = format!("The command '{} {}' failed with code {}. {}", cmd, args.join(" "), code, if cli.yolo { "Fix the code." } else { "Explain the failure." });
                        let _ = run_agent_loop(&session, &client, &prompt, &cwd, 10).await;
                    }
                }
            }
            Err(e) => {
                eprintln!("Failed to run command {cmd}: {e}");
                break;
            }
        }
    }
}
