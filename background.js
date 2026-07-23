// background.js — indirmeleri yönetir, Chrome indirme UI'ını susturur,
// gerçek tamamlanmayı onChanged ile takip eder.
// Uzun işlerde MV3 service worker'ının uyumaması için keep-alive.

const KEEPALIVE_ALARM = "pbd-keepalive";
let keepAliveTimer = null;

// Worker'ın uyku sayacını sıfırlayan hafif no-op çağrı
function pokeAlive() {
  // getPlatformInfo çok ucuz; her çağrı idle timer'ı resetler
  chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
}

function startKeepAlive() {
  // 1) Dış güvenlik ağı: worker tamamen uyursa alarm dışarıdan uyandırır
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
  // 2) İç nabız: 20 sn'de bir hafif çağrı (30 sn uyku eşiğinin altında)
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(pokeAlive, 20000);
  }
  pokeAlive();
}

function stopKeepAlive() {
  chrome.alarms.clear(KEEPALIVE_ALARM);
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

// Alarm uyandırınca da nabız at (worker yeniden ayağa kalkmış olabilir)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) pokeAlive();
});

function sanitize(name) {
  return (
    (name || "pinterest-board")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "pinterest-board"
  );
}

function filenameFromUrl(url, index) {
  try {
    const path = new URL(url).pathname;
    const base = path.split("/").pop() || `pin_${index}.jpg`;
    return /\.[a-z0-9]{2,4}$/i.test(base) ? base : `${base}.jpg`;
  } catch {
    return `pin_${index}.jpg`;
  }
}

// Chrome'un indirme çubuğu/balonu/animasyonunu aç-kapa
async function setDownloadUI(enabled) {
  try {
    if (chrome.downloads.setUiOptions) {
      await chrome.downloads.setUiOptions({ enabled });
    } else if (chrome.downloads.setShelfEnabled) {
      chrome.downloads.setShelfEnabled(enabled); // eski Chrome fallback
    }
  } catch (e) {
    // izin yoksa sessizce geç — indirme yine çalışır, sadece UI görünür
    console.warn("setUiOptions başarısız:", e);
  }
}

// İndirme iptal bayrağı
let cancelRequested = false;

// Aktif indirme id'lerini tamamlanma/iptal durumuna göre izle
const pending = new Map(); // downloadId -> {resolve}

chrome.downloads.onChanged.addListener((delta) => {
  const p = pending.get(delta.id);
  if (!p) return;
  if (delta.state && delta.state.current === "complete") {
    pending.delete(delta.id);
    p.resolve({ ok: true });
  } else if (delta.state && delta.state.current === "interrupted") {
    pending.delete(delta.id);
    p.resolve({ ok: false });
  }
});

const STUCK_TIMEOUT = 90000; // bir dosya 90 sn'de bitmezse başarısız say, devam et

function startDownload(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, conflictAction: "uniquify" }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        resolve({ id: null, done: Promise.resolve({ ok: false }) });
        return;
      }
      const done = new Promise((res) => {
        const t = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            res({ ok: false }); // takıldı, havuzu kilitleme
          }
        }, STUCK_TIMEOUT);
        // onChanged tetiklenince timer'ı da temizle
        pending.set(id, {
          resolve: (v) => {
            clearTimeout(t);
            res(v);
          },
        });
      });
      resolve({ id, done });
    });
  });
}

// Aynı anda en fazla POOL indirme; her biri tamamlanınca ilerleme bildir
async function downloadAll(board, urls, sendProgress) {
  const folder = sanitize(board);
  const total = urls.length;
  let done = 0;
  let failed = 0;
  let dispatched = 0;

  cancelRequested = false;
  await setDownloadUI(false); // ANIMASYONU KAPAT
  startKeepAlive(); // worker uyumasın

  const POOL = 6; // eşzamanlı indirme sayısı

  try {
    let index = 0;
    async function worker() {
      while (index < urls.length) {
        if (cancelRequested) break; // kullanıcı durdurdu
        const i = index++;
        const url = urls[i];
        const filename = `${folder}/${String(i + 1).padStart(4, "0")}_${filenameFromUrl(url, i)}`;
        dispatched++;
        const { id, done: donePromise } = await startDownload(url, filename);
        const res = await donePromise;
        if (res.ok) done++;
        else failed++;
        if (sendProgress) sendProgress({ done, failed, dispatched, total });
      }
    }
    const workers = [];
    for (let k = 0; k < Math.min(POOL, urls.length); k++) workers.push(worker());
    await Promise.all(workers);
  } finally {
    await setDownloadUI(true); // UI'ı geri aç
    stopKeepAlive(); // nabzı durdur
  }

  return { done, failed, total, cancelled: cancelRequested };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "PBD_CANCEL") {
    cancelRequested = true;
    sendResponse({ cancelled: true });
    return;
  }
  if (msg.type === "PBD_DOWNLOAD") {
    downloadAll(msg.board, msg.urls, (p) => {
      // popup açıksa dinler; kapalıysa hata fırlatmasın diye yut
      chrome.runtime.sendMessage({ type: "PBD_DL_PROGRESS", ...p }).catch(() => {});
    }).then((summary) => sendResponse(summary));
    return true;
  }
});
