// Eklenti menüsü: durum ve ayarlar. Özellik anahtarları 6q panelinde.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LIVE = new Set(['LIVE', 'HALFTIME', 'EXTRA_TIME', 'BREAK', 'PENALTIES', 'IN_PLAY']);
const clock = (at) => (at ? new Date(at).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' }) : '');
const ago = (at) => {
  if (!at) return 'hiç';
  const m = Math.round((Date.now() - at) / 60000);
  return m < 1 ? 'az önce' : m < 60 ? `${m} dk önce` : m < 1440 ? `${Math.floor(m / 60)} sa önce` : `${Math.floor(m / 1440)} gün önce`;
};
const setStat = (id, text, state) => {
  $(id).textContent = text;
  const dot = $(`${id}-dot`);
  if (dot) dot.className = `dot${state ? ` dot--${state}` : ''}`;
};

// ---------- durum ----------
async function renderStatus() {
  const s = await chrome.storage.local.get(['skEvents', 'skMeta', 'xbetMeta', 'stakeMeta', 'siteTabs', 'aiCalls']);
  const ev = Object.values(s.skEvents || {});
  const meta = s.skMeta || {};
  const foot = ev.filter((e) => e.sport !== 'basketball');
  const bk = ev.filter((e) => e.sport === 'basketball');
  setStat('st-foot', meta.error && Date.now() - (meta.liveAt || 0) > 3 * 60 * 1000 ? 'alınamadı' : `${foot.length} maç · ${ago(meta.liveAt)}`, meta.error && Date.now() - (meta.liveAt || 0) > 3 * 60 * 1000 ? 'bad' : foot.length ? 'ok' : '');
  setStat('st-bk', meta.bkError ? 'alınamadı' : `${bk.length} maç · ${ago(meta.bkLiveAt || meta.bkListAt)}`, meta.bkError ? 'bad' : bk.length ? 'ok' : '');
  if (meta.bkError) $('st-bk').title = meta.bkError;
  const lf = foot.filter((e) => LIVE.has(e.status)).length;
  const lb = bk.filter((e) => LIVE.has(e.status)).length;
  setStat('st-live', `${lf} futbol · ${lb} NBA`, lf + lb ? 'live' : '');
  for (const [k, id] of [['xbet', 'st-xbet'], ['stake', 'st-stake']]) {
    const at = s[`${k}Meta`]?.updatedAt || 0;
    const open = s.siteTabs?.[k] !== false && Date.now() - at < 3 * 60 * 1000;
    setStat(id, open ? `bağlı · ${clock(at)}` : s.siteTabs?.[k] ? 'sekme açık, veri yok' : 'sekme kapalı', open ? 'ok' : 'bad');
  }
  const ai = Object.keys(s.aiCalls || {}).length;
  $('st-ai').textContent = `${ai} kupon/maç`;
}

async function renderNotes() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'fetchNotes' });
    const j = JSON.parse(res?.text || 'null');
    const fresh = (j?.notes || []).filter((n) => !n.at || Date.now() - Date.parse(n.at) < 24 * 3600 * 1000).length;
    const at = j?.updatedAt ? Date.parse(j.updatedAt) : 0;
    setStat('st-notes', at ? `${fresh} kayıt · ${ago(at)}` : 'yok', fresh ? 'ok' : '');
  } catch {
    setStat('st-notes', 'okunamadı', 'bad');
  }
}

function setupRefresh() {
  $('refresh-data').addEventListener('click', async () => {
    const { skMeta = {} } = await chrome.storage.local.get('skMeta');
    await chrome.storage.local.set({ skMeta: { ...skMeta, fixturesAt: 0, liveAt: 0, bkListAt: 0, bkLiveAt: 0 } });
    chrome.runtime.sendMessage({ type: 'skPoll', ids: [] }).catch(() => {});
    $('refresh-note').textContent = 'İstendi; birkaç saniye içinde güncellenir.';
    setTimeout(renderStatus, 4000);
  });
}

// ---------- ayarlar ----------
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
    if (host === null) { $('xbet-host-note').textContent = 'Geçersiz adres.'; return; }
    $('xbet-host').value = host;
    if (host) await chrome.storage.local.set({ xbetHost: host }); else await chrome.storage.local.remove('xbetHost');
    $('xbet-host-note').textContent = 'Kaydedildi. Açık 1xBet sekmesini yenile.';
  };
  $('xbet-host-save').addEventListener('click', save);
  $('xbet-host').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); });
}
async function init() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  $('open-update').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openUpdate' }));
  const s = await chrome.storage.local.get(['xbetHost']);
  setupRefresh();
  setupXbetHost(s.xbetHost);
  renderStatus();
  renderNotes();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.skMeta || changes.xbetMeta || changes.stakeMeta || changes.siteTabs) renderStatus();
  });
}

init();
