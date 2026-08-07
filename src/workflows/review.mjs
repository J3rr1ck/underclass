export const meta = {
  name: 'review',
  description: 'Review the working diff through several lenses, then try to refute every finding',
  whenToUse: 'Before committing, or on a branch about to merge. Reads only — changes nothing.',
  phases: [
    { title: 'Survey', detail: 'establish what actually changed' },
    { title: 'Review', detail: 'one agent per lens, in parallel' },
    { title: 'Verify', detail: 'a skeptic per finding' },
  ],
}

// Schemas are plain JSON Schema literals. A script body runs as a function, so
// it cannot `import` anything — declaring the shape inline is what keeps a
// workflow a single self-contained file.
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          claim: { type: 'string' },
          why_it_breaks: { type: 'string' },
        },
        required: ['file', 'claim', 'why_it_breaks'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['refuted', 'reason'],
}

// The survey agent needs a shell to ask git what changed; every other agent
// here is read-only. Granting bash is deliberate and scoped to this one call.
const SURVEY_TOOLS = ['read', 'grep', 'find', 'ls', 'repo_search', 'bash']

const LENSES = [
  {
    key: 'correctness',
    ask: 'Look for logic that is simply wrong: inverted conditions, off-by-one, a wrong variable, a branch that can never run, a return value nobody checks.',
  },
  {
    key: 'edge-cases',
    ask: 'Look for inputs the change does not survive: empty, zero, negative, missing, very large, concurrent, or the second call rather than the first.',
  },
  {
    key: 'contracts',
    ask: 'Look for callers and tests this change breaks: a changed signature or return shape, a promise the docs or comments still make, an invariant something else depends on.',
  },
]

const scope = (typeof args === 'string' ? args : args && args.path) || ''

phase('Survey')
const changed = await agent(
  `Run \`git diff HEAD --stat\` and then \`git diff HEAD\`${scope ? ` limited to ${scope}` : ''}.
Summarise what changed: every file touched, and for each one what the change is trying to do.
If the diff is empty, reply with exactly NO_CHANGES_TO_REVIEW and nothing else.`,
  { label: 'survey the diff', tools: SURVEY_TOOLS },
)

if (!changed) {
  // Distinguish "there is nothing to review" from "the survey agent died".
  // Reporting a failed survey as a clean review is how a broken endpoint gets
  // mistaken for a passing one.
  log('the survey agent failed — nothing was reviewed')
  return { findings: [], note: 'survey failed; this is not a clean review' }
}
// Anchored, not a substring search: a summary that merely mentions the sentinel
// while describing a real diff must not abort the review.
if (changed.trim() === 'NO_CHANGES_TO_REVIEW') {
  log('nothing to review — the working tree matches HEAD')
  return { findings: [], note: 'no changes to review' }
}

phase('Review')
// Each lens reviews and then has its own findings verified, without waiting for
// the other lenses to finish reviewing — that is what pipeline() buys here.
const perLens = await pipeline(
  LENSES,
  (lens) =>
    agent(
      `Here is the change under review:\n\n${changed}\n\n${lens.ask}\n\nRead the real files before claiming anything. Report only defects you can point at a line for. An empty list is a perfectly good answer.`,
      { label: `review:${lens.key}`, phase: 'Review', schema: FINDINGS },
    ),
  (found, lens) => {
    // A dead reviewer must not look like a reviewer that found nothing. Throwing
    // drops this lens to null, which is what the coverage check below counts.
    if (!found) throw new Error(`the ${lens.key} reviewer failed`)
    return parallel(
      (found.findings || []).map((f) => () =>
        agent(
          `A reviewer claims this is a defect:\n\n  file: ${f.file}\n  claim: ${f.claim}\n  why it breaks: ${f.why_it_breaks}\n\nYour job is to REFUTE it. Read ${f.file} and check whether the claim actually holds. Reasons a claim is wrong: the code does not say what the reviewer thinks, something upstream already handles it, or the described input cannot occur. If you cannot refute it, say so. When in doubt, refuted: true — a false alarm costs more than a miss here.`,
          { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT },
        ).then((v) => ({ ...f, lens: lens.key, verdict: v })),
      ),
    )
  },
)

// A lens that produced nothing because it died is not a lens that found nothing.
const lensesThatRan = perLens.filter((r) => r !== null).length
if (lensesThatRan === 0) {
  log(`all ${LENSES.length} reviewers failed — nothing was reviewed`)
  return { findings: [], note: 'every reviewer failed; this is not a clean review' }
}

const survived = perLens
  .filter(Boolean)
  .flat()
  .filter(Boolean)
  .filter((f) => f.verdict && !f.verdict.refuted)

log(`${survived.length} finding(s) survived verification`)
return {
  findings: survived,
  ...(lensesThatRan < LENSES.length
    ? { note: `${LENSES.length - lensesThatRan} of ${LENSES.length} reviewers failed — coverage is partial` }
    : {}),
}
