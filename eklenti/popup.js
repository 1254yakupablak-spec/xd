// Eklenti menüsü: özellik anahtarları, site durumları, ayarlar.
const $ = (id) => document.getElementById(id);

// Öğrenilenler: kaç kayıt var, dosyaya aktar / dosyadan ekle (arkadaşınla paylaşmak için).
async function renderLearned() {
  const s = await chrome.storage.local.get(Object.keys(LEARN_KEYS));
  const sides = Object.keys(s.learnedSides || {}).length;
  const arb = Object.values(s.arbLearned || {}).reduce((n, m) => n + Object.keys(m || {}).length, 0);
  const links = Object.keys(s.overrides || {}).length
    + Object.values(s.arbLinks || {}).reduce((n, m) => n + Object.keys(m || {}).length, 0);
  $('learn-meta').textContent = `${sides + arb} takım adı · ${links} bağlı maç`;
}

function setupLearned() {
  $('learn-export').addEventListener('click', async () => {
    const data = await chrome.storage.local.get(Object.keys(LEARN_KEYS));
    // Chrome'un indirme yöneticisiyle: menü penceresi kapansa da dosya Chrome'un indirme klasörüne iner.
    const json = JSON.stringify(data, null, 1);
    const url = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    await chrome.downloads.download({ url, filename: 'learned.json', conflictAction: 'overwrite', saveAs: false });
    $('learn-meta').textContent = `learned.json indirildi (${countLearned(data)} kayıt).`;
    setTimeout(renderLearned, 3000);
  });
  $('learn-import').addEventListener('click', () => $('learn-file').click());
  $('learn-file').addEventListener('change', async () => {
    const file = $('learn-file').files[0];
    if (!file) return;
    try {
      const added = await importLearned(JSON.parse(await file.text()));
      $('learn-meta').textContent = `${added} yeni kayıt eklendi.`;
      setTimeout(renderLearned, 2500);
    } catch {
      $('learn-meta').textContent = 'Dosya okunamadı (learned.json olmalı).';
    }
    $('learn-file').value = '';
  });
  renderLearned();
}

// 1xBet adresi: "https://www.1xbet-tr.com/tr/line" de yazılsa sadece alan adı (1xbet-tr.com) saklanır.
function parseHost(text) {
  const v = text.trim();
  if (!v) return '';
  try {
    const host = new URL(v.includes('://') ? v : `https://${v}`).hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function setupXbetHost(saved) {
  $('xbet-host').value = saved || '';
  const save = async () => {
    const host = parseHost($('xbet-host').value);
    if (host === null) {
      $('xbet-host-note').textContent = 'Geçersiz adres.';
      return;
    }
    $('xbet-host').value = host;
    if (host) await chrome.storage.local.set({ xbetHost: host });
    else await chrome.storage.local.remove('xbetHost');
    $('xbet-host-note').textContent = 'Kaydedildi. Açık 1xBet sekmesini yenile.';
  };
  $('xbet-host-save').addEventListener('click', save);
  $('xbet-host').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
}

// Ortak yorum adresi: herkese açık GitHub dosyası (raw adresi). Boşsa paketteki adres kullanılır.
function setupNotesUrl(saved) {
  $('notes-url').value = saved || '';
  $('notes-url-save').addEventListener('click', async () => {
    const v = $('notes-url').value.trim();
    if (v && !/^https:\/\/(raw|gist)\.githubusercontent\.com\//.test(v)) {
      $('notes-url-note').textContent = 'Sadece GitHub raw adresi girilebilir.';
      return;
    }
    if (v) await chrome.storage.local.set({ notesUrl: v }); else await chrome.storage.local.remove('notesUrl');
    $('notes-url-note').textContent = 'Kaydedildi. 6q sayfasını yenile.';
  });
}

async function init() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  $('open-update').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openUpdate' }));
  const s = await chrome.storage.local.get(['featScores', 'featArb', 'featInfo', 'notesUrl', 'xbetHost', 'lsMeta', 'scoreSource']);
  setupLearned();
  setupXbetHost(s.xbetHost);
  setupNotesUrl(s.notesUrl);
  // Özellik anahtarları: açık sayfalara anında yansır.
  for (const [id, key] of [['feat-scores', 'featScores'], ['feat-arb', 'featArb'], ['feat-info', 'featInfo']]) {
    $(id).checked = s[key] !== false;
    $(id).addEventListener('change', () => chrome.storage.local.set({ [key]: $(id).checked }));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(LEARN_KEYS).some((k) => changes[k])) renderLearned();
  });
}

init();
