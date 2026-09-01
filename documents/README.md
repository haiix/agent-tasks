# プロジェクト文書

このディレクトリを、`agent-tasks`の確定した仕様、設計判断、運用ルールの正本とする。ルートの`README.md`はプロジェクト概要と文書への入口だけを扱う。

## 文書一覧

| 文書                                       | 内容                                   |
| ------------------------------------------ | -------------------------------------- |
| [architecture.md](architecture.md)         | 全体構成、保存方式、データ配置         |
| [database.md](database.md)                 | SQLiteスキーマ、マイグレーション、障害 |
| [cli-spec.md](cli-spec.md)                 | CLIコマンド、JSON入出力、エラー        |
| [agent-cli-prompt.md](agent-cli-prompt.md) | AIエージェント向けCLI利用プロンプト    |
| [task-model.md](task-model.md)             | タスク項目、状態、遷移、依存関係       |
| [development.md](development.md)           | TypeScript/ESM開発環境、ビルド、テスト |
| [releasing.md](releasing.md)               | npm公開、Trusted Publishing、検証      |

## 記述ルール

1. 仕様や設計判断を追加・変更するときは、対応するMarkdown文書をこのディレクトリ内で更新する。
2. 新しい文書は小文字のkebab-caseで命名し、この一覧へ追加する。
3. 検討案や一時的な作業メモはこのディレクトリへ置かず、合意した内容だけを反映する。
4. CLIの挙動、JSON例、状態名、フィールド名は実装と同時に更新する。
5. 文書間で同じ仕様を重複させず、正本となる文書へリンクする。

## 更新時の確認

- 確定した内容だけが記載されているか
- 関連文書と矛盾していないか
- READMEの文書一覧を更新したか
- 実装済みの場合、コードとテストも同じ仕様になっているか
