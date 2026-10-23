# pi-plan-router

Strong model plans, cheap model implements, automatic escalation when the cheap model breaks a check.

A Pi virtual model (`route/auto`) that routes each request to one of two physical models:

| Phase | Model | Trigger |
|---|---|---|
| Planning | strong | each new user message |
| Implementation | cheap | after the first file change |
| Escalated | strong | a check fails after the cheap model changed code |
| Summaries | strong | compaction and other requests outside the agent loop |

## Why

Planning benefits from a strong model; mechanical edits usually do not. Routing after the first
change keeps the expensive model on the part that needs judgment and puts the rest on a model that
costs a fraction as much — while a failing test hands the turn back.

## Install

```bash
pi install git:github.com/Judioljuse/pi-plan-router@v0.1.0
pi --model route/auto
```

Without a repository, copy the extension instead:

```bash
mkdir -p ~/.pi/agent/extensions/plan-then-implement
cp extensions/plan-then-implement.ts ~/.pi/agent/extensions/plan-then-implement/index.ts
```

Select it with `pi --model route/auto` or `/model` in a session. `Ctrl+S` in `/model` makes it the
default for new sessions. Nothing changes until it is selected.

## Configure

| Variable | Default | Meaning |
|---|---|---|
| `PI_ROUTE_PROVIDER` | `tokenhub` | Provider that owns both physical models |
| `PI_ROUTE_STRONG` | `claude-sonnet-5-5` | Planning model |
| `PI_ROUTE_CHEAP` | `deepseek-v4.1-flash` | Implementation model |

```bash
export PI_ROUTE_PROVIDER=anthropic
export PI_ROUTE_STRONG=claude-opus-4-5
export PI_ROUTE_CHEAP=claude-haiku-4-5
```

Both models must be in the catalog with usable credentials. A missing strong model fails the
request instead of silently running on another model.

## What counts as a change

- Tools whose name means mutation: `edit`, `write`, `apply_patch`, `replace_match`, `insert`,
  `str_replace`, and similar — matched by name, so tools from other extensions count.
- Shell commands that write files: `sed -i`, `perl -i`, `git apply`, `patch -p`, `cat > file`, and
  redirections into source files. Read-only shell work and captured logs do not count.

## What counts as a failing check

- Output matching `FAILED`, `N failing/failed` (N > 0), `AssertionError`, `Traceback …`,
  `error TS1234`, `error[E1234]`, `SyntaxError:`, `panicked at`, `compilation failed`.
- A non-zero exit from a test, build, or package command.

Escalation only fires when the failure follows a change the cheap model made. A failure left by the
strong model's own change is the cheap model's job, not a regression.

## Behavior notes

- Each switch loses the prompt cache, so a turn switches at most once.
- Router state lives on the session branch: `/tree` forks and compaction keep the phase.
- `/session` cost per model is only meaningful when the provider declares prices in `models.json`.
- The heuristics are not proof: a mutation from a tool with an unusual name, or a failure whose
  output matches no pattern, is missed. Both fail safe — the cheap model keeps working, or the
  strong model keeps the turn.

## Development

The extension is a single TypeScript file; Pi loads it through jiti, so there is no build step.

```bash
pi -e ./extensions/plan-then-implement.ts --model route/auto
```

## License

MIT
