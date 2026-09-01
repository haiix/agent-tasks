# `taskctl` CLI Workflow Reference

This reference gives the exact CLI calls and response checks for the workflow in
`SKILL.md`. The repository's `documents/cli-spec.md` and
`documents/task-model.md` remain authoritative for the CLI and data model.

Replace `<task-id>`, `<agent-id>`, `<version>`, `<dependency-id>`, and `<cursor>`
with values from the latest successful response. Options follow the command.

## Response Contract

Every automated call uses `--format json`. Successful stdout has this envelope:

```json
{ "ok": true, "data": {} }
```

Failure stdout has this envelope:

```json
{
  "ok": false,
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Human-readable diagnostic",
    "details": { "expectedVersion": 3, "actualVersion": 4 }
  }
}
```

Require all of the following before accepting success:

1. The process exit code is `0`.
2. stdout is exactly one parseable JSON object.
3. `ok` is `true`.
4. The `data` properties needed for the next decision are present.

An unparseable response, contradictory exit code and `ok`, or missing required
data is a protocol failure. Stop without working or changing task state.

The exit-code categories are:

| Exit | Meaning                                | Stable codes relevant to this workflow                                                   |
| ---: | -------------------------------------- | ---------------------------------------------------------------------------------------- |
|  `0` | success                                | none                                                                                     |
|  `2` | usage or input error                   | `INVALID_ARGUMENT`, `INVALID_JSON`, `VALIDATION_ERROR`, `CURSOR_INVALID`                 |
|  `3` | missing task, dependency, or database  | `TASK_NOT_FOUND`, `DEPENDENCY_NOT_FOUND`, `NOT_INITIALIZED`                              |
|  `4` | version, state, or dependency conflict | `VERSION_CONFLICT`, `STATE_CONFLICT`, `NOT_RUNNABLE`, `DEPENDENCY_CONFLICT`              |
|  `5` | storage or internal failure            | `DB_BUSY`, `DB_INVALID`, `SCHEMA_VERSION_UNSUPPORTED`, `STORAGE_ERROR`, `INTERNAL_ERROR` |

## Select, Inspect, and Claim

Get the first runnable page:

```console
taskctl list --status pending --runnable --limit 50 --format json
```

The response data is:

```json
{ "tasks": [], "nextCursor": null }
```

When another page is needed, preserve every filter and the limit:

```console
taskctl list --status pending --runnable --limit 50 --cursor <cursor> --format json
```

Inspect a chosen task rather than relying on a possibly stale list item:

```console
taskctl get --id <task-id> --format json
```

`data` contains `task` and the sorted `dependsOn` array. Confirm `pending`,
`runnable: true`, and save `task.version`. Then claim atomically:

```console
taskctl claim --id <task-id> --agent <agent-id> --expected-version <version> --format json
```

Accept the claim only when `data.task.status` is `in_progress`, its `assignee`
equals `<agent-id>`, and `data.task.version` is present. Save that returned
version.

### Claim conflict

For `VERSION_CONFLICT`, do not copy `error.details.actualVersion` into another
claim. Run `get`, inspect the complete current task and dependencies, and decide
again. For `STATE_CONFLICT` or `NOT_RUNNABLE`, do not start work on that task.

## Update Task Data and Dependencies

Pass update data through stdin as one UTF-8 JSON object:

```console
taskctl update --id <task-id> --expected-version <version> --input-json - --format json
```

Example stdin:

```json
{ "priority": "high", "labels": ["cli", "urgent-review"] }
```

Inspect `data.dependsOn` and use the latest task version before changing a
dependency:

```console
taskctl dependency-add --id <task-id> --depends-on <dependency-id> --expected-version <version> --format json
taskctl dependency-remove --id <task-id> --depends-on <dependency-id> --expected-version <version> --format json
```

Every successful update or dependency change increments the task version by
one. Save the returned version. For any `VERSION_CONFLICT`, retrieve the full
task and reconsider the intent instead of automatically retrying.

## Transition Outcomes

Use the agent that owns the task and the last successfully returned version.

### Blocked

```console
taskctl transition --id <task-id> --to blocked --agent <agent-id> --expected-version <version> --input-json - --format json
```

Example stdin must state both the blocker and recovery condition:

```json
{
  "blockedReason": "API response contract is undecided; the owner must confirm the response shape."
}
```

### Done

```console
taskctl transition --id <task-id> --to done --agent <agent-id> --expected-version <version> --input-json - --format json
```

Example stdin must match the completed and verified work:

```json
{ "result": "Updated the CLI and tests; npm run check completed successfully." }
```

### Canceled

```console
taskctl transition --id <task-id> --to canceled --agent <agent-id> --expected-version <version> --format json
```

`canceled` takes no JSON input. Use it only after confirming that the task will
not be performed. `done` and `canceled` can return to `pending` only through
`reopen`:

```console
taskctl reopen --id <task-id> --agent <agent-id> --expected-version <version> --format json
```

After a transition, require exit code `0`, `ok: true`, and the intended
`data.task.status`. On `VERSION_CONFLICT`, run `get` and reconsider the outcome
against the whole current task before issuing any new transition.

## Create Without Duplication

Before creating, walk relevant `list` pages through `nextCursor` and run `get`
for plausible duplicates. Compare the artifact, problem, and work scope rather
than title text alone. If an existing task represents the work, do not create a
new one.

For a clearly distinct task, send one JSON object through stdin:

```console
taskctl create --input-json - --format json
```

Example stdin:

```json
{ "title": "Add parser diagnostics", "priority": "normal", "labels": ["cli"] }
```

There is no physical-delete command. Represent confirmed obsolete or duplicate
work with a valid transition to `canceled`.

## Environment Failures

- Command not found: stop and report that `taskctl` must be installed and on
  `PATH`.
- `NOT_INITIALIZED`: stop and report the returned `dbPath`; the target project
  must be initialized explicitly with `taskctl init` before work begins.
- Permission or storage failure: stop and report the exit code, stable error
  code, and safe details. State which file or directory permission must be
  restored when known; do not disclose credentials or unrelated environment
  values.
