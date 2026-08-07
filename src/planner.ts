import { execFileSync } from "node:child_process";

/**
 * Planning tier — the insight/execution split.
 *
 * The thesis: a task needs a capable model to *decide what to do*, but the doing
 * is mechanical. So spend frontier tokens once on a plan, then execute the steps
 * on a cheap local model. Routing (pick one model for the whole task) cannot
 * capture that; decomposition can.
 *
 * This is also the shape small models actually succeed at. Measured earlier: a
 * 1.2B refused a politely-worded task and complied with an imperative one, and a
 * 12B produced empty patches on tasks it could not scope. "In file X, change Y
 * to Z" is a different problem from "fix this bug".
 *
 * The planning model may be anything the user has access to — a frontier model
 * they pay for, or another local one. It is a separate endpoint from execution,
 * so `--provider anthropic` for planning and LM Studio for execution is normal.
 */
export interface PlanStep {
  /** File the step touches, when the planner can name one. */
  file?: string;
  /** One imperative instruction, scoped small enough for a cheap model. */
  action: string;
}

export interface Plan {
  steps: PlanStep[];
  /** Anything the executor needs to know that is not a step. */
  notes?: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

const PLAN_SYSTEM = `You are planning work for a SMALL, LITERAL coding model that will execute your steps.
It has file read/write/edit tools and a shell. It is not clever: it follows instructions exactly and
fails when a step requires judgement or spans several files at once.

Produce a plan as JSON only, no prose:
{"steps":[{"file":"path/to/file","action":"one imperative instruction"}],"notes":"optional context"}

Rules for steps:
- Each step must be independently executable and verifiable.
- Name the exact file. Name the exact change. Quote the literal text to find and the literal text to
  replace it with wherever you can.
- No step may require deciding *whether* to do something. You decide; the executor acts.
- Prefer 1-6 steps. If the task genuinely needs more, the task is too large — say so in notes.
- If a step needs a command run to verify, make that its own step with the exact command.

NEVER emit an investigation step. "Read X to understand it", "examine the structure", "review the
code", "analyse the current implementation" and "locate the bug" are all forbidden: the executor
reads files on its own initiative, so a step like that costs a planning round trip and decides
nothing. Every step must change something or verify something. If you cannot say what to change
without reading the file, you were given enough context to try anyway — make your best concrete
call and note the assumption in "notes".

A plan whose steps are all investigation is worse than no plan, because the executor pays for it
twice: once to generate and once to carry in its context.`;

/** Repo context worth giving the planner, cheaply and without a model call. */
function repoContext(cwd: string): string {
  const bits: string[] = [];
  const run = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const tree = run("git", ["ls-files"]);
  if (tree) {
    const files = tree.split("\n").slice(0, 200);
    bits.push(`Files (${tree.split("\n").length} tracked, first ${files.length}):\n${files.join("\n")}`);
  }
  const status = run("git", ["status", "--porcelain"]);
  if (status) bits.push(`Uncommitted changes:\n${status.slice(0, 800)}`);
  return bits.join("\n\n");
}

/**
 * Ask the planning model to decompose a task. Returns null when planning is not
 * possible or the response is unusable — the caller then runs the task directly,
 * because a failed plan must never block the work.
 */
export async function makePlan(
  task: string,
  cwd: string,
  endpoint: { baseUrl: string; apiKey?: string; model: string },
  timeoutMs = 120_000,
): Promise<Plan | null> {
  const context = repoContext(cwd);
  try {
    const res = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "content-type": "application/json",
        "user-agent": "underclass/0.1.0-alpha.1",
        ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        max_tokens: 2000,
        messages: [
          { role: "system", content: PLAN_SYSTEM },
          { role: "user", content: `${context ? `Repository:\n${context}\n\n` : ""}Task: ${task}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const text: string = json?.choices?.[0]?.message?.content ?? "";
    const usage = json?.usage ?? {};

    // Models wrap JSON in prose or fences no matter how firmly you ask.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as { steps?: PlanStep[]; notes?: string };
    const steps = (parsed.steps ?? []).filter((s) => s && typeof s.action === "string" && s.action.trim());
    if (!steps.length) return null;

    // Reject a plan that only tells the executor to go and look.
    //
    // Measured 2026-07-25: MiniMax-M2.7 returned exactly one step — "Read
    // src/cart.js to understand current code structure" — for a two-bug task.
    // The run still succeeded, because the executor reads files anyway, but
    // planning cost 1.68x the input tokens and 2.56x the output to contribute
    // nothing. A plan that decides nothing is strictly worse than no plan: it is
    // paid for twice, once to generate and again as context on every later turn.
    //
    // Falling through to a direct run is the right failure: the task still gets
    // done, just without the tax.
    const investigation =
      /^\s*(read|open|view|inspect|examine|review|analy[sz]e|look at|locate|find|identify|understand|explore|check|study|survey)\b/i;
    const actionable = steps.filter((s) => !investigation.test(s.action));
    if (actionable.length === 0) {
      process.stderr.write(
        `\x1b[33munder: the planner returned only investigation steps ` +
          `("${steps[0]!.action.slice(0, 60)}…") — ignoring the plan and running directly.\x1b[0m\n`,
      );
      return null;
    }
    // Keep a partial plan, minus the steps that decide nothing.
    if (actionable.length < steps.length) {
      process.stderr.write(
        `\x1b[2munder: dropped ${steps.length - actionable.length} investigation step(s) from the plan\x1b[0m\n`,
      );
    }
    steps.length = 0;
    steps.push(...actionable);
    return {
      steps,
      ...(parsed.notes ? { notes: parsed.notes } : {}),
      tokensIn: usage.prompt_tokens ?? 0,
      tokensOut: usage.completion_tokens ?? 0,
      model: endpoint.model,
    };
  } catch {
    return null;
  }
}

/**
 * Render a plan as the execution prompt.
 *
 * The executor is told the plan is authoritative and the decisions are already
 * made, because a small model handed a plan will otherwise re-litigate it.
 */
export function planToPrompt(task: string, plan: Plan): string {
  const steps = plan.steps
    .map((s, i) => `${i + 1}. ${s.file ? `In \`${s.file}\`: ` : ""}${s.action}`)
    .join("\n");
  return [
    `Task: ${task}`,
    "",
    "A plan has already been made for you. Execute these steps in order, exactly as written.",
    "The decisions are made — do not re-plan, do not skip steps, do not substitute your own approach.",
    "",
    steps,
    plan.notes ? `\nContext: ${plan.notes}` : "",
    "",
    "When every step is done, stop.",
  ].join("\n");
}
