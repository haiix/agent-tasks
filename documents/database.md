# SQLiteスキーマとマイグレーション

- Status: Accepted
- Related issue: [#6](https://github.com/haiix/agent-tasks/issues/6)

## 接続設定

各SQLite接続は、利用開始時に次の設定を行う。

- `foreign_keys = ON`: 外部キー制約を接続ごとに有効化する。
- `journal_mode = WAL`: 読み取りと書き込みの競合を減らす。
- `busy_timeout = 5000`: ロックを最大5秒待ち、解消しなければ`DB_BUSY`を返す。

実行時の値をSQLへ渡す場合はprepared statementのプレースホルダーを使用する。マイグレーションに含まれる、利用者入力を含まない固定DDLだけは直接実行する。

## 初期スキーマ

スキーマバージョン1は次のテーブルで構成する。SQLiteの`STRICT`テーブル、`CHECK`、外部キー、ユニーク制約を使用し、アプリケーションのバリデーションに加えて保存時にも主要な不整合を拒否する。

### `tasks`

タスク本体を保存する。

| カラム           | 型        | 制約・用途                        |
| ---------------- | --------- | --------------------------------- |
| `id`             | `TEXT`    | 主キー                            |
| `title`          | `TEXT`    | 必須、1〜200文字                  |
| `description`    | `TEXT`    | 必須、最大20,000文字              |
| `status`         | `TEXT`    | タスクモデルで定義した5状態       |
| `priority`       | `TEXT`    | `low`、`normal`、`high`、`urgent` |
| `assignee`       | `TEXT`    | nullable、最大200文字             |
| `blocked_reason` | `TEXT`    | nullable、最大20,000文字          |
| `result`         | `TEXT`    | nullable、最大20,000文字          |
| `labels_json`    | `TEXT`    | JSON配列                          |
| `metadata_json`  | `TEXT`    | JSON object                       |
| `created_at`     | `TEXT`    | UTC RFC 3339日時                  |
| `updated_at`     | `TEXT`    | UTC RFC 3339日時                  |
| `started_at`     | `TEXT`    | nullable                          |
| `completed_at`   | `TEXT`    | nullable                          |
| `version`        | `INTEGER` | 1以上の楽観ロック用version        |

状態ごとのnullable項目の組み合わせと日時の順序は`CHECK`制約でも検証する。Unicodeコードポイント単位の長さ、空白だけの文字列、JSON内容の詳細な上限はアプリケーション層で検証する。

一覧、状態、担当者の検索用に次のインデックスを持つ。

- `idx_tasks_list_order(priority, created_at, id)`
- `idx_tasks_status(status)`
- `idx_tasks_assignee(assignee)`

### `task_dependencies`

`task_id`と`depends_on`の複合主キーで依存関係を保存する。両方を`tasks.id`への外部キーとし、自己依存と重複を拒否する。循環依存は複数行にまたがるため、書き込みトランザクション内でアプリケーションが検出する。

依存先から依存元を検索するため、`idx_task_dependencies_depends_on(depends_on, task_id)`を持つ。

### `task_events`

タスクの変更履歴を保存する。`id`を主キー、`task_id`を外部キーとし、イベント種別、操作主体、発生日時、変更前後のversion、種別固有のJSON objectを保持する。`created`イベントは`from_version = NULL`かつ`to_version = 1`、その他は`to_version = from_version + 1`とする。

履歴順で取得するため、`idx_task_events_history(task_id, occurred_at, id)`を持つ。

### `schema_migrations`

| カラム       | 型        | 制約・用途                   |
| ------------ | --------- | ---------------------------- |
| `version`    | `INTEGER` | 主キー、1から連続するversion |
| `name`       | `TEXT`    | 一意なマイグレーション名     |
| `checksum`   | `TEXT`    | 定義のSHA-256                |
| `applied_at` | `TEXT`    | 適用日時                     |

## 初期化とマイグレーション

初期化はDBの親ディレクトリを作成し、未作成ならSQLiteファイルを作る。`schema_migrations`の準備と各マイグレーションはそれぞれ`BEGIN IMMEDIATE`トランザクション内で実行する。失敗時はそのマイグレーションのDDLと履歴行をすべてロールバックする。

初期化を繰り返した場合、適用済みversion、名前、チェックサムを確認するだけでデータを変更しない。同時に複数プロセスが初期化した場合は、書き込みロック取得後に適用済みversionを再確認する。

次の場合は処理を中止する。

- DB側のversionが実装より新しい: `SCHEMA_VERSION_UNSUPPORTED`
- versionが連続していない、または適用済み定義の名前・チェックサムが異なる: `DB_INVALID`

## 障害方針

ストレージ例外はSQLやスタックトレースを公開レスポンスへ含めず、DBパスをdetailsに持つ構造化エラーへ変換する。

| エラーコード                 | 条件                                    |
| ---------------------------- | --------------------------------------- |
| `DB_BUSY`                    | busy timeoutまでにロックを取得できない  |
| `DB_INVALID`                 | SQLite形式でない、破損、履歴不整合      |
| `SCHEMA_VERSION_UNSUPPORTED` | DBのスキーマが実装より新しい            |
| `STORAGE_ERROR`              | 開閉、ディレクトリ、I/Oなどその他の障害 |
