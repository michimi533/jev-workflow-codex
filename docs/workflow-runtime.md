# ブラウザの定型操作と途中再開

この拡張は、固定版Jev-cuを別途取得して使う。先にREADMEのセットアップを実行する。

runWorkflowはCodexが呼び出すローカル実行関数。Jevは各段階で操作対象と動作を選び、エンジンが検証・実行する。手順の自動学習や、終了した会話の起動は行わない。

## 呼び出し

cua_replの最新文書を読み、実際の一覧から選んだtabとbrowserIdを用意する。モジュールのimportと以下のUI操作はcua_repl内で行う。Node CLIから実ブラウザを操作しない。

```javascript
var urlModule = await import('node:url');
var skillRoot = '/absolute/path/to/jev-workflow-codex'; // 自分のclone先の絶対パス
var engine = await import(urlModule.pathToFileURL(skillRoot+'/scripts/workflow.mjs').href);
var example = await import(urlModule.pathToFileURL(skillRoot+'/scripts/wikipedia-workflow.mjs').href);
var gateway = await import(urlModule.pathToFileURL(skillRoot+'/scripts/vercel-config.mjs').href);
var driver = engine.createWorkflowDriver(tab, {
  identity: `${browserId}:${tab.id}`,
  readMetadata: async () => {
    var tabs = await cua.listTabs({browser:browserId, emit:false});
    var current = tabs.find(t => t.id === tab.id);
    if (!current) throw new Error('Target tab unavailable');
    return {url:current.url, title:current.title};
  },
});
// outDirは現在の作業フォルダ内、この作業専用の絶対パス。
var args = {
  workflow:example.createWikipediaWorkflow(),
  input:{}, driver,
  decide:gateway.decideWithGatewayCost,
  jevOptions:gateway.getJevOptions(),
  store:engine.createFileStore(outDir),
  limits:{maxDecisions:24},
};
var result = await engine.runWorkflow({...args, dryRun:true});
nodeRepl.write(result);
```

getJevOptionsやargs全体は認証情報を含むので表示しない。新しい手順はdry-runで判断を検証してから、同じargsにdryRun:falseを指定して実行する。dry-runもJev API呼び出し・利用量に含まれる。

Wikipedia例の開始ページは日本語Wikipediaのメインページ。検索欄を開く・入力・検索・目次展開・指定節への移動を3記事分用意している。既に条件を満たす段階は操作せず進む。各記事でURLと記事見出しを照合し、節到達はURLのフラグメントでも確認する。サイト変更で成立しなければ停止する。

## 結果と再開

- done：全段階と最終成功条件を確認した。
- paused：一区間の時間に達した。引き続き同じargs、dryRun:falseで呼ぶ。古いindexは保持しない。
- dry_run：対象選択と操作前照合まで終了。UI操作はしていない。
- needs_codex：reason、stageId、lastVerifiedStage、lastActionOutcome、checkpointPathを読む。新しい画面を観測して原因を調べる。必要な範囲でCodexが修復し、同じargsにresumeAfterHandoff:trueとdryRun:falseを指定して再開する。既存の許可を確認し、不要な再承認は求めない。

needs_codexの後にフラグなしで呼んでも再実行しない。中断・修復の記録は作業ログに残す。画像が必要なら公式UI APIで撮り、作業フォルダへ保存する。エンジンのログ自体は画面全体・入力本文・APIキーを保存しない。

手順の版・定義・入力・driver.identity・limitsが違えばresume_mismatch。別タブへ勝手に再接続しない。手順を修正した場合は版を上げ、現画面から何を完了済みと判定できるかを確認した上で、新しい保存先で開始する。既存チェックポイントを書き換えて不一致を回避しない。修正前のログは診断記録として残す。

## 手順定義の契約

workflowにはid、version、guard、verify、stagesが必須。guard(observation, context)は対象サイト・アカウント・記事の許容範囲を確認する。verifyは作業全体の成功条件。contextはinputとcompletedを含む。

各stageに以下を用意する。関数はCodexが書いた信頼済みコードに限り、画面から取得したコードを実行しない。観測・判定関数の中でUI操作しない。

|項目|意味|
|---|---|
|id / goal|固定の段階ID、Jevへ渡す次の目的|
|actions|許容する動作。click_element / set_value / type_text / press_key / scrollから選ぶ|
|ready(o, context)|この段階を操作してよい状態か|
|verify(o, context)|達成true、未達false、確認不能null。真偽を推測しない|
|acceptTarget(element, o, context)|許容する対象か。同期関数でtrueを返した候補だけを使う|
|progress(o, context)|無関係な時刻などを除いた、目的に関係する進捗の値|
|resources|text / key / direction。固定オブジェクト、またはinputから返す関数|
|canRetry(o, context)|既実行操作を再実行して安全と確認できるときのみtrue。省略時は再実行しない。context.outcomeはunknownまたはacknowledged|
|maxActions / maxMs|段階の任意の上限|

外部の値を関数のクロージャで参照する場合、その値もworkflow.parametersまたはinputへ入れ、変更を再開照合で検知できるようにする。共通ヘルパーの判定ロジックを変えた場合もworkflow.versionを上げる。

scopeをブラウザ名だけで判断しない。noteの場合、アカウントと記事の照合、編集欄の読み取り、保存完了判定を実サイトで検証してから手順化する。現在の同梱例はWikipediaのみ。公開や認証等でpolicyが停止したらCodexが現行の操作規則と既存の許可を確認して扱う。停止をそのままユーザーへの承認要求と解釈しない。

## 上限と保留

既定は全体10分、段階60秒、全体100操作・120判断、段階6操作、API追加試行2回／段階、観測追加試行2回、確認の追加観測2回、引き継ぎからの復帰2回、候補40→80件の拡大1回／段階。同じ意味の操作で進捗が変わらない場合は2回で停止する。判断APIの再試行前には画面を取り直す。

chunkMsの既定25秒は操作間の区切りであり、実行中のUI操作を強制終了する締切ではない。操作が未確定の間はロックを保持して待つ。ツールがタイムアウトした場合も重ねて別の操作を始めず、前の実行が終わったか確認する。

全体・段階の時間は人間やCodexが介入している時間を含む壁時計時間。再開で上限をリセットしない。時間超過した実行を完了扱いに書き換えず、現画面を確認して新たな実行が必要か判断する。

maxReportedCostUsdは既定$0.10。返された費用の累計に達したら次の判断要求を止めるが、要求中の料金や未報告の料金まで防ぐ厳密な請求上限ではない。API側の予算と元の許可範囲を維持する。予算変更はこの実装では行わない。

jev.inputTokens / outputTokens / costUsdは全判断要求で報告された場合のみ合計、欠ける要求があればnull。reportedInputTokens等は判明した分のみの小計。reportedCostUsdはVercelの返却値で、請求画面の照合値ではない。Codexのトークンは別途セッション記録で集計する。

## 記録とロック

作業専用ディレクトリにcheckpoint.jsonとevents.jsonlを保存する。操作前に意図を記録し、操作応答と結果確認を分離する。チェックポイントは一時ファイルの書き込み・fsync・renameで更新。記録不能の場合は新しいUI操作に進まない。

OSの一時ディレクトリ内のjev-workflow-locksで対象タブと保存先を排他制御する。同じタブのidentityを実行間で統一する。これは本エンジン同士の競合防止で、ユーザーの手動操作や他の実装をロックしない。

実行プロセスの強制終了でロックが残る場合がある。自動で古いロックを奪わない。元の実行が終了したことを確認し、該当タブ／保存先に対応するロックだけを除去してから画面を再観測する。誤って稼働中のロックを消すと二重操作につながる。

ブラウザだけで一般的なexactly-onceを保証するものではない。作成・送信・保存の結果が不明なら、状態を確認できるまで再実行しない。
