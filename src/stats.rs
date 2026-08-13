use std::fs::read_to_string;
use colored::Colorize;
use crate::config::under_dir;
use crate::telemetry::RunRecord;

pub fn print_stats(verbose: bool, model_filter: Option<&str>) {
    let path = under_dir().join("runs.jsonl");
    let content = match read_to_string(&path) {
        Ok(c) => c,
        Err(_) => {
            println!("No recorded runs found at {}", path.display());
            return;
        }
    };

    let mut records: Vec<RunRecord> = Vec::new();
    for line in content.lines() {
        if let Ok(rec) = serde_json::from_str::<RunRecord>(line) {
            if let Some(filter) = model_filter {
                if !rec.model.contains(filter) {
                    continue;
                }
            }
            records.push(rec);
        }
    }

    if records.is_empty() {
        println!("No matching runs found.");
        return;
    }

    let total_runs = records.len();
    let successful_runs = records.iter().filter(|r| r.success).count();
    let total_tokens_in: usize = records.iter().map(|r| r.tokens_in).sum();
    let total_tokens_out: usize = records.iter().map(|r| r.tokens_out).sum();
    let total_tool_calls: usize = records.iter().map(|r| r.tool_calls).sum();
    let avg_duration = records.iter().map(|r| r.duration_ms).sum::<u64>() / total_runs as u64;

    println!("{}", "=== Underclass Run Statistics ===".bold().cyan());
    println!("Total Runs:          {}", total_runs.to_string().bold());
    println!("Successful Runs:     {} ({:.1}%)", successful_runs.to_string().green(), (successful_runs as f64 / total_runs as f64) * 100.0);
    println!("Total Tokens In:     {}", total_tokens_in.to_string().yellow());
    println!("Total Tokens Out:    {}", total_tokens_out.to_string().yellow());
    println!("Total Tool Calls:    {}", total_tool_calls.to_string().magenta());
    println!("Avg Duration:        {} ms", avg_duration.to_string().dimmed());

    if verbose {
        println!("\n{}", "--- Recent Runs ---".bold());
        for r in records.iter().rev().take(10) {
            let status = if r.success { "OK".green() } else { "FAIL".red() };
            println!("[{}] {} ({}) - In: {}, Out: {}, Tools: {}", status, r.model.cyan(), r.provider.dimmed(), r.tokens_in, r.tokens_out, r.tool_calls);
        }
    }
}
