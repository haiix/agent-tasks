# タスクモデルとライフサイクル

## 状態

初期状態は次の5種類とする。

| 状態          | 意味                         |
| ------------- | ---------------------------- |
| `pending`     | 未着手                       |
| `in_progress` | claim済みで作業中            |
| `blocked`     | 記録された理由により進行不能 |
| `done`        | 作業と必要な検証が完了       |
| `canceled`    | 実施しないことが確定         |

`ready`は永続状態として保存しない。タスクが次の条件を満たす場合に、`runnable`として導出する。

```text
status = pending
かつ
すべての依存タスクのstatus = done
```

## 状態遷移

通常の遷移は次のとおり。

```text
pending     -> in_progress | blocked | canceled
in_progress -> pending | blocked | done | canceled
blocked     -> pending | canceled
done        -> pending（reopenのみ）
canceled    -> pending（reopenのみ）
```

- `blocked`へ移すときは`blockedReason`を必須とする。
- `done`へ移すときは実施内容と検証結果を`result`へ記録する。
- `done`と`canceled`からの復帰は`reopen`に限定する。
- 通常操作では物理削除せず、不要なタスクは`canceled`へ移す。

## claim

`claim`は、runnableなタスクをエージェントが取得するための第一級操作とする。次の変更を同一トランザクションで実行する。

1. 現在状態とexpected versionを確認する。
2. `pending`から`in_progress`へ変更する。
3. `assignee`と`startedAt`を設定する。
4. `version`を増加する。
5. イベント履歴を追加する。

すでに別エージェントがclaimしたタスクに対しては、成功を返さず状態競合として扱う。

## コア項目

初期モデルには次の項目を含める。

```json
{
  "id": "string",
  "title": "string",
  "description": "string",
  "status": "pending",
  "priority": "normal",
  "assignee": null,
  "blockedReason": null,
  "result": null,
  "labels": [],
  "metadata": {},
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "startedAt": null,
  "completedAt": null,
  "version": 1
}
```

優先度は次のenumとする。

```text
low
normal
high
urgent
```

## 入力制約

文字数はUTF-16コード単位ではなくUnicodeコードポイントで数える。文字列と配列には次の上限を適用する。

| 対象                                     | 制約                                   |
| ---------------------------------------- | -------------------------------------- |
| `title`                                  | 1〜200文字、空白のみは不可             |
| `description`、`blockedReason`、`result` | 最大20,000文字                         |
| タスクID、agent ID、label                | 1〜200文字、空白のみは不可             |
| `labels`、`dependsOn`                    | 最大50件、重複不可                     |
| `metadata`                               | JSON object、UTF-8で64 KiB、最大10階層 |

- `blockedReason`と`result`は設定時に空白のみの値を許可しない。
- `metadata`内を除く文字列値はwell-formed Unicodeとし、孤立したUTF-16サロゲートを拒否する。
- `metadata`には文字列、真偽値、null、有限数値、配列、objectだけを許可する。
- 入力の`labels`と`dependsOn`はUnicodeコードポイント昇順に正規化する。
- CLI入力の未知のプロパティは無視せず、構造化された`VALIDATION_ERROR`として拒否する。

## 保存時の整合性

- 日時はUTCのRFC 3339形式かつミリ秒3桁固定とする。
- `createdAt <= startedAt/completedAt <= updatedAt`を満たす。nullableな日時は比較対象外とする。
- `pending`ではassignee、blockedReason、result、startedAt、completedAtをnullとする。
- `in_progress`ではassigneeとstartedAtを必須とし、blockedReason、result、completedAtをnullとする。
- `blocked`ではblockedReasonを必須とする。assigneeとstartedAtは両方設定するか両方nullとし、resultとcompletedAtはnullとする。
- `done`ではassignee、startedAt、result、completedAtを必須とし、blockedReasonをnullとする。
- `canceled`ではcompletedAtを必須とする。assigneeとstartedAtは両方設定するか両方nullとし、blockedReasonとresultはnullとする。
- versionは1以上のsafe integerとする。

## 依存関係

- 依存関係はタスク本体とは別に管理する。
- 自己依存と循環依存を拒否する。
- 未完了の依存タスクがある場合、claimを拒否する。
- 完了済み依存タスクが再オープンされた場合、未着手の依存元タスクはrunnableではなくなる。
