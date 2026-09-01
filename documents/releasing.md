# npm公開手順

## 公開方式

`@haiix/agent-tasks`はnpmのpublic scoped packageとして公開する。利用者はNode.js 24以降でglobal installし、安定したコマンド名`taskctl`で実行する。

```shell
npm install --global @haiix/agent-tasks
taskctl --version
taskctl --help
```

バージョンはSemantic Versioningの`0.x.y`を使用し、`package.json`を正本とする。通常のPull Requestではバージョンを直接変更せず、Release PleaseのリリースPull Requestで`package.json`、`package-lock.json`、`CHANGELOG.md`を更新する。

GitHub Releaseが公開されると、[`publish-npm.yml`](../.github/workflows/publish-npm.yml)がリリースタグをcheckoutし、タグと`package.json`のバージョン一致、全チェック、npm公開を順に実行する。公開にはnpm Trusted PublishingのOIDCを使用し、長期間有効なpublish tokenは初回公開後に保持しない。公開リポジトリのGitHub-hosted runnerから公開するため、npm provenanceも生成される。

## 初回公開の準備

npmでは未公開パッケージにTrusted Publisherを設定できないため、`0.1.0`の初回公開だけはトークンでブートストラップする。

1. npmで`haiix` scopeから`@haiix/agent-tasks`を公開できることと、パッケージ名が利用可能であることを確認する。
2. npmで初回公開に必要な最小権限のgranular access tokenを作成する。2FAを要求する設定では、公開に使用できるようtoken側の設定も行う。
3. GitHubリポジトリのActions secret `NPM_TOKEN`へtokenを登録する。このsecretは初回公開workflowだけで使用する。
4. 通常の変更を`main`へマージし、Release Pleaseが作成する最初のリリースPull Requestでバージョンが`0.1.0`であること、CHANGELOG、package metadataを確認する。
5. リリースPull Requestをマージする。次回の`Prepare release`実行、または手動実行で`v0.1.0`とGitHub Releaseが作成され、`Publish to npm` workflowが`NPM_TOKEN`を使って公開する。
6. npm上の`@haiix/agent-tasks`にバージョンとprovenanceが表示されることを確認する。

初回公開が完了したら、npmjs.comのパッケージ設定にTrusted Publisherを追加する。

| 設定項目             | 値                |
| -------------------- | ----------------- |
| Provider             | GitHub Actions    |
| Organization or user | `haiix`           |
| Repository           | `agent-tasks`     |
| Workflow filename    | `publish-npm.yml` |
| Environment          | 未指定            |
| Allowed actions      | `npm publish`     |

設定後、GitHubの`NPM_TOKEN` secretを削除する。以降の公開がOIDCで成功することを確認してから、npmのPublishing accessを「2FAを要求しtokenを許可しない」設定へ変更し、初回公開用tokenを失効させる。

Trusted Publishingにはnpm CLI 11.5.1以上、Node.js 22.14.0以上が必要である。このプロジェクトはNode.js 24を使用するため、workflowでも`.node-version`からNode.js 24を設定する。

## 通常リリース

1. `main`へ入ったConventional Commits形式の変更をRelease Pleaseがまとめる。
2. リリースPull Requestで、提案バージョン、CHANGELOG、`package.json`と`package-lock.json`の一致を確認する。
3. リリースするタイミングでリリースPull Requestをマージする。
4. `Prepare release` workflowを手動実行するか、次の定期実行を待つ。
5. 作成されたGitHub Releaseを契機に`Publish to npm` workflowがOIDCで公開する。
6. workflowとnpm package pageで公開結果とprovenanceを確認する。

workflow filename、GitHubのownerまたはrepository、npmのTrusted Publisher設定は完全一致させる。workflowを改名する場合は、マージ前にnpm側の設定も同時に更新する。

## 公開前後の検証

Pull RequestのCIは、`npm pack`で作成したtarballに次の4ファイルだけが含まれることを検証する。

- `package.json`
- `README.md`
- `LICENSE`
- `dist/taskctl.mjs`

さらにtarballを一時的なprefixへglobal installし、生成された`taskctl`コマンドで`--help`、`--version`、`init`を実行する。ローカルで梱包内容だけを確認する場合は次を実行する。

```shell
npm run build
npm pack --dry-run
```

公開後は作業用の一時ディレクトリで次を確認する。

```shell
npm view @haiix/agent-tasks version
npm install --global @haiix/agent-tasks
taskctl --version
taskctl --help
taskctl init
```

既存の業務用ディレクトリではなく、一時ディレクトリで`taskctl init`を実行する。

## 失敗時の扱い

- npm公開前にworkflowが失敗した場合は、原因を修正してworkflowを再実行する。
- npm上に対象バージョンが存在する場合、同じnameとversionは再公開できない。workflow表示だけを根拠に再公開せず、`npm view @haiix/agent-tasks@<version>`で公開済みか確認する。
- 公開済み成果物に問題がある場合は同じバージョンを置き換えず、修正Pull Requestから新しいpatch versionを公開する。必要に応じて問題のあるバージョンをdeprecateする。
- OIDCで`ENEEDAUTH`になった場合は、`id-token: write`、Trusted Publisherのowner、repository、workflow filename、environmentを照合する。
