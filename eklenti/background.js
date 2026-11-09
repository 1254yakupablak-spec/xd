// Ortak maç notları: herkese açık GitHub dosyası. Sadece okunur; adres menüden girilir ya da pakette hazır gelir.
const DEFAULT_NOTES_URL = 'https://raw.githubusercontent.com/1254yakupablak-spec/xd/main/comments';
const NOTES_URL_OK = /^https:\/\/(raw|gist)\.githubusercontent\.com\//;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'fetchNotes') return;
  (async () => {
    const { notesUrl } = await chrome.storage.local.get('notesUrl');
    const url = notesUrl || DEFAULT_NOTES_URL;
    if (!NOTES_URL_OK.test(url)) { reply({ text: null }); return; }
    try {
      const res = await fetch(url, { cache: 'no-store' });
      reply({ text: res.ok ? (await res.text()).slice(0, 500000) : null });
    } catch {
      reply({ text: null });
    }
  })();
  return true;
});

// SofaScore sekmesini yönetir: kupon sayfasından istenince açar ya da yeniler.
const SOFA_URL = 'https://www.sofascore.com/*';
const LS_URL = 'https://www.livescore.in/*';

importScripts('learned.js');

// Eklenti kurulunca/güncellenince açık SofaScore sekmelerindeki eski kod ölür; sekmeleri yenile.
// Paketle gelen öğrenilenler (learned.json, varsa) kendi kayıtlarının üzerine yazmadan eklenir.
chrome.runtime.onInstalled.addListener(async () => {
  // Eski sürümlerden kalan kayıtlar.
  await chrome.storage.local.remove(['comboBank', 'comboUnit', 'xbetDiag', 'clKey', 'clModel', 'clOn', 'arbAi', 'oaKey', 'oaEvents', 'oaEventsAt', 'oaOdds', 'oaMeta']);
  await chrome.storage.local.set({ oaOn: false });
  try {
    const res = await fetch(chrome.runtime.getURL('learned.json'));
    if (res.ok) await importLearned(await res.json());
  } catch {
    // learned.json yok ya da bozuk: paylaşılan öğrenilenler olmadan devam et.
  }
  const urls = [SOFA_URL, ...(await tabDef('openXbet')).match, 'https://stake.com/*', 'https://*.stake.com/*', LS_URL];
  for (const t of await chrome.tabs.query({ url: urls })) chrome.tabs.reload(t.id);
  await groupTabs().catch(() => {});
});

// Eklentinin sekmeleri tek bir sekme grubunda durur, sabitlenmez. Kullanıcının başka pencerede açtığı sekmeler de
// aynı pencerenin grubuna alınır; açık bir grup varsa ona eklenir.
const GROUP_TITLE = 'KOKLEYİCİ SPORTS';

async function groupTabs() {
  const patterns = [SOFA_URL, LS_URL, ...(await tabDef('openXbet')).match, ...TABS.openStake.match];
  const tabs = await chrome.tabs.query({ url: patterns });
  if (!tabs.length) return;
  const byWindow = new Map();
  for (const t of tabs) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) || []), t]);
  for (const [windowId, list] of byWindow) {
    for (const t of list) if (t.pinned) await chrome.tabs.update(t.id, { pinned: false });
    const [group] = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
    const tabIds = list.map((t) => t.id);
    const groupId = await chrome.tabs.group(group ? { groupId: group.id, tabIds } : { createProperties: { windowId }, tabIds });
    if (!group) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'green' });
  }
}

// Veri sekmeleri: SofaScore (skorlar), livescore.in (takım adları), 1xBet ve Stake (özel oranların ters oranları).
const TABS = {
  openSofa: { match: SOFA_URL, url: 'https://www.sofascore.com/tr/futbol' },
  openXbet: { match: ['https://1xbet.com/*', 'https://*.1xbet.com/*'], url: 'https://1xbet.com/tr/line/football' },
  openStake: { match: ['https://stake.com/*', 'https://*.stake.com/*'], url: 'https://stake.com/tr/sports/soccer' },
  // livescore.in: SofaScore'un yanında ikinci takım adı kaynağı (Özel Oranlar eşleştirmesi).
  openLivescore: { match: LS_URL, url: 'https://www.livescore.in/tr/' },
};

// Satırdaki düğmelerden: o sitenin sekmesini öne getir; maç adresi varsa sekmeyi o maça götür.
const BOOK_TABS = { xbet: 'openXbet', stake: 'openStake' };

// 1xBet'in adresi menüden değiştirilebilir (ayna adresler); seçilen adres yoksa 1xbet.com.
async function tabDef(type) {
  if (type !== 'openXbet') return TABS[type];
  const { xbetHost } = await chrome.storage.local.get('xbetHost');
  const host = xbetHost || '1xbet.com';
  const match = [...new Set([`https://${host}/*`, `https://*.${host}/*`, ...TABS.openXbet.match])];
  return { match, url: `https://${host}/tr/line/football` };
}

// Kupondaki "SofaScore'da bul": SofaScore'u yeni sekmede açar (veri toplayan sekme kalsın).
// Kuponun sekmesi hatırlanır; SofaScore'daki çubuktan "Kupona dön" ile oraya dönülür.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'findOnSofa') {
    (async () => {
      const { sofaPick } = await chrome.storage.local.get('sofaPick');
      if (sofaPick) await chrome.storage.local.set({ sofaPick: { ...sofaPick, tabId: sender.tab?.id ?? null } });
      await chrome.tabs.create({ url: 'https://www.sofascore.com/tr/futbol', active: true });
      await groupTabs().catch(() => {});
    })();
  } else if (msg?.type === 'backToCoupon') {
    (async () => {
      if (msg.tabId == null) return;
      const tab = await chrome.tabs.update(msg.tabId, { active: true }).catch(() => null);
      if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    })();
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'gotoBook') return;
  const type = BOOK_TABS[msg.book];
  if (!type) return;
  (async () => {
    // "Bu maç mı?" çubuğundan özel oranlar sekmesine dönülebilsin.
    const { bookPick } = await chrome.storage.local.get('bookPick');
    if (bookPick?.book === msg.book) await chrome.storage.local.set({ bookPick: { ...bookPick, tabId: sender.tab?.id ?? null } });
    const t = await tabDef(type);
    // 1xBet'te kısa adres yok: sekme öne gelir, numarayı sitenin arama kutusuna xbet.js yazar.
    if (msg.gameId) await chrome.storage.local.set({ xbetOpen: { id: msg.gameId, at: Date.now() } });
    const url = msg.gameId ? null : msg.url;
    const [tab] = (await chrome.tabs.query({ url: t.match })).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    if (!tab) {
      await chrome.tabs.create({ url: url || t.url, active: true });
      await groupTabs().catch(() => {});
      return;
    }
    await chrome.tabs.update(tab.id, url ? { url, active: true } : { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  })();
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!TABS[msg?.type]) return;
  (async () => {
    const t = await tabDef(msg.type);
    const tabs = await chrome.tabs.query({ url: t.match });
    if (tabs.length) {
      // Düğmeye "bağlı değil" iken basılıyor: sekme var ama veri gelmiyor, yeniden yükle.
      const [tab] = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      if (!msg.focus || msg.reload) await chrome.tabs.reload(tab.id);
      await chrome.tabs.update(tab.id, { active: true });
      const win = await chrome.windows.get(tab.windowId);
      await chrome.windows.update(tab.windowId, win.state === 'minimized' ? { focused: true, state: 'normal' } : { focused: true });
      reply({ ok: true, existed: true });
      return;
    }
    await chrome.tabs.create({ url: t.url, active: !!msg.focus });
    await groupTabs().catch(() => {});
    reply({ ok: true, existed: false });
  })();
  return true;
});

// Hangi sitenin sekmesi gerçekten açık: sekme açılıp kapanınca hemen güncellenir (siteTabs).
// Sayfa ve menü buna bakar; "son veri ne zaman geldi" tahmini sekme kapandıktan sonra da açık gösteriyordu.
async function updateSiteTabs() {
  const sites = { sofa: 'openSofa', ls: 'openLivescore', xbet: 'openXbet', stake: 'openStake' };
  const next = {};
  for (const [key, type] of Object.entries(sites)) {
    next[key] = (await chrome.tabs.query({ url: (await tabDef(type)).match })).length > 0;
  }
  const { siteTabs } = await chrome.storage.local.get('siteTabs');
  if (JSON.stringify(siteTabs) !== JSON.stringify(next)) await chrome.storage.local.set({ siteTabs: next });
}

const refreshSiteTabs = () => { updateSiteTabs().catch(() => {}); };
chrome.tabs.onRemoved.addListener(refreshSiteTabs);
chrome.tabs.onCreated.addListener(refreshSiteTabs);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === 'complete') refreshSiteTabs(); });
chrome.runtime.onStartup.addListener(refreshSiteTabs);
chrome.runtime.onInstalled.addListener(refreshSiteTabs);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.xbetHost) refreshSiteTabs(); });

// ---------- veri servisi: dün, bugün ve yarının maçları + canlı skorlar ----------
// Sekme gerekmez: 6q açıkken içerik betiği 8 saniyede bir "skPoll" ister. Maç listesi 30 dakikada bir (3 istek),
// canlı skorlar en sık 7 saniyede bir (1 istek) alınır (sunucu veriyi 5-7 sn'de bir tazeliyor); birden çok 6q sekmesi açık olsa da sıklık artmaz. Canlı listeden düşen maç (bitti) için bugünün listesi yenilenir.
const SK_API = 'https://skorcum.com/api/football/';
let skBusy = false;

const skDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

function skConv(f) {
  return {
    id: f.id,
    home: f.home?.name || '',
    away: f.away?.name || '',
    homeLogo: f.home?.logoUrl || '',
    awayLogo: f.away?.logoUrl || '',
    start: f.kickoffAt ? Math.round(Date.parse(f.kickoffAt) / 1000) : null,
    status: f.status || '',
    label: f.stateLabel || '',
    minute: f.minute ?? null,
    added: f.addedMinute ?? null,
    hs: f.score?.home ?? null,
    as: f.score?.away ?? null,
    league: [f.competition?.country?.name, f.competition?.name].filter(Boolean).join(' '),
    homeTid: f.home?.id ?? null,
    awayTid: f.away?.id ?? null,
  };
}

async function skGet(path) {
  const res = await fetch(SK_API + path, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`veri servisi ${res.status}`);
  const json = await res.json();
  return Array.isArray(json?.data?.fixtures) ? json.data.fixtures : [];
}

const SK_LIVE = new Set(['LIVE', 'HALFTIME', 'EXTRA_TIME', 'BREAK', 'PENALTIES', 'IN_PLAY']);

async function skPoll() {
  if (skBusy) return;
  skBusy = true;
  try {
    const s = await chrome.storage.local.get(['skEvents', 'skMeta']);
    const meta = { ...(s.skMeta || {}) };
    let events = s.skEvents || {};
    const now = Date.now();
    let changed = false;
    const noLogos = Object.keys(events).length && !Object.values(events).some((e) => 'homeLogo' in e);
    if (noLogos || now - (meta.fixturesAt || 0) > 30 * 60 * 1000) {
      // Kuponlar birkaç gün önce yapılmış olabilir: son 4 günün ve yarının maçları alınır, bitmiş maçlar 7 gün saklanır.
      // Eski günler (3 ve 2 gün önce) değişmez: günde bir kez yeniden alınması yeter.
      const next = {};
      for (const [k, e] of Object.entries(events)) if (e.start && now / 1000 - e.start < 7 * 86400) next[k] = e;
      const oldDue = noLogos || now - (meta.oldDaysAt || 0) > 24 * 3600 * 1000;
      for (const d of oldDue ? [-3, -2, -1, 0, 1] : [-1, 0, 1]) for (const f of await skGet(`fixtures?date=${skDate(now + d * 864e5)}`)) next[f.id] = skConv(f);
      if (oldDue) meta.oldDaysAt = now;
      events = next;
      meta.fixturesAt = now;
      changed = true;
    }
    if (now - (meta.liveAt || 0) > 7 * 1000) {
      const live = await skGet('live');
      const ids = new Set(live.map((f) => f.id));
      for (const f of live) events[f.id] = { ...events[f.id], ...skConv(f) };
      // Canlıyken listeden düşen maç bitmiştir: son skoru ve durumu bugünün listesinden al.
      if (Object.values(events).some((e) => e.sport !== 'basketball' && SK_LIVE.has(e.status) && !ids.has(e.id))) {
        for (const f of await skGet(`fixtures?date=${skDate(now)}`)) events[f.id] = { ...events[f.id], ...skConv(f) };
      }
      meta.liveAt = now;
      changed = true;
    }
    if (await bkPoll(events, meta, now)) changed = true;
    if (changed) {
      meta.updatedAt = now;
      meta.count = Object.keys(events).length;
      meta.error = null;
      await chrome.storage.local.set({ skEvents: events, skMeta: meta });
    }
  } catch (err) {
    const { skMeta = {} } = await chrome.storage.local.get('skMeta');
    await chrome.storage.local.set({ skMeta: { ...skMeta, error: String(err?.message || err), errorAt: Date.now() } });
  } finally {
    skBusy = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'skPoll') { skPoll(); if (Array.isArray(msg.ids) && msg.ids.length) skFeedPoll(msg.ids); }
  if (msg?.type === 'skDetail' && /^b?\d+$/.test(String(msg.id))) {
    skDetail(String(msg.id)).then((d) => reply({ ok: true, d })).catch((err) => reply({ ok: false, error: String(err?.message || err) }));
    return true;
  }
});

// ---------- güncelleme: GitHub'daki sürüm ----------
// GitHub'ın dosya sunucusu 5 dk önbellekte tutar: adrese ?t= eklenir, hep son hali gelir. 10 dakikada bir son sürüm numarasına bakılır; yeni sürüm varsa paneller "Güncelle" düğmesi gösterir.
const UPDATE_BASE = 'https://raw.githubusercontent.com/1254yakupablak-spec/xd/main/eklenti/';
async function checkUpdate(force = false) {
  const { updateInfo = {} } = await chrome.storage.local.get('updateInfo');
  if (!force && Date.now() - (updateInfo.checkedAt || 0) < 10 * 60 * 1000) return;
  try {
    const res = await fetch(UPDATE_BASE + 'manifest.json?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
    const m = res.ok ? await res.json() : null;
    await chrome.storage.local.set({ updateInfo: { latest: m?.version || updateInfo.latest || null, checkedAt: Date.now() } });
  } catch {
    await chrome.storage.local.set({ updateInfo: { ...updateInfo, checkedAt: Date.now() } });
  }
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'skPoll') checkUpdate();
  if (msg?.type === 'openUpdate') chrome.tabs.create({ url: chrome.runtime.getURL('update.html') });
});
chrome.runtime.onStartup?.addListener(() => checkUpdate(true));
chrome.runtime.onInstalled.addListener(() => checkUpdate(true));

// ---------- ortak öğrenilen takım adları ----------
// GitHub'daki learned.json herkesin eklentisine 3 saatte bir eklenir: siteler arası takım adı eşleşmeleri
// (arbLearned) ve maç bağlantıları. Kendi kayıtların her zaman öne geçer, ortak dosya sadece eksikleri doldurur.
async function pullSharedLearned(force = false) {
  const { learnedSharedAt = 0 } = await chrome.storage.local.get('learnedSharedAt');
  if (!force && Date.now() - learnedSharedAt < 3 * 3600 * 1000) return;
  await chrome.storage.local.set({ learnedSharedAt: Date.now() });
  try {
    const res = await fetch(UPDATE_BASE + 'learned.json?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
    if (res.ok) await importLearned(await res.json());
  } catch {
    // Ortak dosya alınamadı: kendi öğrenilenlerle devam.
  }
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'skPoll') pullSharedLearned();
});
chrome.runtime.onStartup?.addListener(() => pullSharedLearned(true));
chrome.runtime.onInstalled.addListener(() => pullSharedLearned(true));

// ---------- maç olayları: kuponlardaki canlı maçlar için ----------
// Kırmızı kart, VAR kararları, penaltılar ve kendi kalesine gol. Sadece kuponlarda olan canlı maçlar, maç başına
// en sık 25 sn'de bir, tek seferde en çok 10 maç. Önemsiz olaylar (değişiklik, sarı kart) saklanmaz.
const SK_KEY_EVENTS = new Set(['GOAL', 'OWN_GOAL', 'PENALTY', 'MISSED_PENALTY', 'RED_CARD', 'SECOND_YELLOW', 'VAR']);
let skFeedBusy = false;
async function skFeedPoll(ids) {
  if (skFeedBusy) return;
  skFeedBusy = true;
  try {
    const { skFeed = {} } = await chrome.storage.local.get('skFeed');
    const now = Date.now();
    const due = [...new Set(ids.map(String))].filter((id) => /^\d+$/.test(id) && now - (skFeed[id]?.at || 0) > 15 * 1000).slice(0, 10);
    let changed = false;
    for (const id of due) {
      try {
        const res = await fetch(SK_API + 'fixtures/' + id, { cache: 'no-store', credentials: 'omit' });
        if (!res.ok) continue;
        const d = (await res.json())?.data;
        const events = (d?.events || []).filter((e) => SK_KEY_EVENTS.has(e.kind)).map((e) => ({
          id: e.id, kind: e.kind, decision: e.decision || null, teamId: e.teamId, minute: e.minute, added: e.addedMinute, player: e.player || '', detail: e.detail || '',
        }));
        skFeed[id] = { at: Date.now(), events };
        changed = true;
      } catch {
        // bu maç bu turda alınamadı
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    for (const [id, v] of Object.entries(skFeed)) if (now - (v.at || 0) > 6 * 3600 * 1000) { delete skFeed[id]; changed = true; }
    if (changed) await chrome.storage.local.set({ skFeed });
  } finally {
    skFeedBusy = false;
  }
}

// ---------- maç ayrıntısı (Göz at / Canlı akış paneli) ----------
// Sadece kullanıcı paneli açınca. Maç (olaylar, istatistik, kadro, baskı): canlıda 30 sn, değilse 10 dk saklanır.
// Karşılaşma geçmişi, hakem, hava, TV, stat ve puan durumu: 1 saat.
const skDetailCache = new Map();
async function skJson(path) {
  const res = await fetch(SK_API + path, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`veri servisi ${res.status}`);
  return (await res.json())?.data ?? null;
}
async function skDetail(id) {
  if (id.startsWith('b')) return bkDetail(id.slice(1));
  const now = Date.now();
  const c = skDetailCache.get(id) || {};
  const live = SK_LIVE.has(c.detail?.fixture?.status);
  if (!c.detail || now - c.detailAt > (live ? 12 * 1000 : 10 * 60 * 1000)) {
    const d = await skJson('fixtures/' + id);
    c.detail = { fixture: d?.fixture, events: d?.events || [], statistics: d?.statistics || [], lineups: d?.lineups || [], formations: d?.formations || [], trends: d?.trends || [], lineupConfirmed: !!d?.lineupConfirmed };
    c.detailAt = now;
  }
  if (!c.extraAt || now - c.extraAt > 3600 * 1000) {
    const safe = (p) => skJson(p).catch(() => null);
    const [h2h, ref, coach, weather, tv, venue] = await Promise.all([safe(`fixtures/${id}/h2h`), safe(`fixtures/${id}/context/REFEREES`), safe(`fixtures/${id}/context/COACHES`),
      safe(`fixtures/${id}/context/WEATHER`), safe(`fixtures/${id}/context/BROADCASTS`), safe(`fixtures/${id}/context/VENUE`)]);
    c.h2h = h2h;
    c.ctx = { referees: ref?.referees || [], coaches: coach?.coaches || [], weather: weather?.weather || null, broadcasts: tv?.broadcasts || [], venue: venue?.venue || null };
    const cid = c.detail.fixture?.competition?.id;
    c.standings = cid ? ((await safe(`competitions/${cid}/standings`))?.rows || []) : [];
    c.extraAt = now;
  }
  skDetailCache.set(id, c);
  if (skDetailCache.size > 60) skDetailCache.delete(skDetailCache.keys().next().value);
  return { detail: c.detail, h2h: c.h2h, ctx: c.ctx, standings: c.standings };
}

// ---------- basketbol (NBA): maç listesi, canlı skor ve maç ayrıntısı ----------
// Anahtar gerekmez. Maçlar skEvents içinde "b" önekiyle tutulur (ör. b401909952); kuponlardaki eşleştirme,
// skor, geri sayım ve "Göz at" futbolla aynı yoldan çalışır. Liste 30 dakikada bir, canlı skor maç varken 10 sn'de bir.
const BK_API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/';
const bkDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)).replace(/-/g, '');

function bkStatus(st) {
  const n = st?.type?.name || '';
  const s = st?.type?.state;
  if (/POSTPONED/.test(n)) return 'POSTPONED';
  if (/CANCEL/.test(n)) return 'CANCELLED';
  if (/SUSPENDED|DELAYED/.test(n)) return 'SUSPENDED';
  if (s === 'post') return 'FINISHED';
  if (s === 'in') return n === 'STATUS_HALFTIME' ? 'HALFTIME' : n === 'STATUS_END_PERIOD' ? 'BREAK' : 'LIVE';
  return 'NOT_STARTED';
}
function bkPeriodName(p) { return p <= 4 ? `${p}. çeyrek` : `Uzatma${p > 5 ? ` ${p - 4}` : ''}`; }
function bkLabel(st) {
  const p = st?.period || 0;
  const n = st?.type?.name;
  if (n === 'STATUS_HALFTIME') return 'Devre arası';
  if (n === 'STATUS_END_PERIOD') return `${bkPeriodName(p)} bitti`;
  if (st?.type?.state === 'in') return `${bkPeriodName(p)} ${st.displayClock || ''}`.trim();
  if (st?.type?.state === 'post') return p > 4 ? 'Uzatmada bitti' : 'Maç bitti';
  return '';
}
function bkConv(ev) {
  const c = ev.competitions?.[0] || {};
  const side = (s) => c.competitors?.find((x) => x.homeAway === s) || {};
  const h = side('home');
  const a = side('away');
  const status = bkStatus(ev.status);
  const started = status !== 'NOT_STARTED' && status !== 'POSTPONED' && status !== 'CANCELLED';
  const odds = c.odds?.[0];
  return {
    id: `b${ev.id}`, sport: 'basketball', league: 'NBA',
    home: h.team?.displayName || '', away: a.team?.displayName || '',
    homeLogo: h.team?.logo || '', awayLogo: a.team?.logo || '',
    homeTid: h.team?.id ?? null, awayTid: a.team?.id ?? null,
    start: ev.date ? Math.round(Date.parse(ev.date) / 1000) : null,
    status, label: bkLabel(ev.status), minute: null, added: null,
    hs: started && h.score != null ? Number(h.score) : null,
    as: started && a.score != null ? Number(a.score) : null,
    period: ev.status?.period || 0, clock: ev.status?.displayClock || '',
    quarters: (h.linescores || []).map((l, i) => [l.value ?? null, a.linescores?.[i]?.value ?? null]),
    ou: odds?.overUnder ?? null, spread: odds?.details || '',
  };
}
async function bkGet(date) {
  const res = await fetch(`${BK_API}scoreboard?dates=${date}`, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`basketbol ${res.status}`);
  return (await res.json())?.events || [];
}
// skPoll içinden çağrılır (aynı kilitle; skEvents'e aynı anda iki yazan olmasın). Değişiklik varsa true.
async function bkPoll(events, meta, now) {
  let changed = false;
  try {
    if (now - (meta.bkListAt || 0) > 30 * 60 * 1000) {
      for (const [k, e] of Object.entries(events)) if (e.sport === 'basketball' && (!e.start || now / 1000 - e.start > 7 * 86400)) delete events[k];
      const oldDue = now - (meta.bkOldAt || 0) > 24 * 3600 * 1000;
      for (const d of oldDue ? [-3, -2, -1, 0, 1] : [-1, 0, 1]) for (const ev of await bkGet(bkDate(now + d * 864e5))) events[`b${ev.id}`] = bkConv(ev);
      if (oldDue) meta.bkOldAt = now;
      meta.bkListAt = now;
      meta.bkLiveAt = now;
      changed = true;
    }
    const hot = Object.values(events).filter((e) => e.sport === 'basketball' && e.start
      && (SK_LIVE.has(e.status) || (e.status === 'NOT_STARTED' && e.start * 1000 - now < 10 * 60 * 1000 && now - e.start * 1000 < 4 * 3600 * 1000)));
    if (hot.length && now - (meta.bkLiveAt || 0) > 10 * 1000) {
      for (const d of new Set(hot.map((e) => bkDate(e.start * 1000)))) for (const ev of await bkGet(d)) events[`b${ev.id}`] = bkConv(ev);
      meta.bkLiveAt = now;
      changed = true;
    }
    if (meta.bkError) { meta.bkError = null; changed = true; }
  } catch (err) {
    meta.bkError = String(err?.message || err);
    changed = true;
  }
  return changed;
}

// Maç ayrıntısı ("Göz at"): skor tablosu, sayı akışı, takım istatistikleri, oyuncular, puan durumu, sezon serisi.
function bkSummary(j, id) {
  const comp = j.header?.competitions?.[0] || {};
  const st = comp.status || {};
  const side = (s) => comp.competitors?.find((x) => x.homeAway === s) || {};
  const team = (c) => ({
    id: c.team?.id ?? null, name: c.team?.displayName || '', shortCode: c.team?.abbreviation || '',
    logoUrl: c.team?.logos?.find((l) => l.rel?.includes('default'))?.href || c.team?.logos?.[0]?.href || c.team?.logo || '',
    record: c.record?.find((r) => r.type === 'total')?.summary || c.record?.[0]?.summary || '',
  });
  const h = side('home');
  const a = side('away');
  const status = bkStatus(st);
  const started = status !== 'NOT_STARTED';
  const fixture = {
    id: `b${id}`, sport: 'basketball', status, stateLabel: bkLabel(st) || (comp.date ? '' : ''), minute: null,
    home: team(h), away: team(a), kickoffAt: comp.date || null, period: st.period || 0, clock: st.displayClock || '',
    score: started ? { home: Number(h.score ?? 0), away: Number(a.score ?? 0) } : null,
    quarters: (h.linescores || []).map((l, i) => [Number(l.displayValue ?? l.value ?? 0), Number(a.linescores?.[i]?.displayValue ?? a.linescores?.[i]?.value ?? 0)]),
  };
  const plays = (j.plays || []).map((p) => ({
    period: p.period?.number || 0, clock: p.clock?.displayValue || '', text: p.text || '', type: p.type?.text || '',
    hs: p.homeScore ?? null, as: p.awayScore ?? null, teamId: p.team?.id ?? null, scoring: !!p.scoringPlay, value: p.scoreValue || 0,
  }));
  const teamStats = {};
  for (const t of j.boxscore?.teams || []) teamStats[t.team?.id] = Object.fromEntries((t.statistics || []).map((s) => [s.name, s.displayValue]));
  const players = (j.boxscore?.players || []).map((t) => {
    const s = t.statistics?.[0] || {};
    return {
      teamId: t.team?.id ?? null, labels: s.labels || [],
      athletes: (s.athletes || []).map((x) => ({ name: x.athlete?.displayName || '', short: x.athlete?.shortName || '', pos: x.athlete?.position?.abbreviation || '', jersey: x.athlete?.jersey || '', starter: !!x.starter, dnp: !!x.didNotPlay, reason: x.reason || '', stats: x.stats || [] })),
    };
  });
  const leaders = (j.leaders || []).map((t) => ({
    teamId: t.team?.id ?? null,
    list: (t.leaders || []).slice(0, 3).map((l) => ({ cat: l.name || l.displayName, value: l.leaders?.[0]?.displayValue || '', name: l.leaders?.[0]?.athlete?.displayName || '', photo: l.leaders?.[0]?.athlete?.headshot?.href || '' })),
  }));
  const standings = (j.standings?.groups || []).map((g) => ({
    title: (g.header || '').replace(/^\d{4}-\d{2}\s*/, '').replace(/\s*Standings$/, ''),
    rows: (g.standings?.entries || []).map((e) => {
      const s = Object.fromEntries((e.stats || []).map((x) => [x.name, x.displayValue]));
      return { id: e.id, team: e.team, abbr: (/\/name\/(\w+)\//.exec(e.link || '') || [])[1] || '', w: s.wins, l: s.losses, pct: s.winPercent, gb: s.gamesBehind, strk: s.streak };
    }),
  }));
  const series = (j.seasonseries || []).slice(0, 1).map((s) => ({
    summary: s.summary || '', score: s.seriesScore || '',
    events: (s.events || []).map((e) => ({
      date: e.date, done: e.statusType?.completed || e.status === 'post',
      teams: (e.competitors || []).map((c) => ({ homeAway: c.homeAway, id: c.team?.id, name: c.team?.displayName || '', logo: c.team?.logo || '', score: c.score ?? '', winner: !!c.winner })),
    })),
  }))[0] || null;
  const gi = j.gameInfo || {};
  const pick = j.pickcenter?.[0] || null;
  const wp = (j.winprobability || []).slice(-1)[0];
  return {
    sport: 'basketball', live: SK_LIVE.has(status),
    detail: { fixture, events: [], statistics: [], lineups: [], trends: [] },
    plays, teamStats, players, leaders, standings, series,
    info: {
      venue: [gi.venue?.fullName, gi.venue?.address?.city].filter(Boolean).join(', '), attendance: gi.attendance || null,
      officials: (gi.officials || []).map((o) => o.displayName).filter(Boolean),
      tv: [...new Set((j.broadcasts || []).map((b) => b.media?.shortName || b.station || '').filter(Boolean))].slice(0, 3),
      line: pick ? { ou: pick.overUnder ?? null, details: pick.details || '' } : null,
      homeWin: wp && SK_LIVE.has(status) ? Math.round(wp.homeWinPercentage * 100) : null,
    },
  };
}
async function bkDetail(id) {
  const key = `b${id}`;
  const now = Date.now();
  const c = skDetailCache.get(key) || {};
  if (!c.d || now - c.at > (c.d.live ? 10 * 1000 : 5 * 60 * 1000)) {
    const res = await fetch(`${BK_API}summary?event=${id}`, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`basketbol ${res.status}`);
    c.d = bkSummary(await res.json(), id);
    c.at = now;
  }
  skDetailCache.set(key, c);
  if (skDetailCache.size > 60) skDetailCache.delete(skDetailCache.keys().next().value);
  return c.d;
}
