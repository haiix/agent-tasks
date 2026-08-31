# agent-tasks

`agent-tasks`は、プロジェクト内で作業するAIエージェント向けのローカルタスク管理CLIです。サーバーや外部サービスを必要とせず、タスクの作成、検索、claim、状態遷移を機械処理しやすいインターフェースで提供します。

> [!NOTE]
> このプロジェクトは開発中です。現在はデータベース初期化など、一部のCLI機能だけが実装されています。

## 開発

Node.js 24を使用する。

```shell
npm install
npm run check
```

`npm run check`は型検査、lint、書式検査、テスト、ビルドを実行する。書式を修正する場合は`npm run format`を使用する。

`npm run dev -- <command>`でTypeScriptソースを直接実行できる。ビルドすると、実行時npm依存のない単一ESMファイル`dist/taskctl.mjs`が生成される。

カレントディレクトリの`.agent-tasks/tasks.sqlite`を初期化するには、次を実行する。

```shell
npm run dev -- init
```

保存先は`--db <path>`または環境変数`AGENT_TASKS_DB`でも指定でき、`--db`が優先される。

## 目的

- Node.js CLIとしてローカルで動作する
- 対象プロジェクト内にタスクデータを保存する
- 複数のローカルAIエージェントから安全に利用できる
- プログラムから扱いやすい安定したJSON入出力を提供する
- タスクの状態遷移と担当変更を履歴として記録する
- 実行時npm依存のない単一ESMファイル`taskctl.mjs`として配布する

## ドキュメント

プロジェクトの仕様と設計判断は[`documents/`](documents/README.md)で管理します。

- [アーキテクチャと保存方式](documents/architecture.md)
- [SQLiteスキーマとマイグレーション](documents/database.md)
- [CLI仕様](documents/cli-spec.md)
- [タスクモデルとライフサイクル](documents/task-model.md)
- [開発環境と配布方式](documents/development.md)

各文書にはステータスを記載しています。`Accepted`は現在の合意済み仕様、`Draft`は実装前に詳細の確定が必要な仕様を示します。

## ロードマップ

実装作業と依存関係は[GitHub Issues](https://github.com/haiix/agent-tasks/issues)で管理し、全体の実装順は[Issue #12](https://github.com/haiix/agent-tasks/issues/12)で追跡します。

## ライセンス

[LICENSE](LICENSE)を参照してください。
