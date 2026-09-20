# Jev workflow for Codex

[Jev-cu](https://github.com/Sac-Y/Jev-cu)に、ブラウザの定型手順、成功確認、中断記録、途中再開を追加する実験用の拡張です。Codexが手順と入力を用意し、Jevが現在の画面の文字情報から操作を選び、Codexのブラウザ操作APIが実行します。

WindowsのCodexアプリ内ブラウザで、日本語Wikipediaの3記事を検索し、指定の節へ移動する動作を確認しました。noteの編集・保存などは未実装です。すべてのCodex操作を自動でJevへ切り替えるものではありません。

## 元の実装と今回の追加

- 元実装: [Sac-Y/Jev-cu](https://github.com/Sac-Y/Jev-cu)
- Windows・ブラウザ接続: [FortytwooによるPR #1](https://github.com/Sac-Y/Jev-cu/pull/1)。2026-09-20確認時は未統合。
- 依存する固定版: [`fabec3c9ee456b8140f11c8895e62a15ad6b5379`](https://github.com/Fortytwoo/Jev-cu/commit/fabec3c9ee456b8140f11c8895e62a15ad6b5379)
- このリポジトリの追加: `workflow.mjs`、Wikipediaの手順定義、Vercel設定、テスト、文書。
- 取得後に加える互換修正: `search text field`の候補認識、APIエラーの`Retry-After`保持。

上流のソースはこのリポジトリに同梱せず、セットアップ時に別途取得します。上流・PRの著者と、この拡張の変更を区別しています。

## セットアップ

Node.js 20以上、Git、ブラウザ操作ツールを利用できるCodex環境が必要です。

```sh
git clone https://github.com/michimi533/jev-workflow-codex.git
cd jev-workflow-codex
npm run setup
npm test
```

セットアップは固定版の依存ソースを取得して互換修正を適用します。Jev APIを呼ばず、ブラウザも操作しません。`npm test`は模擬API・画面を使い、認証情報なしで実行できます。

Vercel AI Gatewayでキーを用意し、`.env.example`を`.env.local`へコピーして値を設定します。ファイルはgitignore対象です。Vercelのモデル提供状況、カード登録条件、予算、有効期限を自分のアカウントで確認してください。検証時の期間限定無料表示を恒久料金と解釈しないでください。

接続先は`https://ai-gateway.vercel.sh/typesafe/v1/systemone`、モデルは`typesafe-ai/jev`です。`getJevOptions()`の戻り値はキーを含むため表示・保存しないでください。

## 実行

[実行・再開・手順定義の説明](docs/workflow-runtime.md)を参照してください。実ブラウザの操作は、最新のツール文書を読んだCodexが`cua_repl`内で行います。通常のNode CLIでブラウザ操作を起動するものではありません。

1. 操作対象のタブと、作業の成功条件を確認する。
2. 日本語Wikipediaのメインページから、同梱の手順をdry-runする。これはJev APIを使用する。
3. 許可された範囲で実行する。各操作の後に画面を読み直して検証する。
4. `paused`は同じ設定で継続。`needs_codex`はCodexが原因を確認・修復してから再開する。

作業の追加時は、段階ごとの開始条件・許容対象・成功条件をコードで用意します。操作履歴を自動で学習して手順化する機能はありません。

## 停止・記録

操作前の意図と、操作後の成否を分けて保存します。保存・送信などの結果が不明なときは、確認できるまで同じ操作を繰り返しません。Jevの判断だけで完了とせず、各段階と最終状態をプログラムで検証します。

`needs_codex`は呼び出し元への返り値です。終了済みのCodexタスクを自動起動する機能ではありません。排他制御は同じエンジン同士に限り、ユーザーの手動操作を止めません。強制終了で残ったロックは元の実行停止を確かめてから扱います。

Jevの利用量はCodexと別枠で記録し、取得できない値を0にしません。返却費用の上限は次の要求を止める補助であり、請求額の厳密な保証ではありません。

## 観測結果

[2026-09-20の実験記録](docs/observations.md)と[集計JSON](results/observations-2026-09-20.json)を掲載しています。以前の固定手順で測った135.031秒対64.027秒と、その後に作った本エンジンの検証は別の試行です。

公開版の包装では個人の絶対パスを除き、依存コードの取得方法を追加しました。49テストで確認しています。元のローカル版は実ブラウザで確認済みですが、公開用の包装後に同じ速度比較を再実施したわけではありません。

## ライセンス

このリポジトリの独自追加ファイルは[MIT License](LICENSE)。別途取得するJev-cuのコード、Codexの操作環境、APIサービスには、それぞれの提供元の条件が適用されます。
