// ==============================================================
// 箱スキャン 撮影画面 (GitHub Pages 配置用)
//
// カメラアクセス(getUserMedia)はGoogle Apps ScriptのHtmlService
// (サンドボックス化されたiframe)内では動作しないため、このファイルは
// 通常の静的サイト(GitHub Pages等)に配置して使用する。
//
// GASバックエンドとの通信は、fetch()によるCORS制限を回避するため、
// 「隠しiframeへのフォームPOST + postMessageで結果を受け取る」方式を用いる。
// ==============================================================

// ▼▼▼ ここをデプロイ後のWebアプリURLに書き換えてください ▼▼▼
const GAS_URL = 'https://script.google.com/macros/s/AKfycbwYffcivGulP2xIHiD-XuaZOVTvfoc_p3gTTQxRFH3M8gFHk2wRfrTMfgSN4TB12aoD/exec';
// ▲▲▲ ここをデプロイ後のWebアプリURLに書き換えてください ▲▲▲

const MAX_PHOTOS = 4;
const IMAGE_MAX_EDGE = 1600;
const IMAGE_QUALITY = 0.8;
const FACE_LABELS = ['正面', '側面（右）', '背面', '側面（左）'];
const DB_NAME = 'boxScanDraft';
const STORE_NAME = 'drafts';
const GAS_TIMEOUT_MS = 30000;

const state = {
  password: null,
  barcode: null,
  photos: [], // { blob, dataUrl }
  scanStream: null,
  camStream: null,
  detector: null,
  scanning: false,
};

const $ = (id) => document.getElementById(id);

// --- 起動 ---
window.addEventListener('load', () => {
  $('btn-login').addEventListener('click', login);
  $('password-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });
});

// ==============================
// GASとの通信 (隠しiframeフォームPOST + postMessage)
// ==============================

function callGas(action, params) {
  return new Promise((resolve, reject) => {
    const frameName = 'gas_frame_' + Date.now() + '_' + Math.random().toString(36).slice(2);

    const iframe = document.createElement('iframe');
    iframe.name = frameName;
    iframe.style.display = 'none';
    document.body.appendChild(iframe);

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = GAS_URL;
    form.target = frameName;
    form.style.display = 'none';

    const allParams = Object.assign({ action }, params);
    Object.keys(allParams).forEach((key) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = key;
      input.value = allParams[key] == null ? '' : allParams[key];
      form.appendChild(input);
    });
    document.body.appendChild(form);

    let settled = false;

    function onMessage(ev) {
      if (settled) return;
      let data;
      try {
        data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      } catch (e) {
        return; // 関係ないpostMessageは無視
      }
      settled = true;
      cleanup();
      resolve(data);
    }

    function cleanup() {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      setTimeout(() => {
        form.remove();
        iframe.remove();
      }, 500);
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('通信がタイムアウトしました'));
    }, GAS_TIMEOUT_MS);

    window.addEventListener('message', onMessage);
    form.submit();
  });
}

// --- ログイン ---
function login() {
  const pw = $('password-input').value;
  if (!pw) return;
  $('btn-login').disabled = true;
  $('auth-error').hidden = true;

  callGas('verifyPassword', { password: pw })
    .then((res) => {
      $('btn-login').disabled = false;
      if (res && res.ok) {
        state.password = pw;
        $('auth-section').hidden = true;
        initApp();
      } else {
        $('auth-error').textContent = (res && res.error) || '認証に失敗しました';
        $('auth-error').hidden = false;
      }
    })
    .catch((err) => {
      $('btn-login').disabled = false;
      $('auth-error').textContent = '通信エラー: ' + err.message;
      $('auth-error').hidden = false;
    });
}

async function initApp() {
  if (!('BarcodeDetector' in window)) {
    showToast('このブラウザはBarcodeDetector非対応です', 'error');
    return;
  }
  state.detector = new BarcodeDetector({ formats: ['code_39'] });
  $('scanner-section').hidden = false;

  // ボタンの反応登録はカメラ起動の成否を待たずに先に行う
  $('btn-rescan').addEventListener('click', startScanner);
  $('btn-shutter').addEventListener('click', takePhoto);
  $('btn-retake').addEventListener('click', retake);
  $('btn-upload').addEventListener('click', upload);
  $('btn-drafts').addEventListener('click', showDrafts);
  $('btn-drafts-close').addEventListener('click', () => {
    showSection('scanner-section');
  });

  startScanner(); // await しない

  const drafts = await getAllDrafts();
  if (drafts.length > 0) {
    showToast(`下書きが${drafts.length}件あります`, '');
  }
}

// --- スキャナ起動 ---
async function startScanner() {
  showSection('scanner-section');
  state.barcode = null;
  state.photos = [];
  $('scan-result').textContent = '読取待ち…';
  $('scan-result').classList.remove('hit');

  stopStream(state.camStream);
  state.camStream = null;

  try {
    state.scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
    $('video').srcObject = state.scanStream;
    await $('video').play();
    state.scanning = true;
    scanLoop();
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      showToast('カメラが許可されていません。ブラウザのサイト設定でカメラを許可してください', 'error');
    } else {
      showToast('カメラ起動失敗: ' + e.message, 'error');
    }
  }
}

async function scanLoop() {
  const video = $('video');
  while (state.scanning) {
    try {
      const codes = await state.detector.detect(video);
      if (codes.length > 0) {
        const value = codes[0].rawValue;
        onBarcodeDetected(value);
        break;
      }
    } catch (_) {}
    await sleep(300);
  }
}

function onBarcodeDetected(value) {
  state.scanning = false;
  state.barcode = value;
  $('scan-result').textContent = `✓ ${value}`;
  $('scan-result').classList.add('hit');
  if (navigator.vibrate) navigator.vibrate(100);

  setTimeout(() => {
    if (confirm(`バーコード: ${value}\nシリアル番号と一致しますか？`)) {
      startCapture();
    } else {
      startScanner();
    }
  }, 300);
}

// --- 撮影 ---
async function startCapture() {
  stopStream(state.scanStream);
  state.scanStream = null;
  showSection('capture-section');
  $('confirmed-barcode').textContent = state.barcode;
  updateFaceGuide();
  $('thumbs').innerHTML = '';

  try {
    state.camStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    $('cam').srcObject = state.camStream;
    await $('cam').play();
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      showToast('カメラが許可されていません。ブラウザのサイト設定でカメラを許可してください', 'error');
    } else {
      showToast('カメラ起動失敗: ' + e.message, 'error');
    }
  }
}

async function takePhoto() {
  if (state.photos.length >= MAX_PHOTOS) return;
  const video = $('cam');
  const { blob, dataUrl } = await captureAndEncode(video);
  state.photos.push({ blob, dataUrl });

  const img = document.createElement('img');
  img.src = dataUrl;
  $('thumbs').appendChild(img);
  updateFaceGuide();
  if (navigator.vibrate) navigator.vibrate(50);

  if (state.photos.length >= MAX_PHOTOS) {
    goReview();
  }
}

function updateFaceGuide() {
  const n = state.photos.length;
  $('btn-shutter').disabled = n >= MAX_PHOTOS;
  if (n < MAX_PHOTOS) {
    $('face-guide').textContent = `${n + 1}/4: ${FACE_LABELS[n]}を撮影`;
  } else {
    $('face-guide').textContent = '撮影完了';
  }
}

// --- 画像処理 ---
async function captureAndEncode(video) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(vw, vh));
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);

  const blob = await new Promise((res) =>
    canvas.toBlob(res, 'image/webp', IMAGE_QUALITY)
  );
  const dataUrl = await blobToDataUrl(blob);
  return { blob, dataUrl };
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
}

function dataUrlToBase64(dataUrl) {
  return dataUrl.split(',')[1];
}

// --- 確認 ---
function goReview() {
  stopStream(state.camStream);
  state.camStream = null;
  showSection('review-section');
  $('review-barcode').textContent = state.barcode;
  $('note-input').value = '';
  const box = $('review-thumbs');
  box.innerHTML = '';
  state.photos.forEach((p, i) => {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = p.dataUrl;
    const cap = document.createElement('figcaption');
    cap.textContent = FACE_LABELS[i];
    fig.appendChild(img);
    fig.appendChild(cap);
    box.appendChild(fig);
  });
}

function retake() {
  state.photos = [];
  startCapture();
}

// --- アップロード ---
async function upload() {
  $('btn-upload').disabled = true;
  $('btn-retake').disabled = true;
  showToast('アップロード中…');

  const params = {
    password: state.password,
    barcode: state.barcode,
    note: $('note-input').value || '',
  };
  state.photos.forEach((p, i) => {
    params['img' + i] = dataUrlToBase64(p.dataUrl);
  });

  try {
    const res = await callGas('saveScan', params);
    if (res.ok) {
      showToast('アップロード完了', 'success');
      startScanner();
    } else {
      throw new Error(res.error || 'アップロードに失敗しました');
    }
  } catch (e) {
    showToast('送信失敗。下書きに保存しました: ' + e.message, 'error');
    await saveDraft({
      barcode: state.barcode,
      note: $('note-input').value || '',
      images: state.photos.map((p) => ({ base64: dataUrlToBase64(p.dataUrl) })),
    });
  } finally {
    $('btn-upload').disabled = false;
    $('btn-retake').disabled = false;
  }
}

// --- 下書き (IndexedDB) ---
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDraft(draft) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add({
      createdAt: new Date().toISOString(),
      barcode: draft.barcode,
      note: draft.note,
      images: draft.images,
      lastError: '',
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllDrafts() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteDraft(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function showDrafts() {
  showSection('drafts-section');
  const drafts = await getAllDrafts();
  const list = $('drafts-list');
  list.innerHTML = '';
  if (drafts.length === 0) {
    list.textContent = '下書きはありません';
    return;
  }
  drafts.forEach((d) => {
    const item = document.createElement('div');
    item.className = 'draft-item';
    item.innerHTML = `
      <div>
        <div><strong>${d.barcode}</strong></div>
        <div style="font-size:12px;color:#999;">${d.createdAt}</div>
      </div>
    `;
    const actions = document.createElement('div');
    actions.className = 'actions';

    const resendBtn = document.createElement('button');
    resendBtn.className = 'primary';
    resendBtn.textContent = '再送信';
    resendBtn.addEventListener('click', async () => {
      resendBtn.disabled = true;
      try {
        const params = {
          password: state.password,
          barcode: d.barcode,
          note: d.note,
        };
        d.images.forEach((img, i) => {
          params['img' + i] = img.base64;
        });
        const res = await callGas('saveScan', params);
        if (res.ok) {
          await deleteDraft(d.id);
          showToast('再送信成功', 'success');
          showDrafts();
        } else {
          throw new Error(res.error);
        }
      } catch (e) {
        showToast('再送信失敗: ' + e.message, 'error');
        resendBtn.disabled = false;
      }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'secondary';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', async () => {
      await deleteDraft(d.id);
      showDrafts();
    });

    actions.appendChild(resendBtn);
    actions.appendChild(delBtn);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

// --- ユーティリティ ---
function showSection(id) {
  ['auth-section', 'scanner-section', 'capture-section', 'review-section', 'drafts-section'].forEach((s) => {
    $(s).hidden = (s !== id);
  });
}

function stopStream(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

let toastTimer = null;
function showToast(msg, type) {
  const el = $('toast');
  el.textContent = msg;
  el.className = type || '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}
