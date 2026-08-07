export const meta = {
  name: 'understand',
  description: 'Map an unfamiliar codebase: survey it, read each area in parallel, then synthesise',
  whenToUse: 'Landing in a repo you do not know, or before a change that crosses several modules.',
  phases: [
    { title: 'Survey', detail: 'find the areas worth reading' },
    { title: 'Read', detail: 'one agent per area, in parallel' },
    { title: 'Synthesise', detail: 'merge into one map' },
  ],
}

const AREAS = {
  type: 'object',
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
          why: { type: 'string' },
        },
        required: ['name', 'paths', 'why'],
      },
    },
  },
  required: ['areas'],
}

const question = (typeof args === 'string' ? args : args && args.question) || ''
// Reading every area is rarely worth it; the survey ranks and this caps.
const MAX_AREAS = (args && args.maxAreas) || 5

phase('Survey')
const survey = await agent(
  `Survey this repository and identify the ${MAX_AREAS} areas most worth reading${
    question ? ` in order to answer: "${question}"` : ' to understand how it works'
  }.

An "area" is a coherent group of files with one job — not one file, and not a whole top-level directory unless it really is one thing. Look at the directory layout, the entry points, the package manifests and any README before deciding. Order them most important first.`,
  { label: 'survey the repo', schema: AREAS },
)

const areas = ((survey && survey.areas) || []).slice(0, MAX_AREAS)
if (areas.length === 0) {
  log('the survey found nothing to read')
  return { areas: [], map: null }
}
log(`reading ${areas.length} area(s): ${areas.map((a) => a.name).join(', ')}`)

phase('Read')
const readings = await parallel(
  areas.map((area) => () =>
    agent(
      `Read this area of the codebase and explain it.

  area: ${area.name}
  paths: ${area.paths.join(', ')}
  why it matters: ${area.why}

Cover: what it is responsible for, the handful of types or functions that carry the design, how it is entered and what it depends on, and any invariant a newcomer would break without noticing. Quote real identifiers and real file:line references — do not describe it in the abstract.${
        question ? `\n\nKeep the question "${question}" in view and say plainly if this area does not bear on it.` : ''
      }`,
      { label: `read:${area.name}`, phase: 'Read' },
    ).then((text) => ({ area: area.name, text })),
  ),
)

const got = readings.filter(Boolean).filter((r) => r.text)
if (got.length === 0) {
  log('every reader failed — check the endpoint')
  return { areas: areas.map((a) => a.name), map: null }
}

phase('Synthesise')
const map = await agent(
  `${got.length} agents each read one area of this codebase. Merge their reports into one map a new engineer could work from.

Say how the areas fit together and where the seams are, not just what each one does. Where two reports disagree, say so rather than averaging them. Keep the concrete file and identifier references.${
    question ? `\n\nLead with a direct answer to: "${question}"` : ''
  }

${got.map((r) => `\n\n########## ${r.area} ##########\n${r.text}`).join('')}`,
  { label: 'synthesise the map', phase: 'Synthesise' },
)

return { areas: got.map((r) => r.area), map }
