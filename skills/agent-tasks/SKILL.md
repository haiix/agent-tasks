---
name: agent-tasks
description: Use taskctl with a local agent-tasks database to select runnable tasks, claim work safely, and record task status updates. Use when coordinating agent work through the agent-tasks CLI.
license: MIT
compatibility: Requires taskctl on PATH and an initialized agent-tasks project database.
metadata:
  author: haiix
  version: "1"
---

# Agent Tasks

Use `taskctl` as the source of truth for selecting and recording work in a local
agent-tasks database. Do not edit the SQLite database directly.

## Preconditions

Before starting work:

- Confirm that `taskctl` is available on `PATH`.
- Confirm that the target project has been initialized with `taskctl init`.
- Choose a stable agent identifier for every `claim` and `transition` in this
  task.

If the command is unavailable, the database is not initialized, or access is
denied, do not begin the task. Report the failing command, stable error code when
available, database path when reported, and the concrete recovery condition.

## Protocol Rules

- Add `--format json` to every automated business command. Treat a command as
  successful only when its exit code is `0`, stdout parses as one JSON object,
  and `ok` is `true`.
- Stop on malformed JSON, a disagreement between the exit code and `ok`, or
  missing response data required for the next decision. Treat these cases as a
  protocol failure; do not continue work or update task state.
- Branch on the stable `error.code`, `error.details`, and exit code. Do not parse
  human-facing messages or stderr for automation decisions.
- Prefer `--input-json -` and pass one UTF-8 JSON object through stdin. Do not
  assemble JSON with shell string concatenation or send duplicate properties.
- Use the `version` from the last successful response for every mutation.

## Select and Claim Work

Always perform this sequence before modifying work products:

1. Run `taskctl list --status pending --runnable --limit 50 --format json`.
   Follow `data.nextCursor` with the same filters and limit only when more
   candidates are needed. If no task is available, stop without creating one.
2. Select a candidate, then run
   `taskctl get --id <task-id> --format json`. Confirm that `data.task.status` is
   `pending`, `data.task.runnable` is `true`, and inspect `data.dependsOn`.
3. Run
   `taskctl claim --id <task-id> --agent <agent-id> --expected-version <version> --format json`.
4. Begin work only after the claim succeeds and the returned task is
   `in_progress` with the chosen agent as its assignee. Never overwrite or
   reinterpret another agent's claim.

If a claim returns `VERSION_CONFLICT`, retrieve the entire task again with
`get`, reconsider its status, assignee, dependencies, and suitability, and only
then decide whether to claim using the newly returned version. On
`STATE_CONFLICT` or `NOT_RUNNABLE`, do not work on that task; return to selection
only if another task is appropriate.

## Mutate and Resolve Conflicts

After every successful mutation, replace the saved version with
`data.task.version`. If a mutation returns `VERSION_CONFLICT`, run `get` and
re-evaluate whether the intended change remains valid. Never retry the same
mutation blindly or use `error.details.actualVersion` as permission to retry.

Use `update` for task fields and `dependency-add` or `dependency-remove` for
dependencies. Inspect the current task and dependency list before changing
either.

## Record an Outcome

Choose the state according to the actual outcome:

- `blocked`: progress cannot safely continue because required information,
  permission, an external resource, or prerequisite work is missing. Record a
  specific `blockedReason` and the action needed to unblock it. Do not use this
  for ordinary difficulty or a transient command failure.
- `done`: the requested work, relevant tests, checks, and documentation are
  complete. Record a `result` that matches the changes and verification. Do not
  mark partially completed or unverified work done.
- `canceled`: the task is confirmed to be duplicate, obsolete, or intentionally
  abandoned. Do not use cancellation for a failed implementation or temporary
  blocker.

Before transitioning, retrieve the task if the saved version may be stale.
Confirm that a successful transition returned the intended status.

## Avoid Duplicate or Destructive Task Management

When asked to create a task, search every relevant `list` page and inspect
possible matches with `get`. Do not create a second task for the same artifact,
problem, or work scope. Update an existing task when it represents the work.
Create only when a distinct task is clearly required.

Never physically delete task records. Use `canceled` only when its meaning and
transition rules apply.

## Detailed CLI Contract

Read [references/cli-workflow.md](references/cli-workflow.md) when exact command
arguments, JSON shapes, exit codes, or worked conflict and transition examples
are needed.
