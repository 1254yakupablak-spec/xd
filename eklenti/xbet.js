// 1xBet sekmesinde çalışır. 1xBet'in kendi sitesinin aldığı maç listesi ve maç oranı yanıtlarını
// (xbet-hook.js iletir) okuyup maçları ve Toplam Gol Alt/Üst oranlarını chrome.storage'a yazar.
// Kendisi 1xBet'e istek atmaz; ne kadar maç görünürse o kadarı bilinir. Eşleştirmeyi ve kâr
// hesabını özel oranlar sayfasındaki content.js yapar.
(async () => {
  if (window.top !== window || window.__kcsXbet) return;
  // 1xBet'in ayna adresleri: adında "1xbet" geçenler ya da menüden seçilen adres (xbetHost).
  const host = location.hostname;
  const known = /(^|\.)1xbet[\w-]*\./i.test(host);
  let chosen = false;
  if (!known) {
    try {
      const { xbetHost } = await chrome.storage.local.get('xbetHost');
      chosen = !!xbetHost && (host === xbetHost || host.endsWith(`.${xbetHost}`));
    } catch { /* eklenti yenilendi */ }
    // feed-hook.js sonraki açılışlarda hemen başlasın diye bu sitede işaret bırak (ya da kaldır).
    try {
      if (chosen) localStorage.setItem('kcsFeedHook', '1');
      else if (localStorage.getItem('kcsFeedHook')) localStorage.removeItem('kcsFeedHook');
    } catch { /* erişim yok */ }
    if (!chosen) return;
  }
  if (window.__kcsXbet) return;
  window.__kcsXbet = true;
  // Seçilen adreste yakalayıcı henüz başlamamış olabilir (ilk açılış): başlat.
  if (chosen) window.postMessage({ __kcsHookOn: true }, location.origin);

  const SAVE_EVERY_MS = 5000;
  const KEEP_MS = 2 * 24 * 3600 * 1000;
  const TOTALS_GROUP = 17; // 1xBet: "Toplam" pazarı
  const OVER = 9;
  const UNDER = 10;

  let events = {};
  let odds = {};
  let captured = 0;
  let lastUrl = '';
  let dirty = false;

  // Takım toplamları (1xBet "Bireysel Toplam"): ev sahibi 11 Üst / 12 Alt, deplasman 13 Üst / 14 Alt.
  // Bu kodlar 1xBet'te sadece bu pazarlarda kullanılıyor; grup numarasına (15 / 62) bakmaya gerek yok.
  const TEAM_TYPES = { 11: ['home', 'over'], 12: ['home', 'under'], 13: ['away', 'over'], 14: ['away', 'under'] };
  // Karşılıklı gol ("Her iki takım da gol atar"): 180 Var, 181 Yok; çizgisi (P) yok.
  const BTTS_TYPES = { 180: 'yes', 181: 'no' };
  const isWanted = (t) => t === OVER || t === UNDER || TEAM_TYPES[t] != null || BTTS_TYPES[t] != null;

  // Bir maçın oran listesinden Toplam ve takım Toplam Alt/Üst çizgilerini çıkarır (liste ve detay biçimleri).
  // odds[id] = { lines: { "2.5": { over, under } }, home: { "1.5": {...} }, away: { "0.5": {...} },
  //   btts: { yes, no } }.
  function addTotals(id, list) {
    for (const o of list || []) {
      if (!o?.C) continue;
      if (BTTS_TYPES[o.T]) {
        const rec = (odds[id] = odds[id] || { lines: {} });
        rec.btts = { ...(rec.btts || {}), [BTTS_TYPES[o.T]]: o.C };
        rec.at = Date.now();
        continue;
      }
      if (o.P == null) continue;
      let table;
      let side;
      if (o.G === TOTALS_GROUP && (o.T === OVER || o.T === UNDER)) {
        table = 'lines';
        side = o.T === OVER ? 'over' : 'under';
      } else if (TEAM_TYPES[o.T]) {
        [table, side] = TEAM_TYPES[o.T];
      } else {
        continue;
      }
      const rec = (odds[id] = odds[id] || { lines: {} });
      const key = String(o.P);
      rec[table] = rec[table] || {};
      rec[table][key] = rec[table][key] || {};
      rec[table][key][side] = o.C;
      rec.at = Date.now();
    }
  }

  // Maç nesnesi: 1xBet'in eski (I/O1/O2/S) ve olası yeni alan adları.
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // Yeni biçimde takım: { fullName: "Villarreal CF", fullNameEng: "Villarreal", opps: [{ name }] }.
  const nameOf = (v) => str(v) || str(v?.fullName) || str(v?.name) || str(v?.opps?.[0]?.name) || str(v?.title) || str(v?.N);
  const engOf = (v) => str(v?.fullNameEng) || '';

  // Başlama zamanı: bilinen adlar, yoksa adında start/date/time geçen saniye ya da ms değeri.
  function startOf(o) {
    for (const src of [o, o.matchInfo]) {
      if (!src || typeof src !== 'object') continue;
      for (const k of ['S', 'startDate', 'start', 'dateStart', 'startTime', 'date']) {
        if (src[k] != null) return src[k];
      }
      for (const k in src) {
        if (/start|date|time/i.test(k) && typeof src[k] === 'number' && src[k] > 1e9) return src[k];
      }
    }
    return null;
  }

  function asGame(o) {
    // Eski biçim O1/O2; yeni main-line-feed biçimi opponent1/opponent2.
    const home = str(o.O1) || nameOf(o.opponent1) || nameOf(o.opp1) || nameOf(o.team1) || nameOf(o.homeTeam);
    const away = str(o.O2) || nameOf(o.opponent2) || nameOf(o.opp2) || nameOf(o.team2) || nameOf(o.awayTeam);
    if (!home || !away || home === away) return null;
    let start = startOf(o);
    if (typeof start === 'string') start = Date.parse(start) / 1000;
    if (start > 1e11) start /= 1000;
    // Kimlik alanı bulunamazsa takım adları ve saatten bir anahtar üret.
    const id = o.I ?? o.id ?? o.gameId ?? o.constId ?? o.matchInfo?.id ?? o.matchInfo?.gameId ?? `${home}|${away}|${start || ''}`;
    return {
      id, home, away, start,
      homeEng: engOf(o.opponent1), awayEng: engOf(o.opponent2),
      league: str(o.L) || nameOf(o.liga) || nameOf(o.league) || '',
    };
  }

  // Yeni biçimde oranlar eventGroups / events içinde:
  // { groupId: 17, type: 9 (Üst) | 10 (Alt), parameter: 2.5, cf: 1.98 }.
  function addTotalsDeep(id, node, group = null, depth = 0) {
    if (depth > 9 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) addTotalsDeep(id, x, group, depth + 1); return; }
    const g = node.groupId ?? node.G ?? node.group ?? group;
    const t = node.type ?? node.T;
    const p = node.parameter ?? node.param ?? node.P;
    const c = node.cf ?? node.coef ?? node.C;
    if (typeof c === 'number' && isWanted(t) && (p != null || BTTS_TYPES[t])) addTotals(id, [{ G: g, T: t, P: p, C: c }]);
    for (const k in node) {
      const v = node[k];
      // Alt oyunlar (1. yarı, korner) maç sonu oranı değil.
      if (v && typeof v === 'object' && !/^(sg|subgames?)$/i.test(k)) addTotalsDeep(id, v, g, depth + 1);
    }
  }

  // Yanıtın içindeki bütün maç nesnelerini bulur; kaç tane bulduğunu döndürür.
  function absorb(node, depth = 0) {
    if (depth > 8 || !node || typeof node !== 'object') return 0;
    if (Array.isArray(node)) return node.reduce((n, x) => n + absorb(x, depth + 1), 0);
    const g = asGame(node);
    let n = 0;
    if (g) {
      events[g.id] = { ...g, seenAt: Date.now() };
      addTotals(g.id, node.E);
      for (const ae of node.AE || []) addTotals(g.id, (ae.ME || []).map((o) => ({ G: ae.G, ...o })));
      for (const ge of node.GE || []) for (const col of ge.E || []) addTotals(g.id, (col || []).map((o) => ({ G: ge.G, ...o })));
      for (const k of ['eventGroups', 'centralBlockEventGroups', 'events']) if (node[k]) addTotalsDeep(g.id, node[k]);
      n = 1;
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object' && !(g && ['E', 'AE', 'GE', 'eventGroups', 'centralBlockEventGroups', 'events', 'opponent1', 'opponent2'].includes(k))) n += absorb(v, depth + 1);
    }
    return n;
  }

  function gameIdIn(url) {
    try {
      for (const [k, v] of new URL(url).searchParams) if (/^(id|gameid|eventid|game|i)$/i.test(k) && /^\d{5,}$/.test(v)) return v;
    } catch { /* adres değil */ }
    return null;
  }

  // Tanı: hangi adreslerden yanıt geldi, kaçında maç bulundu, kökteki alan adları.
  const urls = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data?.__kcsFeed) return;
    const path = ev.data.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const data = ev.data.data;
    const games = absorb(data);
    // Maç isteğinin yanıtında bazen sadece oranlar var (takım adı yok): numara adresten alınır. Yanıtta
    // maç nesnesi varsa zaten okundu; başka maçların oranı karışmasın diye bu yol kullanılmaz.
    if (!games && /game/i.test(path)) {
      const id = gameIdIn(ev.data.url);
      if (id) addTotalsDeep(id, data);
    }
    const root = data && typeof data === 'object' ? Object.keys(Array.isArray(data) ? data[0] || {} : data).slice(0, 8).join(',') : '';
    const rec = urls.get(path) || { n: 0, games: 0, keys: root };
    rec.n++;
    rec.games += games;
    urls.delete(path);
    urls.set(path, rec);
    while (urls.size > 20) urls.delete(urls.keys().next().value);
    captured++;
    if (games) lastUrl = path;
    dirty = true;
  });

  async function save() {
    if (!dirty) {
      // Veri gelmese de sekmenin açık olduğunu bildir.
      const { xbetMeta = {} } = await chrome.storage.local.get('xbetMeta');
      await chrome.storage.local.set({ xbetMeta: { ...xbetMeta, updatedAt: Date.now(), error: null } });
      return;
    }
    dirty = false;
    const now = Date.now();
    for (const id in events) {
      if (now - events[id].seenAt > KEEP_MS) { delete events[id]; delete odds[id]; }
    }
    // Kayıt başarısız olursa (ör. depolama dolu) veri kaybolmasın: sonra tekrar dene, hatayı menüde göster.
    try {
      await chrome.storage.local.set({
        xbetEvents: Object.values(events),
        xbetOdds: odds,
        xbetMeta: {
          updatedAt: now, error: null, events: Object.keys(events).length, captured, lastUrl, auto,
          urls: [...urls].map(([p, r]) => `${p} ×${r.n} maç:${r.games} [${r.keys}]`),
        },
      });
    } catch (e) {
      dirty = true;
      const { xbetMeta = {} } = await chrome.storage.local.get('xbetMeta');
      await chrome.storage.local.set({ xbetMeta: { ...xbetMeta, updatedAt: now, error: `kaydedilemedi: ${e.message}` } }).catch(() => {});
    }
  }

  // Eklenti yenilenince eski sekmedeki kod chrome.* çağıramaz: sessizce dur, sekme yenilenince yeni kod başlar.
  const safely = (fn) => () => { if (chrome.runtime?.id) Promise.resolve().then(fn).catch(() => {}); };

  chrome.storage.local.get(['xbetEvents', 'xbetOdds']).then((s) => {
    for (const e of s.xbetEvents || []) events[e.id] = e;
    odds = s.xbetOdds || {};
    safely(save)();
    setInterval(safely(save), SAVE_EVERY_MS);
  });

  // ---------- etkin arama ----------
  // 1xBet futbol listesi sadece öne çıkan ligleri yükler. Özel Oranlar sayfası aranacak maçları bildirir
  // (xbetWant); burada 1xBet'in kendi arama isteğiyle (kullanıcı bir kez arama yapınca feed-hook.js
  // kalıbını öğrenir) aranır. Bulunan ama oranı olmayan maçın oranları maç isteğiyle (bir maç sayfası
  // açılınca öğrenilir) çekilir. Stake'teki gibi yavaş: 20 sn'de en çok 2 istek.
  const SEARCH_LOOP_MS = 20 * 1000;
  const PER_LOOP = 4;
  const REFRESH_MS = 3 * 60 * 1000;
  const RETRY_MS = 10 * 60 * 1000;
  let auto = { search: false, game: false };
  const tries = new Map(); // kart anahtarı → { i, at, sig }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data?.__kcsTpl) return;
    const next = ev.data.__kcsTpl;
    if (next.search !== auto.search || next.game !== auto.game) { auto = next; dirty = true; searchLoop(); }
    auto = next;
  });
  window.postMessage({ __kcsRun: true }, location.origin); // yakalayıcı bildiklerini söylesin

  const run = (kind, value, live = false) => window.postMessage({ __kcsRun: { kind, value, live } }, location.origin);

  let searching = false;
  async function searchLoop() {
    if (searching || (!auto.search && !auto.game)) return;
    searching = true;
    try {
      const { xbetWant = [] } = await chrome.storage.local.get('xbetWant');
      const now = Date.now();
      let due = xbetWant.filter((w) => {
        const t = tries.get(w.key);
        if (!t || t.sig !== w.terms.join('|') + w.id) return true;
        if (w.found) return now - t.at > REFRESH_MS;
        if (w.id) return now - t.at > SEARCH_LOOP_MS * 3;
        return t.i < w.terms.length ? now - t.at > SEARCH_LOOP_MS : now - t.at > RETRY_MS;
      });
      // En uzun süredir bakılmayan önce: oranı bulunamayan maçlar sırayı kapıp diğerlerini eskitmesin.
      // Aynı maç (tek kart + çok maçlı kartın parçası) bir kez istenir.
      const age = (w) => tries.get(w.key)?.at || 0;
      const seen = new Set();
      due = due.sort((a, b) => age(a) - age(b)).filter((w) => {
        if (w.id == null) return true;
        if (seen.has(String(w.id))) return false;
        seen.add(String(w.id));
        return true;
      }).slice(0, PER_LOOP);
      for (const w of due) {
        const sig = w.terms.join('|') + w.id;
        let t = tries.get(w.key);
        if (!t || t.sig !== sig) t = { i: 0, at: 0, sig };
        if (w.id && auto.game && /^\d+$/.test(String(w.id))) {
          // Maç biliniyor: oranlarını maç isteğiyle getir (tazele).
          const start = events[w.id]?.start;
          run('game', w.id, !!start && start * 1000 < now);
        } else if (!w.id && auto.search && w.terms.length) {
          run('search', w.terms[t.i % w.terms.length]);
          t.i++;
        }
        tries.set(w.key, { ...t, at: Date.now() });
        if (w.id != null) {
          for (const x of xbetWant) {
            if (x !== w && String(x.id) === String(w.id)) tries.set(x.key, { i: 0, sig: x.terms.join('|') + x.id, at: Date.now() });
          }
        }
      }
    } finally {
      searching = false;
    }
  }
  setInterval(safely(searchLoop), SEARCH_LOOP_MS);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.xbetWant) searchLoop().catch(() => {});
    // Sayfadaki "Yenile": bütün maçlar yeniden sorgulanır (hız sınırı aynı kalır).
    if (area === 'local' && changes.refreshReq) { tries.clear(); searchLoop().catch(() => {}); }
  });

  // ---------- "Aç": maçı sitenin aramasıyla açma ----------
  // 1xBet'te maç numarasıyla kısa adres açılmıyor, ama numara arama kutusuna yazılınca maç çıkıyor. Özel oranlar
  // sayfası xbetOpen bırakır; burada numara arama kutusuna yazılır, çıkan maç linkine tıklanır. Kutu ya da maç
  // bulunamazsa üstteki çubukta numarayı kopyalama düğmesi çıkar.
  const OPEN_TTL_MS = 30 * 1000;
  const OPEN_WAIT_MS = 8000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

  function searchInput() {
    const sel = '.ui-search-default__input, input[type="search"], input[placeholder*="Ara" i], input[placeholder*="search" i], input[class*="search" i], [class*="search" i] input';
    return [...document.querySelectorAll(sel)].find(visible) || null;
  }

  // Arama kutusu kapalıysa açan düğme: adında ya da etiketinde "search"/"ara" geçen ilk görünür düğme.
  function searchOpener() {
    const sel = 'button[aria-label*="search" i], button[aria-label*="ara" i], button[class*="search" i], [class*="search" i][role="button"], a[class*="search" i], [class*="search" i] button';
    return [...document.querySelectorAll(sel)].find(visible) || null;
  }

  function typeInto(input, text) {
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Bazı arama kutuları sonucu Enter ile getirir.
    for (const type of ['keydown', 'keypress', 'keyup']) {
      input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }

  function openFailed(id, why) {
    bar.show([
      bar.text(`Maç ${bar.esc(id)} açılamadı (${bar.esc(why)}). Numarayı sitenin arama kutusuna yapıştır.`),
      bar.button('Numarayı kopyala', true, async () => {
        try { await navigator.clipboard.writeText(id); } catch { /* izin yok */ }
        bar.show([bar.text(`Kopyalandı: ${bar.esc(id)}. Arama kutusuna yapıştır.`), bar.button('Kapat', false, bar.close)]);
      }),
      bar.button('Kapat', false, bar.close),
    ]);
  }

  async function openById(id) {
    bar.show([bar.text(`Maç ${bar.esc(id)} aranıyor…`)]);
    let input = searchInput();
    if (!input) {
      searchOpener()?.click();
      await sleep(600);
      input = searchInput();
    }
    if (!input) { openFailed(id, 'arama kutusu bulunamadı'); return; }
    typeInto(input, id);
    const until = Date.now() + OPEN_WAIT_MS;
    while (Date.now() < until) {
      const link = [...document.querySelectorAll(`a[href*="${id}"]`)].find(visible);
      if (link) {
        link.click();
        bar.close();
        return;
      }
      await sleep(300);
    }
    openFailed(id, 'sonuç gelmedi');
  }

  async function checkOpen() {
    const { xbetOpen } = await chrome.storage.local.get('xbetOpen');
    if (!xbetOpen || Date.now() - xbetOpen.at > OPEN_TTL_MS) return;
    await chrome.storage.local.remove('xbetOpen');
    await openById(String(xbetOpen.id));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.xbetOpen?.newValue) checkOpen().catch(() => {});
  });
  // Sekme yeni açıldıysa istek çoktan yazılmıştır; sayfa yüklensin diye biraz bekle.
  setTimeout(() => checkOpen().catch(() => {}), 3000);

  // ---------- özel orandan "1xBet'e git": maç sayfasında "bu maç mı?" çubuğu (bar.js) ----------
  const bar = window.__kcsBar;
  const { slugify, guessEvent } = bar;

  // Maç sayfası: .../line/football/<lig>/<maç no>-<ev>-<deplasman>. Önce maç numarasıyla, olmazsa
  // adresteki takım adlarıyla bilinen maçlardan bul.
  // Maç listede hiç yoksa (asıl eksik maçlar bunlar) birkaç saniye verisi beklenir, gelmezse maç adresten
  // tanınır: böylece çubuk her maç sayfasında çıkar. Gerçek veri gelince bu kayıt kendiliğinden yenilenir.
  const GUESS_AFTER_MS = 4000;
  let pagePath = '';
  let pageAt = 0;

  function pageEvent() {
    const m = location.pathname.match(/\/football\/[^/]+\/(\d{5,})-([^/]+)\/?$/);
    if (!m) return { onMatch: false };
    const e = events[m[1]];
    if (e) return { onMatch: true, e };
    const slug = m[2];
    const found = Object.values(events).find((v) => slug === slugify(`${v.home} ${v.away}`)
      || (slug.includes(slugify(v.home)) && slug.includes(slugify(v.away))));
    if (found) return { onMatch: true, e: found };
    if (location.pathname !== pagePath) { pagePath = location.pathname; pageAt = Date.now(); }
    if (Date.now() - pageAt < GUESS_AFTER_MS) return { onMatch: true, e: null };
    events[m[1]] = guessEvent(m[1], slug);
    dirty = true;
    return { onMatch: true, e: events[m[1]] };
  }

  bar.watchPick({
    book: 'xbet', name: '1xBet', pageEvent, oddsOf: (id) => odds[id],
    flush: async () => { dirty = true; await save(); },
  });
})();
