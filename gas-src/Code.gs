/**
 * 箱スキャンアプリ - サーバーサイド (GAS)
 * 仕様書 v1.2 準拠
 */

const PAGE_SIZE = 10;
const SHEET_NAME = 'scans';

// ==============================
// ルーティング
// ==============================

function doGet(e) {
  // 撮影画面(capture)はGitHub Pages側に移行したため、GAS側のデフォルトは閲覧画面とする
  const page = (e && e.parameter && e.parameter.page) || 'viewer';
  const templateName = page === 'capture' ? 'capture' : 'viewer';

  return HtmlService.createTemplateFromFile(templateName)
    .evaluate()
    .setTitle('箱スキャン')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ==============================
// 外部サイト(GitHub Pages)からの呼び出し用 doPost
// ==============================
//
// カメラアクセスがGASのHtmlService(サンドボックスiframe)内では
// ブラウザの仕様上ブロックされるため、撮影画面のみGitHub Pages等の
// 外部オリジンに配置する。外部サイトとGASの通信はCORS制限があり
// fetch()でレスポンスを直接読めないため、
// 「隠しiframeへのフォームPOST + postMessageで結果を返す」方式を用いる。

function doPost(e) {
  let result;
  try {
    const action = e && e.parameter && e.parameter.action;

    if (action === 'verifyPassword') {
      result = verifyPassword(e.parameter.password);

    } else if (action === 'saveScan') {
      const images = [];
      for (let i = 0; i < 4; i++) {
        const b64 = e.parameter['img' + i];
        if (b64) {
          images.push({ mimeType: 'image/webp', base64: b64 });
        }
      }
      result = saveScan({
        password: e.parameter.password,
        barcode: e.parameter.barcode,
        note: e.parameter.note || '',
        images: images
      });

    } else if (action === 'listRecords') {
      result = listRecords(
        e.parameter.password,
        Number(e.parameter.page || 1)
      );

    } else if (action === 'getRecord') {
      result = getRecord(
        e.parameter.password,
        e.parameter.barcode
      );

    } else if (action === 'getRecordByRow') {
      result = getRecordByRow(
        e.parameter.password,
        Number(e.parameter.rowNumber)
      );

    } else if (action === 'getImage') {
      result = getImage(
        e.parameter.password,
        e.parameter.fileId
      );

    } else {
      result = { ok: false, error: '不明なactionです: ' + action };
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  return buildPostMessageResponse_(result);
}

/**
 * postMessageで親ウィンドウに結果を返すだけの小さなHTMLページを生成する。
 * 外部サイト側は非表示iframeでこのレスポンスを受け取り、
 * window.addEventListener('message', ...) で結果を受け取る。
 */
function buildPostMessageResponse_(result) {
  // スクリプトタグを閉じるような文字列が混入してもHTMLが壊れないようにエスケープ
  const safeJson = JSON.stringify(result).replace(/</g, '\\u003c');
  const html =
    '<!DOCTYPE html><html><body><script>' +
    // GASのHtmlServiceはさらに内部でiframeに包まれることがあるため、
    // parent ではなく window.top（一番上のウィンドウ）に直接送る
    'window.top.postMessage(' + safeJson + ', "*");' +
    '</' + 'script></body></html>';
  // doPost の応答も iframe から実行されるため、doGet と同様に
  // X-Frame-Options を許可する。これがないと、特にモバイルブラウザで
  // 応答HTMLが iframe 内で実行されず、Pages側がタイムアウトすることがある。
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ==============================
// 認証
// ==============================

/**
 * 共有パスワードを照合する。
 * 各APIの先頭で必ず呼び出すこと。
 */
function checkPassword_(password) {
  const correct = PropertiesService.getScriptProperties().getProperty('APP_PASSWORD');
  if (!correct) {
    // パスワード未設定は運用ミスなのでサーバー側エラーとして扱う
    throw new Error('APP_PASSWORD が未設定です（スクリプトプロパティを確認してください）');
  }
  return password === correct;
}

/**
 * クライアントのログイン画面から呼ばれる、パスワード検証専用API。
 * 成否のみを返し、詳細なエラー原因は返さない。
 */
function verifyPassword(password) {
  try {
    if (checkPassword_(password)) {
      return { ok: true };
    }
    return { ok: false, error: 'パスワードが違います' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('SHEET_ID');
  const folderId = props.getProperty('DRIVE_FOLDER_ID');
  if (!sheetId) throw new Error('SHEET_ID が未設定です');
  if (!folderId) throw new Error('DRIVE_FOLDER_ID が未設定です');
  return { sheetId, folderId };
}

// ==============================
// 6.1 saveScan(payload)
// ==============================

/**
 * クライアントから呼ばれる保存関数
 * @param {Object} payload { password, barcode, note, images: [{name, base64, mimeType}, ...] }
 */
function saveScan(payload) {
  try {
    if (!payload || !checkPassword_(payload.password)) {
      return { ok: false, error: '認証エラー' };
    }

    const { barcode, note, images } = payload;
    if (!barcode) throw new Error('バーコードが空です');
    if (!images || images.length === 0) throw new Error('画像がありません');

    const { sheetId, folderId } = getConfig_();

    const now = new Date();
    const timestamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    const dateFolderName = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
    const timeSuffix = Utilities.formatDate(now, 'Asia/Tokyo', 'HHmmss');

    // フォルダ階層: ルート / YYYY-MM-DD / <barcode>_<HHmmss>
    const rootFolder = DriveApp.getFolderById(folderId);
    const dateFolder = getOrCreateFolder_(rootFolder, dateFolderName);
    const targetFolder = dateFolder.createFolder(`${barcode}_${timeSuffix}`);

    // 面ラベルの順序（撮影順と一致させる）
    const faceNames = ['1_front', '2_right', '3_back', '4_left'];

    const fileIds = [];
    images.forEach((img, i) => {
      const bytes = Utilities.base64Decode(img.base64);
      const fileName = `${faceNames[i] || (i + 1)}.webp`;
      const blob = Utilities.newBlob(bytes, img.mimeType || 'image/webp', fileName);
      const file = targetFolder.createFile(blob);
      file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      fileIds.push(file.getId());
    });

    // シートに追記
    const sheet = getOrCreateSheet_(sheetId);
    sheet.appendRow([
      timestamp,
      barcode,
      note || '',
      targetFolder.getId(),
      fileIds[0] || '',
      fileIds[1] || '',
      fileIds[2] || '',
      fileIds[3] || ''
    ]);

    return { ok: true, folderId: targetFolder.getId() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function getOrCreateFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function getOrCreateSheet_(sheetId) {
  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['タイムスタンプ', 'バーコード', '備考', 'フォルダID', '正面ファイルID', '側面(右)ファイルID', '背面ファイルID', '側面(左)ファイルID']);
  }
  return sheet;
}

// ==============================
// 6.2 listRecords(password, page)
// ==============================

/**
 * 登録データを新しい順にページネーション付きで返す
 * @param {string} password
 * @param {number} page 1始まり
 */
function listRecords(password, page) {
  try {
    if (!checkPassword_(password)) {
      return { ok: false, error: '認証エラー' };
    }

    const { sheetId } = getConfig_();
    const sheet = getOrCreateSheet_(sheetId);
    const lastRow = sheet.getLastRow();

    if (lastRow <= 1) {
      return { ok: true, page: 1, totalPages: 1, totalCount: 0, results: [] };
    }

    // データ行数（ヘッダー除く）
    const dataRowCount = lastRow - 1;
    const totalPages = Math.max(1, Math.ceil(dataRowCount / PAGE_SIZE));
    const currentPage = Math.min(Math.max(1, page || 1), totalPages);

    // 新しい順にしたいので、シートの下から読む
    // 対象となるシート上の行番号範囲を計算する
    const endRow = lastRow - (currentPage - 1) * PAGE_SIZE;
    const startRow = Math.max(2, endRow - PAGE_SIZE + 1);
    const numRows = endRow - startRow + 1;

    // A:タイムスタンプ, B:バーコード, C:備考 のみ取得（個人情報なし）
    // google.script.run へ返す値はすべて文字列にして、Date オブジェクト等の
    // シリアライズエラーを防ぐ。
    const values = sheet.getRange(startRow, 1, numRows, 3).getDisplayValues();

    const results = values.map((row, idx) => ({
      row: startRow + idx,
      // google.script.run では Date オブジェクトをそのまま返せないため、
      // ブラウザへ渡す前に文字列へ変換する。
      timestamp: formatTimestamp_(row[0]),
      barcode: row[1],
      note: row[2]
    })).reverse(); // 新しい順に並べ替え

    return {
      ok: true,
      page: currentPage,
      totalPages: totalPages,
      totalCount: dataRowCount,
      results: results
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ==============================
// 6.3 getRecord(password, barcode)
// ==============================

/**
 * シリアル(バーコード)完全一致で1件取得する
 * 一覧からの遷移時に行番号がわかる場合は getRecordByRow を使う方が高速
 */
function getRecord(password, barcode) {
  try {
    if (!checkPassword_(password)) {
      return { ok: false, error: '認証エラー' };
    }

    const { sheetId } = getConfig_();
    const sheet = getOrCreateSheet_(sheetId);
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { ok: false, error: '該当データがありません' };

    const values = sheet.getRange(2, 1, lastRow - 1, 8).getDisplayValues();
    // 新しい順に検索して最初に一致した行（同一シリアルが複数あっても直近を返す）
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i][1] === barcode) {
        return { ok: true, record: rowToRecord_(values[i]) };
      }
    }
    return { ok: false, error: '該当データがありません' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 一覧画面から行番号を指定して1件取得する（高速版）
 */
function getRecordByRow(password, rowNumber) {
  try {
    if (!checkPassword_(password)) {
      return { ok: false, error: '認証エラー' };
    }
    const { sheetId } = getConfig_();
    const sheet = getOrCreateSheet_(sheetId);
    if (rowNumber < 2 || rowNumber > sheet.getLastRow()) {
      return { ok: false, error: '該当データがありません' };
    }
    const row = sheet.getRange(rowNumber, 1, 1, 8).getDisplayValues()[0];
    return { ok: true, record: rowToRecord_(row) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function rowToRecord_(row) {
  const [timestamp, barcode, note, , frontId, rightId, backId, leftId] = row;
  return {
    timestamp: formatTimestamp_(timestamp),
    barcode: barcode,
    note: note,
    images: [
      { label: '正面', fileId: frontId },
      { label: '側面（右）', fileId: rightId },
      { label: '背面', fileId: backId },
      { label: '側面（左）', fileId: leftId }
    ].filter(img => !!img.fileId)
  };
}

function formatTimestamp_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  }
  return value == null ? '' : String(value);
}

// ==============================
// 6.4 getImage(password, fileId)
// ==============================

function getImage(password, fileId) {
  try {
    if (!checkPassword_(password)) {
      return { ok: false, error: '認証エラー' };
    }
    if (!fileId) return { ok: false, error: 'fileIdが空です' };

    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const base64 = Utilities.base64Encode(blob.getBytes());
    return { ok: true, mimeType: blob.getContentType(), base64: base64 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
