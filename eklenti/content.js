// KOKLEYİCİ SPORTS · Goal Mix kupon oluşturucu (6q › Spor › Özel Oranlar).
//
// Goal Mix'te 2–5 maç seçilir, seçilen maçların 90 dakikadaki toplam golü için tek bir Alt/Üst oynanır.
// Eklenti:
//  1. Goal Mix listesindeki maçları sitenin normal spor bülteniyle eşleştirir (saat + takım adları).
//  2. Her maçın normal "Alt/Üst" oranlarından payı çıkarıp adil gol beklentisini (λ) bulur.
//  3. Goal Mix'in fiyat servisinden (sadece okuma, bahis yapmaz) sitenin aynı maç için varsaydığı gol
//     beklentisini çıkarır. İkisi arasındaki fark, Goal Mix fiyatının nerede adil orandan sapacağını gösterir.
//  4. Farkı en büyük maçlardan kombinasyonlar kurar, gerçek Goal Mix oranını sorar ve adil olasılıkla
//     karşılaştırır. En yüksek beklenen değerli kuponları gösterir.
// Toplam gol, maçların gol beklentilerinin toplamıyla Poisson dağılımı varsayılarak hesaplanır.
// Bahis yapmaz, siteye hiçbir şey göndermez; sadece sitenin herkese açık okuma adreslerini kullanır.
(() => {
  if (window.top !== window || window.__kkGoalMix) return;
  window.__kkGoalMix = true;

  const API = 'https://sb.6q.net/v1';
  const FOOTBALL = 6046;
  const OU_MARKET = 2; // sitenin "Under/Over" (maç sonu toplam gol) pazarı
  const PAGE_RE = /\/sportsbook\/goal-mix/;
  const COLLECT_HOURS = 48; // arka planda bu kadar saat içinde başlayacak bütün maçlar toplanır
  const MAX_EVENTS = 600;
  const DATA_KEY = 'kkData';
  const LOCK_KEY = 'kkLock';
  const DATA_FRESH = 10 * 60 * 1000; // arka plan toplama aralığı
  const SITE_FRESH = 60 * 60 * 1000; // Goal Mix'in maç başı gol beklentisi bu kadar süre geçerli sayılır
  const TOP_PICK = 10; // kombinasyonlar en iyi bu kadar maçtan kurulur
  const MAX_QUOTES = 36; // gerçek oranı sorulan kombinasyon sayısı

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = (t) => new Date(t).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' });
  const day = (t) => new Date(t).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit' });
  const f2 = (x) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(2));
  const pct = (x) => `${x >= 0 ? '+' : '−'}%${Math.abs(x * 100).toFixed(1)}`;

  async function getJ(path) {
    const res = await fetch(API + path, { credentials: 'omit' });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }

  async function pool(items, n, fn) {
    const q = items.map((x, i) => [x, i]);
    const out = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
      while (q.length) {
        const [x, i] = q.shift();
        try { out[i] = await fn(x); } catch { out[i] = null; }
      }
    }));
    return out;
  }

  // ---------- olasılık ----------
  // Poisson: P(X ≤ k).
  function cdf(k, lam) {
    if (k < 0) return 0;
    let t = Math.exp(-lam);
    let s = t;
    for (let i = 1; i <= k; i++) { t *= lam / i; s += t; }
    return Math.min(1, s);
  }
  // P(X ≤ k) = p olan λ (ikili arama).
  function lamFor(k, p) {
    let lo = 0.01;
    let hi = 40;
    for (let i = 0; i < 60; i++) {
      const m = (lo + hi) / 2;
      if (cdf(k, m) > p) lo = m; else hi = m;
    }
    return (lo + hi) / 2;
  }
  // Alt/Üst çizgilerinden gol beklentisi: her çizgide pay çıkarılır (oranlar orantılı), %50'ye yakın çizgiler
  // daha ağır sayılır. Yalnızca çeyrek olmayan (x.5) çizgiler kullanılır.
  function fitLambda(lines) {
    let w = 0;
    let s = 0;
    for (const { line, over, under } of lines) {
      if (!(over > 1) || !(under > 1) || Math.abs((line % 1) - 0.5) > 1e-6) continue;
      const po = 1 / over;
      const pu = 1 / under;
      const p = pu / (po + pu);
      if (p < 0.03 || p > 0.97) continue;
      const ww = Math.max(0.05, 1 - Math.abs(p - 0.5) * 2);
      s += lamFor(Math.floor(line), p) * ww;
      w += ww;
    }
    return w ? s / w : null;
  }

  // ---------- adlar ----------
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
  const STOP = new Set(['fc', 'cf', 'sc', 'ac', 'fk', 'sk', 'cd', 'club', 'de', 'the', 'and', 'afc', 'united', 'city']);
  const toks = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
  function sim(a, b) {
    const A = toks(a);
    const B = toks(b);
    if (!A.size || !B.size) return 0;
    let n = 0;
    for (const w of A) if (B.has(w) || [...B].some((v) => v.length >= 4 && w.length >= 4 && (v.startsWith(w) || w.startsWith(v)))) n++;
    return n / Math.min(A.size, B.size);
  }
  // Yaş grubu / yedek takım farkı eşleşmeyi bozmasın diye ayrıca bakılır.
  const tag = (s) => (norm(s).match(/\b(u\d\d|ii|b|women|w)\b/g) || []).sort().join(',');

  // ---------- veri ----------
  const cache = { gm: null, gmAt: 0, book: null, bookAt: 0, detail: new Map(), site: new Map() };
  const FRESH = 10 * 60 * 1000;

  async function loadGoalMix() {
    if (cache.gm && Date.now() - cache.gmAt < FRESH) return cache.gm;
    const all = [];
    for (let p = 1; p <= 30; p++) {
      const r = await getJ(`/goalmix/events?page=${p}&pageSize=100`);
      all.push(...(r.items || []));
      if (!r.items?.length || all.length >= (r.total || 0)) break;
    }
    cache.gm = all;
    cache.gmAt = Date.now();
    return all;
  }

  async function loadBook() {
    if (cache.book && Date.now() - cache.bookAt < FRESH) return cache.book;
    const leagues = (await getJ(`/sports/${FOOTBALL}/leagues`)).data || [];
    const lists = await pool(leagues, 8, async (l) => (await getJ(`/leagues/${l.id}/events?status=upcoming`)).data || []);
    cache.book = lists.flat().filter(Boolean);
    cache.bookAt = Date.now();
    return cache.book;
  }

  function pairUp(gm, book) {
    const byTime = new Map();
    for (const e of book) {
      const k = Math.round(Date.parse(e.startTime) / 60000);
      for (let d = -5; d <= 5; d++) {
        const kk = k + d;
        if (!byTime.has(kk)) byTime.set(kk, []);
        byTime.get(kk).push(e);
      }
    }
    const out = [];
    for (const g of gm) {
      const cands = byTime.get(Math.round(Date.parse(g.startsAt) / 60000)) || [];
      let best = null;
      for (const e of cands) {
        if (tag(g.home) !== tag(e.homeTeam) || tag(g.away) !== tag(e.awayTeam)) continue;
        const h = sim(g.home, e.homeTeam);
        const a = sim(g.away, e.awayTeam);
        const s = h + a;
        if ((h >= 0.5 && a >= 0.5) || (s >= 0.5 && cands.length === 1)) {
          if (!best || s > best.s) best = { e, s };
        }
      }
      if (best) out.push({ g, e: best.e });
    }
    return out;
  }

  async function fairOf(bookId) {
    const hit = cache.detail.get(bookId);
    if (hit && Date.now() - hit.at < 20 * 60 * 1000) return hit.v; // maç oranları 20 dk geçerli
    const d = await getJ(`/events/${bookId}`);
    const m = (d.markets || []).find((x) => x.marketTypeId === OU_MARKET && x.status === 'OPEN');
    const by = {};
    for (const o of m?.outcomes || []) {
      if (!o.active) continue;
      const k = String(o.line);
      by[k] = by[k] || { line: Number(o.line) };
      if (/^over$/i.test(o.name)) by[k].over = Number(o.price);
      if (/^under$/i.test(o.name)) by[k].under = Number(o.price);
    }
    const lines = Object.values(by);
    const lam = fitLambda(lines);
    const near = lines.filter((x) => x.over && x.under).sort((a, b) => Math.abs(a.over - a.under) - Math.abs(b.over - b.under))[0] || null;
    const v = lam ? { lam, near } : null;
    cache.detail.set(bookId, { v, at: Date.now() });
    return v;
  }

  async function quote(ids) {
    const r = await getJ(`/goalmix/quote?events=${encodeURIComponent([...ids].sort().join(','))}`);
    if (r.refused || (r.events || []).some((x) => x.available === false)) return null;
    const lines = (r.lines || []).map((l) => ({ line: Number(l.line), over: l.over == null ? null : Number(l.over), under: l.under == null ? null : Number(l.under) }));
    return { lines, lam: fitLambda(lines) };
  }

  // Sitenin Goal Mix'te her maç için varsaydığı gol beklentisi: üç maçlık bir üçgenden referans maçın
  // beklentisi bulunur, sonra her maç referansla birlikte sorulur (λ toplanır).
  async function siteLambdas(items, onStep) {
    const has = (id) => { const h = cache.site.get(id); return !!h && Date.now() - h.at < SITE_FRESH; };
    const put = (id, v) => cache.site.set(id, { v, at: Date.now() });
    const need = items.filter((x) => !has(x.g.id));
    if (need.length) {
      const pool3 = items.slice(0, 3);
      if (pool3.length < 3) return;
      const [a, b, c] = pool3;
      const [ab, ac, bc] = await Promise.all([quote([a.g.id, b.g.id]), quote([a.g.id, c.g.id]), quote([b.g.id, c.g.id])]);
      if (!ab?.lam || !ac?.lam || !bc?.lam) throw new Error('Goal Mix fiyatı alınamadı');
      const la = (ab.lam + ac.lam - bc.lam) / 2;
      put(a.g.id, la);
      put(b.g.id, ab.lam - la);
      put(c.g.id, ac.lam - la);
      const rest = items.filter((x) => !has(x.g.id));
      let done = 0;
      await pool(rest, 4, async (x) => {
        const q = await quote([a.g.id, x.g.id]);
        if (q?.lam) put(x.g.id, q.lam - la);
        onStep(++done, rest.length);
      });
    }
    for (const x of items) x.site = cache.site.get(x.g.id)?.v ?? null;
  }

  function* combos(arr, k, start = 0, pre = []) {
    if (pre.length === k) { yield pre; return; }
    for (let i = start; i <= arr.length - (k - pre.length); i++) yield* combos(arr, k, i + 1, [...pre, arr[i]]);
  }

  // Sıralama puanı. Olasılık modunda değeri eksi olmayan kuponlar önce gelir, aralarında tutma olasılığı
  // yüksek olan öne geçer; değeri eksi olanlar en sona (kendi değerlerine göre) kalır.
  const score = (p, ev, sort) => (sort === 'EV' ? ev : ev >= 0 ? 1 + p : ev);

  // Bir kombinasyonun her çizgisi için değer: adil olasılık × sitenin oranı − 1.
  function bestLine(lines, lamFair, sides, minOdds, maxOdds, sort) {
    let best = null;
    for (const l of lines) {
      const pu = cdf(Math.floor(l.line), lamFair);
      for (const side of sides) {
        const odds = side === 'OVER' ? l.over : l.under;
        if (!(odds >= minOdds) || odds > maxOdds) continue;
        const p = side === 'OVER' ? 1 - pu : pu;
        const ev = p * odds - 1;
        const sc = score(p, ev, sort);
        if (!best || sc > best.sc) best = { line: l.line, side, odds, p, fair: 1 / p, ev, sc };
      }
    }
    return best;
  }

  // ---------- arka planda toplama ----------
  // 6q'nun herhangi bir sayfası açıkken 10 dakikada bir, önümüzdeki 48 saatteki bütün Goal Mix maçlarının adil
  // gol beklentisi (normal Alt/Üst oranlarından) ve Goal Mix'in varsaydığı gol beklentisi hesaplanıp eklentinin
  // deposuna yazılır. Birden çok 6q sekmesi açıksa sadece biri toplar (kilit). Kupon penceresi bu veriden
  // anında filtreler; sadece seçilen kombinasyonların gerçek oranı o an sorulur.
  const store = {
    get: (k) => new Promise((r) => { try { chrome.storage.local.get(k, (x) => r(x?.[k] ?? null)); } catch { r(null); } }),
    set: (k, v) => new Promise((r) => { try { chrome.storage.local.set({ [k]: v }, () => r()); } catch { r(); } }),
  };
  let data = null;
  let collecting = null;

  // Kayıttaki değerler belleğe alınır: sayfa yenilense de aynı maçlar baştan sorulmaz.
  function seed(d) {
    for (const e of d?.events || []) {
      if (e.siteAt && !cache.site.has(e.id)) cache.site.set(e.id, { v: e.site, at: e.siteAt });
      if (e.lamAt && !cache.detail.has(e.bookId)) cache.detail.set(e.bookId, { v: { lam: e.lam }, at: e.lamAt });
    }
  }

  async function collect(say = () => {}) {
    const now = Date.now();
    say('Goal Mix maç listesi alınıyor…');
    const gm = (await loadGoalMix()).filter((g) => {
      const t = Date.parse(g.startsAt);
      return t > now + 3 * 60 * 1000 && t < now + COLLECT_HOURS * 3600 * 1000;
    });
    say(`${gm.length} maç. Sitenin bülteni alınıyor…`);
    const pairs = pairUp(gm, await loadBook())
      .sort((a, b) => Date.parse(a.g.startsAt) - Date.parse(b.g.startsAt))
      .slice(0, MAX_EVENTS);
    let n = 0;
    await pool(pairs, 6, async (x) => {
      x.fair = await fairOf(x.e.id);
      say(`Maç oranları okunuyor… ${++n}/${pairs.length}`);
    });
    const priced = pairs.filter((x) => x.fair?.lam);
    if (priced.length >= 3) await siteLambdas(priced, (i, t) => say(`Goal Mix fiyatları okunuyor… ${i}/${t}`));
    const events = priced.filter((x) => x.site != null && x.site > 0.2).map((x) => ({
      id: x.g.id,
      bookId: x.e.id,
      home: x.g.home,
      away: x.g.away,
      league: x.g.league?.name || '',
      startsAt: x.g.startsAt,
      lam: x.fair.lam,
      lamAt: cache.detail.get(x.e.id)?.at || now,
      site: x.site,
      siteAt: cache.site.get(x.g.id)?.at || now,
    }));
    data = { at: Date.now(), total: gm.length, matched: pairs.length, events };
    await store.set(DATA_KEY, data);
    return data;
  }

  // Tek seferde bir toplama; force değilse veri tazeyse ya da başka sekme topluyorsa beklenmez.
  async function ensureData(force, say) {
    if (collecting) return collecting;
    if (!data) { data = await store.get(DATA_KEY); seed(data); }
    if (!force && data && Date.now() - data.at < DATA_FRESH) return data;
    collecting = (async () => {
      await store.set(LOCK_KEY, Date.now());
      try { return await collect(say); } finally { collecting = null; }
    })();
    return collecting;
  }

  async function backgroundTick() {
    try {
      if (collecting) return;
      data = (await store.get(DATA_KEY)) || data;
      seed(data);
      if (data && Date.now() - data.at < DATA_FRESH) return;
      const lock = await store.get(LOCK_KEY);
      if (lock && Date.now() - lock < 3 * 60 * 1000) return; // başka sekme topluyor
      await ensureData(true);
    } catch {
      // Ağ hatası: bir sonraki turda tekrar denenir.
    }
  }

  // ---------- ana hesap ----------
  async function build(opts, say, force = false) {
    const now = Date.now();
    await ensureData(force, say);
    if (!data?.events?.length) throw new Error('Maç verisi toplanamadı. Biraz sonra tekrar dene.');
    const items = data.events
      .filter((e) => {
        const t = Date.parse(e.startsAt);
        return t > now + 3 * 60 * 1000 && t < now + opts.hours * 3600 * 1000;
      })
      .map((e) => ({ g: { id: e.id, home: e.home, away: e.away, startsAt: e.startsAt, league: { name: e.league } }, fair: { lam: e.lam }, site: e.site, edge: e.lam - e.site }));
    if (items.length < 2) throw new Error('Bu saat aralığında adil oranı hesaplanmış yeterli maç yok. Başlama aralığını genişlet (24 ya da 48 sa).');
    let n = 0;

    const sides = opts.side === 'BOTH' ? ['OVER', 'UNDER'] : [opts.side];
    // Kombinasyonları önce yerel tahminle sırala (sitenin oranı ≈ kendi λ'sıyla Poisson + pay), en iyileri sor.
    const MARGIN = 1.085;
    const cands = [];
    for (const side of sides) {
      const top = [...items].sort((a, b) => (side === 'OVER' ? b.edge - a.edge : a.edge - b.edge)).slice(0, TOP_PICK);
      for (const k of opts.sizes) {
        for (const c of combos(top, k)) {
          const lf = c.reduce((s, x) => s + x.fair.lam, 0);
          const ls = c.reduce((s, x) => s + x.site, 0);
          let best = null;
          for (let line = Math.max(0.5, Math.floor(ls) - 4.5); line <= ls + 6; line += 1) {
            const psU = cdf(Math.floor(line), ls);
            const ps = side === 'OVER' ? 1 - psU : psU;
            const odds = 1 / (ps * MARGIN);
            if (odds < opts.minOdds || odds > opts.maxOdds) continue;
            const pfU = cdf(Math.floor(line), lf);
            const pf = side === 'OVER' ? 1 - pfU : pfU;
            const sc = score(pf, pf * odds - 1, opts.sort);
            if (best == null || sc > best) best = sc;
          }
          if (best != null) cands.push({ c, side, est: best });
        }
      }
    }
    if (!cands.length) throw new Error('Bu oran aralığında kurulabilen kupon yok. Aralığı genişlet.');
    cands.sort((a, b) => b.est - a.est);
    // Aynı maç çok fazla kuponda tekrar etmesin.
    const used = new Map();
    const pick = [];
    for (const x of cands) {
      if (pick.length >= MAX_QUOTES) break;
      if (x.c.some((m) => (used.get(m.g.id) || 0) >= 4)) continue;
      pick.push(x);
      for (const m of x.c) used.set(m.g.id, (used.get(m.g.id) || 0) + 1);
    }
    n = 0;
    const res = await pool(pick, 4, async (x) => {
      const q = await quote(x.c.map((m) => m.g.id));
      say(`Kuponların oranı soruluyor… ${++n}/${pick.length}`);
      if (!q) return null;
      const lf = x.c.reduce((s, m) => s + m.fair.lam, 0);
      const b = bestLine(q.lines, lf, [x.side], opts.minOdds, opts.maxOdds, opts.sort);
      return b ? { ...b, legs: x.c, lamFair: lf, lamSite: q.lam } : null;
    });
    const seen = new Set();
    const list = res.filter(Boolean).sort((a, b) => b.sc - a.sc).filter((x) => {
      const k = `${x.side}|${x.line}|${x.legs.map((m) => m.g.id).sort().join(',')}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { list: list.slice(0, opts.count), stats: { gm: data.total, matched: data.matched, priced: data.events.length, window: items.length, at: data.at } };
  }

  // ---------- arayüz ----------
  let fab = null;
  let modal = null;
  let busy = false;
  const state = { side: 'OVER', sort: 'PROB', minOdds: 1.5, maxOdds: 4, sizes: [2, 3, 4, 5], hours: 24, count: 10 };
  try { Object.assign(state, JSON.parse(localStorage.getItem('kkGoalMixOpts') || '{}')); } catch { /* yok */ }

  function legHtml(m) {
    const t = Date.parse(m.g.startsAt);
    return `<li class="kk-leg"><span class="kk-leg-time"><small>${esc(day(t))}</small><b>${esc(hm(t))}</b></span>`
      + `<span class="kk-leg-teams"><b>${esc(m.g.home)}</b><b>${esc(m.g.away)}</b><small>${esc(m.g.league?.name || '')}</small></span>`
      + `<span class="kk-leg-xg" title="Adil gol beklentisi · Goal Mix'in varsaydığı">${f2(m.fair.lam)}<small>site ${f2(m.site)}</small></span></li>`;
  }

  // Kuponun olasılığının nereden geldiğini anlatan kısa yorum (sayılardan üretilir).
  function commentText(c) {
    const over = c.side === 'OVER';
    const need = over ? Math.ceil(c.line) : Math.floor(c.line);
    const gap = c.lamFair - c.line;
    const legs = [...c.legs].sort((a, b) => b.fair.lam - a.fair.lam);
    const name = (m) => `${m.g.home}-${m.g.away}`;
    const s = [];
    s.push(`Bu ${c.legs.length} maçta toplam yaklaşık ${c.lamFair.toFixed(1)} gol bekleniyor; kupon ${over ? `en az ${need}` : `en fazla ${need}`} gol istiyor.`);
    const side = over ? (gap > 0 ? 'üstünde' : 'altında') : (gap < 0 ? 'altında' : 'üstünde');
    const helps = over ? gap > 0 : gap < 0;
    s.push(`Beklenen gol çizginin ${Math.abs(gap).toFixed(1)} ${side}; ${helps ? 'bu kuponun lehine' : 'bu kuponun aleyhine'}, tutma olasılığı bu yüzden %${(c.p * 100).toFixed(0)}.`);
    if (over) {
      s.push(`En çok gol beklenen maç ${name(legs[0])} (${legs[0].fair.lam.toFixed(1)}). En zayıf halka ${name(legs[legs.length - 1])} (${legs[legs.length - 1].fair.lam.toFixed(1)} gol).`);
    } else {
      s.push(`En büyük risk ${name(legs[0])}: tek başına ${legs[0].fair.lam.toFixed(1)} gol bekleniyor.`);
    }
    const diff = c.lamFair - c.lamSite;
    if (Math.abs(diff) >= 0.1) {
      const lehine = over ? diff > 0 : diff < 0;
      s.push(`Site bu maçlara ${c.lamSite.toFixed(1)} gol biçmiş, normal maç oranları ${c.lamFair.toFixed(1)} gösteriyor; ${lehine ? 'bu fark oranı adil orandan yükseltiyor' : 'bu fark oranı adil orandan düşürüyor'} (değer ${pct(c.ev)}).`);
    }
    return s.join(' ');
  }

  function cardHtml(c, i) {
    const side = c.side === 'OVER' ? 'ÜST' : 'ALT';
    const good = c.ev > 0;
    const copy = c.legs.map((m) => `${m.g.home} - ${m.g.away}`).join('\n') + `\nToplam ${c.line} ${side} · ${c.odds.toFixed(2)}`;
    return `<article class="kk-card${good ? ' is-good' : ''}">`
      + `<header class="kk-card-head"><span class="kk-card-no">${i + 1}</span>`
      + `<span class="kk-card-pick"><b>${c.legs.length} maç · Toplam ${c.line} ${side}</b><small>Beklenen toplam gol ${f2(c.lamFair)} · sitenin hesabı ${f2(c.lamSite)}</small></span>`
      + `<span class="kk-card-prob"><b>%${(c.p * 100).toFixed(0)}</b><small>tutma</small></span><span class="kk-card-odds">${c.odds.toFixed(2)}</span></header>`
      + `<div class="kk-card-stats"><span>Adil oran <b>${c.fair.toFixed(2)}</b></span>`
      + `<span class="kk-ev">Değer <b>${pct(c.ev)}</b></span>`
      + `<button type="button" class="kk-copy" data-copy="${esc(copy)}">Kopyala</button></div>`
      + `<p class="kk-note">${esc(commentText(c))}</p>`
      + `<ol class="kk-legs">${c.legs.map(legHtml).join('')}</ol></article>`;
  }

  function seg(name, value, opts) {
    return `<div class="kk-seg" data-name="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(value) ? 'is-on' : ''}">${l}</button>`).join('')}</div>`;
  }

  function renderForm() {
    const body = modal.querySelector('.kk-form');
    body.innerHTML = `<label class="kk-field"><span>Alt / Üst</span>${seg('side', state.side, [['OVER', 'Üst'], ['UNDER', 'Alt'], ['BOTH', 'İkisi']])}</label>`
      + `<label class="kk-field"><span>Öncelik</span>${seg('sort', state.sort, [['PROB', 'Tutma olasılığı'], ['EV', 'Değer']])}</label>`
      + `<label class="kk-field"><span>En az oran</span><input class="kk-input" name="minOdds" type="number" min="1.01" step="0.05" value="${state.minOdds}"></label>`
      + `<label class="kk-field"><span>En çok oran</span><input class="kk-input" name="maxOdds" type="number" min="1.05" step="0.25" value="${state.maxOdds}"></label>`
      + `<label class="kk-field"><span>Maç sayısı</span><div class="kk-seg kk-seg--multi" data-name="sizes">${[2, 3, 4, 5].map((k) => `<button type="button" data-v="${k}" class="${state.sizes.includes(k) ? 'is-on' : ''}">${k}</button>`).join('')}</div></label>`
      + `<label class="kk-field"><span>Başlama</span>${seg('hours', state.hours, [[6, '6 sa'], [12, '12 sa'], [24, '24 sa'], [48, '48 sa']])}</label>`
      + `<label class="kk-field"><span>Kupon sayısı</span>${seg('count', state.count, [[5, '5'], [10, '10'], [20, '20']])}</label>`
      + '<button type="button" class="kk-go">Kuponları oluştur</button>';
  }

  function save() {
    localStorage.setItem('kkGoalMixOpts', JSON.stringify(state));
  }

  // Yazılan oranlar (seçim düğmeleri formu yeniden çizmeden önce de okunur).
  function readInputs() {
    const val = (n) => Number(String(modal.querySelector(`input[name="${n}"]`)?.value ?? '').replace(',', '.'));
    const mo = val('minOdds');
    state.minOdds = mo > 1 ? mo : 1.5;
    const xo = val('maxOdds');
    state.maxOdds = xo > state.minOdds ? xo : Math.max(state.minOdds + 0.5, 4);
  }

  async function run(force = false) {
    if (busy) return;
    readInputs();
    if (!state.sizes.length) state.sizes = [2, 3, 4, 5];
    save();
    busy = true;
    const out = modal.querySelector('.kk-out');
    const go = modal.querySelector('.kk-go');
    go.disabled = true;
    const say = (t) => { out.innerHTML = `<div class="kk-wait"><i></i>${esc(t)}</div>`; };
    try {
      const { list, stats } = await build({ ...state, sizes: [...state.sizes].sort() }, say, force);
      const mins = Math.round((Date.now() - stats.at) / 60000);
      const info = `<p class="kk-meta">Toplanan veri (48 sa): ${stats.gm} Goal Mix maçı · ${stats.matched} bültende bulundu · ${stats.priced} maçın adil oranı hazır · seçilen aralıkta ${stats.window} maç · ${mins < 1 ? 'az önce' : `${mins} dk önce`} toplandı <button type="button" class="kk-refresh">Verileri yenile</button></p>`;
      out.innerHTML = info + (list.length
        ? list.map(cardHtml).join('')
        : '<div class="kk-empty">Bu ayarlarla kupon bulunamadı. En az oranı düşür ya da saat aralığını genişlet.</div>');
    } catch (err) {
      out.innerHTML = `<div class="kk-empty is-bad">Hesaplanamadı: ${esc(err?.message || err)}</div>`;
    } finally {
      busy = false;
      go.disabled = false;
    }
  }

  function openModal() {
    if (modal) { modal.hidden = false; return; }
    modal = document.createElement('div');
    modal.className = 'kk-modal';
    modal.innerHTML = '<div class="kk-backdrop"></div><section class="kk-box" role="dialog" aria-label="Kupon oluşturucu">'
      + '<header class="kk-head"><div><h2>Kupon oluşturucu</h2><p>Goal Mix · sitenin maç oranlarından adil oran</p></div><button type="button" class="kk-x" aria-label="Kapat">×</button></header>'
      + '<div class="kk-form"></div><div class="kk-out"><div class="kk-empty">Ayarları seçip <b>Kuponları oluştur</b>a bas. Maçlar 6q açıkken arka planda toplanıyor; veri hazırsa kuponlar birkaç saniyede çıkar.</div></div>'
      + '<footer class="kk-foot">Adil oran, sitenin normal Alt/Üst oranlarından pay çıkarılarak hesaplanan tahmindir; kazanç garantisi değildir. Eklenti bahis yapmaz, maçları Goal Mix listesinden kendin eklersin.</footer>'
      + '</section>';
    document.body.appendChild(modal);
    renderForm();
    modal.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t.closest('.kk-x') || t.classList.contains('kk-backdrop')) { modal.hidden = true; return; }
      const b = t.closest('.kk-seg button');
      if (b) {
        const segEl = b.parentElement;
        const name = segEl.dataset.name;
        if (name === 'sizes') {
          const k = Number(b.dataset.v);
          state.sizes = state.sizes.includes(k) ? state.sizes.filter((x) => x !== k) : [...state.sizes, k];
          if (!state.sizes.length) state.sizes = [k];
        } else {
          state[name] = name === 'side' || name === 'sort' ? b.dataset.v : Number(b.dataset.v);
        }
        readInputs();
        save();
        renderForm();
        return;
      }
      if (t.closest('.kk-go')) { run(); return; }
      if (t.closest('.kk-refresh')) { run(true); return; }
      const cp = t.closest('.kk-copy');
      if (cp) {
        navigator.clipboard?.writeText(cp.dataset.copy).then(() => {
          cp.textContent = 'Kopyalandı';
          setTimeout(() => { cp.textContent = 'Kopyala'; }, 1500);
        });
      }
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && modal && !modal.hidden) modal.hidden = true; });
  }

  function sync() {
    const on = PAGE_RE.test(location.pathname);
    if (on && !fab) {
      fab = document.createElement('button');
      fab.type = 'button';
      fab.className = 'kk-fab';
      fab.innerHTML = '<span>⚽</span>Kupon oluşturucu';
      fab.addEventListener('click', openModal);
      document.body.appendChild(fab);
    }
    if (fab) fab.hidden = !on;
    if (!on && modal) modal.hidden = true;
  }
  sync();
  setInterval(sync, 1000);
  // Arka plan toplama: 6q açıkken dakikada bir bakılır, veri 10 dakikadan eskiyse yeniden toplanır.
  setTimeout(backgroundTick, 5000);
  setInterval(backgroundTick, 60 * 1000);
})();
