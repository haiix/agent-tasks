# アーキテクチャと保存方式

- Status: Accepted
- Related issues: [#6](https://github.com/haiix/agent-tasks/issues/6), [#7](https://github.com/haiix/agent-tasks/issues/7)

## 概要

`agent-tasks`は、プロジェクト内で動作するAIエージェント向けのローカルCLIである。HTTPサーバーや常駐デーモンは持たず、各操作を短命なNode.jsプロセスとして実行する。

CLIをプロセス境界の公開APIとし、JavaScriptライブラリとしてのimport APIはMVPの対象外とする。

## 保存方式

SQLiteをタスクデータの正本とする。既定の保存先は次のとおり。

```text
<project>/.agent-tasks/tasks.sqlite
```

JSONファイルではなくSQLiteを採用する主な理由は、複数エージェントによるclaimや状態更新をトランザクションで原子的に処理するためである。

JSONエクスポートは確認やバックアップ用に提供できるが、エクスポート結果を正本として再編集する運用は行わない。

## 論理テーブル

初期スキーマは、少なくとも次の論理テーブルで構成する。

- `tasks`: タスク本体
- `task_dependencies`: タスク間の依存関係
- `task_events`: 状態、担当者、内容変更などのイベント履歴
- `schema_migrations`: スキーマバージョンと適用済みマイグレーション

具体的なカラム、インデックス、制約はIssue #6で確定し、この文書または専用のDB仕様文書へ反映する。

## DBパスの解決

DBパスは次の優先順位で決定する。

1. CLIの`--db <path>`
2. 環境変数`AGENT_TASKS_DB`
3. カレントディレクトリから親方向に探索した`.agent-tasks/tasks.sqlite`

DB作成は`init`コマンドだけが行う。その他のコマンドはDBを暗黙作成せず、見つからない場合に未初期化エラーを返す。

探索はカレントディレクトリからファイルシステムルートまで行う。`init`だけは親方向へ探索せず、明示指定がなければカレントディレクトリ直下を初期化する。詳細は[CLI仕様](cli-spec.md)を正本とする。

## 一貫性と競合

- claim、状態遷移、version更新、イベント追加は同一トランザクションで処理する。
- 更新にはexpected versionを使い、古い読み取り結果からの上書きを拒否する。
- SQLにはプレースホルダーを使い、任意SQL実行機能は公開しない。
- DBロックを無期限に待たず、一定時間後に構造化エラーを返す。
- 通常操作ではタスクを物理削除しない。

## MVPの対象外

- HTTP APIと常駐デーモン
- Web UI
- リモート同期
- Gitとの双方向同期
- スケジューラー
- 認証と複雑な権限管理
- プラグイン機構
