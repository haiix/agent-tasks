# agent-tasks

`agent-tasks`は、プロジェクト内で作業するAIエージェント向けのローカルタスク管理CLIです。サーバーや外部サービスを必要とせず、タスクの作成、検索、claim、状態遷移を機械処理しやすいインターフェースで提供します。

> [!NOTE]
> このプロジェクトは現在、設計・計画段階です。CLIはまだ実装されていません。

## 目的

- Node.js CLIとしてローカルで動作する
- 対象プロジェクト内にタスクデータを保存する
- 複数のローカルAIエージェントから安全に利用できる
- プログラムから扱いやすい安定したJSON入出力を提供する
- タスクの状態遷移と担当変更を履歴として記録する
- 実行時npm依存のない単一ESM JavaScriptファイルとして配布する

## ドキュメント

プロジェクトの仕様と設計判断は[`documents/`](documents/README.md)で管理します。

- [アーキテクチャと保存方式](documents/architecture.md)
- [CLI仕様](documents/cli-spec.md)
- [タスクモデルとライフサイクル](documents/task-model.md)
- [開発環境と配布方式](documents/development.md)

各文書にはステータスを記載しています。`Accepted`は現在の合意済み仕様、`Draft`は実装前に詳細の確定が必要な仕様を示します。

## ロードマップ

実装作業と依存関係は[GitHub Issues](https://github.com/haiix/agent-tasks/issues)で管理し、全体の実装順は[Issue #12](https://github.com/haiix/agent-tasks/issues/12)で追跡します。

## ライセンス

[LICENSE](LICENSE)を参照してください。
