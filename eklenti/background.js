// Sadece güncelleme: GitHub'daki son sürüm numarasına bakar, menüden istenince güncelleme sayfasını açar.
// GitHub'ın dosya sunucusu 5 dk önbellekte tutar: adrese ?t= eklenir, hep son hali gelir.
const UPDATE_BASE = 'https://raw.githubusercontent.com/1254yakupablak-spec/xd/main/eklenti/';

async function checkUpdate(force = false) {
  const { updateInfo = {} } = await chrome.storage.local.get('updateInfo');
  if (!force && Date.now() - (updateInfo.checkedAt || 0) < 10 * 60 * 1000) return updateInfo;
  let latest = updateInfo.latest || null;
  try {
    const res = await fetch(UPDATE_BASE + 'manifest.json?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
    if (res.ok) latest = (await res.json())?.version || latest;
  } catch {
    // Bağlantı yok: eski bilgi kalır.
  }
  const info = { latest, checkedAt: Date.now() };
  await chrome.storage.local.set({ updateInfo: info });
  return info;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'openUpdate') chrome.tabs.create({ url: chrome.runtime.getURL('update.html') });
  if (msg?.type === 'checkUpdate') {
    checkUpdate(!!msg.force).then(reply, () => reply(null));
    return true;
  }
  return false;
});

chrome.runtime.onStartup?.addListener(() => checkUpdate(true));
chrome.runtime.onInstalled.addListener(async () => {
  // Eski sürümlerin kayıtları (canlı skor, oranlar, notlar) artık kullanılmıyor.
  // 1xBet verisi, adresi ve kupon verisi korunur.
  const KEEP = ['updateInfo', 'xbetHost', 'xbetEvents', 'xbetOdds', 'xbetMeta', 'kkData'];
  const keep = await chrome.storage.local.get(KEEP);
  await chrome.storage.local.clear();
  await chrome.storage.local.set(keep);
  checkUpdate(true);
});

// ---------- form: veri servisinden maç listesi ve takımların son 5 maçı ----------
// Kupon sayfası ister; servis tarayıcı eklentisinin arka planından sorulur (sayfanın kendisi soramaz).
const FORM_API = 'https://site.web.api.espn.com/apis/site/v2/sports/soccer/all/';
const formCache = new Map(); // adres → { at, v }
async function cachedJson(url, ttl) {
  const hit = formCache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const res = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`veri servisi ${res.status}`);
  const v = await res.json();
  formCache.set(url, { at: Date.now(), v });
  if (formCache.size > 400) formCache.delete(formCache.keys().next().value);
  return v;
}
const etDate = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)).replace(/-/g, '');

async function formEvents(days) {
  const out = [];
  const seen = new Set();
  for (let d = -1; d <= days; d++) {
    const sb = await cachedJson(`${FORM_API}scoreboard?dates=${etDate(Date.now() + d * 864e5)}&limit=1000`, 30 * 60 * 1000);
    for (const ev of sb?.events || []) {
      if (seen.has(ev.id) || ev.status?.type?.state !== 'pre') continue;
      seen.add(ev.id);
      const c = ev.competitions?.[0] || {};
      const side = (s) => c.competitors?.find((x) => x.homeAway === s)?.team || {};
      // Kadın ve genç takımlar A takımıyla aynı adla gelebiliyor: ligden ek konur.
      const tagText = `${ev.season?.slug || ''} ${c.league?.slug || ''} ${c.altGameNote || ''}`.replace(/-/g, ' ');
      const age = /\bu ?(17|19|20|21|23)\b/i.exec(tagText);
      const suffix = /wom[ae]n|femin|frauen|nwsl/i.test(tagText) ? ' Women' : age ? ` U${age[1]}` : '';
      const home = side('home').displayName;
      const away = side('away').displayName;
      if (!home || !away) continue;
      out.push({ id: String(ev.id), home: home + (/\bU\d\d\b|Women/.test(home) ? '' : suffix), away: away + (/\bU\d\d\b|Women/.test(away) ? '' : suffix), start: Math.round(Date.parse(ev.date) / 1000) });
    }
  }
  return out;
}

async function formOf(id) {
  const s = await cachedJson(`${FORM_API}summary?event=${encodeURIComponent(id)}`, 6 * 3600 * 1000);
  const teams = (s?.lastFiveGames || []).map((t) => ({
    team: t.team?.displayName || '',
    games: (t.events || []).map((g) => {
      const home = String(g.homeTeamId) === String(t.team?.id);
      const hs = Number(g.homeTeamScore);
      const as = Number(g.awayTeamScore);
      return Number.isFinite(hs) && Number.isFinite(as) ? { gf: home ? hs : as, ga: home ? as : hs, res: g.gameResult || '' } : null;
    }).filter(Boolean),
  }));
  return teams;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'formEvents') {
    formEvents(Math.min(3, Number(msg.days) || 2)).then((v) => reply({ ok: true, v }), (e) => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === 'formOf') {
    formOf(String(msg.id)).then((v) => reply({ ok: true, v }), (e) => reply({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  return false;
});

// Eklenti kurulunca/güncellenince açık 1xBet sekmelerindeki okuyucu ölür (sayfaya baştan eklenmesi gerekir):
// o sekmeler bir kez yenilenir. Ayna adres (xbetHost) seçildiyse onun sekmeleri de.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { xbetHost } = await chrome.storage.local.get('xbetHost');
    const urls = ['https://1xbet.com/*', 'https://*.1xbet.com/*'];
    if (xbetHost) urls.push(`https://${xbetHost}/*`, `https://*.${xbetHost}/*`);
    const tabs = await chrome.tabs.query({ url: urls }).catch(() => []);
    for (const t of tabs) chrome.tabs.reload(t.id).catch(() => {});
  } catch {
    // Sekmelere erişilemedi: kullanıcı kendisi yeniler.
  }
});
