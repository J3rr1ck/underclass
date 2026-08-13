pub fn suggest_install_hint(cmd: &str) -> Option<String> {
    match cmd {
        "npm" | "npx" | "node" => Some("Install Node.js: https://nodejs.org or `nvm install 22`".to_string()),
        "cargo" | "rustc" => Some("Install Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`".to_string()),
        "pip" | "python" | "python3" => Some("Install Python: `sudo apt install python3` or `brew install python`".to_string()),
        "go" => Some("Install Go: https://go.dev/doc/install or `brew install go`".to_string()),
        "rg" => Some("Install ripgrep: `brew install ripgrep` or `cargo install ripgrep`".to_string()),
        "gh" => Some("Install GitHub CLI: `brew install gh` or `sudo apt install gh`".to_string()),
        "docker" => Some("Install Docker: https://docs.docker.com/get-docker/".to_string()),
        _ => None,
    }
}
