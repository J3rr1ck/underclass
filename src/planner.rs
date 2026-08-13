use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub step_number: usize,
    pub description: String,
    pub files_to_touch: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlan {
    pub goal: String,
    pub steps: Vec<PlanStep>,
}

pub fn plan_to_prompt(plan: &ExecutionPlan) -> String {
    let mut out = format!("Execution Plan for: {}\n\nSteps:\n", plan.goal);
    for step in &plan.steps {
        out.push_str(&format!("{}. {}\n", step.step_number, step.description));
        if !step.files_to_touch.is_empty() {
            out.push_str(&format!("   Target Files: {}\n", step.files_to_touch.join(", ")));
        }
    }
    out
}
