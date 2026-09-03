# Contributing to agent-tasks

## 開発フロー

変更はissue単位でブランチとPull Requestを作成し、CIとレビューを通して`main`へマージします。

通常のPull Requestでは、`package.json`や`package-lock.json`の`version`を変更しないでください。バージョン更新はリリースPull Requestに集約します。

## ソースコメント

TSDocコメントは英語で記述し、次のような、宣言だけでは重要な契約を十分に表現できない箇所へ選択的に追加します。

- CLIやモジュールの主要な境界となる関数・型
- 引数や戻り値に関する非自明な制約、デフォルト値、不変条件
- 状態遷移、楽観的ロック、トランザクションなどの重要な振る舞い
- 呼び出し側が考慮すべき副作用やエラー条件

単純な内部ヘルパー、自明なアクセサー、宣言を言い換えるだけのコメントには追加しません。TSDocは`/** ... */`形式を使用し、必要に応じて`@param`、`@returns`、`@throws`などで呼び出し契約を補足します。実装の手順ではなく、利用者や保守者が安全に呼び出すために必要な情報を記述します。

ソースのTSDocコメントは開発時の参照用であり、配布するCLIバンドル`dist/taskctl.mjs`には残しません。ライセンス通知はTSDocとは別に扱い、将来サードパーティーの実行時依存をバンドルする場合は、必要な通知を保持できるようesbuildの`legalComments`設定を再確認します。ライブラリAPIを公開する場合は、JavaScriptバンドルへコメントを残すのではなく、TSDocを保持した型宣言ファイルを配布します。

## PRタイトルとコミット

Release Pleaseは`main`へ入ったConventional Commits形式の履歴から、次のバージョンとリリースノートを生成します。このリポジトリでは原則としてPull Requestをsquash mergeし、PRタイトルを次の形式にします。

```text
<type>(任意のscope): <変更内容>
```

主なtypeは次のとおりです。

| type                           | 用途                         | CHANGELOG     | バージョンへの影響 |
| ------------------------------ | ---------------------------- | ------------- | ------------------ |
| `feat`                         | 利用者向け機能の追加         | Added         | minor              |
| `fix`                          | 利用者向け不具合の修正       | Fixed         | patch              |
| `perf`                         | 利用者に影響する性能改善     | Performance   | patch              |
| `refactor`                     | 利用者に影響する構成変更     | Changed       | なし               |
| `docs`                         | 利用者向けドキュメントの変更 | Documentation | なし               |
| `revert`                       | 利用者向け変更の取り消し     | Reverted      | patch              |
| `chore`, `test`, `ci`, `build` | 内部作業                     | 記載しない    | なし               |

破壊的変更はtypeの直後に`!`を付け、コミット本文またはPR本文に影響と移行方法を記載します。

```text
feat!: テンプレート構文を変更する
```

## バージョン方針

プロジェクトが安定版になるまではSemantic Versioningの`0.x.y`を使用します。

- 利用者向けの不具合修正はpatchを上げます（例: `0.2.0`から`0.2.1`）。
- 機能、API、構文の追加はminorを上げます（例: `0.2.1`から`0.3.0`）。
- 1.0未満の破壊的変更はminorを上げます（例: `0.3.0`から`0.4.0`）。
- 構文、コアAPI、基本的な利用方法を安定版として保証できる段階で`1.0.0`にします。

プロジェクトバージョンの基準は`package.json`です。Release PleaseがリリースPull Requestで`package.json`と`package-lock.json`を同じバージョンへ自動更新します。

## リリースフロー

1. 通常のPull Requestを`main`へマージすると、日本時間の毎日0時にRelease Pleaseが変更をまとめ、リリースPull Requestを作成または更新します。必要な場合は`Prepare release` workflowを手動実行できます。
2. リリースPull Requestで、提案されたバージョン、`CHANGELOG.md`、各バージョンファイルを確認します。
3. リリースする節目でそのPull Requestをマージします。
4. 次回の定期実行時、または`Prepare release` workflowの手動実行時に、Release Pleaseが`v0.1.0`形式のタグとGitHub Releaseを作成します。
5. GitHub Releaseの公開を契機に`Publish to npm` workflowが`@haiix/agent-tasks`をnpmへ公開します。

初回公開のブートストラップ、npm Trusted Publishing、公開後の確認と失敗時の対応は[`documents/releasing.md`](documents/releasing.md)を参照してください。

次のバージョンは、前回のタグ以降にマージされた変更から決まります。バージョンを例外的に指定する場合は、対象コミットの本文に`Release-As: 0.4.0`のようなフッターを記載します。

リリースPull Requestを標準の`GITHUB_TOKEN`で作成するには、リポジトリの **Settings → Actions → General → Workflow permissions** で **Allow GitHub Actions to create and approve pull requests** を有効にします。

この設定を有効にしない場合や、リリースPull Requestでも通常のCIを自動起動したい場合は、Pull Requestとcontentsへの書き込み権限を持つ専用トークンをActions secretの`RELEASE_PLEASE_TOKEN`として登録します。workflowは、このsecretがあれば専用トークンを、なければ`GITHUB_TOKEN`を使用します。

## CHANGELOG

`CHANGELOG.md`は利用者に影響するリリース済み変更の記録です。通常のPull Requestから直接編集せず、Release Pleaseが生成するリリースPull Request内で内容を確認・調整します。テスト、CI、依存関係の定例更新など、利用者に影響しない変更は含めません。
