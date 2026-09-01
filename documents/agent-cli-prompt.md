# AIエージェント向けCLI利用指示の移行

AIエージェントが`taskctl`でタスクを安全に取得・更新するための指示は、
Agent Skills標準に準拠した
[`agent-tasks` Skill](../skills/agent-tasks/SKILL.md)へ移行した。

この文書に再利用プロンプトを複製しない。運用時はSkillをproject scopeの
`.agents/skills/agent-tasks/`へ配置し、Skillを正本として読み込ませる。配置の
自動化はIssue #51の範囲であり、現時点では手動配置を前提とする。

- 目的、前提、禁止事項、基本フロー:
  [`skills/agent-tasks/SKILL.md`](../skills/agent-tasks/SKILL.md)
- 詳細なコマンド契約と例:
  [`skills/agent-tasks/references/cli-workflow.md`](../skills/agent-tasks/references/cli-workflow.md)
- CLIの公開仕様: [CLI仕様](cli-spec.md)
- 状態と遷移の正本: [タスクモデルとライフサイクル](task-model.md)

CLI仕様またはタスクモデルを変更するときは、Skillの運用規則とコマンド例への
影響を同じPull Requestで確認する。
