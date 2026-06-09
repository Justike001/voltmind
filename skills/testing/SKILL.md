---
name: testing
version: 2.0.0
description: |
  VoltMind MVP validation framework. Runs skill conformance checks, focused
  runtime gates, project tests, and health readouts, then classifies failures
  as regression, stale test, flake, new work, or infrastructure.
triggers:
  - "validate skills"
  - "test skills"
  - "skill health check"
  - "run conformance tests"
  - "run the tests"
  - "how are the tests"
  - "what's broken"
  - "daily test run"
tools:
  - search
  - list_pages
  - get_health
  - run_doctor
mutating: false
---

# Testing Skill

Use this skill when the user wants to validate VoltMind skills, run tests, or
understand current project health.

## Contract

This skill guarantees:

- Test scope is stated before broad runs.
- Skill conformance, resolver coverage, and MVP runtime health are treated as
  separate signals.
- Failures are classified before suggesting fixes.
- Security or trust-boundary failures are not auto-fixed.
- Results preserve enough command output to be actionable.

## Mode 1: Skill Conformance

Run focused skill validation when skills or routing changed:

```bash
bun test test/skills-conformance.test.ts test/resolver.test.ts
```

Check:

- every active skill has `SKILL.md`
- frontmatter has required fields
- `skills/manifest.json` references the right files
- `skills/RESOLVER.md` routes active MVP skills
- trigger text is not misleading

## Mode 2: MVP Runtime Gate

Run the focused MVP gate before calling the runtime healthy:

```bash
bun run typecheck
bun test test/cli-help-discoverability.test.ts test/mvp-surface.test.ts test/mcp-tool-defs.test.ts test/operations-descriptions.test.ts
voltmind doctor --fast
voltmind status
```

On Windows, if Bun subprocess tests return `status=-1` but the same CLI command
works manually, report it as a harness issue and include the manual verification.

## Mode 3: Project Test Health

For broader health:

```bash
bun test
git log --oneline --since="24 hours ago"
```

For each failing test, classify:

| Classification | Meaning | Action |
|---|---|---|
| regression | code changed and behavior broke | flag likely change |
| stale test | expected behavior changed intentionally | update test after review |
| flake | timeout or external variance | retry once and report |
| new work | newly added test not passing yet | confirm intent |
| infra | local environment or dependency issue | fix environment or document |

## State

If trend tracking is needed, store it in VoltMind, for example:

- `state/indexes/test-state`
- raw data source `test-state`

Do not use old `~/.gbrain` paths.

## Output Format

```text
VOLTMIND TEST REPORT
Scope: <conformance / MVP gate / full>
Commands run: <commands>
Result: pass / fail / partial
Failures: <classified failures>
Manual verification: <if any>
Next action: <recommended fix or review>
```

## Anti-Patterns

- Treating every red test as a regression before classification.
- Auto-fixing security or trust-boundary tests.
- Reporting all clear without running the stated commands.
- Calling inherited `gbrain` commands.
- Expanding to slow or external tests without user approval.

## Tools Used

- Run project tests (`bun test`, repo-local command)
- Run typecheck (`bun run typecheck`, repo-local command)
- Read runtime health (`get_health`, CLI: `voltmind health`)
- Run doctor (`run_doctor`, CLI: `voltmind doctor --fast`)
- Search/list VoltMind pages when test state is stored in the brain (`search`, `list_pages`)
