# 箱スキャン（証拠写真撮影）

箱に貼られたバーコード（Code 39）を読み取り、外観4面の写真を撮影して保存するアプリです。
撮影した写真と情報は Google ドライブとスプレッドシートに記録されます。

## 主な機能

- バーコード読み取り（13桁・先頭が `C` の値を検証）
- 正面・側面（右）・背面・側面（左）の4面撮影
- 通信エラー時の下書き保存と再送信（IndexedDB）
- 閲覧画面（Google Apps Script）での履歴・写真の確認

## 構成

| パス | 役割 | 配置先 |
| --- | --- | --- |
| `index.html` / `script.js` / `style.css` | 撮影画面 | GitHub Pages |
| `gas-src/Code.gs` | サーバー処理（認証・保存・一覧取得） | Google Apps Script |
| `gas-src/viewer.html` 他 | 閲覧画面 | Google Apps Script |
| `doc/manual.html` | 操作マニュアル | 参照用 |

## データの流れ

1. 撮影画面でバーコードを読み取り、4面の写真を撮影
2. `saveScan` が Google ドライブに以下の階層で保存
   `ルート / YYYY-MM-DD / <バーコード>_<HHmmss> / 1_front.webp, 2_right.webp, ...`
3. スプレッドシート（シート名 `scans`）に1件1行で追記
   - 列: タイムスタンプ / バーコード / 備考 / フォルダID / 各面のファイルID

## セットアップ

### Google Apps Script

1. `gas-src/` のファイルを Apps Script プロジェクトに配置
2. スクリプトプロパティを設定
   - `APP_PASSWORD`: 共有パスワード
   - `SHEET_ID`: 記録先スプレッドシートのID
   - `DRIVE_FOLDER_ID`: 写真の保存先フォルダのID
3. ウェブアプリとしてデプロイ

### 撮影画面（GitHub Pages）

1. `script.js` の `GAS_URL` をデプロイ後のウェブアプリURLに書き換え
2. リポジトリの Pages を有効化して配信

## 注意

- 撮影にはカメラ権限が必要です。`BarcodeDetector` 対応ブラウザで利用してください。
- パスワードは共有パスワードです。`APP_PASSWORD` は外部に公開しないでください。
- 操作手順の詳細は [doc/manual.html](doc/manual.html) を参照してください。
