# CLI仕様

- Status: Draft
- Related issue: [#11](https://github.com/haiix/agent-tasks/issues/11)

この文書はCLI公開仕様のドラフトである。Issue #11で詳細を確定した後、ステータスを`Accepted`へ変更する。

## 実行形式

```text
node taskctl.js <command> [options]
```

CLIは短命プロセスとして動作し、デフォルトでは機械処理向けJSONを出力する。

## コマンド

MVPで予定しているコマンドは次のとおり。

```text
node taskctl.js init
node taskctl.js create --input-json <json>
node taskctl.js get --id <task-id>
node taskctl.js list [filters]
node taskctl.js update --id <task-id> --input-json <json>
node taskctl.js claim --id <task-id> --agent <agent-id> --expected-version <version>
node taskctl.js transition --id <task-id> --to <status> --expected-version <version>
node taskctl.js reopen --id <task-id> --expected-version <version>
node taskctl.js history --id <task-id>
node taskctl.js export
```

複雑な入力は`--input-json`で渡す。標準入力を示す`--input-json -`の採用を予定している。

## JSONレスポンス

成功時：

```json
{
  "ok": true,
  "data": {}
}
```

失敗時：

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

## 出力規則

- stdoutにはレスポンスJSONだけを出力する。
- 診断、デバッグ情報、人間向け警告はstderrへ出力する。
- 日時はUTCのISO 8601文字列とする。
- 不明な入力フィールドは無視せずエラーにする。
- 一覧結果は決定的な順序で返す。
- 人間向け出力は明示的な`--format text`で提供する。
- 状態変更は汎用`update`ではなく`transition`などの専用操作で行う。

## 終了コード案

| コード | 意味 |
| ---: | --- |
| 0 | 成功 |
| 2 | 入力または使用方法のエラー |
| 3 | 対象が存在しない |
| 4 | version競合または状態競合 |
| 5 | DBまたは内部エラー |

詳細な失敗理由は終了コードだけでなく`error.code`で判定する。

## 未決定事項

- JSONプロパティをcamelCaseとsnake_caseのどちらへ統一するか
- 専用環境変数名
- 一覧の既定ソート順、件数上限、ページング方式
- エラーコードの完全な一覧
- `create`と`update`で個別オプションも許可するか
- text形式をMVPへ含める範囲
