# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the Node.js automation core: CDP clients, planners, action executors, persistence, the automation runtime, and the browser control server.
- `web/` contains the React/Vite control console source; generated static assets go to `public/` and are served by the Node control server.
- `wmpf/` implements the WeChat mini-program CDP route. Keep `wmpf/src/` and `wmpf/frida/` synchronized when packaging.
- `scripts/` holds capture analysis and catalog-building utilities. Runtime samples and the generated item catalog live in `captures/`.
- `test/` contains Node test-runner suites named `*.test.js`.
- `docs/` stores implementation plans. `release*/`, `data*/`, and `node_modules/` are generated or local-only.

## Build, Test, and Development Commands

- `npm test` runs all tests with Node’s built-in test runner.
- `npm run check` performs syntax checks and the full test suite; run it before submitting changes.
- `npm run web:dev` starts the Node control server and Vite development server.
- `npm run web:build` builds the browser control console into `public/`.
- `npm start` starts the managed CDP route, control server, and browser console; `npm run console` reuses an externally started CDP route.
- `npm run wx:cdp:debug` starts the required CDP route with `--debug-main --debug-frida`.
- `npm run inspect` and `npm run status` inspect the connected runtime.

## Coding Style & Naming Conventions

Use CommonJS and `"use strict"` in Node files; the renderer uses TypeScript/React. Follow the existing two-space indentation, semicolons, and double-quoted JavaScript strings. Use `camelCase` for functions and variables, `PascalCase` for classes/components, and kebab-case filenames such as `connection-service.js`. Keep CDP expressions short and atomic; orchestration loops belong on the Node side.

## Testing Guidelines

Add a focused regression test for every bug fix. Test names should describe observable behavior, preferably in the domain language used by the feature. Mock CDP/process boundaries rather than contacting the live game. Run the targeted test first, then `npm run check`. Packaging changes must verify required files, especially `wmpf/frida/**/*`.

## Commit & Pull Request Guidelines

This workspace snapshot has no Git history, so no established commit convention is available. Use concise Conventional Commit subjects, for example `fix(cdp): launch managed route in debug mode`. Pull requests should explain behavior changes, list validation commands, link relevant issues, and include screenshots for UI changes. Note any installer, CDP, or runtime compatibility impact.

## Runtime & Configuration Notes

The reliable connection order is: start the debug CDP route, then open the game. Do not commit local databases, logs, captures containing private state, or packaged binaries unless a release specifically requires them.

## WSL Development Completion Rule

This rule applies only when working in the WSL checkout at `/home/tiygu/mini-game-adapter-lab` and only to this repository and its descendants. After every completed development task, before reporting completion:

1. Run the relevant validation and review the task diff.
2. Synchronize only the files changed by the current task, including deletions, to the Windows checkout at `/mnt/d/Desktop/Projects/mini-game-adapter-lab/`. Preserve the Windows checkout's `.git`, dependencies, generated/local-only files, databases, logs, captures containing private state, and packaged binaries unless the task explicitly changes them.
3. Commit only the current task's changes with a concise Conventional Commit subject and push the current branch to `origin`. Do not include unrelated pre-existing workspace changes.
4. Verify both the Windows synchronization and the remote push. If either step fails, report the exact failure and leave the verified local work intact rather than claiming completion.

Do not apply this workflow from another checkout, outside WSL, or to any other repository.

## Agent skills

### Issue tracker

Issues and specs are tracked as GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` states. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with `CONTEXT.md` at the root and ADRs under `docs/adr/`. See `docs/agents/domain.md`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **KvQql129PnmufwDhML8** (4013 symbols, 11819 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/KvQql129PnmufwDhML8/context` | Codebase overview, check index freshness |
| `gitnexus://repo/KvQql129PnmufwDhML8/clusters` | All functional areas |
| `gitnexus://repo/KvQql129PnmufwDhML8/processes` | All execution flows |
| `gitnexus://repo/KvQql129PnmufwDhML8/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
