# Contributing to agent-tasks

## 開発フロー

変更はissue単位でブランチとPull Requestを作成し、CIとレビューを通して`main`へマージします。

通常のPull Requestでは、`package.json`や`package-lock.json`の`version`を変更しないでください。バージョン更新はリリースPull Requestに集約します。

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
5. npmへの公開は、公開方針が決まるまで自動では行いません。

次のバージョンは、前回のタグ以降にマージされた変更から決まります。バージョンを例外的に指定する場合は、対象コミットの本文に`Release-As: 0.4.0`のようなフッターを記載します。

リリースPull Requestを標準の`GITHUB_TOKEN`で作成するには、リポジトリの **Settings → Actions → General → Workflow permissions** で **Allow GitHub Actions to create and approve pull requests** を有効にします。

この設定を有効にしない場合や、リリースPull Requestでも通常のCIを自動起動したい場合は、Pull Requestとcontentsへの書き込み権限を持つ専用トークンをActions secretの`RELEASE_PLEASE_TOKEN`として登録します。workflowは、このsecretがあれば専用トークンを、なければ`GITHUB_TOKEN`を使用します。

## CHANGELOG

`CHANGELOG.md`は利用者に影響するリリース済み変更の記録です。通常のPull Requestから直接編集せず、Release Pleaseが生成するリリースPull Request内で内容を確認・調整します。テスト、CI、依存関係の定例更新など、利用者に影響しない変更は含めません。
