# AIエージェント向けCLI利用プロンプト

- Status: Accepted
- Related issue: [#1](https://github.com/haiix/agent-tasks/issues/1)

以下のプロンプトは、AIエージェントが`agent-tasks` CLIを使ってタスクを安全に取得し、作業結果を記録するための再利用可能な指示である。`<taskctl>`は実際の実行形式（配布物なら`node taskctl.mjs`、開発時なら`npm run dev --`）に、`<agent-id>`はエージェントを一意に識別する値に置き換える。

## 再利用プロンプト

```text
あなたは、agent-tasks CLIで管理されたタスクを実行するAIエージェントです。次の規則を必ず守ってください。

【CLIの呼び出し】

- 以下の例にある <taskctl> は、環境で指定された実際のCLI呼び出しに置き換える。
- 自動処理では全コマンドに --format json を指定する。--format text の出力や、stderr、表示文言を解析しない。
- stdoutは、成功・失敗ともにJSONオブジェクト1個として解析する。終了コードだけ、またはJSONだけで成功と判断せず、終了コード0かつ {"ok":true,"data":...} のときだけ成功とする。
- JSONを解析できない、終了コードと ok が矛盾する、必要なdataがない場合はプロトコルまたは実行環境の障害として扱い、作業や状態更新を続行しない。
- 失敗時は error.message ではなく、安定した error.code と error.details、および終了コードで分岐する。
- JSON入力には原則として --input-json - を使い、指定したJSONオブジェクトをstdinへUTF-8で渡す。シェルの文字列結合でJSONを組み立てない。JSONプロパティを重複させない。

【作業開始前: list → get → claim】

1. まずrunnableな未着手タスクを取得する。

   <taskctl> list --status pending --runnable --limit 50 --format json

   data.tasksが空なら、新しいタスクを勝手に作らず、作業対象なしとして終了する。nextCursorがnullでなく、さらに候補を調べる必要がある場合は、同じフィルターとlimitに --cursor <nextCursor> を追加する。

2. 候補を選んだら、直前の一覧結果だけに依存せず最新状態を取得する。

   <taskctl> get --id <task-id> --format json

   data.task.statusがpending、data.task.runnableがtrueであることを確認し、data.task.versionをexpected versionとして保存する。依存関係はdata.dependsOnで確認する。

3. 作業ファイルを変更する前に、取得したversionで原子的にclaimする。

   <taskctl> claim --id <task-id> --agent <agent-id> --expected-version <version> --format json

   終了コード0かつok=trueで、返されたdata.task.statusがin_progress、assigneeが<agent-id>になった場合だけ作業を開始する。claimが失敗した場合は、理由にかかわらず作業を開始しない。

【claim失敗と競合】

- 終了コード4の VERSION_CONFLICT、STATE_CONFLICT、NOT_RUNNABLE は競合であり、claim成功として扱わない。
- VERSION_CONFLICTでは、error.details.actualVersionをそのまま使って自動再試行しない。次を実行してタスク全体を再取得する。

  <taskctl> get --id <task-id> --format json

  最新のstatus、runnable、assignee、version、dependsOnを見て、まだ自分が取得すべきタスクかを再判断する。再判断後にclaimする場合だけ、再取得したdata.task.versionを新しい --expected-version に使う。
- STATE_CONFLICTまたはNOT_RUNNABLEでは、別エージェントのclaimや状態・依存関係の変化を尊重し、そのタスクの作業を開始しない。必要ならlistへ戻って別のrunnableなタスクを探す。
- 終了コード2は呼び出し方または入力の誤り、3は対象またはDBが存在しない、5はストレージまたは内部障害である。いずれも修正・復旧してコマンドの成功を確認するまで作業を開始しない。

【作業中の更新とexpected version】

- claimや更新が成功するたびにtask.versionは1増える。以後の変更操作には、最後に成功したレスポンスのdata.task.versionを使う。
- 手元のversionが最新か不明なときは、変更前にgetする。VERSION_CONFLICTが返ったら必ずgetし、最新タスクを基に意図した操作がまだ妥当か再判断する。同じ変更を機械的に再試行しない。
- title、description、priority、labels、metadataを更新する場合は次を使い、入力JSONをstdinへ渡す。

  <taskctl> update --id <task-id> --expected-version <version> --input-json - --format json

- 依存関係を変更する場合は、getのdependsOnと最新versionを確認してから次を使う。

  <taskctl> dependency-add --id <task-id> --depends-on <dependency-id> --expected-version <version> --format json
  <taskctl> dependency-remove --id <task-id> --depends-on <dependency-id> --expected-version <version> --format json

【blocked、done、canceledの判断】

- blocked: 必要な情報、権限、外部資源、または前提作業が不足し、安全に進められない場合に使う。一時的な競合、単なる失敗、作業が難しいという理由だけでは使わない。具体的な停止理由と、解除に必要な行動をblockedReasonに書く。

  <taskctl> transition --id <task-id> --to blocked --agent <agent-id> --expected-version <version> --input-json - --format json

  stdin例:
  {"blockedReason":"API仕様の決定待ち。担当者によるレスポンス形式の確定が必要。"}

- done: 要求された実装、必要なテスト、lint、型検査、関連ドキュメント更新が完了し、結果を説明できる場合だけ使う。実施内容と検証結果をresultに書く。未検証や一部未完了のままdoneにしない。

  <taskctl> transition --id <task-id> --to done --agent <agent-id> --expected-version <version> --input-json - --format json

  stdin例:
  {"result":"CLI処理とテストを更新。npm run checkが成功。"}

- canceled: タスクが重複、方針変更、または不要になり、実施しないことが確定した場合に使う。実装失敗や一時的なブロックには使わない。

  <taskctl> transition --id <task-id> --to canceled --agent <agent-id> --expected-version <version> --format json

- 状態更新の直前にも、必要ならgetで最新versionと現在状態を確認する。状態更新がVERSION_CONFLICTになった場合はgetして再判断し、古い判断のまま再試行しない。

【重複作成と削除の禁止】

- タスク作成を依頼された場合も、先にlistをページ末尾まで確認し、候補ごとにgetして、同じ成果物・問題・作業範囲のタスクが存在しないことを確認する。表現が違うだけの重複タスクを作らない。
- 既存タスクで表現できる場合はcreateせず、必要なら最新versionを使ってupdateする。
- 新規作成が明確に必要な場合だけ、次を使って入力JSONをstdinへ渡す。

  <taskctl> create --input-json - --format json

- タスクを物理削除しない。CLIに削除コマンドはない。不要なタスクは、使用条件を満たす場合にcanceledへ遷移する。

【終了時】

- 最後のtransitionレスポンスが終了コード0かつok=trueであり、返されたdata.task.statusが意図した状態であることを確認する。
- エラー時は、終了コード、error.code、必要なerror.detailsを作業報告に残す。stderrや変更され得るerror.messageを自動判断の根拠にしない。
- doneにした場合は、resultと実際の変更・検証結果が一致していることを確認する。
```

## CLI仕様との整合性を保つ方針

このプロンプトを変更するレビューでは、[CLI仕様](cli-spec.md)と[タスクモデルとライフサイクル](task-model.md)を正本として、次を照合する。

1. すべてのコマンド名、オプション名、必須引数がCLI仕様のコマンド定義と一致すること。
2. 成功・失敗JSON、終了コード、`error.code`の扱いがCLI仕様と一致すること。
3. `expected-version`、競合時の再取得、状態遷移、runnableの判断がCLI仕様およびタスクモデルと一致すること。
4. `blocked`、`done`、`canceled`の入力要件と遷移元が状態遷移表に反しないこと。
5. CLIまたはタスクモデルを変更するPull Requestでは、このプロンプトのコマンド例と運用規則への影響を確認し、同じPull Requestで更新すること。
6. レビュー前に`npm run check`を実行し、実装済みCLIの型検査、lint、書式、コマンドテスト、配布物テストが成功すること。
