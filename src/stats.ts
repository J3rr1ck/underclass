/**
 * `under stats` — what the model you are actually using is actually doing.
 *
 * The alternative to this is benchmarking, and benchmarking has two problems
 * that this does not. It costs a matrix of requests against someone's endpoint
 * to learn things a week of real work reveals for free, and it measures
 * synthetic tasks rather than yours. Every number here is derived from
 * `~/.underclass/runs.jsonl`, which every run already writes. Zero requests.
 *
 * What it is FOR: noticing that the model you switched to last week is slower,
 * or fails more, or takes twice the turns to do the same job. What it is NOT:
 * a fair comparison. These are observational data over whatever you happened to
 * ask each model to do, so a model that only ever saw hard tasks will look bad.
 * The report says so rather than pretending otherwise, and refuses to rank on
 * too few runs.
 *
 * The one relationship worth knowing, measured in this repo: input tokens are
 * close to linear in TOOL CALLS, not in task difficulty. So tokens-per-turn is
 * the efficiency number, and turns-per-task is the thing a better model
 * actually improves.
 */
import { readRuns, type RunRecord } from "./telemetry.js";

export interface ModelStats {
  model: string;
  provider: string;
  runs: number;
  ok: number;
  errors: number;
  aborted: number;
  successRate: number;
  medianIn: number;
  medianOut: number;
  medianToolCalls: number;
  medianSeconds: number;
  /** Input tokens per tool call — the efficiency number that is comparable across tasks. */
  tokensPerToolCall: number | null;
  /** in:out ratio. An agent is prefill-heavy; this repo measures ~33:1. */
  inOutRatio: number | null;
  /** Runs that consumed a real prompt and called nothing — the silent-no-op signature. */
  noToolRuns: number;
  toolsUsed: string[];
  firstSeen: string;
  lastSeen: string;
}

const med = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

/**
 * Median rather than mean throughout.
 *
 * One 300-second timeout drags a mean of ten runs by 30 seconds and tells you
 * nothing about the typical case. The tail matters too, but it belongs in its
 * own column, not smuggled into the headline.
 */
export function computeStats(records: RunRecord[]): ModelStats[] {
  const byModel = new Map<string, RunRecord[]>();
  for (const r of records) {
    const key = `${r.provider}/${r.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), r]);
  }

  const out: ModelStats[] = [];
  for (const [key, rs] of byModel) {
    const withTokens = rs.filter((r) => (r.tokensIn ?? 0) > 0);
    const ins = withTokens.map((r) => r.tokensIn);
    const outs = withTokens.map((r) => r.tokensOut);
    const calls = rs.map((r) => r.toolCalls ?? 0);
    const secs = rs.filter((r) => r.durationMs).map((r) => r.durationMs / 1000);
    const totalIn = ins.reduce((a, b) => a + b, 0);
    const totalOut = outs.reduce((a, b) => a + b, 0);
    const totalCalls = calls.reduce((a, b) => a + b, 0);
    const ts = rs.map((r) => r.ts).sort();

    out.push({
      model: rs[0]!.model,
      provider: rs[0]!.provider,
      runs: rs.length,
      ok: rs.filter((r) => r.outcome === "ok").length,
      errors: rs.filter((r) => r.outcome === "error").length,
      aborted: rs.filter((r) => r.outcome === "aborted").length,
      successRate: rs.length ? rs.filter((r) => r.outcome === "ok").length / rs.length : 0,
      medianIn: med(ins),
      medianOut: med(outs),
      medianToolCalls: med(calls),
      medianSeconds: Math.round(med(secs)),
      tokensPerToolCall: totalCalls > 0 ? Math.round(totalIn / totalCalls) : null,
      inOutRatio: totalOut > 0 ? Number((totalIn / totalOut).toFixed(1)) : null,
      // A run with a real prompt and zero tool calls did not do the work. It is
      // the signature of a collapsed generation budget or a model narrating.
      noToolRuns: rs.filter((r) => (r.toolCalls ?? 0) === 0 && (r.tokensIn ?? 0) > 500).length,
      toolsUsed: [...new Set(rs.flatMap((r) => r.tools ?? []))].sort(),
      firstSeen: ts[0] ?? "",
      lastSeen: ts[ts.length - 1] ?? "",
    });
    void key;
  }
  return out.sort((a, b) => b.runs - a.runs);
}

/** Runs below this are reported but never ranked — n=3 is an anecdote. */
const RANKABLE_MIN = 10;

export function renderStats(stats: ModelStats[], opts: { verbose?: boolean } = {}): string {
  const L: string[] = [];
  if (!stats.length) {
    return (
      "under stats — no runs recorded yet.\n\n" +
      "  Telemetry lands in ~/.underclass/runs.jsonl as you use `under`.\n" +
      "  (UNDER_NO_TELEMETRY disables it; nothing here leaves your machine.)"
    );
  }

  const total = stats.reduce((a, s) => a + s.runs, 0);
  L.push(`under stats — ${total} runs across ${stats.length} model(s)\n`);

  // Rows that never produced a token or a tool call are failed connection
  // attempts, not usage. Listing twenty of them buries the four models actually
  // being used, so they collapse into one line — still reported, not hidden.
  const used = stats.filter((s) => s.medianIn > 0 || s.medianToolCalls > 0);
  const neverWorked = stats.filter((s) => !(s.medianIn > 0 || s.medianToolCalls > 0));

  // Label by PROVIDER/MODEL. The same weights served by two providers are two
  // different things operationally, and rendering only the model name produced
  // a report that compared `google/gemma-4-12b` to `google/gemma-4-12b`.
  const label = (x: ModelStats) => `${x.provider}/${x.model}`;

  L.push("| provider/model | runs | ok | median in | tok/call | turns | time | in:out |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const s of used) {
    const pct = `${Math.round(s.successRate * 100)}%`;
    L.push(
      `| \`${label(s)}\` | ${s.runs} | ${pct} | ${s.medianIn.toLocaleString()} | ` +
        `${s.tokensPerToolCall?.toLocaleString() ?? "—"} | ${s.medianToolCalls} | ${s.medianSeconds}s | ` +
        `${s.inOutRatio ?? "—"}:1 |`,
    );
  }
  L.push("");
  if (neverWorked.length) {
    const n = neverWorked.reduce((a, x) => a + x.runs, 0);
    L.push(
      `\x1b[2m${neverWorked.length} model(s), ${n} run(s), never returned a token — connection or config ` +
        `failures rather than usage: ${neverWorked.map((x) => x.model).slice(0, 6).join(", ")}` +
        `${neverWorked.length > 6 ? ", …" : ""}\x1b[0m`,
      "",
    );
  }

  // The interpretation, because a table of numbers is not insight.
  const rankable = used.filter((s) => s.runs >= RANKABLE_MIN);
  if (rankable.length >= 2) {
    const byEff = [...rankable].filter((s) => s.tokensPerToolCall).sort((a, b) => a.tokensPerToolCall! - b.tokensPerToolCall!);
    const bySpeed = [...rankable].sort((a, b) => a.medianSeconds - b.medianSeconds);
    L.push("**On your actual work, not a benchmark:**\n");
    if (byEff.length >= 2) {
      L.push(
        `- Cheapest per turn: \`${label(byEff[0]!)}\` at ${byEff[0]!.tokensPerToolCall!.toLocaleString()} input tokens ` +
          `per tool call, vs ${byEff[byEff.length - 1]!.tokensPerToolCall!.toLocaleString()} for ` +
          `\`${label(byEff[byEff.length - 1]!)}\`.`,
      );
    }
    L.push(`- Fastest median run: \`${label(bySpeed[0]!)}\` at ${bySpeed[0]!.medianSeconds}s.`);
    L.push("");
  } else if (stats.length >= 2) {
    L.push(
      `\x1b[2mNot ranking: no model has ${RANKABLE_MIN}+ runs yet. ` +
        `Comparisons below that are anecdote.\x1b[0m\n`,
    );
  }

  // Problems worth surfacing unprompted.
  const trouble: string[] = [];
  for (const s of used) {
    if (s.noToolRuns > 0) {
      trouble.push(
        `\`${label(s)}\`: ${s.noToolRuns} run(s) consumed a real prompt and called NO tools. ` +
          `That is a collapsed generation budget or a model narrating instead of acting — ` +
          `check \`servedContext\` in your model map.`,
      );
    }
    if (s.runs >= RANKABLE_MIN && s.successRate < 0.5) {
      trouble.push(`\`${label(s)}\`: ${Math.round(s.successRate * 100)}% success over ${s.runs} runs.`);
    }
  }
  if (trouble.length) {
    L.push("**Worth looking at:**\n");
    for (const t of trouble) L.push(`- ${t}`);
    L.push("");
  }

  L.push(
    "\x1b[2mObservational, not a controlled comparison: these are whatever you happened to ask",
    "each model to do. A model that only saw hard tasks will look worse than it is. The",
    "comparable number is tokens-per-tool-call — input tokens are close to linear in turns,",
    "so it normalises away task size in a way total tokens does not.\x1b[0m",
  );

  if (opts.verbose) {
    L.push("", "---", "");
    for (const s of stats) {
      L.push(`### ${s.provider}/${s.model}`);
      L.push(`- ${s.runs} runs — ${s.ok} ok, ${s.errors} error, ${s.aborted} aborted`);
      L.push(`- median: ${s.medianIn.toLocaleString()} in / ${s.medianOut.toLocaleString()} out, ${s.medianToolCalls} tool calls, ${s.medianSeconds}s`);
      L.push(`- tools seen: ${s.toolsUsed.join(", ") || "(none)"}`);
      L.push(`- ${s.firstSeen.slice(0, 10)} → ${s.lastSeen.slice(0, 10)}`);
      L.push("");
    }
  }
  return L.join("\n");
}

export function runStats(argv: string[]): number {
  const verbose = argv.includes("--verbose") || argv.includes("-v");
  const modelFilter = argv[argv.indexOf("--model") + 1];
  const sinceArg = argv[argv.indexOf("--since") + 1];

  let records = readRuns();
  if (argv.includes("--model") && modelFilter) {
    records = records.filter((r) => r.model.includes(modelFilter));
  }
  if (argv.includes("--since") && sinceArg) {
    // Accept a date or a "7d"-style window; anything unparseable is an error
    // rather than a silently ignored filter.
    const m = /^(\d+)d$/.exec(sinceArg);
    const cutoff = m ? Date.now() - Number(m[1]) * 86_400_000 : Date.parse(sinceArg);
    if (Number.isNaN(cutoff)) {
      console.error(`under stats: cannot parse --since ${sinceArg} (try 7d or 2026-08-01)`);
      return 1;
    }
    records = records.filter((r) => Date.parse(r.ts) >= cutoff);
  }
  console.log(renderStats(computeStats(records), { verbose }));
  return 0;
}
