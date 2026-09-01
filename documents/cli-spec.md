# CLI仕様

この文書は、`taskctl.mjs`のMVPにおけるプロセス境界の公開仕様である。CLIの利用者は、表示文言ではなく、終了コードとJSONレスポンスを処理する。

## 実行形式と共通規則

```text
taskctl <command> [options]
node taskctl.mjs <command> [options]
```

npmからglobal installした場合は`taskctl`を使用する。単一ESM成果物を直接配置した場合は`node taskctl.mjs`でも同じコマンドを実行できる。

配布情報を確認するトップレベルオプションは次のとおり。

| オプション  | 出力                                                       | 終了コード |
| ----------- | ---------------------------------------------------------- | ---------- |
| `--help`    | 利用方法とコマンド一覧を人間向けテキストでstdoutへ出力する | 0          |
| `--version` | `package.json`と一致するバージョンをstdoutへ出力する       | 0          |

これらはJSON入出力を提供する業務コマンドではなく、単独で指定する。出力は改行で終了する。

- コマンド名とオプション名は小文字のkebab-case、JSONプロパティ名はcamelCaseとする。
- オプションはコマンドの後に記述する。同じオプションを複数回指定した場合は`INVALID_ARGUMENT`とし、最後の値で上書きしない。
- `--`による位置引数、短縮オプション、オプション値の省略はサポートしない。
- タスクID、エージェントID、cursorは大文字小文字を区別する不透明な文字列として扱う。
- version、limitは10進整数とし、versionは1以上でなければならない。

全業務コマンドで利用できる共通オプションは次のとおり。

| オプション              | 既定値   | 意味                       |
| ----------------------- | -------- | -------------------------- |
| `--db <path>`           | 自動解決 | 使用するSQLiteファイル     |
| `--format <json\|text>` | `json`   | stdoutの成功レスポンス形式 |

相対的な`--db`と`AGENT_TASKS_DB`はプロセスのカレントディレクトリを基準に絶対パスへ解決する。DBパスは次の優先順位で決定する。

1. `--db <path>`
2. 環境変数`AGENT_TASKS_DB`
3. `init`では`<current-directory>/.agent-tasks/tasks.sqlite`
4. `init`以外では、カレントディレクトリからファイルシステムルートまで親方向に探索して最初に見つかった`.agent-tasks/tasks.sqlite`

`init`以外のコマンドはDBを暗黙に作成しない。探索で見つからなければ`NOT_INITIALIZED`を返す。シンボリックリンクとパスの正規化はOSのファイルシステム規則に従う。

## JSON入力

JSONオブジェクトを受け取るコマンドは、必須オプション`--input-json <value>`を使用する。

- `<value>`が`-`以外なら、そのオプション値自体をUTF-8のJSONとして解析する。
- `--input-json -`なら、標準入力をEOFまでUTF-8として読み取って解析する。
- 空入力、不正なUTF-8、不正なJSON、JSONオブジェクト以外のルート値は`INVALID_JSON`とする。
- JSON objectのプロパティ名は一意でなければならない。重複プロパティを含む入力の挙動は保証しないため、利用者は送信してはならない。
- 未知のプロパティは、ネストされたオブジェクトも含めて`VALIDATION_ERROR`とし、無視しない。ただし`metadata`の直下は利用者定義のプロパティを許可する。
- `--input-json -`を指定したプロセスの標準入力が対話端末かどうかにかかわらず、EOFまで読み取る。
- コマンドライン長やシェルの引用規則の影響を避けるため、エージェントには`--input-json -`の利用を推奨する。

文字列、配列、metadataの上限とタスク状態ごとの整合性規則は[タスクモデルとライフサイクル](task-model.md)を正本とする。

## 共通データ型

日時はUTCのRFC 3339形式、ミリ秒3桁固定の文字列とする。

```text
YYYY-MM-DDTHH:mm:ss.sssZ
```

タスクのJSON表現は次のとおり。nullableなプロパティも省略しない。`runnable`は保存値ではなく、レスポンス生成時に依存関係から導出する。

```json
{
  "id": "01J...",
  "title": "Implement command parser",
  "description": "",
  "status": "pending",
  "priority": "normal",
  "assignee": null,
  "blockedReason": null,
  "result": null,
  "labels": [],
  "metadata": {},
  "createdAt": "2026-01-02T03:04:05.006Z",
  "updatedAt": "2026-01-02T03:04:05.006Z",
  "startedAt": null,
  "completedAt": null,
  "version": 1,
  "runnable": true
}
```

配列の順序も公開仕様の一部とする。`labels`はUnicodeコードポイント昇順、依存先IDはID昇順で返す。数値はJSONの有限なsafe integerまたは有限な倍精度値のみを許可し、`NaN`や無限大は許可しない。JSON objectのプロパティ順は互換性の対象外である。

作成時のversionは1とする。作成後に成功した変更操作は対象タスクのversionをちょうど1増加させ、`updatedAt`を操作日時へ更新し、同じトランザクションでイベントを1件追加する。タスクとイベントには同じ操作日時を使用する。

## 成功・失敗レスポンス

`--format json`では、成功・失敗を問わずstdoutへ改行で終わるJSONオブジェクトを1個だけ出力する。成功時は次の形とする。

```json
{
  "ok": true,
  "data": {}
}
```

失敗時は次の形とする。`details`は常にオブジェクトとし、追加情報がなければ空オブジェクトを返す。

```json
{
  "ok": false,
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Task was modified by another process.",
    "details": {
      "expectedVersion": 3,
      "actualVersion": 4
    }
  }
}
```

- `ok`、`data`、`error`を省略したり、成功レスポンスに`error`を含めたりしない。
- `message`は人間の診断用で、将来変更され得る。プログラムは`code`と`details`を利用する。
- JSONはUTF-8、BOMなしで出力し、プロパティ順や空白には依存しない。
- stdoutへログ、進捗、警告、ANSIエスケープシーケンスを出力しない。
- stderrは診断・デバッグ情報専用とする。通常の業務エラーはstdoutの失敗JSONだけで表現し、stderrを解析させない。
- stdoutへの書き込みが可能な限り、予期しない内部障害も`INTERNAL_ERROR`の失敗JSONへ変換する。

`--format text`は`get`、`list`、`history`だけで利用できる。これらの成功時だけstdoutへ人間向けテキストを出力する。失敗時は形式にかかわらずJSONエラーをstdoutへ出力する。それ以外のコマンドで`text`を指定すると`UNSUPPORTED_FORMAT`を返す。テキストのレイアウトは公開互換性の対象外である。

## コマンド

### `init`

```text
node taskctl.mjs init [--db <path>]
```

親ディレクトリ探索は行わず、解決したDBを最新スキーマへ初期化またはマイグレーションする。既に最新ならデータを変更せず成功する。

```json
{
  "ok": true,
  "data": {
    "dbPath": "/project/.agent-tasks/tasks.sqlite",
    "schemaVersion": 1,
    "created": true
  }
}
```

`created`はこの実行でDBを新規作成した場合だけ`true`とする。

### `create`

```text
node taskctl.mjs create --input-json <json-or->
```

入力は`title`を必須とし、`description`、`priority`、`labels`、`metadata`、`dependsOn`を任意とする。省略値は順に`""`、`"normal"`、`[]`、`{}`、`[]`である。`dependsOn`は既存タスクIDの配列で、重複を拒否する。ID、状態、担当、日時、versionはCLIが設定するため入力できない。

```json
{
  "title": "Implement parser",
  "priority": "high",
  "labels": ["cli"],
  "dependsOn": ["01J..."]
}
```

成功時の`data`は`{"task": <Task>, "dependsOn": [<task-id>]}`とする。

### `get`

```text
node taskctl.mjs get --id <task-id>
```

成功時の`data`は`{"task": <Task>, "dependsOn": [<task-id>]}`とする。

### `list`

```text
node taskctl.mjs list [--status <status>] [--priority <priority>]
  [--assignee <agent-id>] [--unassigned] [--label <label>] [--runnable]
  [--limit <1..200>] [--cursor <cursor>]
```

- `--status`、`--priority`、`--assignee`、`--label`は完全一致で絞り込む。
- `--unassigned`は`assignee = null`を意味し、`--assignee`とは併用できない。
- `--runnable`は値を取らず、導出値が`true`のタスクだけを返す。
- 異なるフィルターはAND条件とする。MVPでは同種フィルターの複数指定と部分一致を提供しない。
- `--limit`の既定値は50、最大値は200とする。

既定順は`priority`（`urgent`、`high`、`normal`、`low`）、`createdAt`昇順、`id`昇順である。cursorはこの順序における直前ページの末尾を示す不透明な文字列で、同じフィルターとlimitでだけ再利用できる。不正、期限切れ、または条件不一致のcursorは`CURSOR_INVALID`とする。ページ取得中の更新に対するスナップショット分離は保証しないが、同じDB状態と入力には同じ順序を返す。

```json
{
  "ok": true,
  "data": {
    "tasks": [],
    "nextCursor": null
  }
}
```

返却件数がlimitに達していても次の要素が存在しなければ`nextCursor`は`null`とする。

### `update`

```text
node taskctl.mjs update --id <task-id> --expected-version <version> --input-json <json-or->
```

入力には`title`、`description`、`priority`、`labels`、`metadata`のうち1つ以上を指定する。指定されたプロパティだけを置換する。status、assignee、依存関係、ライフサイクル日時、versionは変更できない。入力値が現在値と同じ場合も成功した更新としてversionを1増加し、履歴を追加する。

成功時の`data`は`{"task": <Task>, "dependsOn": [<task-id>]}`とする。

### `dependency-add`

```text
node taskctl.mjs dependency-add --id <task-id> --depends-on <task-id> --expected-version <version>
```

対象タスクに依存先を1件追加する。自己依存、既存の依存、循環依存を`DEPENDENCY_CONFLICT`として拒否する。成功時は対象タスクのversionを増加し、`data`は`{"task": <Task>, "dependsOn": [<task-id>]}`とする。

### `dependency-remove`

```text
node taskctl.mjs dependency-remove --id <task-id> --depends-on <task-id> --expected-version <version>
```

対象タスクから依存先を1件解除する。指定関係が存在しなければ`DEPENDENCY_NOT_FOUND`とする。成功時は対象タスクのversionを増加し、`data`は`{"task": <Task>, "dependsOn": [<task-id>]}`とする。

依存関係の取得には`get`の`dependsOn`を使う。独立した取得コマンドは設けない。

### `claim`

```text
node taskctl.mjs claim --id <task-id> --agent <agent-id> --expected-version <version>
```

runnableなタスクを原子的に取得し、`pending`から`in_progress`へ遷移させる。`assignee`にagent、`startedAt`に現在日時を設定し、versionを増加する。成功時の`data`は`{"task": <Task>, "dependsOn": [<task-id>]}`とする。

### `transition`

```text
node taskctl.mjs transition --id <task-id> --to <status>
  --agent <agent-id> --expected-version <version> [--input-json <json-or->]
```

許可された通常遷移だけを実行する。`--agent`は操作主体である。現在のassigneeがnullでなければagentとの一致を要求し、不一致は`STATE_CONFLICT`とする。これにより、未割り当ての`pending`タスクも`blocked`または`canceled`へ遷移できる。遷移先ごとのJSON入力は次のとおり。

| 遷移先                | `--input-json` | 入力                      |
| --------------------- | -------------- | ------------------------- |
| `blocked`             | 必須           | `{"blockedReason":"..."}` |
| `done`                | 必須           | `{"result":"..."}`        |
| `pending`、`canceled` | 省略           | 入力不可                  |

`pending`へ戻す場合はassignee、startedAt、blockedReason、result、completedAtをnullにする。`blocked`ではblockedReasonを設定し、resultとcompletedAtをnullにする。`done`ではblockedReasonをnullにし、resultとcompletedAtを設定する。`canceled`ではblockedReasonとresultをnullにし、completedAtを設定する。全遷移でversionを増加する。成功時の`data`は`{"task": <Task>, "dependsOn": [<task-id>]}`とする。

### `reopen`

```text
node taskctl.mjs reopen --id <task-id> --agent <agent-id> --expected-version <version>
```

`done`または`canceled`を`pending`へ戻す。assignee、blockedReason、result、startedAt、completedAtをnullにし、versionを増加する。`--agent`は履歴に記録する操作主体である。成功時の`data`は`{"task": <Task>, "dependsOn": [<task-id>]}`とする。

### `history`

```text
node taskctl.mjs history --id <task-id> [--limit <1..500>] [--cursor <cursor>]
```

イベントを因果順序を表す`toVersion`昇順で返す。limitの既定値は100、最大値は500とする。cursorの規則は`list`と同じである。

イベントは少なくとも次の共通プロパティを持つ。`actor`は`created`、`updated`、`dependencyAdded`、`dependencyRemoved`ではnull、`claimed`、`transitioned`、`reopened`では操作したagent IDとする。`details`はイベント種別固有のJSON objectとする。

```json
{
  "id": "01J...",
  "taskId": "01J...",
  "type": "transitioned",
  "actor": "agent-a",
  "occurredAt": "2026-01-02T03:04:05.006Z",
  "fromVersion": 2,
  "toVersion": 3,
  "details": {}
}
```

```json
{ "ok": true, "data": { "events": [], "nextCursor": null } }
```

`fromVersion`は`created`だけnull、それ以外は直前のversionとする。イベントtypeと`details`は次のとおり。`changes`の各値は`{"from":<old-value>,"to":<new-value>}`であり、入力で指定されたプロパティだけを含む。

| `type`              | `details`                                                                   |
| ------------------- | --------------------------------------------------------------------------- |
| `created`           | `{"task": <Task>, "dependsOn": [<task-id>]}`                                |
| `updated`           | `{"changes": {<input-property>: {"from": ..., "to": ...}}}`                 |
| `dependencyAdded`   | `{"dependsOn":"<task-id>"}`                                                 |
| `dependencyRemoved` | `{"dependsOn":"<task-id>"}`                                                 |
| `claimed`           | `{"fromStatus":"pending","toStatus":"in_progress","assignee":"<agent-id>"}` |
| `transitioned`      | `{"fromStatus":"...","toStatus":"...","blockedReason":null,"result":null}`  |
| `reopened`          | `{"fromStatus":"done\|canceled","toStatus":"pending"}`                      |

`transitioned`の`blockedReason`と`result`はnullableだが省略しない。イベントは作成時の値を保持し、後のタスク更新によって書き換えない。

### `export`

```text
node taskctl.mjs export
```

確認とバックアップ用の一貫した読み取りトランザクションによるスナップショットを返す。インポート機能はMVPに含めず、この出力を正本として編集する運用は行わない。タスクはID昇順、依存関係は`taskId`昇順、同一タスク内では`dependsOn`昇順とする。件数制限は適用しない。

```json
{
  "ok": true,
  "data": {
    "schemaVersion": 1,
    "exportedAt": "2026-01-02T03:04:05.006Z",
    "tasks": [],
    "dependencies": []
  }
}
```

依存関係の要素は`{"taskId":"...","dependsOn":"..."}`とする。exportのタスクにも`runnable`を含める。

## 競合時の優先順位

versionを必要とする操作では、対象の存在、expected version、現在状態、その他のドメイン条件の順に検証する。このため、古いversionと不正状態が同時に成立する場合は`VERSION_CONFLICT`を返す。競合後は`get`で最新タスクを取得してから再判断し、同じ変更を自動的に再試行しない。

## 終了コードとエラーコード

終了コードは大分類、`error.code`はプログラムが分岐に使用する安定した詳細分類である。

| 終了コード | 意味                               | `error.code`                                                                                                      |
| ---------: | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
|          0 | 成功                               | なし                                                                                                              |
|          2 | コマンド使用方法または入力の誤り   | `UNKNOWN_COMMAND`, `INVALID_ARGUMENT`, `INVALID_JSON`, `VALIDATION_ERROR`, `UNSUPPORTED_FORMAT`, `CURSOR_INVALID` |
|          3 | 対象または初期化済みDBが存在しない | `TASK_NOT_FOUND`, `DEPENDENCY_NOT_FOUND`, `NOT_INITIALIZED`                                                       |
|          4 | 楽観ロック、状態、依存関係の競合   | `VERSION_CONFLICT`, `STATE_CONFLICT`, `NOT_RUNNABLE`, `DEPENDENCY_CONFLICT`                                       |
|          5 | ストレージまたは予期しない内部障害 | `DB_BUSY`, `DB_INVALID`, `SCHEMA_VERSION_UNSUPPORTED`, `STORAGE_ERROR`, `INTERNAL_ERROR`                          |

エラー詳細は次の規則に従う。

- `INVALID_ARGUMENT`: `option`、必要に応じて`value`
- `VALIDATION_ERROR`: `issues`配列。各要素は`path`、`code`、`message`を持つ
- `TASK_NOT_FOUND`: `taskId`
- `DEPENDENCY_NOT_FOUND`: `taskId`、`dependsOn`
- `VERSION_CONFLICT`: `taskId`、`expectedVersion`、`actualVersion`
- `STATE_CONFLICT`: `taskId`、`actualStatus`、可能なら`allowedStatuses`
- `NOT_RUNNABLE`: `taskId`、`incompleteDependencyIds`
- `DEPENDENCY_CONFLICT`: `taskId`、`dependsOn`、`reason`。reasonは`self`、`duplicate`、`cycle`のいずれか
- `NOT_INITIALIZED`、DB関連エラー: `dbPath`

複数の入力検証エラーは、`path`のUnicodeコードポイント昇順で`issues`へすべて格納する。セキュリティ上不要なスタックトレース、SQL、認証情報、環境変数の値はレスポンスへ含めない。
