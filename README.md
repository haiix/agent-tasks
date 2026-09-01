# agent-tasks

`agent-tasks`は、プロジェクト内で作業するAIエージェント向けのローカルタスク管理CLIです。サーバーや外部サービスを必要とせず、タスクの作成、検索、claim、状態遷移を機械処理しやすいインターフェースで提供します。

## インストール

Node.js 24以降で利用する。

```shell
npm install --global @haiix/agent-tasks
taskctl --version
taskctl --help
```

インストール後は、対象プロジェクトでデータベースを初期化する。

```shell
taskctl init
```

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

タスクを作成し、取得・一覧・更新する例を次に示す。コマンドの成功・失敗は公開JSON仕様に従ってstdoutへ出力される。

```shell
npm run dev -- create --input-json '{"title":"Implement parser","priority":"high"}'
npm run dev -- get --id <task-id>
npm run dev -- list --status pending --limit 20
npm run dev -- update --id <task-id> --expected-version 1 --input-json '{"labels":["cli"]}'
npm run dev -- dependency-add --id <task-id> --depends-on <dependency-id> --expected-version 2
npm run dev -- list --runnable
npm run dev -- claim --id <task-id> --agent <agent-id> --expected-version 3
npm run dev -- transition --id <task-id> --to done --agent <agent-id> --expected-version 4 --input-json '{"result":"Implemented and tested"}'
npm run dev -- history --id <task-id>
npm run dev -- export
```

シェルの引用やコマンドライン長の影響を避ける場合は、`--input-json -`を指定して標準入力からJSONを渡す。

`get`、`list`、`history`では、対話的な確認用に`--format text`も指定できる。`export`は確認・バックアップ用のスナップショットであり、編集して正本として扱うための形式ではない。

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
- [AIエージェント向けCLI利用プロンプト](documents/agent-cli-prompt.md)
- [タスクモデルとライフサイクル](documents/task-model.md)
- [開発環境と配布方式](documents/development.md)
- [npm公開手順](documents/releasing.md)

## ライセンス

[LICENSE](LICENSE)を参照してください。
