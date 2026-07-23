const scanBtn = document.getElementById("scan");
const dlBtn = document.getElementById("download");
const allBtn = document.getElementById("downloadAll");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");

let stopFlag = false; // tüm-board döngüsünü kırmak için

function showStop(show) {
  stopBtn.style.display = show ? "block" : "none";
}
const progWrap = document.getElementById("progWrap");
const progFill = document.getElementById("progFill");
const progText = document.getElementById("progText");

let scanned = null; // tek board: { board, urls }

function setStatus(html) {
  statusEl.innerHTML = html;
}

function showProgress(show) {
  progWrap.style.display = show ? "block" : "none";
}

function updateProgress(done, failed, total) {
  const pct = total ? Math.round(((done + failed) / total) * 100) : 0;
  progFill.style.width = pct + "%";
  progText.textContent =
    `${done + failed} / ${total}  (%${pct})` + (failed ? ` · hata: ${failed}` : "");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isPinterest(url) {
  return /^https:\/\/([a-z]+\.)?pinterest\.[a-z.]+\//i.test(url || "");
}

// Profil mi (/kullanici/ veya /kullanici/_saved/) yoksa board mu (/kullanici/board/)?
function pageType(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean);
    if (seg.length === 0) return "other";
    if (seg.length === 1) return "profile";
    if (seg.length === 2 && seg[1].startsWith("_")) return "profile"; // _saved, _created
    if (seg.length === 2) return "board";
    return "other";
  } catch {
    return "other";
  }
}

async function injectContent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

// Content script hazır olana kadar mesajı dene (navigasyon sonrası yarış durumları için)
async function sendWithRetry(tabId, msg, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      await sleep(500);
    }
  }
  throw new Error("Content script yanıt vermedi");
}

// İlerleme mesajları
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PBD_PROGRESS") {
    setStatus(`Taranıyor… <span class="count">${msg.count}</span> pin`);
  } else if (msg.type === "PBD_BOARDS_PROGRESS") {
    setStatus(`Board'lar bulunuyor… <span class="count">${msg.count}</span>`);
  } else if (msg.type === "PBD_DL_PROGRESS") {
    showProgress(true);
    updateProgress(msg.done, msg.failed, msg.total);
  }
});

// Sayfa tipine göre butonları ayarla
(async function init() {
  const tab = await getActiveTab();
  if (!isPinterest(tab.url)) {
    setStatus("⚠️ Bir Pinterest sekmesinde aç (board veya profil sayfası).");
    scanBtn.disabled = true;
    return;
  }
  const type = pageType(tab.url);
  if (type === "profile") {
    setStatus("Profil sayfası algılandı. Tüm board'ları tarayıp indirebilirsin.");
    scanBtn.style.display = "none";
    dlBtn.style.display = "none";
    allBtn.style.display = "block";
  } else if (type === "board") {
    setStatus("Board sayfası algılandı. Önce tara, sonra indir.");
    allBtn.style.display = "none";
  } else {
    setStatus("Bir board (/kullanici/board/) veya profil (/kullanici/) sayfası aç.");
  }
})();

// ---- Durdur ----
stopBtn.addEventListener("click", async () => {
  stopFlag = true; // tüm-board döngüsü varsa kır
  setStatus("Durduruluyor…");
  const tab = await getActiveTab();
  // Taramayı durdur (content script)
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "PBD_STOP" });
  } catch {}
  // İndirmeyi durdur (background)
  try {
    await chrome.runtime.sendMessage({ type: "PBD_CANCEL" });
  } catch {}
});

// ---- Tek board akışı ----
scanBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  scanBtn.disabled = true;
  dlBtn.disabled = true;
  showStop(true);
  setStatus("Content script yükleniyor…");
  try {
    await injectContent(tab.id);
    setStatus("Taranıyor… sekmeye dokunma. (Durdurabilirsin)");
    const result = await chrome.tabs.sendMessage(tab.id, { type: "PBD_SCAN" });
    scanned = result;
    if (!result || !result.urls.length) {
      setStatus("Hiç pin bulunamadı. Board tam yüklendi mi?");
      return;
    }
    setStatus(
      `Board: <span class="board">${result.board}</span>\n` +
        `<span class="count">${result.urls.length}</span> pin hazır.` +
        (stopFlag ? " (tarama durduruldu)" : "")
    );
    dlBtn.disabled = false;
  } catch (e) {
    setStatus("Hata: " + (e.message || e));
  } finally {
    scanBtn.disabled = false;
    showStop(false);
    stopFlag = false;
  }
});

dlBtn.addEventListener("click", async () => {
  if (!scanned || !scanned.urls.length) return;
  dlBtn.disabled = true;
  scanBtn.disabled = true;
  showStop(true);
  setStatus(`İndiriliyor — <span class="board">${scanned.board}</span>`);
  showProgress(true);
  updateProgress(0, 0, scanned.urls.length);
  try {
    const summary = await chrome.runtime.sendMessage({
      type: "PBD_DOWNLOAD",
      board: scanned.board,
      urls: scanned.urls,
    });
    setStatus(
      (summary.cancelled ? "⏹ Durduruldu — " : "✅ Bitti — ") +
        `<span class="board">${scanned.board}</span>\n` +
        `İndirilen: <span class="count">${summary.done}</span>/${summary.total}` +
        (summary.failed ? `\nBaşarısız: ${summary.failed}` : "")
    );
  } catch (e) {
    setStatus("İndirme hatası: " + (e.message || e));
  } finally {
    scanBtn.disabled = false;
    dlBtn.disabled = false;
    showStop(false);
    stopFlag = false;
  }
});

// ---- Tüm board akışı (profil sayfası) ----
allBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  allBtn.disabled = true;
  stopFlag = false;
  showStop(true);
  setStatus("Board listesi çıkarılıyor…");
  try {
    await injectContent(tab.id);
    const { boards } = await chrome.tabs.sendMessage(tab.id, { type: "PBD_SCAN_BOARDS" });
    if (!boards || !boards.length) {
      setStatus("Board bulunamadı. Profil sayfası doğru mu? (Gizli profiller çalışmaz.)");
      allBtn.disabled = false;
      return;
    }

    setStatus(`<span class="count">${boards.length}</span> board bulundu.\nSırayla işleniyor…`);
    await sleep(900);

    let grandDone = 0,
      grandFail = 0,
      boardIdx = 0;

    for (const b of boards) {
      if (stopFlag) break; // kullanıcı durdurdu
      boardIdx++;
      setStatus(
        `Board ${boardIdx}/${boards.length}: <span class="board">${b.name}</span>\nAçılıyor…`
      );
      // Aynı sekmede board'a git
      await chrome.tabs.update(tab.id, { url: b.url });
      await sleep(2500); // sayfa yüklensin
      await injectContent(tab.id);

      const result = await sendWithRetry(tab.id, { type: "PBD_SCAN" });
      if (!result || !result.urls.length) {
        setStatus(`Board ${boardIdx}/${boards.length}: <span class="board">${b.name}</span> — pin yok, atlanıyor.`);
        await sleep(800);
        continue;
      }

      setStatus(
        `Board ${boardIdx}/${boards.length}: <span class="board">${b.name}</span>\n` +
          `<span class="count">${result.urls.length}</span> pin indiriliyor…`
      );
      const summary = await chrome.runtime.sendMessage({
        type: "PBD_DOWNLOAD",
        board: result.board || b.name,
        urls: result.urls,
      });
      grandDone += summary.done;
      grandFail += summary.failed;
    }

    setStatus(
      (stopFlag ? "⏹ Durduruldu.\n" : "✅ Tüm board'lar bitti.\n") +
        `İşlenen board: <span class="count">${boardIdx}</span>/${boards.length}\n` +
        `Toplam indirilen: <span class="count">${grandDone}</span>` +
        (grandFail ? `\nBaşarısız: ${grandFail}` : "")
    );
  } catch (e) {
    setStatus("Hata: " + (e.message || e) + "\nPopup'ı açık tuttuğundan emin ol.");
  } finally {
    allBtn.disabled = false;
    showStop(false);
    stopFlag = false;
  }
});
