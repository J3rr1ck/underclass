use std::fs::{read_to_string, write, create_dir_all};
use colored::Colorize;

const ZSH_INTEGRATION_LINE: &str = "# underclass danger zsh integration\nsource ~/.underclass/plugin.zsh";

pub fn install_zsh_plugin(login_shell: bool) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot locate home directory".to_string())?;
    let under_dir = home.join(".underclass");
    create_dir_all(&under_dir).map_err(|e| e.to_string())?;

    // Copy plugin.zsh into ~/.underclass/plugin.zsh
    let plugin_dest = under_dir.join("plugin.zsh");
    let plugin_content = include_str!("plugin.zsh");
    write(&plugin_dest, plugin_content).map_err(|e| e.to_string())?;

    // Update ~/.zshrc
    let zshrc = home.join(".zshrc");
    let mut content = read_to_string(&zshrc).unwrap_or_default();
    if !content.contains("source ~/.underclass/plugin.zsh") {
        content.push_str(&format!("\n\n{ZSH_INTEGRATION_LINE}\n"));
        write(&zshrc, content).map_err(|e| e.to_string())?;
        println!("{}", format!("Successfully added danger zsh integration to {}", zshrc.display()).green());
    } else {
        println!("{}", format!("danger zsh integration is already installed in {}", zshrc.display()).yellow());
    }

    if login_shell {
        println!("Login shell configuration requested.");
    }

    println!("\nRestart your shell or run: {}", "source ~/.zshrc".cyan().bold());
    Ok(())
}

pub fn uninstall_zsh_plugin() -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "Cannot locate home directory".to_string())?;
    let zshrc = home.join(".zshrc");
    if zshrc.exists() {
        let content = read_to_string(&zshrc).unwrap_or_default();
        let cleaned: Vec<&str> = content
            .lines()
            .filter(|line| !line.contains(".underclass/plugin.zsh") && !line.contains("underclass danger zsh"))
            .collect();
        write(&zshrc, cleaned.join("\n")).map_err(|e| e.to_string())?;
        println!("{}", format!("Removed danger zsh integration from {}", zshrc.display()).green());
    }
    Ok(())
}
