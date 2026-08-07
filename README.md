# underclass

**The permanent underclass escape kit.** Two commands, one package, no
subscription:

- **`under`** — a coding agent for models you run yourself: LM Studio, Ollama,
  or any model server you point it at. Guided first run: `under setup`.
- **`danger`** — your own zsh, with help built in. Tab writes commands from
  plain words; `danger why` explains the last failure. One reversible line to
  install, one to remove.

Install (macOS/Linux, Node ≥ 22.19):

```bash
curl -fsSL https://permanent.sh/install | sh
```

Or from this repo:

```bash
npm install && npm run build
node dist/index.js --help
```

## Why

Most AI coding tools come from the companies selling the models, and their job
is keeping you on the model — closed source, hidden reasoning, a price that can
change under you. This is the other option: open source, models you own,
reasoning you can read, and a project that publishes its own mistakes.
`CHANGELOG.md` records what was verified; `KNOWN-ISSUES.md` names what is
broken. Both are honest on purpose.

## Status

Early alpha (`0.1.0-alpha.1`). It works; twelve known issues are open and
listed by name. The test suite is model-free — `npm test` runs the whole thing
without an endpoint or a GPU.

## Credits

Built on [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(MIT). The agent harness, tools, shell integration, workflows, and their bugs
are ours.

## License

AGPL-3.0-only. Site and installer: [permanent.sh](https://permanent.sh) ·
story: [underclass.tech](https://underclass.tech)
