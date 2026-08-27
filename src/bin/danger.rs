use clap::{Parser, Subcommand};
use colored::Colorize;
use reqwest::Client;
use std::process::Command;
use std::time::Duration;
use underclass::agent::r#loop::{run_agent_loop, AgentSession};
use underclass::config::{pick_model_spec, write_models_json, ModelsJson, UnderOptions};
use underclass::shell::assist::run_assist;
use underclass::shell::install::{
    detect_installed_shells, install_shell_plugin, start_subshell_for, uninstall_shell_plugin, ShellType,
};

/// `danger` has no --base-url/--api-key/-m of its own -- its whole design is
/// "just works" with whatever's already configured. The three call sites
/// below used to hardcode api.danger.plus + a guest key directly, which ran
/// EVERY danger command through the remote gateway regardless of what a user
/// had already set up via `under setup` (the same bug class already fixed in
/// under.rs's own model selection). This runs the identical discovery
/// under.rs's main() does -- write_models_json() + pick_model_spec() against
/// UnderOptions::default() (danger takes no model flags of its own) -- so
/// `danger why`/`edit`/the retry-loop's explain/--yolo branch land on
/// whatever local or configured endpoint the user actually has live.
async fn resolve_danger_session(client: &Client) -> Result<AgentSession, String> {
    let opts = UnderOptions { model: None, provider: None, base_url: None, api_key: None };
    let (models_path, live_providers, _) = write_models_json(client, &opts).await;
    let models_content = std::fs::read_to_string(&models_path).unwrap_or_default();
    let models_json: ModelsJson =
        serde_json::from_str(&models_content).unwrap_or(ModelsJson { providers: std::collections::HashMap::new() });

    let (provider, model_id) = pick_model_spec(&opts, &live_providers, &models_json)?;
    let p_config = models_json
        .providers
        .get(&provider)
        .ok_or_else(|| format!("no config found for provider '{provider}'"))?;

    Ok(AgentSession {
        provider,
        model_id,
        base_url: p_config.base_url.clone(),
        api_key: p_config.api_key.clone(),
        context_window: 128000,
        max_tokens: 8192,
    })
}

#[derive(Parser)]
#[command(name = "danger")]
#[command(version = "0.1.0-alpha.1")]
#[command(about = "AI-assisted command runner and multi-shell integration (Rust rewrite)", long_about = None)]
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
    /// Interactive subshell with danger integration enabled (zsh, bash, fish, nu)
    Shell {
        #[arg(long)]
        shell: Option<String>,
    },
    /// Install shell integration (~/.zshrc, ~/.bashrc, ~/.config/fish, ~/.config/nushell)
    Init {
        #[arg(long)]
        shell: Option<String>,

        #[arg(long)]
        login_shell: bool,
    },
    /// Uninstall shell integration
    UninstallShell {
        #[arg(long)]
        shell: Option<String>,
    },
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
                    let session = match resolve_danger_session(&client).await {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("danger why: {e}");
                            return;
                        }
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
                let session = match resolve_danger_session(&client).await {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("danger edit: {e}");
                        return;
                    }
                };
                let prompt = format!("Edit file '{}' according to instruction: '{}'", file, change);
                let _ = run_agent_loop(&session, &client, &prompt, &cwd, 10).await;
            }
            Commands::Assist { input, hint } => {
                run_assist(&input, hint).await;
            }
            Commands::Shell { shell } => {
                let target = shell
                    .as_deref()
                    .and_then(ShellType::parse)
                    .unwrap_or_else(|| detect_installed_shells().first().copied().unwrap_or(ShellType::Zsh));
                let code = start_subshell_for(target);
                std::process::exit(code);
            }
            Commands::Init { shell, login_shell } => {
                let targets = match shell.as_deref() {
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

                for sh in targets {
                    if let Err(e) = install_shell_plugin(sh, login_shell) {
                        eprintln!("Failed to install {sh} plugin: {e}");
                    }
                }
            }
            Commands::UninstallShell { shell } => {
                let targets = match shell.as_deref() {
                    Some("all") => vec![ShellType::Zsh, ShellType::Bash, ShellType::Fish, ShellType::Nushell],
                    Some(s) => {
                        if let Some(parsed) = ShellType::parse(s) {
                            vec![parsed]
                        } else {
                            detect_installed_shells()
                        }
                    }
                    None => detect_installed_shells(),
                };

                for sh in targets {
                    if let Err(e) = uninstall_shell_plugin(sh) {
                        eprintln!("Failed to uninstall {sh} plugin: {e}");
                    }
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
                        let session = match resolve_danger_session(&client).await {
                            Ok(s) => s,
                            Err(e) => {
                                eprintln!("danger: {e}");
                                return;
                            }
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
