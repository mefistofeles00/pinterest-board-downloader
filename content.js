// content.js — Pinterest board sayfasında çalışır.
// Sayfayı otomatik kaydırarak sanallaştırılmış pinlerin hepsini yükler,
// görsel URL'lerini toplar ve orijinal çözünürlüğe yükseltir.

(function () {
  // Aynı sekmede birden fazla enjekte edilmeyi engelle
  if (window.__pbdInjected) return;
  window.__pbdInjected = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Durdurma bayrağı — popup "Durdur" deyince true olur, döngüler kırılır
  window.__pbdStop = false;

  // i.pinimg.com thumbnail URL'ini orijinal boyuta yükselt.
  // Örn: https://i.pinimg.com/236x/ab/cd/ef/hash.jpg
  //   -> https://i.pinimg.com/originals/ab/cd/ef/hash.jpg
  function upgradeResolution(url) {
    if (!url) return null;
    // /236x/ /474x/ /564x/ /736x/ gibi boyut segmentini originals ile değiştir
    return url.replace(
      /(https:\/\/i\.pinimg\.com\/)(\d+x|\d+x\d+)(\/)/,
      "$1originals$3"
    );
  }

  function getBoardName() {
    // 1) Sayfa başlığından
    const h1 = document.querySelector("h1");
    if (h1 && h1.textContent.trim()) return h1.textContent.trim();
    // 2) OG title
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return og.content.replace(/\s*\|\s*Pinterest.*$/i, "").trim();
    // 3) URL'nin son segmenti
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : "pinterest-board";
  }

  // Görünürdeki pin görsellerini topla
  function collectVisible(map) {
    const imgs = document.querySelectorAll('img[src*="i.pinimg.com"]');
    imgs.forEach((img) => {
      // srcset varsa en büyük adayı al, yoksa src
      let candidate = img.src;
      if (img.srcset) {
        const last = img.srcset.split(",").pop().trim().split(" ")[0];
        if (last) candidate = last;
      }
      const full = upgradeResolution(candidate);
      if (!full) return;
      // avatar / profil gibi çok küçük görselleri ele
      // (originals'a çevirdiğimiz için boyuta değil, kaynağa göre eliyoruz)
      // Anahtar olarak hash yolunu kullan -> aynı pin tekrar sayılmasın
      const key = full.replace("https://i.pinimg.com/originals/", "");
      if (!map.has(key)) map.set(key, full);
    });
  }

  async function scanBoard(onProgress) {
    const map = new Map();
    let lastCount = 0;
    let stagnantRounds = 0;
    const MAX_STAGNANT = 5; // kaç kez üst üste yeni pin gelmezse dur
    const MAX_ROUNDS = 400; // güvenlik sınırı

    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (window.__pbdStop) break; // kullanıcı durdurdu
      collectVisible(map);
      window.scrollBy(0, window.innerHeight * 0.9);
      await sleep(650); // pinlerin yüklenmesini bekle

      const count = map.size;
      if (onProgress) onProgress(count);

      if (window.__pbdStop) break;

      if (count === lastCount) {
        stagnantRounds++;
        if (stagnantRounds >= MAX_STAGNANT) {
          // En dibe bir kez daha in, emin ol
          window.scrollTo(0, document.body.scrollHeight);
          await sleep(1200);
          collectVisible(map);
          if (map.size === count) break;
          stagnantRounds = 0;
        }
      } else {
        stagnantRounds = 0;
      }
      lastCount = count;
    }

    window.scrollTo(0, 0);
    return {
      board: getBoardName(),
      urls: Array.from(map.values()),
    };
  }

  // Profil sayfasındaki tüm board linklerini topla.
  // Profil de sanallaştırılmış olabilir, o yüzden kaydırarak topluyoruz.
  async function scanBoards(onProgress) {
    const map = new Map(); // url -> {url, name}
    // Profil kullanıcı adı: /kullanici/ -> board yolu /kullanici/board/
    const parts = location.pathname.split("/").filter(Boolean);
    const user = parts[0] ? parts[0].toLowerCase() : null;

    function collect() {
      const links = document.querySelectorAll('a[href^="/"]');
      links.forEach((a) => {
        const href = a.getAttribute("href");
        if (!href) return;
        const seg = href.split("/").filter(Boolean);
        // board linki: /kullanici/board-adi/  (2 segment, ilk segment kullanıcı)
        if (
          seg.length === 2 &&
          user &&
          seg[0].toLowerCase() === user &&
          !seg[1].startsWith("_") // _saved, _created gibi sekmeleri ele
        ) {
          const url = location.origin + "/" + seg[0] + "/" + seg[1] + "/";
          if (!map.has(url)) {
            map.set(url, { url, name: decodeURIComponent(seg[1]) });
          }
        }
      });
    }

    let last = 0,
      stagnant = 0;
    for (let i = 0; i < 100; i++) {
      if (window.__pbdStop) break; // kullanıcı durdurdu
      collect();
      if (onProgress) onProgress(map.size);
      if (map.size === last) {
        if (++stagnant >= 4) break;
      } else stagnant = 0;
      last = map.size;
      window.scrollBy(0, window.innerHeight * 0.9);
      await sleep(600);
    }
    window.scrollTo(0, 0);
    return Array.from(map.values());
  }

  // Popup / background'dan gelen mesajları dinle
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "PBD_STOP") {
      window.__pbdStop = true;
      sendResponse({ stopped: true });
      return; // senkron yanıt
    }
    if (msg.type === "PBD_SCAN") {
      window.__pbdStop = false; // yeni tarama, bayrağı sıfırla
      scanBoard((count) => {
        chrome.runtime.sendMessage({ type: "PBD_PROGRESS", count });
      }).then((result) => sendResponse(result));
      return true; // async yanıt
    }
    if (msg.type === "PBD_SCAN_BOARDS") {
      window.__pbdStop = false; // yeni tarama, bayrağı sıfırla
      scanBoards((count) => {
        chrome.runtime.sendMessage({ type: "PBD_BOARDS_PROGRESS", count });
      }).then((boards) => sendResponse({ boards }));
      return true;
    }
  });
})();
