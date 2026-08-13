use std::collections::HashMap;

pub struct InstallHint {
    pub brew: Option<&'static str>,
    pub apt: Option<&'static str>,
    pub note: Option<&'static str>,
}

pub fn get_install_hints() -> HashMap<&'static str, InstallHint> {
    let mut h = HashMap::new();
    h.insert("rg", InstallHint { brew: Some("brew install ripgrep"), apt: Some("apt install ripgrep"), note: Some("under's repo_search needs this") });
    h.insert("fd", InstallHint { brew: Some("brew install fd"), apt: Some("apt install fd-find"), note: None });
    h.insert("jq", InstallHint { brew: Some("brew install jq"), apt: Some("apt install jq"), note: None });
    h.insert("gh", InstallHint { brew: Some("brew install gh"), apt: Some("see https://cli.github.com"), note: Some("`under fan-out --pr` needs this") });
    h.insert("bat", InstallHint { brew: Some("brew install bat"), apt: Some("apt install bat"), note: None });
    h.insert("tree", InstallHint { brew: Some("brew install tree"), apt: Some("apt install tree"), note: None });
    h.insert("wget", InstallHint { brew: Some("brew install wget"), apt: Some("apt install wget"), note: Some("curl is already installed and does the same job") });
    h.insert("htop", InstallHint { brew: Some("brew install htop"), apt: Some("apt install htop"), note: None });
    h.insert("docker", InstallHint { brew: Some("brew install --cask orbstack"), apt: None, note: Some("OrbStack is lighter than Docker Desktop on Apple Silicon") });
    h.insert("podman", InstallHint { brew: Some("brew install podman"), apt: None, note: None });
    h.insert("python", InstallHint { brew: None, apt: None, note: Some("macOS ships `python3`, not `python`. Try `python3`, or `brew install python`") });
    h.insert("pip", InstallHint { brew: None, apt: None, note: Some("try `pip3`, or `python3 -m pip`") });
    h.insert("node", InstallHint { brew: Some("brew install node"), apt: None, note: Some("under needs Node >= 22.19 or Rust binary") });
    h.insert("pnpm", InstallHint { brew: Some("brew install pnpm"), apt: None, note: Some("or `corepack enable pnpm`") });
    h.insert("yarn", InstallHint { brew: None, apt: None, note: Some("`corepack enable yarn` — no install needed on modern Node") });
    h.insert("cargo", InstallHint { brew: Some("brew install rustup && rustup-init"), apt: None, note: Some("cargo comes with the Rust toolchain") });
    h.insert("rustc", InstallHint { brew: Some("brew install rustup && rustup-init"), apt: None, note: None });
    h.insert("go", InstallHint { brew: Some("brew install go"), apt: None, note: None });
    h.insert("java", InstallHint { brew: Some("brew install openjdk"), apt: None, note: Some("Android builds want a JDK on PATH and JAVA_HOME set") });
    h.insert("adb", InstallHint { brew: Some("brew install --cask android-platform-tools"), apt: None, note: Some("or use the one in $ANDROID_HOME/platform-tools") });
    h.insert("gradle", InstallHint { brew: None, apt: None, note: Some("use the wrapper: `./gradlew`. A repo without one is missing a committed file") });
    h.insert("sdkmanager", InstallHint { brew: None, apt: None, note: Some("lives in $ANDROID_HOME/cmdline-tools/latest/bin — not on PATH by default") });
    h.insert("xcodebuild", InstallHint { brew: None, apt: None, note: Some("run `xcode-select --install`, or point xcode-select at a full Xcode") });
    h.insert("swift", InstallHint { brew: None, apt: None, note: Some("ships with Xcode; `xcode-select --install` gets the command-line tools") });
    h.insert("code", InstallHint { brew: None, apt: None, note: Some("VS Code's CLI is installed from the app: Command Palette → 'Shell Command: Install code'") });
    h.insert("under", InstallHint { brew: None, apt: None, note: Some("cargo install or npm i -g underclass") });
    h.insert("ollama", InstallHint { brew: Some("brew install ollama"), apt: None, note: Some("local runtimes available") });
    h.insert("lms", InstallHint { brew: None, apt: None, note: Some("LM Studio's CLI: install it from the app's Developer tab") });
    h.insert("uv", InstallHint { brew: Some("brew install uv"), apt: None, note: None });
    h.insert("ruff", InstallHint { brew: Some("brew install ruff"), apt: None, note: Some("or `uvx ruff`") });
    h
}

pub fn suggest_install_hint(cmd: &str) -> Option<String> {
    let hints = get_install_hints();
    if let Some(hint) = hints.get(cmd) {
        let mut msg = String::new();
        if let Some(note) = hint.note {
            msg.push_str(note);
        } else if let Some(brew) = hint.brew {
            msg.push_str(brew);
        } else if let Some(apt) = hint.apt {
            msg.push_str(apt);
        }
        if !msg.is_empty() {
            return Some(msg);
        }
    }
    None
}

pub fn emit_zsh_rules() -> String {
    let mut out = String::from("# Generated static danger shell rules\n");
    out.push_str("typeset -A DANGER_INSTALL_HINTS\n");
    for (cmd, hint) in get_install_hints() {
        let val = hint.brew.or(hint.note).or(hint.apt).unwrap_or("");
        out.push_str(&format!("DANGER_INSTALL_HINTS[{}]={:?}\n", cmd, val));
    }
    out
}
