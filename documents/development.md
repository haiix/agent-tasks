# 開発環境と配布方式

## 基本方針

開発にはTypeScriptとESMを使用する。開発ソースは責務ごとに複数モジュールへ分割し、配布時に単一のESM `taskctl.mjs`へバンドルする。

成果物には`.mjs`拡張子を使用し、配置先プロジェクトの`package.json`にある`type`設定にかかわらず、Node.jsが常にESMとして解釈できるようにする。

```text
TypeScript + ESM modules
          ↓
lint, format check, type check and test
          ↓
esbuild
          ↓
single ESM taskctl.mjs
```

配布物には実行時npm依存を持たせない。

## ツール

- Node.js 24 LTS
- TypeScriptのstrict mode
- Biomeによる静的解析
- Prettierによるコードとドキュメントの書式統一
- Node向けESMとモジュール解決
- esbuildによる単一ESMファイルへのバンドル
- Node.js組み込みテストランナー
- Node.js組み込みの`node:sqlite`

大規模なCLIフレームワーク、ORM、DIコンテナはMVPでは採用しない。

変更を提出する前に`npm run check`を実行する。書式を修正する場合は`npm run format`を使用する。

## ソース構成

```text
src/
  cli.ts
  main.ts
  domain/
  storage/
  validation/
  errors.ts
  id.ts
scripts/
  build.mjs
test/
dist/
  taskctl.mjs
```

CLI解析、ドメインルール、SQLite処理、入力検証を責務ごとに分離する。`scripts/build.mjs`が配布物を生成し、テストは`test/`に配置する。

## バリデーション

TypeScriptの型は実行時に消えるため、次の入力を明示的に検証する。

- CLIから受け取るJSON
- SQLiteから読み出した値
- enum、日時、文字列長、配列、metadata
- 状態遷移に伴う必須項目

入力検証には、実行時依存を増やさない手書きバリデーションを使用する。

## テスト要件

- 同一タスクへの同時claimで成功するプロセスが1つだけであること
- staleなexpected versionを検出すること
- 不正な状態遷移を拒否すること
- タスク更新とイベント履歴が同一トランザクションで保存されること
- 一覧の絞り込みと順序が決定的であること
- stdoutが常に解析可能なJSONであること
- DB初期化、マイグレーション、ロック、障害を扱えること
- 単一ESM成果物だけで実行できること
- Windows、macOS、Linuxで動作すること

テストではプロジェクトの実データを使用せず、毎回一時ディレクトリと一時DBを作成する。
