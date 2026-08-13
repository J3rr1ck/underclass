use colored::Colorize;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{create_dir_all, read_to_string, set_permissions, write, Permissions};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use crate::config::under_dir;
use crate::shell::rules::emit_zsh_rules;

pub const MARKER_START: &str = "# >>> danger shell integration >>>";
pub const MARKER_END: &str = "# <<< danger shell integration <<<";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ShellType {
    Zsh,
    Bash,
    Fish,
    Nushell,
}

impl fmt::Display for ShellType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ShellType::Zsh => write!(f, "zsh"),
            ShellType::Bash => write!(f, "bash"),
            ShellType::Fish => write!(f, "fish"),
            ShellType::Nushell => write!(f, "nushell"),
        }
    }
}

impl ShellType {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().trim() {
            "zsh" => Some(ShellType::Zsh),
            "bash" => Some(ShellType::Bash),
            "fish" => Some(ShellType::Fish),
            "nu" | "nushell" => Some(ShellType::Nushell),
            _ => None,
        }
    }
}

pub fn shell_dir() -> PathBuf {
    under_dir().join("shell")
}

pub fn detect_installed_shells() -> Vec<ShellType> {
    let mut detected = Vec::new();
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));

    if which_bin("zsh").is_some() || home.join(".zshrc").exists() {
        detected.push(ShellType::Zsh);
    }
    if which_bin("bash").is_some() || home.join(".bashrc").exists() {
        detected.push(ShellType::Bash);
    }
    if which_bin("fish").is_some() || home.join(".config/fish").exists() {
        detected.push(ShellType::Fish);
    }
    if which_bin("nu").is_some() || home.join(".config/nushell").exists() {
        detected.push(ShellType::Nushell);
    }

    if detected.is_empty() {
        detected.push(ShellType::Zsh);
    }
    detected
}

fn which_bin(name: &str) -> Option<String> {
    let candidates = match name {
        "zsh" => vec!["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh", "/opt/homebrew/bin/zsh"],
        "bash" => vec!["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"],
        "fish" => vec!["/usr/bin/fish", "/usr/local/bin/fish", "/opt/homebrew/bin/fish"],
        "nu" => vec!["/usr/bin/nu", "/usr/local/bin/nu", "/opt/homebrew/bin/nu"],
        _ => vec![],
    };
    for c in candidates {
        if Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    let output = Command::new("which").arg(name).output().ok()?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return Some(path);
        }
    }
    None
}

pub fn stage_assets() -> Result<(PathBuf, PathBuf), String> {
    let dir = shell_dir();
    create_dir_all(&dir).map_err(|e| e.to_string())?;

    let plugin_path = dir.join("danger.plugin.zsh");
    let plugin_content = include_str!("plugin.zsh");
    write(&plugin_path, plugin_content).map_err(|e| e.to_string())?;

    let bash_plugin_path = dir.join("danger.plugin.bash");
    let bash_plugin_content = r#"# danger shell integration for Bash
danger_assist_widget() {
    local READLINE_LINE_OLD="$READLINE_LINE"
    local READLINE_POINT_OLD=$READLINE_POINT
    local OUT
    OUT=$(danger assist "$READLINE_LINE" 2>/dev/null)
    if [ -n "$OUT" ]; then
        READLINE_LINE="$OUT"
        READLINE_POINT=${#READLINE_LINE}
    fi
}
bind -x '"\C-x\C-a": danger_assist_widget'
alias danger='under'
"#;
    write(&bash_plugin_path, bash_plugin_content).map_err(|e| e.to_string())?;

    let fish_plugin_path = dir.join("danger.fish");
    let fish_plugin_content = r#"# danger shell integration for Fish
function danger_assist_widget
    set -l command_line (commandline)
    if test -n "$command_line"
        set -l suggestion (danger assist "$command_line" 2>/dev/null)
        if test -n "$suggestion"
            commandline -r "$suggestion"
        end
    end
end

bind \cx\ca danger_assist_widget
alias danger='under'
"#;
    write(&fish_plugin_path, fish_plugin_content).map_err(|e| e.to_string())?;

    let nu_plugin_path = dir.join("danger.nu");
    let nu_plugin_content = r#"# danger shell integration for Nushell
def danger [prompt?: string] {
    if ($prompt == null) {
        under
    } else {
        under $prompt
    }
}
"#;
    write(&nu_plugin_path, nu_plugin_content).map_err(|e| e.to_string())?;

    let rules_path = dir.join("danger-rules.zsh");
    let rules_content = emit_zsh_rules();
    write(&rules_path, rules_content).map_err(|e| e.to_string())?;

    stage_bin_shim()?;
    Ok((plugin_path, rules_path))
}

pub fn stage_bin_shim() -> Result<PathBuf, String> {
    let bin_dir = shell_dir().join("bin");
    create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    let shim = bin_dir.join("danger");

    let current_exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("danger"));
    let shim_content = format!(
        "#!/bin/sh\n# Generated by danger. Points at the install that created it.\nexec {} \"$@\"\n",
        current_exe.display()
    );
    write(&shim, shim_content).map_err(|e| e.to_string())?;
    set_permissions(&shim, Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;

    Ok(bin_dir)
}

pub fn stage_zdotdir() -> Result<PathBuf, String> {
    let zdot_dir = shell_dir().join("zdotdir");
    create_dir_all(&zdot_dir).map_err(|e| e.to_string())?;
    let plugin = shell_dir().join("danger.plugin.zsh");

    write(
        zdot_dir.join(".zshenv"),
        "# Generated by danger init --login-shell. Forwards to your real rc files.\n\
         : ${DANGER_REAL_ZDOTDIR:=${DANGER_PREV_ZDOTDIR:-$HOME}}\n\
         export DANGER_REAL_ZDOTDIR\n\
         [[ -r \"$DANGER_REAL_ZDOTDIR/.zshenv\" ]] && source \"$DANGER_REAL_ZDOTDIR/.zshenv\"\n",
    ).map_err(|e| e.to_string())?;

    for f in [".zprofile", ".zlogin", ".zlogout"] {
        write(
            zdot_dir.join(f),
            format!("[[ -r \"${{DANGER_REAL_ZDOTDIR:-$HOME}}/{f}\" ]] && source \"${{DANGER_REAL_ZDOTDIR:-$HOME}}/{f}\"\n"),
        ).map_err(|e| e.to_string())?;
    }

    write(
        zdot_dir.join(".zshrc"),
        format!(
            "[[ -r \"${{DANGER_REAL_ZDOTDIR:-$HOME}}/.zshrc\" ]] && source \"${{DANGER_REAL_ZDOTDIR:-$HOME}}/.zshrc\"\n\
             [[ -r \"{}\" ]] && source \"{}\"\n",
            plugin.display(), plugin.display()
        ),
    ).map_err(|e| e.to_string())?;

    Ok(zdot_dir)
}

pub fn stage_login_stub() -> Result<PathBuf, String> {
    let stub = shell_dir().join("danger-shell");
    let zsh_path = which_bin("zsh").unwrap_or_else(|| "zsh".to_string());
    let zdot = shell_dir().join("zdotdir");

    let content = format!(
        "#!/bin/sh\n\
         DANGER_PREV_ZDOTDIR=\"${{ZDOTDIR:-$HOME}}\"\n\
         export DANGER_PREV_ZDOTDIR\n\
         ZDOTDIR=\"{}\"\n\
         export ZDOTDIR\n\
         case \"$0\" in\n\
           -*) exec \"{}\" -l \"$@\" ;;\n\
           *)  exec \"{}\" \"$@\" ;;\n\
         esac\n",
        zdot.display(),
        zsh_path,
        zsh_path
    );

    write(&stub, content).map_err(|e| e.to_string())?;
    set_permissions(&stub, Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    Ok(stub)
}

pub fn install_shell_plugin(shell: ShellType, login_shell: bool) -> Result<(), String> {
    let _ = stage_assets()?;
    let home = dirs::home_dir().ok_or_else(|| "Cannot locate home directory".to_string())?;

    match shell {
        ShellType::Zsh => {
            let zshrc = home.join(".zshrc");
            let plugin_path = shell_dir().join("danger.plugin.zsh");
            let block = format!(
                "{MARKER_START}\n# Remove this block, or run `danger uninstall-shell`, to undo.\n[[ -r \"{}\" ]] && source \"{}\"\n{MARKER_END}",
                plugin_path.display(), plugin_path.display()
            );

            let existing = read_to_string(&zshrc).unwrap_or_default();
            if existing.contains(MARKER_START) {
                let re = regex::Regex::new(&format!("{}[\\s\\S]*?{}", regex::escape(MARKER_START), regex::escape(MARKER_END))).unwrap();
                let updated = re.replace(&existing, block.as_str()).to_string();
                write(&zshrc, updated).map_err(|e| e.to_string())?;
                println!("{}", format!("danger: updated Zsh integration in {}", zshrc.display()).yellow());
            } else {
                let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
                let new_content = format!("{existing}{sep}\n{block}\n");
                write(&zshrc, new_content).map_err(|e| e.to_string())?;
                println!("{}", format!("danger: added Zsh integration to {}", zshrc.display()).green());
            }

            if login_shell {
                stage_zdotdir()?;
                let login_stub = stage_login_stub()?;
                println!("\n  To make it your login shell:\n    sudo sh -c 'echo {} >> /etc/shells'\n    chsh -s {}", login_stub.display(), login_stub.display());
            }
            println!("\nOpen a new Zsh session or run: {}", "source ~/.zshrc".cyan().bold());
        }

        ShellType::Bash => {
            let bashrc = home.join(".bashrc");
            let plugin_path = shell_dir().join("danger.plugin.bash");
            let block = format!(
                "{MARKER_START}\n# Remove this block, or run `danger uninstall-shell --shell bash`, to undo.\n[ -r \"{}\" ] && source \"{}\"\n{MARKER_END}",
                plugin_path.display(), plugin_path.display()
            );

            let existing = read_to_string(&bashrc).unwrap_or_default();
            if existing.contains(MARKER_START) {
                let re = regex::Regex::new(&format!("{}[\\s\\S]*?{}", regex::escape(MARKER_START), regex::escape(MARKER_END))).unwrap();
                let updated = re.replace(&existing, block.as_str()).to_string();
                write(&bashrc, updated).map_err(|e| e.to_string())?;
                println!("{}", format!("danger: updated Bash integration in {}", bashrc.display()).yellow());
            } else {
                let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
                let new_content = format!("{existing}{sep}\n{block}\n");
                write(&bashrc, new_content).map_err(|e| e.to_string())?;
                println!("{}", format!("danger: added Bash integration to {}", bashrc.display()).green());
            }
            println!("\nOpen a new Bash session or run: {}", "source ~/.bashrc".cyan().bold());
        }

        ShellType::Fish => {
            let fish_config_dir = home.join(".config").join("fish").join("conf.d");
            create_dir_all(&fish_config_dir).map_err(|e| e.to_string())?;
            let fish_conf = fish_config_dir.join("danger.fish");
            let plugin_path = shell_dir().join("danger.fish");
            let content = format!(
                "{MARKER_START}\n# Remove this file, or run `danger uninstall-shell --shell fish`, to undo.\ntest -r \"{}\"; and source \"{}\"\n{MARKER_END}\n",
                plugin_path.display(), plugin_path.display()
            );
            write(&fish_conf, content).map_err(|e| e.to_string())?;
            println!("{}", format!("danger: added Fish integration to {}", fish_conf.display()).green());
            println!("\nOpen a new Fish session or run: {}", "source ~/.config/fish/config.fish".cyan().bold());
        }

        ShellType::Nushell => {
            let nu_config = home.join(".config").join("nushell").join("config.nu");
            let plugin_path = shell_dir().join("danger.nu");
            let block = format!(
                "{MARKER_START}\nsource \"{}\"\n{MARKER_END}",
                plugin_path.display()
            );

            let existing = read_to_string(&nu_config).unwrap_or_default();
            if existing.contains(MARKER_START) {
                let re = regex::Regex::new(&format!("{}[\\s\\S]*?{}", regex::escape(MARKER_START), regex::escape(MARKER_END))).unwrap();
                let updated = re.replace(&existing, block.as_str()).to_string();
                let _ = write(&nu_config, updated);
                println!("{}", format!("danger: updated Nushell integration in {}", nu_config.display()).yellow());
            } else if nu_config.exists() {
                let sep = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
                let new_content = format!("{existing}{sep}\n{block}\n");
                let _ = write(&nu_config, new_content);
                println!("{}", format!("danger: added Nushell integration to {}", nu_config.display()).green());
            } else {
                let _ = create_dir_all(nu_config.parent().unwrap());
                let _ = write(&nu_config, format!("{block}\n"));
                println!("{}", format!("danger: created Nushell integration at {}", nu_config.display()).green());
            }
        }
    }

    Ok(())
}

pub fn uninstall_shell_plugin(shell: ShellType) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot locate home directory".to_string())?;

    match shell {
        ShellType::Zsh => {
            let zshrc = home.join(".zshrc");
            if zshrc.exists() {
                let content = read_to_string(&zshrc).unwrap_or_default();
                let re = regex::Regex::new(&format!("\\n?{}[\\s\\S]*?{}\\n?", regex::escape(MARKER_START), regex::escape(MARKER_END))).unwrap();
                let cleaned = re.replace_all(&content, "\n").to_string();
                write(&zshrc, cleaned).map_err(|e| e.to_string())?;
                println!("{}", format!("danger: removed Zsh integration from {}", zshrc.display()).green());
            }
        }
        ShellType::Bash => {
            let bashrc = home.join(".bashrc");
            if bashrc.exists() {
                let content = read_to_string(&bashrc).unwrap_or_default();
                let re = regex::Regex::new(&format!("\\n?{}[\\s\\S]*?{}\\n?", regex::escape(MARKER_START), regex::escape(MARKER_END))).unwrap();
                let cleaned = re.replace_all(&content, "\n").to_string();
                write(&bashrc, cleaned).map_err(|e| e.to_string())?;
                println!("{}", format!("danger: removed Bash integration from {}", bashrc.display()).green());
            }
        }
        ShellType::Fish => {
            let fish_conf = home.join(".config").join("fish").join("conf.d").join("danger.fish");
            if fish_conf.exists() {
                let _ = std::fs::remove_file(&fish_conf);
                println!("{}", format!("danger: removed Fish integration from {}", fish_conf.display()).green());
            }
        }
        ShellType::Nushell => {
            let nu_config = home.join(".config").join("nushell").join("config.nu");
            if nu_config.exists() {
                let content = read_to_string(&nu_config).unwrap_or_default();
                let re = regex::Regex::new(&format!("\\n?{}[\\s\\S]*?{}\\n?", regex::escape(MARKER_START), regex::escape(MARKER_END))).unwrap();
                let cleaned = re.replace_all(&content, "\n").to_string();
                let _ = write(&nu_config, cleaned);
                println!("{}", format!("danger: removed Nushell integration from {}", nu_config.display()).green());
            }
        }
    }
    Ok(())
}

pub fn start_subshell_for(shell: ShellType) -> i32 {
    let _ = stage_assets();
    let bin_dir = stage_bin_shim().unwrap_or_else(|_| shell_dir().join("bin"));
    let current_path = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{}:{}", bin_dir.display(), current_path);

    let shell_bin = which_bin(&shell.to_string()).unwrap_or_else(|| shell.to_string());

    println!("{}", format!("danger shell — interactive {} subshell with danger integration loaded.", shell.to_string().bold()).cyan());
    println!("Type a description and press Ctrl+X Ctrl+A / Tab to complete. Exit any time with `exit`.\n");

    let status = match shell {
        ShellType::Zsh => {
            let zdot = stage_zdotdir().unwrap_or_else(|_| shell_dir().join("zdotdir"));
            let prev_zdot = std::env::var("ZDOTDIR").unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().display().to_string());
            Command::new(&shell_bin)
                .arg("-i")
                .env("PATH", new_path)
                .env("DANGER_PREV_ZDOTDIR", prev_zdot)
                .env("ZDOTDIR", zdot)
                .env("DANGER_GREET", "1")
                .status()
        }
        ShellType::Bash => {
            let bash_plugin = shell_dir().join("danger.plugin.bash");
            Command::new(&shell_bin)
                .arg("--rcfile")
                .arg(bash_plugin)
                .arg("-i")
                .env("PATH", new_path)
                .status()
        }
        ShellType::Fish => {
            Command::new(&shell_bin)
                .arg("-i")
                .env("PATH", new_path)
                .status()
        }
        ShellType::Nushell => {
            Command::new(&shell_bin)
                .env("PATH", new_path)
                .status()
        }
    };

    match status {
        Ok(s) => s.code().unwrap_or(0),
        Err(e) => {
            eprintln!("Failed to spawn subshell {shell_bin}: {e}");
            1
        }
    }
}
