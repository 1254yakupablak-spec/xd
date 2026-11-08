// Stake sekmesinde çalışır. Stake'in kendi sitesinin aldığı GraphQL yanıtlarını (feed-hook.js iletir)
// okuyup futbol maçlarını ve Toplam Gol Alt/Üst oranlarını chrome.storage'a yazar. Kendisi Stake'e
// istek atmaz; sayfada ne kadar maç yüklenirse o kadarı bilinir. Eşleştirmeyi ve kâr hesabını özel
// oranlar sayfasındaki content.js yapar.
(() => {
  if (window.top !== window || window.__kcsStake) return;
  if (!/(^|\.)stake[\w-]*\./i.test(location.hostname)) return;
  window.__kcsStake = true;

  const SAVE_EVERY_MS = 5000;
  const KEEP_MS = 2 * 24 * 3600 * 1000;
  // Maçın tamamı ve takımlar için "Toplam" pazarları; devre, korner vb. değil.
  const FAKE_MATCH = /\b(srl|simulated|simulation|esports?|e-?football|cyber|virtual)\b/i;
  const TOTAL_MARKET = /^\s*(total|totals|total goals|toplam|toplam gol|over\/under|alt\/üst)\s*$/i;

  let events = {};
  let odds = {};
  let captured = 0;
  let dirty = false;
  const ops = new Map();

  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  // Takımlar: tam ad ("Newcastle United FC") ve kısa ad ("Newcastle").
  function competitorsOf(node) {
    const list = node?.data?.competitors || node?.competitors;
    if (!Array.isArray(list) || list.length < 2) return null;
    const teams = list.map((c) => ({ name: str(c?.name) || str(c), short: str(c?.defaultName) || '' })).filter((t) => t.name);
    return teams.length >= 2 ? teams : null;
  }

  function startOf(node) {
    let s = node?.data?.startTime ?? node?.startTime ?? node?.data?.startDate ?? null;
    if (typeof s === 'string') s = Date.parse(s);
    if (typeof s === 'number' && s > 1e11) s /= 1000;
    return typeof s === 'number' && !Number.isNaN(s) ? s : null;
  }

  // table: 'lines' maçın toplamı, 'home' / 'away' takım toplamı.
  function addOutcome(id, line, side, price, table = 'lines') {
    if (!line || !side || typeof price !== 'number') return;
    const rec = (odds[id] = odds[id] || { lines: {} });
    const key = String(line);
    rec[table] = rec[table] || {};
    rec[table][key] = rec[table][key] || {};
    rec[table][key][side] = price;
    rec.at = Date.now();
  }

  // Betradar pazar kodları (dilden bağımsız): 18 maçın toplamı, 19 ev sahibi toplamı, 20 deplasman toplamı.
  // Kod yoksa addan: "Toplam" maçın toplamı; "<takım adı> toplam" / "Home total" takım toplamı.
  function marketTable(node, teams) {
    const ext = String(node.extId ?? node.templateExtId ?? '');
    if (ext === '18') return 'lines';
    if (ext === '19') return 'home';
    if (ext === '20') return 'away';
    if (ext === '29') return 'btts';
    const name = String(node.name || '');
    if (TOTAL_MARKET.test(name)) return 'lines';
    // Karşılıklı gol (maçın tamamı): "Both teams to score", "Karşılıklı Gol".
    if (/both teams to score|karşılıklı gol|karsilikli gol|btts/i.test(name)) return /half|yarı|devre|&|and|ve /i.test(name) ? null : 'btts';
    if (!/total|toplam/i.test(name) || /half|yarı|corner|korner|card|kart|exact/i.test(name)) return null;
    const n = name.toLowerCase();
    if (/home|ev sahibi/.test(n) || (teams?.[0] && n.includes(teams[0].name.toLowerCase()))) return 'home';
    if (/away|deplasman/.test(n) || (teams?.[1] && n.includes(teams[1].name.toLowerCase()))) return 'away';
    return null;
  }

  // Maçın altındaki "Toplam" ve takım toplamı pazarlarını bulur.
  function collectMarkets(id, node, depth = 0, teams = null) {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const x of node) collectMarkets(id, x, depth + 1, teams); return; }
    if (Array.isArray(node.markets) && node.extId != null) {
      for (const m of node.markets) if (m && m.extId == null) m.templateExtId = node.extId;
    }
    const table = Array.isArray(node.outcomes) ? marketTable(node, teams) : null;
    if (table === 'btts') {
      for (const o of node.outcomes) {
        if (o?.active === false) continue;
        const name = String(o?.name || '').toLowerCase();
        const side = /^(yes|var|evet)\b/.test(name) ? 'yes' : (/^(no|yok|hayır|hayir)\b/.test(name) ? 'no' : null);
        const price = o?.odds ?? o?.price ?? o?.decimalOdds;
        if (!side || typeof price !== 'number') continue;
        const rec = (odds[id] = odds[id] || { lines: {} });
        rec.btts = { ...(rec.btts || {}), [side]: price };
        rec.at = Date.now();
      }
      return;
    }
    if (table) {
      const spec = String(node.specifiers || '').match(/total=([\d.]+)/)?.[1];
      for (const o of node.outcomes) {
        if (o?.active === false) continue;
        const name = String(o?.name || '');
        const line = spec || name.match(/([\d.]+)/)?.[1];
        const side = /over|üst|ust/i.test(name) ? 'over' : (/under|alt/i.test(name) ? 'under' : null);
        addOutcome(id, line, side, o?.odds ?? o?.price ?? o?.decimalOdds, table);
      }
      return;
    }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') collectMarkets(id, v, depth + 1, teams);
    }
  }

  // Maç sayfası: /sports/<spor>/<ülke>/<turnuva>/<maç> (örn. soccer/england/premier-league/47004920-newcastle-everton).
  function fixtureUrl(node) {
    const t = node.tournament;
    const parts = [t?.category?.sport?.slug, t?.category?.slug, t?.slug, node.slug];
    return parts.every(Boolean) ? `${location.origin}/tr/sports/${parts.join('/')}` : null;
  }

  // Adresten tanınan maçın gerçek kaydı geldi: oranlar gerçek numarada, karta bağlantı da ona taşınır.
  async function relink(slug, id) {
    delete events[slug];
    dirty = true;
    const { arbLinks = {} } = await chrome.storage.local.get('arbLinks');
    const mine = { ...(arbLinks.stake || {}) };
    let changed = false;
    for (const k in mine) if (mine[k] === slug) { mine[k] = id; changed = true; }
    if (changed) await chrome.storage.local.set({ arbLinks: { ...arbLinks, stake: mine } });
  }

  function absorb(node, depth = 0) {
    if (depth > 10 || !node || typeof node !== 'object') return 0;
    if (Array.isArray(node)) return node.reduce((n, x) => n + absorb(x, depth + 1), 0);
    const names = competitorsOf(node);
    if (names && node.id != null) {
      // Sadece gerçek futbol: FIFA/e-spor ayrı spor türünde; simülasyon (SRL) maçları adından elenir.
      const slug = node.tournament?.category?.sport?.slug;
      if ((slug && slug !== 'soccer') || FAKE_MATCH.test(`${node.name || ''} ${names.map((t) => t.name).join(' ')}`)) return 0;
      events[node.id] = {
        id: node.id, home: names[0].name, away: names[1].name, homeEng: names[0].short, awayEng: names[1].short,
        start: startOf(node), url: fixtureUrl(node), slug: node.slug, seenAt: Date.now(),
        league: [node.tournament?.category?.name, node.tournament?.name].filter(Boolean).join(' · '),
      };
      collectMarkets(node.id, node, 0, names);
      if (node.slug && events[node.slug]?.guess) relink(node.slug, node.id);
      return 1;
    }
    let n = 0;
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') n += absorb(v, depth + 1);
    }
    return n;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data?.__kcsFeed) return;
    const path = ev.data.url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const label = ev.data.op ? `${path}#${ev.data.op}` : path;
    const games = absorb(ev.data.data);
    const rec = ops.get(label) || { n: 0, games: 0 };
    rec.n++;
    rec.games += games;
    ops.delete(label);
    ops.set(label, rec);
    while (ops.size > 20) ops.delete(ops.keys().next().value);
    captured++;
    dirty = true;
  });

  async function save() {
    if (!dirty) {
      const { stakeMeta = {} } = await chrome.storage.local.get('stakeMeta');
      await chrome.storage.local.set({ stakeMeta: { ...stakeMeta, updatedAt: Date.now() } });
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
        stakeEvents: Object.values(events),
        stakeOdds: odds,
        stakeMeta: {
          updatedAt: now, events: Object.keys(events).length, captured,
          urls: [...ops].map(([l, r]) => `${l} ×${r.n} maç:${r.games}`),
          error: null,
        },
      });
    } catch (e) {
      dirty = true;
      const { stakeMeta = {} } = await chrome.storage.local.get('stakeMeta');
      await chrome.storage.local.set({ stakeMeta: { ...stakeMeta, updatedAt: now, error: `kaydedilemedi: ${e.message}` } }).catch(() => {});
    }
  }

  // ---------- etkin arama ----------
  // Stake'in futbol sayfası maçları ülke/lig sekmelerine böldüğü için hepsi kendiliğinden yüklenmez.
  // Özel Oranlar sayfası aranacak maçları bildirir (stakeWant); burada Stake'in kendi arama sorgusu
  // (sportFixtureQuery) "Total" grubuyla çağrılır, tek istekte maçın bütün Alt/Üst çizgileri gelir.
  // Bulunan maçlar 3 dakikada bir tazelenir; bulunamayanlar için sıradaki kelime denenir.

  const SEARCH_LOOP_MS = 20 * 1000;
  const PER_LOOP = 3;
  const REFRESH_MS = 3 * 60 * 1000;
  const RETRY_MS = 10 * 60 * 1000;
  // groups: "goals" (Stake'in "Goller" sekmesi): maçın toplamı (18), ev sahibi / deplasman toplamı (19 / 20)
  // ve karşılıklı gol (29) birlikte gelir. Grup adı tanınmazsa eski "Total" grubuyla (sadece 18) devam edilir.
  const SEARCH_QUERY = `query KcsFixtureSearch($query: String!, $limit: Int, $groups: [String!]!, $marketLimit: Int) {
    sportFixtureQuery(limit: $limit, offset: 0, query: $query) {
      fixture { ... on SportFixture {
        id name slug status
        data { ... on SportFixtureDataMatch { startTime competitors { name defaultName } } }
        tournament { name slug category { name slug sport { slug } } }
        groups(groups: $groups, status: [active, suspended, deactivated]) {
          name
          templates(limit: 20, includeEmpty: false) {
            extId name
            markets(limit: $marketLimit) { name extId specifiers status outcomes { name odds active } }
          }
        }
      } }
    }
  }`;
  const tries = new Map(); // kart anahtarı → { i: kaçıncı kelime, at: son arama, term: bulduran kelime }

  let groupList = ['goals'];

  async function search(term) {
    try {
      return await searchWith(term, groupList);
    } catch (e) {
      if (groupList[0] === 'Total') throw e;
      groupList = ['Total'];
      return searchWith(term, groupList);
    }
  }

  async function searchWith(term, groups) {
    const res = await fetch('/_api/v1/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-language': document.documentElement.lang || 'tr' },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { query: term, limit: 10, groups, marketLimit: 30 } }),
    });
    if (!res.ok) throw new Error(`${res.status} arama`);
    const j = await res.json();
    if (j.errors?.length) throw new Error(j.errors[0].message);
    return j.data;
  }

  let searching = false;
  async function searchLoop() {
    if (searching) return;
    searching = true;
    try {
      const { stakeWant = [] } = await chrome.storage.local.get('stakeWant');
      const now = Date.now();
      const due = stakeWant.filter((w) => {
        const t = tries.get(w.key);
        if (!t || t.sig !== w.terms.join('|')) return true;
        if (w.found) return now - t.at > REFRESH_MS;
        return t.i < w.terms.length ? now - t.at > SEARCH_LOOP_MS : now - t.at > RETRY_MS;
      }).sort((a, b) => (tries.get(a.key)?.at || 0) - (tries.get(b.key)?.at || 0)).slice(0, PER_LOOP);
      for (const w of due) {
        let t = tries.get(w.key) || { i: 0, at: 0, term: null };
        // Kelime listesi değiştiyse (ör. maç 1xBet'te bulunup adları eklendi) baştan dene.
        const sig = w.terms.join('|');
        if (t.sig !== sig) t = { i: 0, at: 0, term: w.found ? t.term : null, sig };
        // Bulunmuş maçı bulduran kelimeyle tazele; bulunmamışsa sıradaki kelimeyi dene.
        const term = w.found && t.term ? t.term : w.terms[t.i % w.terms.length];
        if (!w.found && t.i >= w.terms.length) t.i = 0;
        try {
          const n = absorb(await search(term));
          ops.set(`arama: ${term}`, { n: 1, games: n });
          if (n) dirty = true;
        } catch (e) {
          console.debug('[kupon-skor/stake] arama', term, e.message);
        }
        tries.set(w.key, { i: w.found ? t.i : t.i + 1, at: Date.now(), term: w.found ? t.term : term, sig });
      }
      while (ops.size > 20) ops.delete(ops.keys().next().value);
    } finally {
      searching = false;
    }
  }

  // Eklenti yenilenince eski sekmedeki kod chrome.* çağıramaz: sessizce dur, sekme yenilenince yeni kod başlar.
  const safely = (fn) => () => { if (chrome.runtime?.id) Promise.resolve().then(fn).catch(() => {}); };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.stakeWant) searchLoop();
    // Sayfadaki "Yenile": bütün maçlar yeniden sorgulanır (hız sınırı aynı kalır).
    if (area === 'local' && changes.refreshReq) { tries.clear(); searchLoop(); }
  });

  chrome.storage.local.get(['stakeEvents', 'stakeOdds']).then((s) => {
    for (const e of s.stakeEvents || []) events[e.id] = e;
    odds = s.stakeOdds || {};
    safely(save)();
    setInterval(safely(save), SAVE_EVERY_MS);
    safely(searchLoop)();
    setInterval(safely(searchLoop), SEARCH_LOOP_MS);
  });

  // ---------- özel orandan "Stake'e git": maç sayfasında "bu maç mı?" çubuğu (bar.js) ----------
  // Maç sayfası: /sports/soccer/<ülke>/<turnuva>/<maç>; maç, adresindeki son parçadan bilinen maçlarda bulunur.
  // Maç bilinmiyorsa (asıl eksik maçlar bunlar) Stake'te adresteki adla bir kez aranır; yine gelmezse maç
  // adresten tanınır, böylece çubuk her maç sayfasında çıkar. Gerçek kayıt gelince bağlantı ona taşınır (relink).
  const GUESS_AFTER_MS = 5000;
  let pagePath = '';
  let pageAt = 0;

  function pageEvent() {
    const slug = location.pathname.match(/\/sports\/soccer\/[^/]+\/[^/]+\/([^/]+)\/?$/)?.[1];
    if (!slug) return { onMatch: false };
    const e = Object.values(events).find((v) => v.slug === slug || v.url?.endsWith(`/${slug}`));
    if (e) return { onMatch: true, e };
    if (location.pathname !== pagePath) {
      pagePath = location.pathname;
      pageAt = Date.now();
      const word = slug.replace(/^\d+-/, '').split('-').sort((a, b) => b.length - a.length)[0];
      if (word) search(word).then((d) => { if (absorb(d)) dirty = true; }).catch(() => {});
    }
    if (Date.now() - pageAt < GUESS_AFTER_MS) return { onMatch: true, e: null };
    events[slug] = window.__kcsBar.guessEvent(slug, slug);
    dirty = true;
    return { onMatch: true, e: events[slug] };
  }

  window.__kcsBar.watchPick({
    book: 'stake', name: 'Stake', pageEvent, oddsOf: (id) => odds[id],
    flush: async () => { dirty = true; await save(); },
  });
})();
