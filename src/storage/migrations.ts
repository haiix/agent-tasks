import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export const SCHEMA_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    statements: [
      `
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
          description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 20000),
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'in_progress', 'blocked', 'done', 'canceled')),
          priority TEXT NOT NULL DEFAULT 'normal'
            CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
          assignee TEXT CHECK (assignee IS NULL OR length(assignee) BETWEEN 1 AND 200),
          blocked_reason TEXT CHECK (
            blocked_reason IS NULL OR length(blocked_reason) BETWEEN 1 AND 20000
          ),
          result TEXT CHECK (result IS NULL OR length(result) BETWEEN 1 AND 20000),
          labels_json TEXT NOT NULL DEFAULT '[]'
            CHECK (json_valid(labels_json) AND json_type(labels_json) = 'array'),
          metadata_json TEXT NOT NULL DEFAULT '{}'
            CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
          CHECK (created_at <= updated_at),
          CHECK (started_at IS NULL OR started_at BETWEEN created_at AND updated_at),
          CHECK (completed_at IS NULL OR completed_at BETWEEN created_at AND updated_at),
          CHECK (
            (status = 'pending'
              AND assignee IS NULL AND blocked_reason IS NULL AND result IS NULL
              AND started_at IS NULL AND completed_at IS NULL)
            OR
            (status = 'in_progress'
              AND assignee IS NOT NULL AND started_at IS NOT NULL
              AND blocked_reason IS NULL AND result IS NULL AND completed_at IS NULL)
            OR
            (status = 'blocked'
              AND blocked_reason IS NOT NULL AND result IS NULL AND completed_at IS NULL
              AND ((assignee IS NULL AND started_at IS NULL)
                OR (assignee IS NOT NULL AND started_at IS NOT NULL)))
            OR
            (status = 'done'
              AND assignee IS NOT NULL AND started_at IS NOT NULL
              AND blocked_reason IS NULL AND result IS NOT NULL AND completed_at IS NOT NULL)
            OR
            (status = 'canceled'
              AND blocked_reason IS NULL AND result IS NULL AND completed_at IS NOT NULL
              AND ((assignee IS NULL AND started_at IS NULL)
                OR (assignee IS NOT NULL AND started_at IS NOT NULL)))
          )
        ) STRICT
      `,
      `
        CREATE TABLE task_dependencies (
          task_id TEXT NOT NULL,
          depends_on TEXT NOT NULL,
          PRIMARY KEY (task_id, depends_on),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          FOREIGN KEY (depends_on) REFERENCES tasks(id) ON DELETE RESTRICT,
          CHECK (task_id <> depends_on)
        ) STRICT
      `,
      `
        CREATE TABLE task_events (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (
            type IN (
              'created', 'updated', 'dependencyAdded', 'dependencyRemoved',
              'claimed', 'transitioned', 'reopened'
            )
          ),
          actor TEXT CHECK (actor IS NULL OR length(actor) BETWEEN 1 AND 200),
          occurred_at TEXT NOT NULL,
          from_version INTEGER CHECK (from_version IS NULL OR from_version >= 1),
          to_version INTEGER NOT NULL CHECK (to_version >= 1),
          details_json TEXT NOT NULL
            CHECK (json_valid(details_json) AND json_type(details_json) = 'object'),
          FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
          CHECK (
            (type = 'created' AND from_version IS NULL AND to_version = 1)
            OR (type <> 'created' AND from_version IS NOT NULL AND to_version = from_version + 1)
          )
        ) STRICT
      `,
      `
        CREATE INDEX idx_tasks_list_order ON tasks(
          CASE priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
            WHEN 'low' THEN 3
          END,
          created_at,
          id
        )
      `,
      "CREATE INDEX idx_tasks_status ON tasks(status)",
      "CREATE INDEX idx_tasks_assignee ON tasks(assignee)",
      "CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on, task_id)",
      "CREATE INDEX idx_task_events_history ON task_events(task_id, occurred_at, id)",
    ],
  },
];

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.version}\n${migration.name}\n`)
    .update(migration.statements.join("\n-- statement --\n"))
    .digest("hex");
}

export function executeMigration(
  database: DatabaseSync,
  migration: Migration,
): void {
  for (const statement of migration.statements) {
    database.exec(statement);
  }
}
