export const FORMATS = ["json", "text"] as const;
export type Format = (typeof FORMATS)[number];

interface CommandSpec {
  readonly invocation: readonly string[];
  readonly description: string;
  readonly valueOptions: readonly string[];
  readonly flagOptions: readonly string[];
  readonly formats: readonly Format[];
}

const JSON_ONLY = ["json"] as const;
const JSON_AND_TEXT = ["json", "text"] as const;

export const COMMAND_SPECS = {
  init: {
    invocation: ["init"],
    description: "Initialize the task database",
    valueOptions: ["--db", "--format"],
    flagOptions: [],
    formats: JSON_ONLY,
  },
  create: {
    invocation: ["create"],
    description: "Create a task",
    valueOptions: ["--db", "--format", "--input-json"],
    flagOptions: [],
    formats: JSON_ONLY,
  },
  get: {
    invocation: ["get"],
    description: "Get a task",
    valueOptions: ["--db", "--format", "--id"],
    flagOptions: [],
    formats: JSON_AND_TEXT,
  },
  list: {
    invocation: ["list"],
    description: "List tasks",
    valueOptions: [
      "--db",
      "--format",
      "--status",
      "--priority",
      "--assignee",
      "--label",
      "--limit",
      "--cursor",
    ],
    flagOptions: ["--unassigned", "--runnable"],
    formats: JSON_AND_TEXT,
  },
  update: {
    invocation: ["update"],
    description: "Update a task",
    valueOptions: [
      "--db",
      "--format",
      "--id",
      "--expected-version",
      "--input-json",
    ],
    flagOptions: [],
    formats: JSON_ONLY,
  },
  claim: {
    invocation: ["claim"],
    description: "Claim a task",
    valueOptions: ["--db", "--format", "--id", "--agent", "--expected-version"],
    flagOptions: [],
    formats: JSON_ONLY,
  },
  transition: {
    invocation: ["transition"],
    description: "Change a task status",
    valueOptions: [
      "--db",
      "--format",
      "--id",
      "--to",
      "--agent",
      "--expected-version",
      "--input-json",
    ],
    flagOptions: [],
    formats: JSON_ONLY,
  },
  reopen: {
    invocation: ["reopen"],
    description: "Reopen a task",
    valueOptions: ["--db", "--format", "--id", "--agent", "--expected-version"],
    flagOptions: [],
    formats: JSON_ONLY,
  },
  history: {
    invocation: ["history"],
    description: "Show task history",
    valueOptions: ["--db", "--format", "--id", "--limit", "--cursor"],
    flagOptions: [],
    formats: JSON_AND_TEXT,
  },
  export: {
    invocation: ["export"],
    description: "Export all task data",
    valueOptions: ["--db", "--format"],
    flagOptions: [],
    formats: JSON_ONLY,
  },
  "dependency-add": {
    invocation: ["dependency-add"],
    description: "Add a task dependency",
    valueOptions: [
      "--db",
      "--format",
      "--id",
      "--depends-on",
      "--expected-version",
    ],
    flagOptions: [],
    formats: JSON_ONLY,
  },
  "dependency-remove": {
    invocation: ["dependency-remove"],
    description: "Remove a task dependency",
    valueOptions: [
      "--db",
      "--format",
      "--id",
      "--depends-on",
      "--expected-version",
    ],
    flagOptions: [],
    formats: JSON_ONLY,
  },
  "skill-install": {
    invocation: ["skill", "install"],
    description: "Install the agent-tasks Skill in a project",
    valueOptions: ["--project", "--format"],
    flagOptions: [],
    formats: JSON_ONLY,
  },
} as const satisfies Readonly<Record<string, CommandSpec>>;

export type Command = keyof typeof COMMAND_SPECS;

export const COMMANDS = Object.keys(COMMAND_SPECS) as readonly Command[];

export const HELP_TEXT = `Usage: taskctl <command> [options]

Commands:
${COMMANDS.map((command) => {
  const spec = COMMAND_SPECS[command];
  return `  ${spec.invocation.join(" ").padEnd(19)}${spec.description}`;
}).join("\n")}

Global options:
  --help             Show this help
  --version          Show the installed version

Use --db <path> with task and database commands to select a database.
`;

export function supportsFormat(command: Command, format: Format): boolean {
  return (COMMAND_SPECS[command].formats as readonly Format[]).includes(format);
}
