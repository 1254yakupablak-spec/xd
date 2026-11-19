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
  const DATA_V = 2; // toplanan verinin biçimi; değişince eski kayıt bayat sayılır
  const fresh = (d) => !!d && d.v === DATA_V && Date.now() - d.at < DATA_FRESH;
  const LOCK_KEY = 'kkLock';
  const DATA_FRESH = 10 * 60 * 1000; // arka plan toplama aralığı
  const SITE_FRESH = 60 * 60 * 1000; // Goal Mix'in maç başı gol beklentisi bu kadar süre geçerli sayılır
  const TOP_PICK = 20; // kombinasyonlar (her taraf için) en iyi bu kadar maçtan kurulur
  const MAX_QUOTES = 36; // gerçek oranı sorulan kombinasyon sayısı

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = (t) => new Date(t).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' });
  const day = (t) => new Date(t).toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit' });
  const f2 = (x) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(2));
  const pct = (x) => `${x >= 0 ? '+' : '−'}%${Math.abs(x * 100).toFixed(1)}`;

  async function getJ(path) {
    // Site çok sık istekte 429 dönebiliyor: kısa bekleyip iki kez daha denenir.
    for (let i = 0; ; i++) {
      const res = await fetch(API + path, { credentials: 'omit' });
      if (res.ok) return res.json();
      if (i >= 2 || (res.status !== 429 && res.status < 500)) throw new Error(`${res.status}`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
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
  // P(X ≤ k), k = 0..K (tek geçişte).
  function cumPois(lam, K) {
    const out = new Array(K + 1);
    let t = Math.exp(-lam);
    let acc = t;
    out[0] = acc;
    for (let i = 1; i <= K; i++) { t *= lam / i; acc += t; out[i] = Math.min(1, acc); }
    return out;
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
  // Maçın beklenen golü (eski yöntem): 1.5–4.5 arası x.5 çizgiler, payı orantılı atılır; olasılığı %20–80 arası
  // (dengeli) çizgilerin her birinden çıkan beklentinin ortancası, dengeli çizgi yoksa en dengeli çizgi.
  // Ortanca: tek bozuk çizgi sonucu kaydırmasın. Yüksek çizgiler beklentiyi şişirebildiği için alınmaz.
  function matchLambda(lines) {
    const all = [];
    for (const { line, over, under } of lines) {
      if (!(line >= 1.5) || line > 4.5 || (line * 2) % 2 !== 1 || !(over > 1) || !(under > 1)) continue;
      const p = (1 / over) / (1 / over + 1 / under); // üst olasılığı
      all.push({ line, p, off: Math.abs(p - 0.5) });
    }
    if (!all.length) return null;
    all.sort((a, b) => a.off - b.off);
    const near = all.filter((x) => x.off <= 0.3);
    const vals = (near.length ? near : all.slice(0, 1)).map((x) => lamFor(Math.floor(x.line), 1 - x.p)).sort((a, b) => a - b);
    const m = vals.length >> 1;
    return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  }

  // Goal Mix fiyatlarından sitenin varsaydığı toplam beklenti (çok maçlı çizgiler, 5.5–15.5 gibi).
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
    const lam = matchLambda(lines);
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

  // Seçilen maç sayılarına göre aday havuzu: toplam kombinasyon ~60 bini geçmesin (10 maçlık kuponlarda havuz küçülür).
  const choose = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };
  // Az maçlı kuponlarda (ör. sadece 2 maç) kombinasyon sayısı küçük olduğu için havuz bütün maçlara kadar büyür:
  // 2 maçta ~340 maç bile 60 bin kombinasyon eder. Böylece oran/çizgi sınırına uyan maçlar (ör. 2 maç 6.5 üst
  // 5–10 oran için düşük gollü maçlar) en iyi 20'nin dışında kalsa da bulunur.
  function poolSize(sizes, avail = TOP_PICK) {
    for (let n = Math.min(Math.max(avail, TOP_PICK), 400); n > Math.max(...sizes); n--) {
      if (sizes.reduce((t, k) => t + choose(n, k), 0) <= 60000) return n;
    }
    return Math.max(...sizes) + 1;
  }

  function* combos(arr, k, start = 0, pre = []) {
    if (pre.length === k) { yield pre; return; }
    for (let i = start; i <= arr.length - (k - pre.length); i++) yield* combos(arr, k, i + 1, [...pre, arr[i]]);
  }

  // Sıralama puanı. Olasılık modunda değeri eksi olmayan kuponlar önce gelir, aralarında tutma olasılığı
  // yüksek olan öne geçer; değeri eksi olanlar en sona (kendi değerlerine göre) kalır.
  // Olasılık modunda sadece tutma olasılığına bakılır; değeri sitenin payından (yaklaşık %8) daha kötü olanlar elenir.
  const score = (p, ev, sort) => (sort === 'EV' ? ev : ev >= -0.08 ? 1 + p : ev);

  // Bir kombinasyonun her çizgisi için değer: adil olasılık × sitenin oranı − 1.
  // Çizgi kullanıcının sınırları içinde mi (boş = sınırsız).
  const lineOk = (line, opts) => (opts.minLine == null || line >= opts.minLine - 1e-9) && (opts.maxLine == null || line <= opts.maxLine + 1e-9);

  // Aralıktaki bütün uygun çizgiler (en iyiden kötüye). Aynı maçlarla 7.5 Alt ve 8.5 Alt ayrı kupon olabilir.
  function allLines(lines, lamFair, sides, minOdds, maxOdds, sort, opts = {}) {
    const out = [];
    for (const l of lines) {
      if (!lineOk(l.line, opts)) continue;
      const pu = cdf(Math.floor(l.line), lamFair);
      for (const side of sides) {
        const odds = side === 'OVER' ? l.over : l.under;
        if (!(odds >= minOdds) || odds > maxOdds) continue;
        const p = side === 'OVER' ? 1 - pu : pu;
        const ev = p * odds - 1;
        out.push({ line: l.line, side, odds, p, fair: 1 / p, ev, sc: score(p, ev, sort) });
      }
    }
    return out.sort((a, b) => b.sc - a.sc);
  }

  function bestLine(lines, lamFair, sides, minOdds, maxOdds, sort, opts = {}) {
    let best = null;
    for (const l of lines) {
      if (!lineOk(l.line, opts)) continue;
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
      if (e.src === '6q' && e.bookId && e.lamAt && !cache.detail.has(e.bookId)) cache.detail.set(e.bookId, { v: { lam: e.lam }, at: e.lamAt });
    }
  }

  // ---------- takım adları ----------
  // Takım adları tablosu (teams.json): aynı kulübün farklı dillerdeki ve kısaltılmış adları aynı satırda.
  let aliasMap = null;
  async function loadAliases() {
    if (aliasMap) return aliasMap;
    try {
      const rows = await (await fetch(chrome.runtime.getURL('teams.json'))).json();
      const map = new Map();
      for (const names of rows) {
        // Milli takımlar tabloda "ingiltere milli futbol takimi" diye geçiyor; bülten sadece "Ingiltere" yazar.
        for (const n of [...names]) {
          const m = /^(.+?) (?:a )?milli (?:futbol )?takimi$/.exec(n) || /^(.+?) (?:men s )?national (?:association )?football team$/.exec(n);
          if (m && m[1].length >= 3 && !names.includes(m[1])) names.push(m[1]);
        }
        for (const n of names) {
          const list = map.get(n);
          if (!list) map.set(n, [names]);
          else if (list.length < 4 && !list.includes(names)) list.push(names);
        }
      }
      aliasMap = map;
    } catch {
      aliasMap = new Map();
    }
    return aliasMap;
  }
  // Yaş grubu / yedek takım ekleri eşleşmeden önce atılır, ayrıca karşılaştırılır.
  const bare = (s) => norm(s).replace(/\b(u\d\d|ii|b|women|w|reserves?)\b/g, ' ').replace(/\s+/g, ' ').trim();
  // Önce adın kendisi (ör. "celta vigo b" yedek takımın satırında), yoksa eksiz hali aranır.
  const rowsOf = (n) => aliasMap?.get(norm(n)) || aliasMap?.get(bare(n)) || null;
  const sameClub = (a, b) => {
    const ra = rowsOf(a);
    const rb = rowsOf(b);
    return !!ra && !!rb && ra.some((r) => rb.includes(r));
  };
  // Yaş grubu (U19, U21) ve kadın takımı; yedek takım ("II", "B", "Castilla", "Fortuna") ayrıca: tablodaki satırında
  // "... ii" ya da "... b" adı geçen takım yedek sayılır. İki taraf aynı olmalı, yoksa ana takım yedekle karışır.
  const ageTag = (n) => (norm(n).match(/\b(u\d\d|women|w)\b/g) || []).sort().join(',');
  const reserve = (n) => /\b(ii|b|reserves?|jong)\b/.test(norm(n)) || !!rowsOf(n)?.some((r) => r.some((x) => /\s(ii|b)$/.test(x)));
  const sameKind = (a, b) => ageTag(a) === ageTag(b) && reserve(a) === reserve(b);
  const nameScore = (g, names) => Math.max(0, ...names.filter(Boolean).map((x) => (sameClub(g, x) ? 1 : sim(g, x))));

  // Goal Mix maçlarını başka bir listeyle (form için veri servisi) saat ±15 dk ve takım adlarıyla eşleştirir.
  function matchEvents(gm, xEvents) {
    const byMin = new Map();
    for (const e of xEvents) {
      if (!e.start) continue;
      const k = Math.round(e.start / 60);
      for (let d = -15; d <= 15; d++) {
        if (!byMin.has(k + d)) byMin.set(k + d, []);
        byMin.get(k + d).push(e);
      }
    }
    const out = new Map();
    for (const g of gm) {
      const cands = byMin.get(Math.round(Date.parse(g.startsAt) / 60000)) || [];
      let best = null;
      for (const e of cands) {
        if (!sameKind(g.home, e.homeEng || e.home) || !sameKind(g.away, e.awayEng || e.away)) continue;
        const h = nameScore(g.home, [e.home, e.homeEng]);
        const a = nameScore(g.away, [e.away, e.awayEng]);
        if (h >= 0.5 && a >= 0.5 && (!best || h + a > best.s)) best = { e, s: h + a };
      }
      if (best) out.set(g.id, best.e);
    }
    return out;
  }

  // ---------- form (son 5 maç) ----------
  // Veri servisinin maç listesi (büyük ligler) Goal Mix maçlarıyla eşleştirilir; eşleşen maçta iki takımın son 5
  // maçının attığı/yediği gol ortalaması alınır. Formdan beklenen toplam gol:
  // (ev attığı + dep yediği) / 2 + (dep attığı + ev yediği) / 2.
  const ask = (msg) => new Promise((r) => { try { chrome.runtime.sendMessage(msg, (x) => r(chrome.runtime.lastError ? null : x)); } catch { r(null); } });
  function teamForm(games) {
    const g = (games || []).slice(0, 5);
    if (g.length < 3) return null;
    const gf = g.reduce((t, x) => t + x.gf, 0) / g.length;
    const ga = g.reduce((t, x) => t + x.ga, 0) / g.length;
    return { n: g.length, gf, ga, over: g.filter((x) => x.gf + x.ga > 2.5).length, res: g.map((x) => x.res).join('') };
  }
  async function loadForms(gm, say) {
    const r = await ask({ type: 'formEvents', days: Math.ceil(COLLECT_HOURS / 24) });
    if (!r?.ok || !r.v?.length) return new Map();
    const fm = matchEvents(gm, r.v);
    const out = new Map();
    let n = 0;
    await pool([...fm.entries()], 4, async ([gid, e]) => {
      const f = await ask({ type: 'formOf', id: e.id });
      say(`Form okunuyor… ${++n}/${fm.size}`);
      if (!f?.ok || f.v?.length !== 2) return;
      const [h, a] = f.v.map((t) => teamForm(t.games));
      if (!h || !a) return;
      out.set(gid, { h, a, lam: (h.gf + a.ga) / 2 + (a.gf + h.ga) / 2 });
    });
    return out;
  }

  async function collect(say = () => {}) {
    const now = Date.now();
    say('Goal Mix maç listesi alınıyor…');
    const gm = (await loadGoalMix()).filter((g) => {
      const t = Date.parse(g.startsAt);
      return t > now + 3 * 60 * 1000 && t < now + COLLECT_HOURS * 3600 * 1000;
    }).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, MAX_EVENTS);

    // Her maçın beklentisi 6q'nun normal bültenindeki Alt/Üst oranlarından.
    await loadAliases();
    const items = gm.map((g) => ({ g, fair: null }));
    say('Sitenin bülteni alınıyor…');
    const pairs = pairUp(gm, await loadBook());
    const byId = new Map(pairs.map((p) => [p.g.id, p.e]));
    let n = 0;
    await pool(items.filter((it) => byId.has(it.g.id)), 6, async (it) => {
      const e = byId.get(it.g.id);
      const v = await fairOf(e.id);
      if (v?.lam) it.fair = { lam: v.lam, src: '6q', at: cache.detail.get(e.id)?.at || now, bookId: e.id };
      say(`Sitenin maç oranları okunuyor… ${++n}/${byId.size}`);
    });

    // Bültende Alt/Üst oranı olmayan maçlar: günlük görevin yazdığı YZ tahmini (varsa) kullanılır.
    const yz = await loadYz();
    for (const it of items) {
      const t = yz[it.g.id];
      if (!it.fair && t?.lam > 0.3 && t.lam < 9) it.fair = { lam: Number(t.lam), src: 'yz', at: Date.parse(t.at) || now, note: String(t.note || '').slice(0, 300) };
    }
    const missing = items.filter((it) => !it.fair || it.fair.src === 'yz').map((it) => ({
      id: it.g.id, home: it.g.home, away: it.g.away, league: it.g.league?.name || '', country: it.g.country?.code || '',
      startsAt: it.g.startsAt, yz: it.fair?.src === 'yz' ? it.fair.lam : null,
    }));

    let forms = new Map();
    try { forms = await loadForms(items.map((it) => it.g), say); } catch { /* form yoksa da devam */ }
    const priced = items.filter((it) => it.fair?.lam);
    if (priced.length >= 3) await siteLambdas(priced, (i, t) => say(`Goal Mix fiyatları okunuyor… ${i}/${t}`));
    const events = priced.filter((x) => x.site != null && x.site > 0.2).map((x) => ({
      id: x.g.id,
      bookId: x.fair.bookId || null,
      home: x.g.home,
      away: x.g.away,
      league: x.g.league?.name || '',
      startsAt: x.g.startsAt,
      lam: x.fair.lam,
      src: x.fair.src,
      note: x.fair.note || '',
      lamAt: x.fair.at,
      form: forms.get(x.g.id) || null,
      site: x.site,
      siteAt: cache.site.get(x.g.id)?.at || now,
    }));
    data = { at: Date.now(), total: gm.length, matched: pairs.length, formFound: forms.size, yzCount: events.filter((e) => e.src === 'yz').length, events, missing, v: DATA_V };
    await store.set(DATA_KEY, data);
    publishMissing();
    return data;
  }

  // YZ tahmin dosyası (GitHub'da herkese açık): { at, matches: { <Goal Mix maç no>: { lam, note, at, home, away } } }.
  async function loadYz() {
    const r = await ask({ type: 'fetchYz' });
    return r?.ok && r.v?.matches && typeof r.v.matches === 'object' ? r.v.matches : {};
  }

  // Bültende oranı olmayan maçlar sayfada gizli bir JSON olarak durur (#kk-missing): günlük YZ tahmin görevi okur.
  // Sadece maç adları, lig ve saat içerir.
  function publishMissing() {
    if (!data || !document.body) return;
    let el = document.getElementById('kk-missing');
    if (!el) {
      el = document.createElement('script');
      el.type = 'application/json';
      el.id = 'kk-missing';
      document.body.appendChild(el);
    }
    el.textContent = JSON.stringify({ at: new Date(data.at).toISOString(), total: data.total, missing: data.missing || [] });
  }

  // Tek seferde bir toplama; force değilse veri tazeyse ya da başka sekme topluyorsa beklenmez.
  async function ensureData(force, say) {
    if (collecting) return collecting;
    if (!data) { data = await store.get(DATA_KEY); seed(data); }
    if (!force && fresh(data)) return data;
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
      publishMissing();
      if (fresh(data)) return;
      const lock = await store.get(LOCK_KEY);
      if (lock && Date.now() - lock < 3 * 60 * 1000) return; // başka sekme topluyor
      await ensureData(true);
    } catch {
      // Ağ hatası: bir sonraki turda tekrar denenir.
    }
  }

  // ---------- ana hesap ----------
  // ---------- en iyi ayarı bul ----------
  // Alt/Üst × maç sayısı (2–5) × oran bandı kombinasyonları kendi tahminimizle taranır (gerçek oran sorulmaz, hızlı):
  // her ayarda en iyi N kuponun ortalama puanı (Öncelik'e göre: olasılık ya da değer) hesaplanır, en yükseği seçilir.
  // Başlama, lig, YZ, kupon sayısı, tekrar modu ve tutar kullanıcının seçimi olarak kalır; çizgi sınırı kaldırılır.
  const AUTO_BANDS = [[1.3, 1.8], [1.8, 2.5], [2.5, 4], [4, 7], [7, 12]];
  async function autoTune(opts, say) {
    const now = Date.now();
    await ensureData(false, say);
    if (!data?.events?.length) throw new Error('Maç verisi toplanamadı. Biraz sonra tekrar dene.');
    const items = data.events.filter((e) => {
      const t = Date.parse(e.startsAt);
      return t > now + 3 * 60 * 1000 && t < now + opts.hours * 3600 * 1000
        && (!opts.leagues?.length || opts.leagues.includes(e.league))
        && (opts.useYz === 1 || e.src !== 'yz');
    }).map((e) => ({ lam: e.lam, site: e.site, edge: e.lam - e.site }));
    if (items.length < 2) throw new Error('Bu saat aralığında yeterli maç yok. Başlama aralığını genişlet.');
    const N = opts.count;
    const MARGIN = 1.085;
    const ks = [2, 3, 4, 5].filter((k) => k <= Math.min(maxLegsAllowed, items.length));
    let best = null;
    for (const side of ['OVER', 'UNDER']) {
      const sorted = [...items].sort((a, b) => (side === 'OVER' ? b.edge - a.edge : a.edge - b.edge));
      for (const k of ks) {
        say(`En iyi ayar aranıyor… ${side === 'OVER' ? 'Üst' : 'Alt'} · ${k} maç`);
        await new Promise((r) => setTimeout(r, 0)); // sayfa donmasın
        const top = sorted.slice(0, poolSize([k], items.length));
        const bands = AUTO_BANDS.map(() => []);
        for (const c of combos(top, k)) {
          const lf = c.reduce((t, x) => t + x.lam, 0);
          const ls = c.reduce((t, x) => t + x.site, 0);
          const K = Math.ceil(Math.max(ls, lf) * 2 + 12);
          const cs = cumPois(ls, K);
          const cf = cumPois(lf, K);
          const per = new Array(AUTO_BANDS.length).fill(null);
          for (let line = 0.5; line <= K - 0.5; line += 1) {
            const ps = side === 'OVER' ? 1 - cs[Math.floor(line)] : cs[Math.floor(line)];
            if (ps < 1e-4) continue;
            const odds = 1 / (ps * MARGIN);
            const b = AUTO_BANDS.findIndex(([lo, hi]) => odds >= lo && odds < hi);
            if (b < 0) continue;
            const pf = side === 'OVER' ? 1 - cf[Math.floor(line)] : cf[Math.floor(line)];
            const sc = score(pf, pf * odds - 1, opts.sort);
            if (per[b] == null || sc > per[b]) per[b] = sc;
          }
          per.forEach((sc, b) => { if (sc != null) bands[b].push(sc); });
        }
        bands.forEach((arr, b) => {
          if (arr.length < Math.ceil(N / 2)) return; // yeterli kupon kurulamayacak ayar seçilmez
          arr.sort((x, y) => y - x);
          const val = arr.slice(0, N).reduce((t, x) => t + x, 0) / N; // eksik kupon puanı 0 sayılır
          if (!best || val > best.val) best = { val, side, k, band: AUTO_BANDS[b], n: arr.length };
        });
      }
    }
    if (!best) throw new Error('Bu başlama/lig seçiminde uygun ayar bulunamadı. Başlama aralığını genişlet.');
    return best;
  }

  async function build(opts, say, force = false) {
    const now = Date.now();
    await ensureData(force, say);
    if (!data?.events?.length) throw new Error('Maç verisi toplanamadı. Biraz sonra tekrar dene.');
    const items = data.events
      .filter((e) => {
        const t = Date.parse(e.startsAt);
        return t > now + 3 * 60 * 1000 && t < now + opts.hours * 3600 * 1000
          && (!opts.leagues?.length || opts.leagues.includes(e.league))
          && (opts.useYz === 1 || e.src !== 'yz');
      })
      // Yüzdeler sadece oranlardan: oranlar formu zaten içerir. Form kartta bilgi olarak gösterilir.
      .map((e) => ({ g: { id: e.id, home: e.home, away: e.away, startsAt: e.startsAt, league: { name: e.league } }, fair: { lam: e.lam, mkt: e.lam, src: e.src || '6q', note: e.note || '' }, form: e.form || null, site: e.site, edge: e.lam - e.site }));
    if (items.length < 2) throw new Error('Bu saat aralığında adil oranı hesaplanmış yeterli maç yok. Başlama aralığını genişlet (24 ya da 48 sa).');
    let n = 0;

    const sides = opts.side === 'BOTH' ? ['OVER', 'UNDER'] : [opts.side];
    // Kombinasyonlar önce yerel tahminle sıralanır (sitenin oranı ≈ kendi λ'sıyla Poisson + pay), en iyilerinin
    // gerçek Goal Mix oranı sorulur.
    const MARGIN = 1.085;
    function localCands(avail, bySide = null) {
      const cands = [];
      for (const side of sides) {
        const base = bySide ? bySide[side] : avail;
        const top = [...base].sort((x, y) => (side === 'OVER' ? y.edge - x.edge : x.edge - y.edge)).slice(0, poolSize(opts.sizes, base.length));
        for (const k of opts.sizes) {
          if (k > top.length) continue;
          for (const c of combos(top, k)) {
            const lf = c.reduce((t, x) => t + x.fair.lam, 0);
            const ls = c.reduce((t, x) => t + x.site, 0);
            let best = null;
            // Bütün çizgiler (0.5'ten beklenen golün iki katına kadar) ya da kullanıcının çizgi aralığı taranır.
            const K = Math.ceil(Math.max(ls, lf) * 2 + 12);
            const cs = cumPois(ls, K);
            const cf = cumPois(lf, K);
            const lo = Math.max(0.5, opts.minLine ?? 0.5);
            const hi = Math.min(K - 0.5, opts.maxLine ?? K - 0.5);
            for (let line = lo; line <= hi + 1e-9; line += 1) {
              const psU = cs[Math.floor(line)];
              const ps = side === 'OVER' ? 1 - psU : psU;
              if (ps < 1e-4) continue;
              const odds = 1 / (ps * MARGIN);
              if (odds < opts.minOdds || odds > opts.maxOdds) continue;
              const pfU = cf[Math.floor(line)];
              const pf = side === 'OVER' ? 1 - pfU : pfU;
              const sc = score(pf, pf * odds - 1, opts.sort);
              if (best == null || sc > best) best = sc;
            }
            if (best != null) cands.push({ c, side, est: best });
          }
        }
      }
      return cands.sort((x, y) => y.est - x.est);
    }
    async function priceOf(x) {
      const q = await quote(x.c.map((m) => m.g.id));
      if (!q) return null;
      const lf = x.c.reduce((t, m) => t + m.fair.lam, 0);
      const all = allLines(q.lines, lf, [x.side], opts.minOdds, opts.maxOdds, opts.sort, opts).map((b) => ({ ...b, legs: x.c, lamFair: lf, lamSite: q.lam }));
      if (!all.length) return null;
      // En iyi çizgi + aynı maçlarla diğer uygun çizgiler (tekrarlı modda ayrı kupon olarak listelenir).
      return { ...all[0], alts: all.slice(1) };
    }
    const NONE = 'Bu oran ve çizgi aralığında kurulabilen kupon yok. Aralığı genişlet (çizgi sınırı maç sayısına uymuyor olabilir: örneğin 2 maçta 12.5 çizgisi yok).';
    const stats = { ...data, priced: data.events.length, window: items.length };

    // Tekrarsız: kuponlar sırayla kurulur. Her adımda kalan maçlardan en iyi birkaç aday sorulur, en iyisi alınır,
    // maçları havuzdan çıkarılır. Böylece her maç en fazla bir kuponda olur.
    // 0: tekrarsız (her maç en fazla bir kuponda). 2: ters yönde tekrar (bir maç en fazla bir Üst ve bir Alt kuponda;
    // aynı yönde iki kez girmez).
    async function seqBuild(want, mode) {
      // Kurulamayan aday (gerçek oran aralık dışında) "denendi" diye işaretlenir ve atlanır; maçları havuzda kalır.
      // Böylece uzak saatteki çok sayıda aday soru hakkını bitirip iyi kuponları engellemez.
      const usedOver = new Set();
      const usedUnder = mode === 2 ? new Set() : usedOver;
      const usedOf = (side) => (side === 'OVER' ? usedOver : usedUnder);
      const failed = new Set();
      const ck = (x) => `${x.side}|${x.c.map((m) => m.g.id).sort().join(',')}`;
      const out = [];
      let asked = 0;
      const BUDGET = Math.max(60, want * 10);
      while (out.length < want && asked < BUDGET) {
        const bySide = { OVER: items.filter((x) => !usedOver.has(x.g.id)), UNDER: items.filter((x) => !usedUnder.has(x.g.id)) };
        const tries = localCands(null, bySide).filter((x) => !failed.has(ck(x))).slice(0, 4);
        if (!tries.length) break;
        asked += tries.length;
        say(`Farklı maçlı kuponlar kuruluyor… ${out.length + 1}/${want}`);
        const got = (await Promise.all(tries.map((x) => priceOf(x).catch(() => null))))
          .map((r, i) => (r ? r : (failed.add(ck(tries[i])), null)))
          .filter(Boolean)
          .sort((x, y) => y.sc - x.sc);
        if (!got.length) continue;
        out.push(got[0]);
        got[0].legs.forEach((m) => usedOf(got[0].side).add(m.g.id));
        // Bu turda kurulup seçilmeyenler sonraki turlarda yeniden sorulmasın diye değil, maçları değiştiği için
        // zaten elenir (kullanılan maç içeriyorlarsa).
      }
      return out;
    }
    if (opts.repeat === 0 || opts.repeat === 2) {
      const out = await seqBuild(opts.count, opts.repeat);
      if (!out.length) throw new Error(NONE);
      return { list: out, stats: { ...stats, short: out.length < opts.count } };
    }

    // Tekrarlı: önce kuponların yarısı tamamen farklı maçlardan kurulur, kalan yarısı tekrara izin verilerek doldurulur.
    const distinct = await seqBuild(Math.ceil(opts.count / 2), 0);

    const cands = localCands(items);
    if (!cands.length && !distinct.length) throw new Error(NONE);
    // Tekrarlı: tekrar zorunlu değil, serbest. En iyi kupondan başlanır; bir maç en fazla MAX_REP kupona girer, böylece
    // liste hem farklı maçlı kuponlardan hem de tekrar eden maçlı kuponlardan oluşur (hepsi aynı 5 maçın türevi olmaz).
    // Sorulan kombinasyonların bir kısmı gerçek oranda aralık dışına düşebilir ya da aynı kupon çıkabilir: istenen
    // sayıya ulaşılamazsa sıradaki adaylar da sorulur (en çok 3 tur).
    const MAX_REP = 3;
    const maxUse = Math.max(MAX_REP, Math.ceil((MAX_QUOTES * Math.max(...opts.sizes)) / poolSize(opts.sizes, items.length) / 4));
    const pickDiverse = (all) => {
      const use = new Map();
      const out = [...distinct];
      const taken = new Set(distinct.map(keyOf));
      distinct.forEach((x) => x.legs.forEach((m) => use.set(m.g.id, (use.get(m.g.id) || 0) + 1)));
      for (const x of [...all].sort((a, b) => b.sc - a.sc)) {
        if (taken.has(keyOf(x))) continue;
        if (out.length >= opts.count) break;
        if (x.legs.some((m) => (use.get(m.g.id) || 0) >= MAX_REP)) continue;
        out.push(x);
        x.legs.forEach((m) => use.set(m.g.id, (use.get(m.g.id) || 0) + 1));
      }
      return out;
    };
    const used = new Map();
    const seen = new Set();
    const list = [];
    let from = 0;
    n = 0;
    for (let round = 0; round < 4 && pickDiverse(list).length < opts.count && from < cands.length; round++) {
      const pick = [];
      while (from < cands.length && pick.length < Math.max(MAX_QUOTES, opts.count + 10)) {
        const x = cands[from++];
        if (x.c.some((m) => (used.get(m.g.id) || 0) >= maxUse * (round + 1))) continue;
        pick.push(x);
        for (const m of x.c) used.set(m.g.id, (used.get(m.g.id) || 0) + 1);
      }
      const res = await pool(pick, 4, async (x) => {
        const r = await priceOf(x);
        say(`Kuponların oranı soruluyor… ${++n}`);
        return r;
      });
      for (const x of res.flatMap((r) => (r ? [r, ...(r.alts || [])] : []))) {
        const k = `${x.side}|${x.line}|${x.legs.map((m) => m.g.id).sort().join(',')}`;
        if (seen.has(k)) continue;
        seen.add(k);
        list.push(x);
      }
    }
    const outList = pickDiverse(list).sort((a, b) => b.sc - a.sc);
    return { list: outList, stats: { ...stats, short: outList.length < opts.count } };
  }

  // ---------- arayüz ----------
  let fab = null;
  let modal = null;
  let busy = false;
  const state = { side: 'OVER', sort: 'PROB', minOdds: 1.5, maxOdds: 4, minLine: null, maxLine: null, minLegs: 2, maxLegs: 5, repeat: 1, stake: 1, leagues: [], useYz: 0, sizes: [2, 3, 4, 5], hours: 24, count: 10 };
  try { Object.assign(state, JSON.parse(localStorage.getItem('kkGoalMixOpts') || '{}')); delete state.formW; } catch { /* yok */ }
  // Goal Mix'in izin verdiği en çok maç (sitenin ayarı; okunamazsa 10).
  let maxLegsAllowed = 10;
  getJ('/goalmix/config').then((c) => { if (c?.maxMatches >= 2) maxLegsAllowed = Math.min(15, c.maxMatches); }).catch(() => {});
  const legRange = () => {
    const a = Math.max(2, Math.min(state.minLegs || 2, maxLegsAllowed));
    const b = Math.max(a, Math.min(state.maxLegs || a, maxLegsAllowed));
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  };

  const trRes = (r) => String(r || '').replace(/W/g, 'G').replace(/D/g, 'B').replace(/L/g, 'M');
  // Son 5 maç: sonuçlar renkli kutucuk (G yeşil, B gri, M kırmızı), yanında attığı–yediği ortalama ve üst sayısı.
  function teamFormHtml(label, x) {
    if (!x) return '';
    const dots = [...trRes(x.res)].map((r) => `<i class="kk-r kk-r--${r}">${r}</i>`).join('');
    return `<span class="kk-tf"><em>${label}</em><span class="kk-dots">${dots}</span><small>${x.gf.toFixed(1)}–${x.ga.toFixed(1)} · üst ${x.over}/${x.n}</small></span>`;
  }
  function formHtml(f) {
    if (!f) return '<span class="kk-leg-form is-none">form yok</span>';
    return `<span class="kk-leg-form">${teamFormHtml('Ev', f.h)}${teamFormHtml('Dep', f.a)}</span>`;
  }

  // Açılan kuponda maçlar tablo satırı: saat | ev – deplasman (lig) | beklenen gol | son 5 maç.
  function legHtml(m) {
    const t = Date.parse(m.g.startsAt);
    return `<li class="kk-leg"><span class="kk-leg-time"><b>${esc(hm(t))}</b><small>${esc(day(t))}</small></span>`
      + `<span class="kk-leg-teams"><b>${esc(m.g.home)} <span class="kk-vs">–</span> ${esc(m.g.away)}</b><small>${esc(m.g.league?.name || '')}</small></span>`
      + `<span class="kk-leg-xg"><b>${f2(m.fair.lam)}${m.fair.src === 'yz' ? ` <em class="kk-yz" title="${esc(m.fair.note || 'Yapay zekâ tahmini')}">YZ</em>` : ''}</b><small>site ${f2(m.site)}</small></span>`
      + `${formHtml(m.form)}</li>`;
  }
  const legsHead = () => `<li class="kk-leg kk-leg--head"><span>Saat</span><span>Maç</span><span>Beklenen gol ${info(TIP.xg)}</span><span>Son 5 maç ${info(TIP.formLeg)}</span></li>`;

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
    const withForm = c.legs.filter((m) => m.form?.lam);
    if (withForm.length) {
      const fl = withForm.reduce((t, m) => t + m.form.lam, 0);
      const ml = withForm.reduce((t, m) => t + (m.fair.mkt ?? m.fair.lam), 0);
      const d = fl - ml;
      const say = Math.abs(d) < 0.3 ? 'oranlarla aynı yönde' : d > 0 ? `oranlardan ${d.toFixed(1)} gol fazla (üst lehine)` : `oranlardan ${Math.abs(d).toFixed(1)} gol az (alt lehine)`;
      s.push(`Son 5 maç formuna göre ${withForm.length === c.legs.length ? 'bu maçlarda' : `${withForm.length} maçta`} toplam ~${fl.toFixed(1)} gol düşüyor; ${say}.`);
    }
    const diff = c.lamFair - c.lamSite;
    if (Math.abs(diff) >= 0.1) {
      const lehine = over ? diff > 0 : diff < 0;
      const effect = !lehine ? 'bu fark oranı aleyhine çeviriyor' : c.ev > 0 ? 'bu fark oranı adil orandan yükseltiyor' : 'fark lehine ama sitenin payını karşılamaya yetmiyor';
      s.push(`Site bu maçlara ${c.lamSite.toFixed(1)} gol biçmiş, normal maç oranları ${c.lamFair.toFixed(1)} gösteriyor; ${effect} (değer ${pct(c.ev)}).`);
    }
    return s.join(' ');
  }

  // Sol panel: kupon satırı. Sağ panel: seçili kuponun ayrıntısı.
  let selKey = null;
  function cardHtml(c, i) {
    const side = c.side === 'OVER' ? 'ÜST' : 'ALT';
    const k = keyOf(c);
    return `<article class="kk-card${c.ev > 0 ? ' is-good' : ''}${k === selKey ? ' is-sel' : ''}" data-key="${esc(k)}">`
      + `<header class="kk-card-head" title="Ayrıntıyı göster"><button type="button" class="kk-pick${offSet.has(k) ? '' : ' is-on'}" data-key="${esc(k)}" title="Kupon setine kat / çıkar" aria-label="Kupon setine kat / çıkar"></button><span class="kk-card-no">${i + 1}</span>`
      + `<span class="kk-card-pick"><b>${c.legs.length} maç · ${c.line} ${side}</b><small>Değer ${pct(c.ev)} · beklenen ${f2(c.lamFair)} gol</small></span>`
      + `<span class="kk-card-prob"><b>%${(c.p * 100).toFixed(0)}</b><small>tutma</small></span><span class="kk-card-odds">${c.odds.toFixed(2)}</span></header></article>`;
  }
  function detailHtml(c) {
    if (!c) return '<div class="kk-detail-empty">Soldan bir kupon seç; maçları, yorumu ve ayrıntıları burada görünür.</div>';
    const side = c.side === 'OVER' ? 'ÜST' : 'ALT';
    const copy = c.legs.map((m) => `${m.g.home} - ${m.g.away}`).join('\n') + `\nToplam ${c.line} ${side} · ${c.odds.toFixed(2)}`;
    return `<div class="kk-detail${c.ev > 0 ? ' is-good' : ''}">`
      + `<div class="kk-detail-head"><div><b>${c.legs.length} maç · Toplam ${c.line} ${side}</b><small>Beklenen toplam gol ${f2(c.lamFair)} · sitenin hesabı ${f2(c.lamSite)}</small></div>`
      + `<span class="kk-card-prob"><b>%${(c.p * 100).toFixed(0)}</b><small>tutma</small></span><span class="kk-card-odds">${c.odds.toFixed(2)}</span></div>`
      + `<div class="kk-card-stats"><span>Adil oran <b>${c.fair.toFixed(2)}</b> ${info(TIP.fair)}</span><span>Tutma <b>%${(c.p * 100).toFixed(1)}</b> ${info(TIP.prob)}</span>`
      + `<span class="kk-ev">Değer <b>${pct(c.ev)}</b> ${info(TIP.ev)}</span>`
      + `<button type="button" class="kk-copy" data-copy="${esc(copy)}">Kopyala</button></div>`
      + `<p class="kk-note">${esc(commentText(c))}</p>`
      + `<ol class="kk-legs">${legsHead()}${[...c.legs].sort((a, b) => Date.parse(a.g.startsAt) - Date.parse(b.g.startsAt)).map(legHtml).join('')}</ol></div>`;
  }
  function showDetail() {
    const right = modal.querySelector('.kk-right');
    if (right) right.innerHTML = detailHtml(lastList.find((c) => keyOf(c) === selKey) || null);
    modal.querySelectorAll('.kk-card').forEach((x) => x.classList.toggle('is-sel', x.dataset.key === selKey));
  }

  const TIP = {
    sort: 'Olasılık: tutma ihtimali en yüksek kuponlar önce gelir (sitenin payından kötü olanlar elenir). Değer: sitenin oranının adil orandan en yüksek olduğu kuponlar önce gelir.',
    ev: 'Değer = tutma olasılığı × oran − 1. Örnek: %60 olasılık ve 1.80 oran → 0.60 × 1.80 − 1 = +%8. Artı ise site adil orandan yüksek oran veriyor (uzun vadede lehine), eksi ise düşük veriyor. Tek kuponun tutacağını göstermez.',
    fair: 'Adil oran = 1 ÷ tutma olasılığı. Sitenin payı olmasaydı bu kupona verilmesi gereken oran.',
    prob: 'Tutma olasılığı: maçların normal Alt/Üst oranlarından payı çıkarılarak bulunan gol beklentisiyle hesaplanır. Oran yükseldikçe olasılık düşer (yaklaşık 1 ÷ oran).',
    data: 'Ekranda görünenler değil, önümüzdeki 48 saatteki bütün Goal Mix maçları okunur. Adil oran 6q\'nun normal bültenindeki maç sonu Alt/Üst oranlarından hesaplanır: 1.5–4.5 arası dengeli çizgilerden payı atılmış olasılıklarla beklenen gol (Poisson) bulunur, ortancası alınır. Bültende Alt/Üst oranı olmayan maç kuponlara girmez.',
    order: 'Oluşan kuponları yeniden sıralar; hesap değişmez.',
    auto: 'Alt/Üst, maç sayısı (2–5) ve oran aralığı kombinasyonlarını tarar; Öncelik\'e göre (olasılık ya da değer) en iyi kupon setini veren ayarı forma doldurur ve kuponları oluşturur. Başlama, lig, YZ, kupon sayısı, tekrar modu ve tutar senin seçimin olarak kalır; çizgi sınırı kaldırılır.',
    yz: 'Normal bültende Alt/Üst oranı olmayan maçlar için günde iki kez (00:00 ve 12:00) yapay zekâ beklenen gol tahmini yapar (son maçlar, lig ortalaması). Dahil: bu maçlar da kuponlara girer, maç satırında YZ etiketiyle. Tahmin, oranlardan çıkan beklentiden daha az isabetlidir; değeri de o kadar belirsizdir.',
    line: 'Kuponun toplam gol çizgisi sınırı. Örnek: Alt, en az 5.5, en çok 8.5 → sadece 5.5, 6.5, 7.5, 8.5 Alt kuponlar. Boş bırakılırsa sınır yok. Tam sayı yazılırsa en az yukarı (6 → 6.5), en çok aşağı (6 → 5.5) yuvarlanır.',
    xg: 'Maçın adil gol beklentisi (sitenin normal Alt/Üst oranlarından); altında Goal Mix\'in aynı maç için varsaydığı.',
    repeat: 'Tekrarlı: kuponların yarısı tamamen farklı maçlardan, kalan yarısı tekrara izin verilerek kurulur (bir maç en fazla 3 kupona girer); yani tekrarlılar da dahil, ama hepsi tekrarlı değil. Tekrarsız: her maç en fazla bir kuponda olur. Ters çizgi: bir maç en fazla bir Üst ve bir Alt kupona girebilir, aynı yönde iki kez girmez (Alt/Üst "İkisi" seçiliyken anlamlı; tek yönde tekrarsızla aynıdır). Tekrarsız ve ters çizgide kuponlar sırayla, kalan maçlardan kurulur; istenenden az kupon çıkabilir.',
    set: 'Seçili kuponların birlikte hesabı: en az 1, en az 2… kuponun tutma olasılığı. Her kutunun altında tam o kadar kupon tutarsa net kâr/zarar: ortalama, en kötü (en düşük oranlılar tutarsa) … en iyi (en yüksek oranlılar tutarsa). Kâra geçiş: ortalamada artıya geçmek için gereken en az tutan kupon sayısı. Her maçın golü adil beklentiyle 20.000 kez denendi; aynı maç birden çok kuponda varsa o maçın sonucu hepsinde aynı sayıldı. Beklenen net: her kupona 1 birim yatırılırsa ortalama sonuç (oranlar × tutma − kupon sayısı). Tahmindir, garanti değildir.',
    formLeg: 'Sadece bilgi, yüzdeye katılmaz (oranlar formu zaten içerir). Son 5 maç: attığı–yediği gol ortalaması, 2.5 üst biten maç sayısı ve sonuçlar (G galibiyet, B beraberlik, M mağlubiyet).',
  };
  const info = (text) => `<span class="kk-i" tabindex="0" role="button" aria-label="Açıklama" data-tip="${esc(text)}">i</span>`;

  // ---------- kupon seti (eski "en az bir kupon" hesabı) ----------
  // Seçili kuponlardan kaçının tutacağı: her maçın golü adil beklentiyle (Poisson) bir kez çekilir, o maçı içeren
  // bütün kuponlar aynı sonucu görür (aynı maç birden çok kuponda olabilir). 20.000 deneme, sabit tohum.
  const keyOf = (c) => `${c.side}|${c.line}|${c.legs.map((m) => m.g.id).sort().join(',')}`;
  const offSet = new Set(); // hesaptan çıkarılan kuponlar
  function setChance(list, runs = 20000) {
    if (!list.length) return null;
    const ids = [...new Set(list.flatMap((c) => c.legs.map((m) => m.g.id)))];
    const lam = ids.map((id) => list.flatMap((c) => c.legs).find((m) => m.g.id === id).fair.lam);
    const idx = list.map((c) => c.legs.map((m) => ids.indexOf(m.g.id)));
    let seed = 20261119;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const poisson = (l) => { const L = Math.exp(-l); let k = 0; let p = rnd(); while (p > L) { k++; p *= rnd(); } return k; };
    const byK = new Array(list.length + 1).fill(0);
    const payK = new Array(list.length + 1).fill(0); // tam k tutunca tutan kuponların oranları toplamı
    let pay = 0;
    const goals = new Array(ids.length);
    for (let i = 0; i < runs; i++) {
      for (let j = 0; j < ids.length; j++) goals[j] = poisson(lam[j]);
      let hits = 0;
      let p1 = 0;
      list.forEach((c, n) => {
        const total = idx[n].reduce((t, j) => t + goals[j], 0);
        if (c.side === 'OVER' ? total > c.line : total < c.line) { hits++; p1 += c.odds; }
      });
      pay += p1;
      byK[hits]++;
      payK[hits] += p1;
    }
    const atLeast = byK.map((_, k) => byK.slice(k).reduce((t, x) => t + x, 0) / runs);
    // Tam k kupon tutarsa net sonuç (her kupona 1 birim): hangi kuponların tuttuğuna göre değişir. En kötü: en düşük
    // oranlı k kupon, en iyi: en yüksek oranlı k kupon. Ortalama: denemede yeterince görüldüyse oradan, değilse
    // ortalama oranla.
    const odds = list.map((c) => c.odds).sort((x, y) => x - y);
    const avgOdds = odds.reduce((t, o) => t + o, 0) / odds.length;
    const net = byK.map((cnt, k) => ({
      avg: cnt >= 50 ? payK[k] / cnt - list.length : k * avgOdds - list.length,
      min: odds.slice(0, k).reduce((t, o) => t + o, 0) - list.length,
      max: odds.slice(odds.length - k).reduce((t, o) => t + o, 0) - list.length,
    }));
    // Kâra geçiş: ortalama net sonucun artıya döndüğü en az tutan kupon sayısı.
    const even = net.findIndex((x) => x.avg > 0);
    return { n: list.length, atLeast, netK: net, even, pEven: even >= 0 ? atLeast[even] : 0, mean: byK.reduce((t, x, k) => t + x * k, 0) / runs, net: pay / runs - list.length, shared: ids.length < list.reduce((t, c) => t + c.legs.length, 0) };
  }
  const pctTxt = (p) => (p >= 0.9995 ? '%99.9 üstü' : p >= 0.001 ? `%${(p * 100).toFixed(1)}` : '%0.1 altı');
  function setHtml() {
    const sel = lastList.filter((c) => !offSet.has(keyOf(c)));
    const r = setChance(sel);
    if (!r) return `<div class="kk-set"><b>Kupon seti</b><span>Hesaba katılacak kupon seç (kupondaki kutucuk).</span></div>`;
    const st = state.stake > 0 ? state.stake : 1;
    const money = (v) => `${v > 0.005 ? '+' : v < -0.005 ? '−' : ''}${Math.abs(v * st).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}`;
    const cls = (v) => (v > 0.005 ? 'is-up' : v < -0.005 ? 'is-down' : '');
    // Gösterilecek k'lar: az kuponda hepsi; çok kuponda 1, beklenen tutan sayısının çevresi, kâra geçiş noktası
    // ve hepsi (1–5 gibi kesin tutacak sayılar yer kaplamasın).
    const m = Math.round(r.mean);
    const ks = [...new Set((r.n <= 7
      ? Array.from({ length: r.n }, (_, i) => i + 1)
      : [1, Math.max(1, m - 3), Math.max(1, m - 1), m, m + 1, m + 3, r.even, r.n])
      .filter((k) => k >= 1 && k <= r.n))].sort((x, y) => x - y);
    const tiles = ks.map((k) => {
      const x = r.netK[k];
      const range = Math.abs(x.max - x.min) > 0.005 ? `<em>${money(x.min)} … ${money(x.max)}</em>` : '';
      return `<span class="kk-set-tile${k === r.even ? ' is-even' : ''}"><small>${k === r.n && k > 5 ? `Hepsi (${k})` : `En az ${k}`}</small><b>${pctTxt(r.atLeast[k])}</b>`
        + `<span class="kk-pl">tam ${k} tutarsa <i class="${cls(x.avg)}">${money(x.avg)}</i>${range}</span></span>`;
    }).join('');
    const evenTxt = r.even > 0
      ? `Kâra geçiş: en az <b>${r.even}</b> kupon tutmalı · olasılığı <b>${pctTxt(r.pEven)}</b>`
      : 'Bu sette ortalamada kâra geçilmiyor';
    return `<div class="kk-set"><div class="kk-set-head"><b>Kupon seti · ${r.n}/${lastList.length} kupon ${info(TIP.set)}</b>`
      + `<label class="kk-stake">Kupon başı <input type="number" min="0.01" step="any" name="stake" value="${st}"></label>`
      + `<span>Yatırılan <b>${(r.n * st).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</b> · beklenen tutan <b>${r.mean.toFixed(2)}</b> kupon · beklenen net <b class="${cls(r.net)}">${money(r.net)}</b> · ${evenTxt}${r.shared ? ' · ortak maçlar birlikte sayıldı' : ''}</span>`
      + `<span class="kk-set-btns"><button type="button" class="kk-set-all">Hepsi</button><button type="button" class="kk-set-none">Hiçbiri</button></span></div>`
      + `<div class="kk-set-tiles">${tiles}</div></div>`;
  }
  function redrawSet() {
    const el = modal.querySelector('.kk-set');
    if (el) el.outerHTML = setHtml();
  }

  // Oluşan kuponların sıralaması (hesabı değiştirmez).
  let lastList = [];
  const ORDERS = [['prob', 'Olasılık'], ['ev', 'Değer'], ['oddsDesc', 'Oran ↓'], ['oddsAsc', 'Oran ↑'], ['legs', 'Maç sayısı'], ['time', 'Saat']];
  const firstStart = (c) => Math.min(...c.legs.map((m) => Date.parse(m.g.startsAt)));
  function sortList(list) {
    const k = state.order || 'prob';
    const f = {
      prob: (a, b) => b.p - a.p,
      ev: (a, b) => b.ev - a.ev,
      oddsDesc: (a, b) => b.odds - a.odds,
      oddsAsc: (a, b) => a.odds - b.odds,
      legs: (a, b) => a.legs.length - b.legs.length || b.p - a.p,
      time: (a, b) => firstStart(a) - firstStart(b),
    }[k] || ((a, b) => b.p - a.p);
    return [...list].sort(f);
  }
  const orderBar = () => `<div class="kk-order"><span>Sırala ${info(TIP.order)}</span>${seg('order', state.order || 'prob', ORDERS)}</div>`;
  function redrawList() {
    const grid = modal.querySelector('.kk-grid');
    const bar = modal.querySelector('.kk-order');
    if (!grid || !bar) return;
    bar.outerHTML = orderBar();
    grid.innerHTML = sortList(lastList).map(cardHtml).join('');
    showDetail();
  }

  function seg(name, value, opts) {
    return `<div class="kk-seg" data-name="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(value) ? 'is-on' : ''}">${l}</button>`).join('')}</div>`;
  }

  const legSelect = (name, v) => `<select class="kk-input kk-select" name="${name}">${Array.from({ length: maxLegsAllowed - 1 }, (_, i) => i + 2).map((k) => `<option value="${k}"${k === v ? ' selected' : ''}>${k} maç</option>`).join('')}</select>`;

  const COUNTS = [5, 10, 15, 20, 25, 30, 40, 50];

  // ---------- lig seçimi (çoklu seçimli açılır liste) ----------
  // Ligler toplanan veriden, seçili başlama aralığındaki maç sayısıyla gelir. Boş seçim = bütün ligler.
  function leagueList() {
    const now = Date.now();
    const counts = new Map();
    for (const e of data?.events || []) {
      const t = Date.parse(e.startsAt);
      if (t <= now + 3 * 60 * 1000 || t >= now + state.hours * 3600 * 1000) continue;
      const k = e.league || 'Diğer';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const k of state.leagues) if (!counts.has(k)) counts.set(k, 0);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'tr'));
  }
  const leagueLabel = () => (!state.leagues.length ? 'Tüm ligler' : state.leagues.length === 1 ? state.leagues[0] : `${state.leagues.length} lig seçili`);
  function leagueItems() {
    const list = leagueList();
    if (!list.length) return '<p class="kk-dd-empty">Maç verisi toplanınca ligler burada çıkar.</p>';
    return list.map(([name, n]) => `<label class="kk-dd-item" data-name="${esc(name.toLocaleLowerCase('tr'))}"><input type="checkbox" value="${esc(name)}"${state.leagues.includes(name) ? ' checked' : ''}><span>${esc(name)}</span><em>${n}</em></label>`).join('');
  }
  const leagueField = () => `<div class="kk-field kk-field--league"><span>Lig</span><div class="kk-dd">`
    + `<button type="button" class="kk-input kk-dd-btn" title="${esc(state.leagues.join(', '))}">${esc(leagueLabel())}</button>`
    + '<div class="kk-dd-panel" hidden><input class="kk-input kk-dd-search" type="search" placeholder="Lig ara…">'
    + '<div class="kk-dd-tools"><button type="button" class="kk-dd-clear">Tüm ligler</button><button type="button" class="kk-dd-close">Tamam</button></div>'
    + `<div class="kk-dd-list">${leagueItems()}</div></div></div></div>`;
  function refreshLeagues() {
    const dd = modal?.querySelector('.kk-dd');
    if (!dd) return;
    dd.querySelector('.kk-dd-list').innerHTML = leagueItems();
    dd.querySelector('.kk-dd-btn').textContent = leagueLabel();
  }

  function renderForm() {
    const body = modal.querySelector('.kk-form');
    body.innerHTML = `<div class="kk-field"><span>Alt / Üst</span>${seg('side', state.side, [['OVER', 'Üst'], ['UNDER', 'Alt'], ['BOTH', 'İkisi']])}</div>`
      + `<div class="kk-field"><span>Öncelik ${info(TIP.sort)}</span>${seg('sort', state.sort, [['PROB', 'Olasılık'], ['EV', 'Değer']])}</div>`
      + `<div class="kk-field"><span>En az oran</span><input class="kk-input" name="minOdds" type="number" min="1.01" step="0.05" value="${state.minOdds}"></div>`
      + `<div class="kk-field"><span>En çok oran</span><input class="kk-input" name="maxOdds" type="number" min="1.05" step="0.25" value="${state.maxOdds}"></div>`
      + `<div class="kk-field"><span>En az çizgi ${info(TIP.line)}</span><input class="kk-input" name="minLine" type="number" min="0.5" step="1" placeholder="sınırsız" value="${state.minLine ?? ''}"></div>`
      + `<div class="kk-field"><span>En çok çizgi</span><input class="kk-input" name="maxLine" type="number" min="0.5" step="1" placeholder="sınırsız" value="${state.maxLine ?? ''}"></div>`
      + `<div class="kk-field"><span>Maç sayısı</span><div class="kk-legs-sel">${legSelect('minLegs', state.minLegs)}<em>–</em>${legSelect('maxLegs', state.maxLegs)}</div></div>`
      + `<div class="kk-field"><span>Başlama</span>${seg('hours', state.hours, [[6, '6 sa'], [12, '12 sa'], [24, '24 sa'], [48, '48 sa']])}</div>`

      + leagueField()
      + `<div class="kk-field"><span>YZ tahmini ${info(TIP.yz)}</span>${seg('useYz', state.useYz, [[0, 'Hariç'], [1, 'Dahil']])}</div>`
      + `<div class="kk-field"><span>Kupon sayısı</span><select class="kk-input kk-select" name="count">${COUNTS.map((k) => `<option value="${k}"${k === state.count ? ' selected' : ''}>${k} kupon</option>`).join('')}</select></div>`
      + `<div class="kk-field"><span>Aynı maç ${info(TIP.repeat)}</span>${seg('repeat', state.repeat, [[1, 'Tekrarlı'], [0, 'Tekrarsız'], [2, 'Ters çizgi']])}</div>`
      + `<div class="kk-field kk-field--go"><span>&nbsp;</span><div class="kk-go-row"><button type="button" class="kk-auto" title="${esc(TIP.auto)}">En iyi ayarı bul</button><button type="button" class="kk-go">Kuponları oluştur</button></div></div>`;
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
    // Çizgi: x.5'e yuvarlanır. En az yukarı (6 → 6.5, 5.5 → 5.5), en çok aşağı (6 → 5.5, 7.5 → 7.5); boş = sınırsız.
    const ln = (n, up) => {
      const el = modal.querySelector(`input[name="${n}"]`);
      const raw = String(el?.value ?? '').trim();
      if (!raw) return null;
      const v = Number(raw.replace(',', '.'));
      if (!Number.isFinite(v) || v <= 0) { if (el) el.value = ''; return null; }
      const r = Math.max(0.5, (up ? Math.ceil(v - 0.5) : Math.floor(v - 0.5)) + 0.5);
      if (el) el.value = String(r); // yuvarlanan değer kutuda görünsün
      return r;
    };
    const sel = (n) => Number(modal.querySelector(`select[name="${n}"]`)?.value) || null;
    state.count = COUNTS.includes(sel('count')) ? sel('count') : state.count || 10;
    state.minLegs = sel('minLegs') || state.minLegs || 2;
    state.maxLegs = sel('maxLegs') || state.maxLegs || 5;
    if (state.maxLegs < state.minLegs) [state.minLegs, state.maxLegs] = [state.maxLegs, state.minLegs];
    state.sizes = legRange();
    state.minLine = ln('minLine', true);
    state.maxLine = ln('maxLine', false);
    if (state.minLine != null && state.maxLine != null && state.maxLine < state.minLine) [state.minLine, state.maxLine] = [state.maxLine, state.minLine];
  }

  let autoNote = '';
  async function runAuto() {
    if (busy) return;
    readInputs();
    const out = modal.querySelector('.kk-out');
    const say = (t) => { out.innerHTML = `<div class="kk-wait"><i></i>${esc(t)}</div>`; };
    busy = true;
    let best;
    try {
      best = await autoTune({ ...state }, say);
    } catch (err) {
      out.innerHTML = `<div class="kk-empty is-bad">Ayar bulunamadı: ${esc(err?.message || err)}</div>`;
      return;
    } finally {
      busy = false;
    }
    state.side = best.side;
    state.minLegs = best.k;
    state.maxLegs = best.k;
    state.sizes = [best.k];
    state.minOdds = best.band[0];
    state.maxOdds = best.band[1];
    state.minLine = null;
    state.maxLine = null;
    save();
    renderForm();
    autoNote = `Otomatik ayar: ${best.side === 'OVER' ? 'Üst' : 'Alt'} · ${best.k} maç · oran ${best.band[0]}–${best.band[1]} (${state.sort === 'EV' ? 'değere' : 'tutma olasılığına'} göre en iyisi)`;
    run();
  }

  async function run(force = false) {
    if (busy) return;
    readInputs();
    if (!state.sizes.length) state.sizes = legRange();
    save();
    busy = true;
    const out = modal.querySelector('.kk-out');
    const go = modal.querySelector('.kk-go');
    go.disabled = true;
    const say = (t) => { out.innerHTML = `<div class="kk-wait"><i></i>${esc(t)}</div>`; };
    try {
      const { list, stats } = await build({ ...state, sizes: [...state.sizes].sort() }, say, force);
      const mins = Math.round((Date.now() - stats.at) / 60000);
      const ago = mins < 1 ? 'az önce' : `${mins} dk önce`;
      const infoLine = (autoNote ? `<p class="kk-meta kk-auto-note">${esc(autoNote)}</p>` : '') + `<p class="kk-meta">${info(TIP.data)} 48 sa: ${stats.total} Goal Mix maçı · ${stats.matched ?? '?'} bültende bulundu · ${stats.priced} maçın adil oranı hazır · form ${stats.formFound || 0} maçta · YZ tahmini ${stats.yzCount || 0} maç${state.useYz === 1 ? ' (dahil)' : ' (hariç)'} · seçilen aralıkta ${stats.window} maç · ${ago}${stats.short ? ` · <span class="kk-warn">${state.repeat === 0 ? 'tekrarsız: ' : state.repeat === 2 ? 'ters çizgi: ' : ''}istenenden az kupon kurulabildi (bu oran/çizgi aralığında yeterli uygun kombinasyon yok)</span>` : ''} <span class="kk-meta-btns"><button type="button" class="kk-refresh">Verileri yenile</button></span></p>`;
      lastList = list;
      offSet.clear();
      selKey = list.length ? keyOf(sortList(list)[0]) : null;
      out.innerHTML = infoLine + (list.length
        ? setHtml() + `<div class="kk-split"><div class="kk-left">${orderBar()}<div class="kk-grid">${sortList(list).map(cardHtml).join('')}</div></div><div class="kk-right"></div></div>`
        : '<div class="kk-empty">Bu ayarlarla kupon bulunamadı. En az oranı düşür, saat aralığını ya da lig seçimini genişlet.</div>');
      showDetail();
    } catch (err) {
      out.innerHTML = `<div class="kk-empty is-bad">Hesaplanamadı: ${esc(err?.message || err)}</div>`;
    } finally {
      busy = false;
      go.disabled = false;
    }
  }

  // Küçük açıklama balonu: ⓘ'nin üstünde (yer yoksa altında) çıkar; kaydırma alanına kırpılmasın diye sabit konumlu.
  let tip = null;
  let tipPinned = false;
  function showTip(el, pin = false) {
    if (!tip) { tip = document.createElement('div'); tip.className = 'kk-tip'; modal.appendChild(tip); }
    if (pin) tipPinned = !(tipPinned && tip.dataset.for === el.dataset.tip);
    tip.dataset.for = el.dataset.tip;
    tip.textContent = el.dataset.tip;
    tip.hidden = pin && !tipPinned;
    const r = el.getBoundingClientRect();
    const w = 280;
    tip.style.width = `${w}px`;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    const h = tip.offsetHeight;
    tip.style.top = `${r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8}px`;
  }
  function hideTip() { if (tip) tip.hidden = true; }

  function openModal() {
    if (modal) { modal.hidden = false; refreshLeagues(); return; }
    modal = document.createElement('div');
    modal.className = 'kk-modal';
    modal.innerHTML = '<div class="kk-backdrop"></div><section class="kk-box" role="dialog" aria-label="Kupon oluşturucu">'
      + '<header class="kk-head"><div><h2>Kupon oluşturucu</h2><p>Goal Mix · sitenin maç oranlarından adil oran</p></div><button type="button" class="kk-x" aria-label="Kapat">×</button></header>'
      + '<div class="kk-form"></div><div class="kk-out"><div class="kk-empty">Ayarları seçip <b>Kuponları oluştur</b>a bas. Maçlar 6q açıkken arka planda toplanıyor; veri hazırsa kuponlar birkaç saniyede çıkar.</div></div>'
      + '<footer class="kk-foot">Adil oran tahmindir, kazanç garantisi değildir. Eklenti bahis yapmaz; maçları Goal Mix listesinden kendin eklersin. Kupona basınca maçları ve yorumu açılır.</footer>'
      + '</section>';
    document.body.appendChild(modal);
    renderForm();
    ensureData(false).then(refreshLeagues).catch(() => {});
    modal.addEventListener('mouseover', (ev) => { const ib = ev.target.closest?.('.kk-i'); if (ib) showTip(ib); });
    modal.addEventListener('mouseout', (ev) => { if (ev.target.closest?.('.kk-i') && !tipPinned) hideTip(); });
    modal.addEventListener('input', (ev) => {
      if (!ev.target.classList.contains('kk-dd-search')) return;
      const q = ev.target.value.trim().toLocaleLowerCase('tr');
      modal.querySelectorAll('.kk-dd-item').forEach((x) => { x.hidden = !!q && !x.dataset.name.includes(q); });
    });
    modal.addEventListener('change', (ev) => {
      if (ev.target.closest?.('.kk-dd-item')) {
        const v = ev.target.value;
        state.leagues = ev.target.checked ? [...new Set([...state.leagues, v])] : state.leagues.filter((x) => x !== v);
        save();
        const btn = modal.querySelector('.kk-dd-btn');
        btn.textContent = leagueLabel();
        btn.title = state.leagues.join(', ');
        return;
      }
      if (ev.target.name !== 'stake') return;
      const v = Number(String(ev.target.value).replace(',', '.'));
      state.stake = v > 0 ? v : 1;
      save();
      redrawSet();
    });
    modal.addEventListener('focusin', (ev) => { if (ev.target.classList?.contains('kk-i')) showTip(ev.target); });
    modal.addEventListener('focusout', (ev) => { if (ev.target.classList?.contains('kk-i')) { tipPinned = false; hideTip(); } });
    modal.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t.closest('.kk-x') || t.classList.contains('kk-backdrop')) { modal.hidden = true; return; }
      const b = t.closest('.kk-seg button');
      if (b) {
        const segEl = b.parentElement;
        const name = segEl.dataset.name;
        if (name === 'order') { state.order = b.dataset.v; save(); redrawList(); return; }
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
      if (t.closest('.kk-go')) { autoNote = ''; run(); return; }
      if (t.closest('.kk-auto')) { runAuto(); return; }
      if (t.closest('.kk-refresh')) { run(true); return; }
      const ib = t.closest('.kk-i');
      if (ib) { showTip(ib, true); return; }
      const pk = t.closest('.kk-pick');
      if (pk) {
        const k = pk.dataset.key;
        if (offSet.has(k)) offSet.delete(k); else offSet.add(k);
        pk.classList.toggle('is-on', !offSet.has(k));
        redrawSet();
        return;
      }
      if (t.closest('.kk-set-all')) { offSet.clear(); modal.querySelectorAll('.kk-pick').forEach((x) => x.classList.add('is-on')); redrawSet(); return; }
      if (t.closest('.kk-set-none')) { lastList.forEach((c) => offSet.add(keyOf(c))); modal.querySelectorAll('.kk-pick').forEach((x) => x.classList.remove('is-on')); redrawSet(); return; }
      // Aynı anda tek kupon açık: pencere tek ekrana sığsın.
      const head = t.closest('.kk-card-head');
      if (head) { selKey = head.parentElement.dataset.key; showDetail(); return; }
      // Lig listesi
      if (t.closest('.kk-dd-btn')) {
        const p = modal.querySelector('.kk-dd-panel');
        p.hidden = !p.hidden;
        if (!p.hidden) { refreshLeagues(); p.querySelector('.kk-dd-search').focus(); }
        return;
      }
      if (t.closest('.kk-dd-clear')) { state.leagues = []; save(); refreshLeagues(); return; }
      if (t.closest('.kk-dd-close')) { modal.querySelector('.kk-dd-panel').hidden = true; return; }
      if (!t.closest('.kk-dd')) { const p = modal.querySelector('.kk-dd-panel'); if (p) p.hidden = true; }
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
