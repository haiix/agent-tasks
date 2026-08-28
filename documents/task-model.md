# タスクモデルとライフサイクル

- Status: Accepted
- Related issues: [#9](https://github.com/haiix/agent-tasks/issues/9), [#5](https://github.com/haiix/agent-tasks/issues/5), [#4](https://github.com/haiix/agent-tasks/issues/4)

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

ID形式、最大文字数、metadataの上限などの詳細な制約は、ドメイン実装時に確定して追記する。

## 依存関係

- 依存関係はタスク本体とは別に管理する。
- 自己依存と循環依存を拒否する。
- 未完了の依存タスクがある場合、claimを拒否する。
- 完了済み依存タスクが再オープンされた場合、未着手の依存元タスクはrunnableではなくなる。
