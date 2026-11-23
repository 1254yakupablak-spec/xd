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
  // Branşlar: futbolda toplam gol Poisson, basketbolda toplam sayı normal dağılım (ortalama + sapma) varsayılır.
  // Basketbolun bülten pazarı "Under/Over Including Overtime" (uzatmalar dahil), Goal Mix de uzatmalar dahil sayar.
  const SPORTS = {
    football: { key: 'football', label: 'Futbol', book: FOOTBALL, market: OU_MARKET, normal: false, dataKey: 'kkData', lockKey: 'kkLock', unit: 'gol', margin: 1.085, legs: 10 },
    basketball: { key: 'basketball', label: 'Basketbol', book: 48242, market: 28, normal: true, dataKey: 'kkDataBb', lockKey: 'kkLockBb', unit: 'sayı', margin: 1.08, legs: 5 },
  };
  const SPORT_KEYS = Object.keys(SPORTS);
  const PAGE_RE = /\/sportsbook\/goal-mix/;
  const COLLECT_HOURS = 168; // arka planda bu kadar saat (7 gün) içinde başlayacak bütün maçlar toplanır
  const MAX_EVENTS = 1200;
  // Uzak maçların oranları seyrek değişir: yenileme aralığı maça kalan süreye göre (siteyi gereksiz sorgulamamak için).
  const refreshTtl = (startsAt) => {
    const h = (Date.parse(startsAt) - Date.now()) / 3600e3;
    return h < 24 ? 20 * 60 * 1000 : h < 72 ? 2 * 3600 * 1000 : 6 * 3600 * 1000;
  };
  const DATA_KEY = 'kkData';
  const DATA_V = 6; // toplanan verinin biçimi; değişince eski kayıt bayat sayılır
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

  // Standart normal dağılım: Φ(z) ve tersi.
  function Phi(z) {
    const t = 1 / (1 + (0.3275911 * Math.abs(z)) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
    return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
  }
  function invPhi(p) {
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
    if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  // Basketbol: Alt/Üst çizgilerinden ortalama ve sapma. Her çizgide pay orantılı atılır, alt olasılığı p ise
  // çizgi = ortalama + sapma × Φ⁻¹(p). Çizgiler bu doğruya ağırlıklı (dengeli çizgi daha ağır) oturtulur.
  // Çizgiler sapmayı bulmaya yetmezse sd0 (yoksa maç başı 13 sayı) kullanılır.
  function normFit(lines, sd0 = null, n = 1) {
    const pts = [];
    for (const { line, over, under } of lines) {
      if (!(over > 1) || !(under > 1) || !Number.isFinite(line)) continue;
      const p = (1 / under) / (1 / over + 1 / under);
      if (p < 0.03 || p > 0.97) continue;
      pts.push({ y: line, z: invPhi(p), w: Math.max(0.05, 1 - Math.abs(p - 0.5) * 2) });
    }
    if (!pts.length) return null;
    const W = pts.reduce((t, x) => t + x.w, 0);
    const mz = pts.reduce((t, x) => t + x.w * x.z, 0) / W;
    const my = pts.reduce((t, x) => t + x.w * x.y, 0) / W;
    const vz = pts.reduce((t, x) => t + x.w * (x.z - mz) ** 2, 0) / W;
    let sd = vz > 0.01 ? pts.reduce((t, x) => t + x.w * (x.z - mz) * (x.y - my), 0) / W / vz : null;
    const lo = 6 * Math.sqrt(n);
    const hi = 30 * Math.sqrt(n);
    if (!(sd >= lo && sd <= hi)) sd = sd0 || 13 * Math.sqrt(n);
    return { mean: my - sd * mz, sd };
  }
  // P(toplam < çizgi): sd yoksa Poisson (futbol), varsa normal (basketbol).
  const pUnder = (line, mean, sd) => (sd ? Phi((line - mean) / sd) : cdf(Math.floor(line), mean));
  function underFn(mean, sd, K) {
    if (sd) return (line) => Phi((line - mean) / sd);
    const cs = cumPois(mean, K);
    return (line) => cs[Math.floor(line)] ?? 1;
  }
  // Taranacak çizgi aralığı [ilk, son, K]: futbolda 0.5'ten beklentinin iki katına, basketbolda ortalama ± 4.5 sapma.
  function lineSpan(a, b, sa, sb) {
    if (!sa) { const K = Math.ceil(Math.max(a, b) * 2 + 12); return [0.5, K - 0.5, K]; }
    const sd = Math.max(sa, sb || sa);
    return [Math.max(0.5, Math.floor(Math.min(a, b) - 4.5 * sd) + 0.5), Math.ceil(Math.max(a, b) + 4.5 * sd) - 0.5, 0];
  }
  // Kuponun toplam sapması (maçlar bağımsız): √Σσ². Futbolda (sapma yok) null.
  const sdOf = (legs, f) => (legs.some((x) => f(x)) ? Math.sqrt(legs.reduce((t, x) => t + (f(x) || 0) ** 2, 0)) : null);

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
  const mkCache = () => ({ gm: null, gmAt: 0, book: null, bookAt: 0, detail: new Map(), site: new Map() });
  const caches = { football: mkCache(), basketball: mkCache() };
  const FRESH = 10 * 60 * 1000;

  async function loadGoalMix(sp = 'football') {
    const cache = caches[sp];
    if (cache.gm && Date.now() - cache.gmAt < FRESH) return cache.gm;
    const all = [];
    for (let p = 1; p <= 30; p++) {
      const r = await getJ(`/goalmix/events?page=${p}&pageSize=100${sp === 'football' ? '' : `&sport=${sp}`}`);
      all.push(...(r.items || []));
      if (!r.items?.length || all.length >= (r.total || 0)) break;
    }
    cache.gm = all;
    cache.gmAt = Date.now();
    return all;
  }

  async function loadBook(sp = 'football') {
    const cache = caches[sp];
    if (cache.book && Date.now() - cache.bookAt < FRESH) return cache.book;
    const leagues = (await getJ(`/sports/${SPORTS[sp].book}/leagues`)).data || [];
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

  async function fairOf(bookId, startsAt = null, sp = 'football') {
    const cache = caches[sp];
    const S = SPORTS[sp];
    const hit = cache.detail.get(bookId);
    if (hit && Date.now() - hit.at < (startsAt ? refreshTtl(startsAt) : 20 * 60 * 1000)) return hit.v; // yakın maç 20 dk, uzak maç 2–6 sa
    const d = await getJ(`/events/${bookId}`);
    const m = (d.markets || []).find((x) => x.marketTypeId === S.market && x.status === 'OPEN');
    const by = {};
    for (const o of m?.outcomes || []) {
      if (!o.active) continue;
      const k = String(o.line);
      by[k] = by[k] || { line: Number(o.line) };
      if (/^\s*over\b/i.test(o.name)) by[k].over = Number(o.price);
      if (/^\s*under\b/i.test(o.name)) by[k].under = Number(o.price);
    }
    const lines = Object.values(by);
    let v = null;
    if (S.normal) {
      const f = normFit(lines);
      v = f ? { lam: f.mean, sd: f.sd } : null;
    } else {
      const lam = matchLambda(lines);
      v = lam ? { lam } : null;
    }
    cache.detail.set(bookId, { v, at: Date.now() });
    return v;
  }

  async function quote(ids, sp = 'football') {
    const r = await getJ(`/goalmix/quote?events=${encodeURIComponent([...ids].sort().join(','))}`);
    if (r.refused || (r.events || []).some((x) => x.available === false)) return null;
    const lines = (r.lines || []).map((l) => ({ line: Number(l.line), over: l.over == null ? null : Number(l.over), under: l.under == null ? null : Number(l.under) }));
    if (SPORTS[sp].normal) { const f = normFit(lines, null, ids.length); return { lines, lam: f?.mean ?? null, sd: f?.sd ?? null }; }
    return { lines, lam: fitLambda(lines) };
  }

  // Sitenin Goal Mix'te her maç için varsaydığı gol beklentisi: üç maçlık bir üçgenden referans maçın
  // beklentisi bulunur, sonra her maç referansla birlikte sorulur (λ toplanır).
  // Basketbolda sapma da aynı yolla bulunur (varyanslar toplanır).
  async function siteLambdas(items, onStep, sp = 'football') {
    const cache = caches[sp];
    const nrm = SPORTS[sp].normal;
    const startOf = new Map(items.map((x) => [x.g.id, x.g.startsAt]));
    const has = (id) => { const h = cache.site.get(id); return !!h && Date.now() - h.at < Math.max(SITE_FRESH, startOf.has(id) ? refreshTtl(startOf.get(id)) : 0); };
    const put = (id, v, vr = null) => cache.site.set(id, { v, vr, at: Date.now() });
    const need = items.filter((x) => !has(x.g.id));
    if (need.length) {
      const pool3 = items.slice(0, 3);
      if (pool3.length < 3) return;
      const [a, b, c] = pool3;
      const [ab, ac, bc] = await Promise.all([quote([a.g.id, b.g.id], sp), quote([a.g.id, c.g.id], sp), quote([b.g.id, c.g.id], sp)]);
      if (!ab?.lam || !ac?.lam || !bc?.lam) throw new Error('Goal Mix fiyatı alınamadı');
      const la = (ab.lam + ac.lam - bc.lam) / 2;
      const va = nrm ? Math.max(25, (ab.sd ** 2 + ac.sd ** 2 - bc.sd ** 2) / 2) : null;
      const vr = (q) => (nrm ? Math.max(25, q.sd ** 2 - va) : null);
      put(a.g.id, la, va);
      put(b.g.id, ab.lam - la, vr(ab));
      put(c.g.id, ac.lam - la, vr(ac));
      const rest = items.filter((x) => !has(x.g.id));
      let done = 0;
      await pool(rest, 4, async (x) => {
        const q = await quote([a.g.id, x.g.id], sp);
        if (q?.lam) put(x.g.id, q.lam - la, vr(q));
        onStep(++done, rest.length);
      });
    }
    for (const x of items) {
      const h = cache.site.get(x.g.id);
      x.site = h?.v ?? null;
      x.siteSd = h?.vr ? Math.sqrt(h.vr) : null;
    }
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
  function allLines(lines, lamFair, sides, minOdds, maxOdds, sort, opts = {}, sdFair = null) {
    const out = [];
    for (const l of lines) {
      if (!lineOk(l.line, opts)) continue;
      const pu = pUnder(l.line, lamFair, sdFair);
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

  function bestLine(lines, lamFair, sides, minOdds, maxOdds, sort, opts = {}, sdFair = null) {
    let best = null;
    for (const l of lines) {
      if (!lineOk(l.line, opts)) continue;
      const pu = pUnder(l.line, lamFair, sdFair);
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
  const datas = { football: null, basketball: null };
  const collectingBy = {};
  const D = () => datas[state.sport];

  // Kayıttaki değerler belleğe alınır: sayfa yenilense de aynı maçlar baştan sorulmaz.
  function seed(d, sp = 'football') {
    const cache = caches[sp];
    for (const e of d?.events || []) {
      if (e.siteAt && !cache.site.has(e.id)) cache.site.set(e.id, { v: e.site, vr: e.siteSd ? e.siteSd ** 2 : null, at: e.siteAt });
      if (e.src === '6q' && e.bookId && e.lamAt && !cache.detail.has(e.bookId)) cache.detail.set(e.bookId, { v: { lam: e.lam, sd: e.sd || null }, at: e.lamAt });
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

  // ---------- ilerleme ----------
  // Veri toplama kim başlatırsa başlatsın (arka plan ya da düğme) ilerlemesi buradan yayılır; pencere açıksa düğmede
  // ve ana alanda yüzde olarak görünür.
  const progs = {}; // branş → { pct, text }
  const progSubs = new Set();
  function setProg(pct, text, sp = 'football') {
    progs[sp] = pct == null ? null : { pct: Math.max(0, Math.min(100, Math.round(pct))), text };
    progSubs.forEach((f) => { try { f(progs[sp], sp); } catch { /* yok */ } });
  }
  const progFor = () => progs[state.sport] || null;

  async function collect(say = () => {}, sp = 'football') {
    const S = SPORTS[sp];
    const foot = sp === 'football';
    const pre = foot ? '' : `${S.label}: `;
    const st = (pct, t) => { setProg(pct, pre + t, sp); say(pre + t); };
    const now = Date.now();
    st(2, 'Goal Mix maç listesi alınıyor…');
    const gm = (await loadGoalMix(sp)).filter((g) => {
      const t = Date.parse(g.startsAt);
      return t > now + 3 * 60 * 1000 && t < now + COLLECT_HOURS * 3600 * 1000;
    }).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, MAX_EVENTS);

    // Her maçın beklentisi 6q'nun normal bültenindeki Alt/Üst oranlarından.
    if (foot) await loadAliases();
    const items = gm.map((g) => ({ g, fair: null }));
    st(8, 'Sitenin bülteni alınıyor…');
    const pairs = pairUp(gm, await loadBook(sp));
    const byId = new Map(pairs.map((p) => [p.g.id, p.e]));
    let n = 0;
    await pool(items.filter((it) => byId.has(it.g.id)), 6, async (it) => {
      const e = byId.get(it.g.id);
      const v = await fairOf(e.id, it.g.startsAt, sp);
      if (v?.lam) it.fair = { lam: v.lam, sd: v.sd || null, src: '6q', at: caches[sp].detail.get(e.id)?.at || now, bookId: e.id };
      ++n;
      st(12 + (43 * n) / Math.max(1, byId.size), `Maç oranları okunuyor… ${n}/${byId.size}`);
    });

    // Bültende Alt/Üst oranı olmayan maçlar: günlük görevin yazdığı YZ tahmini (varsa) kullanılır. Basketbolda tahmin
    // toplam sayıdır (uzatmalar dahil); sapma verilmediyse 17 sayı (bültenden çıkan tipik değer) alınır.
    const yz = await loadYz();
    for (const it of items) {
      const t = yz[it.g.id];
      if (it.fair || !t) continue;
      const lam = Number(t.lam);
      const ok = S.normal ? lam > 80 && lam < 330 && (t.sport || 'football') === sp : lam > 0.3 && lam < 9 && (t.sport || 'football') === 'football';
      if (!ok) continue;
      const sd = S.normal ? (Number(t.sd) >= 8 && Number(t.sd) <= 30 ? Number(t.sd) : 17) : null;
      it.fair = { lam, sd, src: 'yz', at: Date.parse(t.at) || now, note: String(t.note || '').slice(0, 300) };
    }
    const missing = items.filter((it) => !it.fair || it.fair.src === 'yz').map((it) => ({
      id: it.g.id, home: it.g.home, away: it.g.away, league: it.g.league?.name || '', leagueId: it.g.league?.id || '', country: it.g.country?.code || '',
      startsAt: it.g.startsAt, sport: sp, yz: it.fair?.src === 'yz' ? it.fair.lam : null,
    }));

    let forms = new Map();
    if (foot) {
      st(55, 'Takım formları okunuyor…');
      try {
        forms = await loadForms(items.map((it) => it.g), (t) => { const m = /(\d+)\/(\d+)/.exec(t); st(55 + (m ? (10 * m[1]) / Math.max(1, m[2]) : 0), t); });
      } catch { /* form yoksa da devam */ }
    }
    const priced = items.filter((it) => it.fair?.lam);
    st(65, 'Goal Mix fiyatları okunuyor…');
    if (priced.length >= 3) await siteLambdas(priced, (i, t) => st(65 + (33 * i) / Math.max(1, t), `Goal Mix fiyatları okunuyor… ${i}/${t}`), sp);
    const events = priced.filter((x) => x.site != null && x.site > 0.2).map((x) => ({
      id: x.g.id,
      bookId: x.fair.bookId || null,
      home: x.g.home,
      away: x.g.away,
      league: x.g.league?.name || '',
      leagueId: x.g.league?.id || '',
      logoId: byId.get(x.g.id)?.leagueId || null,
      country: x.g.country?.code || '',
      startsAt: x.g.startsAt,
      lam: x.fair.lam,
      sd: x.fair.sd || null,
      src: x.fair.src,
      note: x.fair.note || '',
      lamAt: x.fair.at,
      form: forms.get(x.g.id) || null,
      site: x.site,
      siteSd: x.siteSd || null,
      siteAt: caches[sp].site.get(x.g.id)?.at || now,
    }));
    const d = { at: Date.now(), sport: sp, total: gm.length, matched: pairs.length, formFound: forms.size, yzCount: events.filter((e) => e.src === 'yz').length, events, missing, v: DATA_V };
    datas[sp] = d;
    if (foot) calLogMatches(events).catch(() => {});
    await store.set(S.dataKey, d);
    setProg(null, null, sp);
    publishMissing();
    return d;
  }

  // YZ tahmin dosyası (GitHub'da herkese açık): { at, matches: { <Goal Mix maç no>: { lam, note, at, home, away } } }.
  async function loadYz() {
    const r = await ask({ type: 'fetchYz' });
    return r?.ok && r.v?.matches && typeof r.v.matches === 'object' ? r.v.matches : {};
  }

  // Bültende oranı olmayan maçlar sayfada gizli bir JSON olarak durur (#kk-missing): günlük YZ tahmin görevi okur.
  // Sadece maç adları, lig ve saat içerir.
  // İki branşın eksik maçları tek listede (her maçta sport alanı: football | basketball).
  function publishMissing() {
    const parts = SPORT_KEYS.map((k) => datas[k]).filter(Boolean);
    if (!parts.length || !document.body) return;
    let el = document.getElementById('kk-missing');
    if (!el) {
      el = document.createElement('script');
      el.type = 'application/json';
      el.id = 'kk-missing';
      document.body.appendChild(el);
    }
    // YZ görevi sadece önümüzdeki 48 saati tahmin eder (uzak maçlar sonraki çalışmalarda gelir).
    const lim = Date.now() + 48 * 3600 * 1000;
    el.textContent = JSON.stringify({
      at: new Date(Math.max(...parts.map((d) => d.at))).toISOString(),
      total: parts.reduce((t, d) => t + (d.total || 0), 0),
      missing: parts.flatMap((d) => (d.missing || []).filter((m) => Date.parse(m.startsAt) < lim).map((m) => ({ ...m, sport: m.sport || d.sport || 'football' }))),
    });
  }

  // Tek seferde bir toplama (branş başına); force değilse veri tazeyse ya da başka sekme topluyorsa beklenmez.
  async function ensureData(force, say, sp = state.sport) {
    if (collectingBy[sp]) return collectingBy[sp];
    const S = SPORTS[sp];
    if (!datas[sp]) { datas[sp] = await store.get(S.dataKey); seed(datas[sp], sp); }
    if (!force && fresh(datas[sp])) return datas[sp];
    collectingBy[sp] = (async () => {
      await store.set(S.lockKey, Date.now());
      try { return await collect(say, sp); } finally { collectingBy[sp] = null; if (progs[sp]) setProg(null, null, sp); }
    })();
    return collectingBy[sp];
  }

  // ---------- kalibrasyon: tahminleri gerçek sonuçlarla ölçme ----------
  // Her toplamada maçların maç öncesi tahmini (adil λ, sitenin λ'sı, kaynak) kaydedilir; oluşturulan kuponlar da
  // (olasılık, oran, çizgi) kaydedilir. Maç başladıktan sonra 6q bülteninden skor izlenir; bitince 90 dakikanın toplam
  // golü yazılır. Kalibrasyon sekmesi "%60 dediklerimiz gerçekten %60 tuttu mu" sorusunu cevaplar. 14 gün saklanır.
  const CAL_KEY = 'kkCal';
  const CAL_DAYS = 14;
  let cal = null;
  let calLastUpd = 0;
  async function calLoad() {
    if (cal) return cal;
    const v = await store.get(CAL_KEY);
    cal = v && typeof v === 'object' ? { matches: v.matches || {}, coupons: v.coupons || [] } : { matches: {}, coupons: [] };
    return cal;
  }
  const calSave = () => store.set(CAL_KEY, cal);
  function calPrune() {
    const lim = Date.now() - CAL_DAYS * 86400e3;
    for (const [id, m] of Object.entries(cal.matches)) if (Date.parse(m.startsAt) < lim) delete cal.matches[id];
    cal.coupons = cal.coupons.filter((c) => c.at > lim).slice(-3000);
  }
  // Maç öncesi tahmin: başlamadan önceki son değer tutulur.
  async function calLogMatches(events) {
    await calLoad();
    const now = Date.now();
    for (const e of events) {
      if (Date.parse(e.startsAt) <= now) continue;
      const old = cal.matches[e.id];
      cal.matches[e.id] = { ...(old || {}), bookId: e.bookId || old?.bookId || null, home: e.home, away: e.away, league: e.league, startsAt: e.startsAt, lam: e.lam, site: e.site, src: e.src || '6q', at: now };
    }
    calPrune();
    await calSave();
  }
  async function calLogCoupons(list) {
    await calLoad();
    const now = Date.now();
    const have = new Set(cal.coupons.map((c) => c.key));
    for (const c of list) {
      const key = keyOf(c);
      if (have.has(key)) continue;
      have.add(key);
      cal.coupons.push({ key, at: now, side: c.side, line: c.line, odds: c.odds, p: c.p, ev: c.ev, lam: c.lamFair, legs: c.legs.map((m) => m.g.id) });
    }
    calPrune();
    await calSave();
  }
  // Skor izleme: başlamış maçların bülten kaydı 10 dakikada bir sorulur. Bitince (ya da kayıt silinince, son görülen
  // dakika 88+ ise) 90 dakikanın skoru yazılır. Uzatmaya giden (120+ dk) maçlar ölçümden çıkarılır.
  async function calUpdate(force = false) {
    const now = Date.now();
    if (!force && now - calLastUpd < 5 * 60 * 1000) return;
    calLastUpd = now;
    await calLoad();
    const due = Object.values(cal.matches).filter((m) => {
      const t = Date.parse(m.startsAt);
      return !m.res && m.bookId && t + 30 * 60 * 1000 < now && t > now - 3 * 86400e3 && (!m.chk || now - m.chk > 10 * 60 * 1000);
    }).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).slice(0, 30);
    if (!due.length) return;
    const fin = (m, h, a, sec) => { m.res = sec != null && sec > 115 * 60 ? { void: 'uzatma' } : { h, a, total: h + a, at: now }; };
    await pool(due, 3, async (m) => {
      m.chk = now;
      const t = Date.parse(m.startsAt);
      let ev = null;
      try { ev = await getJ(`/events/${m.bookId}`); } catch (err) { ev = { gone: String(err?.message || err) }; }
      const ls = ev?.liveScore;
      const st = `${ev?.status || ''}/${ls?.status || ''}`;
      if (ls && ls.home != null && /END|FIN|CLOS|COMPLET|AFTER/i.test(st)) { fin(m, Number(ls.home), Number(ls.away), ls.clockSeconds); return; }
      if (ls && ls.home != null) m.last = { h: Number(ls.home), a: Number(ls.away), sec: Number(ls.clockSeconds) || null, at: now };
      const late = t + 3 * 3600 * 1000 < now;
      if ((ev?.gone || late) && m.last && (m.last.sec || 0) >= 88 * 60) { fin(m, m.last.h, m.last.a, m.last.sec); return; }
      if (late && t + 8 * 3600 * 1000 < now) m.res = { void: 'sonuç yok' };
      if (/CANCEL|POSTPON|ABANDON/i.test(st)) m.res = { void: 'ertelendi' };
    });
    await calSave();
  }

  // Ölçüm: maç düzeyi (beklenen gol, 1.5/2.5/3.5 üst olasılığı) ve kupon düzeyi (olasılık dilimlerine göre tutma).
  function calStats() {
    if (!cal) return null;
    const done = Object.values(cal.matches).filter((m) => m.res && m.res.total != null);
    const pending = Object.values(cal.matches).filter((m) => !m.res && Date.parse(m.startsAt) <= Date.now()).length;
    const grp = (arr) => {
      if (!arr.length) return null;
      const avg = (f) => arr.reduce((t, m) => t + f(m), 0) / arr.length;
      const lines = [1.5, 2.5, 3.5].map((L) => ({ L, pred: avg((m) => 1 - cdf(Math.floor(L), m.lam)), act: avg((m) => (m.res.total > L ? 1 : 0)) }));
      const brier = avg((m) => { const p = 1 - cdf(2, m.lam); const o = m.res.total > 2.5 ? 1 : 0; return (p - o) ** 2; });
      return { n: arr.length, lam: avg((m) => m.lam), site: avg((m) => m.site || m.lam), goals: avg((m) => m.res.total), lines, brier };
    };
    const byRes = new Map(done.map((m) => [Object.keys(cal.matches).find((k) => cal.matches[k] === m), m]));
    const coupons = [];
    for (const c of cal.coupons) {
      const legs = c.legs.map((id) => cal.matches[id]);
      if (legs.some((m) => !m || !m.res)) continue;
      if (legs.some((m) => m.res.total == null)) continue;
      const total = legs.reduce((t, m) => t + m.res.total, 0);
      coupons.push({ ...c, hit: c.side === 'OVER' ? total > c.line : total < c.line, total });
    }
    const BUCKETS = [[0, 0.2], [0.2, 0.4], [0.4, 0.6], [0.6, 0.8], [0.8, 1.01]];
    const buckets = BUCKETS.map(([lo, hi]) => {
      const arr = coupons.filter((c) => c.p >= lo && c.p < hi);
      return { lo, hi, n: arr.length, pred: arr.length ? arr.reduce((t, c) => t + c.p, 0) / arr.length : null, act: arr.length ? arr.filter((c) => c.hit).length / arr.length : null };
    });
    const roi = coupons.length ? coupons.reduce((t, c) => t + (c.hit ? c.odds : 0), 0) / coupons.length - 1 : null;
    const sides = ['OVER', 'UNDER'].map((sd) => {
      const arr = coupons.filter((c) => c.side === sd);
      return { side: sd, n: arr.length, pred: arr.length ? arr.reduce((t, c) => t + c.p, 0) / arr.length : null, act: arr.length ? arr.filter((c) => c.hit).length / arr.length : null };
    });
    void byRes;
    return {
      matches: grp(done), m6q: grp(done.filter((m) => m.src !== 'yz')), myz: grp(done.filter((m) => m.src === 'yz')),
      logged: Object.keys(cal.matches).length, pending, coupons: coupons.length, loggedCoupons: cal.coupons.length, buckets, roi, sides,
    };
  }

  async function backgroundTick() {
    calUpdate().catch(() => {});
    for (const sp of SPORT_KEYS) {
      try {
        if (collectingBy[sp]) continue;
        const S = SPORTS[sp];
        datas[sp] = (await store.get(S.dataKey)) || datas[sp];
        seed(datas[sp], sp);
        publishMissing();
        if (fresh(datas[sp])) continue;
        const lock = await store.get(S.lockKey);
        if (lock && Date.now() - lock < 3 * 60 * 1000) continue; // başka sekme topluyor
        await ensureData(true, undefined, sp);
      } catch {
        // Ağ hatası: bir sonraki turda tekrar denenir.
      }
    }
  }

  // ---------- ana hesap ----------
  // ---------- en iyi ayarı bul ----------
  // Alt/Üst × maç sayısı (kullanıcının aralığında) kombinasyonları kendi tahminimizle taranır (gerçek oran sorulmaz, hızlı); oran aralığı
  // kullanıcınınki olarak kalır. Her ayarda en iyi N kuponun ortalama puanı (Öncelik'e göre: olasılık ya da değer)
  // hesaplanır, en yükseği seçilir. Oran, başlama, lig, YZ, kupon sayısı, tekrar modu ve tutar değişmez; çizgi sınırı
  // kaldırılır.
  async function autoTune(opts, say) {
    const now = Date.now();
    const sp = opts.sport || 'football';
    await ensureData(false, say, sp);
    const data = datas[sp];
    if (!data?.events?.length) throw new Error('Maç verisi toplanamadı. Biraz sonra tekrar dene.');
    const items = data.events.filter((e) => {
      const t = Date.parse(e.startsAt);
      return t > now + 3 * 60 * 1000 && t < now + opts.hours * 3600 * 1000
        && (!opts.leagues?.length || leagueSelected(e, opts.leagues))
        && (opts.useYz === 1 || e.src !== 'yz');
    }).map((e) => ({ lam: e.lam, site: e.site, sd: e.sd || null, siteSd: e.siteSd || null, edge: e.lam - e.site }));
    if (items.length < 2) throw new Error('Bu saat aralığında yeterli maç yok. Başlama aralığını genişlet.');
    const N = opts.count;
    const MARGIN = SPORTS[sp].margin;
    // Maç sayısı kullanıcının seçtiği aralıkta (en az – en çok) taranır.
    const ks = (opts.sizes?.length ? opts.sizes : [2, 3, 4, 5]).filter((k) => k >= 2 && k <= Math.min(legMax[sp], items.length));
    const AUTO_BANDS = [[opts.minOdds, opts.maxOdds + 1e-9]];
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
          const sf = sdOf(c, (x) => x.sd);
          const ss = sdOf(c, (x) => x.siteSd) ?? sf;
          const [lo, hi, K] = lineSpan(ls, lf, ss, sf);
          const us = underFn(ls, ss, K);
          const uf = underFn(lf, sf, K);
          const per = new Array(AUTO_BANDS.length).fill(null);
          for (let line = lo; line <= hi + 1e-9; line += 1) {
            const ps = side === 'OVER' ? 1 - us(line) : us(line);
            if (ps < 1e-4) continue;
            const odds = 1 / (ps * MARGIN);
            const b = AUTO_BANDS.findIndex(([lo, hi]) => odds >= lo && odds < hi);
            if (b < 0) continue;
            const pf = side === 'OVER' ? 1 - uf(line) : uf(line);
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
    if (!best) throw new Error('Bu oran aralığı ve başlama/lig seçiminde uygun ayar bulunamadı. Oran ya da başlama aralığını genişlet.');
    return best;
  }

  async function build(opts, say, force = false) {
    const now = Date.now();
    const sp = opts.sport || 'football';
    await ensureData(force, say, sp);
    const data = datas[sp];
    if (!data?.events?.length) throw new Error('Maç verisi toplanamadı. Biraz sonra tekrar dene.');
    const items = data.events
      .filter((e) => {
        const t = Date.parse(e.startsAt);
        return t > now + 3 * 60 * 1000 && t < now + opts.hours * 3600 * 1000
          && (!opts.leagues?.length || leagueSelected(e, opts.leagues))
          && (opts.useYz === 1 || e.src !== 'yz');
      })
      // Yüzdeler sadece oranlardan: oranlar formu zaten içerir. Form kartta bilgi olarak gösterilir.
      .map((e) => ({ g: { id: e.id, home: e.home, away: e.away, startsAt: e.startsAt, league: { name: e.country ? `${e.league} · ${countryName(e.country)}` : e.league } }, fair: { lam: e.lam, sd: e.sd || null, mkt: e.lam, src: e.src || '6q', note: e.note || '' }, form: e.form || null, site: e.site, siteSd: e.siteSd || null, edge: e.lam - e.site }));
    if (items.length < 2) throw new Error('Bu saat aralığında adil oranı hesaplanmış yeterli maç yok. Başlama aralığını genişlet (48 sa, 72 sa ya da 7 gün).');
    let n = 0;

    const sides = opts.side === 'BOTH' ? ['OVER', 'UNDER'] : [opts.side];
    // Kombinasyonlar önce yerel tahminle sıralanır (sitenin oranı ≈ kendi λ'sıyla Poisson + pay), en iyilerinin
    // gerçek Goal Mix oranı sorulur.
    const MARGIN = SPORTS[sp].margin;
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
            const sf = sdOf(c, (x) => x.fair.sd);
            const ss = sdOf(c, (x) => x.siteSd) ?? sf;
            const [l0, h0, K] = lineSpan(ls, lf, ss, sf);
            const us = underFn(ls, ss, K);
            const uf = underFn(lf, sf, K);
            const lo = Math.max(l0, opts.minLine ?? l0);
            const hi = Math.min(h0, opts.maxLine ?? h0);
            for (let line = lo; line <= hi + 1e-9; line += 1) {
              const psU = us(line);
              const ps = side === 'OVER' ? 1 - psU : psU;
              if (ps < 1e-4) continue;
              const odds = 1 / (ps * MARGIN);
              if (odds < opts.minOdds || odds > opts.maxOdds) continue;
              const pfU = uf(line);
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
      const q = await quote(x.c.map((m) => m.g.id), sp);
      if (!q) return null;
      const lf = x.c.reduce((t, m) => t + m.fair.lam, 0);
      const sf = sdOf(x.c, (m) => m.fair.sd);
      const all = allLines(q.lines, lf, [x.side], opts.minOdds, opts.maxOdds, opts.sort, opts, sf).map((b) => ({ ...b, legs: x.c, lamFair: lf, sdFair: sf, lamSite: q.lam, sport: sp }));
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
    let qTotal = 0;
    n = 0;
    for (let round = 0; round < 4 && pickDiverse(list).length < opts.count && from < cands.length; round++) {
      const pick = [];
      while (from < cands.length && pick.length < Math.max(MAX_QUOTES, opts.count + 10)) {
        const x = cands[from++];
        if (x.c.some((m) => (used.get(m.g.id) || 0) >= maxUse * (round + 1))) continue;
        pick.push(x);
        for (const m of x.c) used.set(m.g.id, (used.get(m.g.id) || 0) + 1);
      }
      qTotal += pick.length;
      const res = await pool(pick, 4, async (x) => {
        const r = await priceOf(x);
        say(`Kuponların oranı soruluyor… ${++n}/${qTotal}`);
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

  // ---------- arayüz (5.0: baştan) ----------
  // Yerleşim: üst bar (sekmeler: Kupon oluştur / Favoriler) · solda ayarlar (dikey bölümler, altta sabit düğme) ·
  // ana alanda kupon seti özeti, kupon listesi ve seçili kuponun ayrıntısı. Favoriler aynı görünümü kullanır.
  let fab = null;
  let modal = null;
  let busy = false;
  // Futbol ve basketbolun ayarları ayrı saklanır (branş değişince kendi ayarları gelir).
  const DEFAULTS = {
    football: { side: 'OVER', sort: 'PROB', minOdds: 1.5, maxOdds: 4, minLine: null, maxLine: null, minLegs: 2, maxLegs: 5, repeat: 1, stake: 1, leagues: [], useYz: 0, auto: 0, sizes: [2, 3, 4, 5], hours: 24, count: 10 },
    basketball: { side: 'OVER', sort: 'PROB', minOdds: 1.5, maxOdds: 4, minLine: null, maxLine: null, minLegs: 2, maxLegs: 3, repeat: 1, stake: 1, leagues: [], useYz: 0, auto: 0, sizes: [2, 3], hours: 48, count: 10 },
  };
  const OPTS_KEY = (sp) => (sp === 'football' ? 'kkGoalMixOpts' : `kkGoalMixOpts_${sp}`);
  const state = {};
  function loadState(sp) {
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, JSON.parse(JSON.stringify(DEFAULTS[sp])));
    try { Object.assign(state, JSON.parse(localStorage.getItem(OPTS_KEY(sp)) || '{}')); } catch { /* yok */ }
    delete state.formW;
    state.sport = sp;
    if (![12, 24, 48, 72, 168].includes(state.hours)) state.hours = DEFAULTS[sp].hours; // eski 6 sa seçeneği kalktı
  }
  loadState(SPORTS[localStorage.getItem('kkSport')] ? localStorage.getItem('kkSport') : 'football');
  // Goal Mix'in izin verdiği en çok maç, branş başına (sitenin ayarı; okunamazsa futbol 10, basketbol 5).
  const legMax = Object.fromEntries(SPORT_KEYS.map((k) => [k, SPORTS[k].legs]));
  getJ('/goalmix/config').then((c) => {
    for (const k of SPORT_KEYS) {
      const m = c?.sports?.[k]?.maxMatches ?? (k === 'football' ? c?.maxMatches : null);
      if (m >= 2) legMax[k] = Math.min(15, m);
    }
  }).catch(() => {});
  const maxLegsNow = () => legMax[state.sport] || 10;
  const legRange = () => {
    const a = Math.max(2, Math.min(state.minLegs || 2, maxLegsNow()));
    const b = Math.max(a, Math.min(state.maxLegs || a, maxLegsNow()));
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  };

  const sideTxt = (s) => (s === 'OVER' ? 'Üst' : 'Alt');
  const trRes = (r) => String(r || '').replace(/W/g, 'G').replace(/D/g, 'B').replace(/L/g, 'M');
  const ICON = {
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>',
    ball: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7l4 3-1.5 4.5h-5L8 10z"/></svg>',
    bball: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.7 5.7c2.8 3 2.8 9.6 0 12.6M18.3 5.7c-2.8 3-2.8 9.6 0 12.6"/></svg>',
    spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  };

  // ---------- maç satırı, yorum ----------
  function teamFormHtml(label, x) {
    if (!x) return '';
    const dots = [...trRes(x.res)].map((r) => `<i class="kk-r kk-r--${r}">${r}</i>`).join('');
    return `<span class="kk-tf"><em>${label}</em><span class="kk-dots">${dots}</span><small>${x.gf.toFixed(1)}–${x.ga.toFixed(1)} · üst ${x.over}/${x.n}</small></span>`;
  }
  function formHtml(f) {
    if (!f) return '<span class="kk-leg-form is-none">—</span>';
    return `<span class="kk-leg-form">${teamFormHtml('Ev', f.h)}${teamFormHtml('Dep', f.a)}</span>`;
  }
  function legHtml(m) {
    const t = Date.parse(m.g.startsAt);
    const started = t <= Date.now();
    return `<li class="kk-leg${started ? ' is-started' : ''}"><span class="kk-leg-time"><b>${esc(hm(t))}</b><small>${esc(day(t))}</small></span>`
      + `<span class="kk-leg-teams"><b>${esc(m.g.home)} <span class="kk-vs">–</span> ${esc(m.g.away)}</b><small>${esc(m.g.league?.name || '')}</small></span>`
      + `<span class="kk-leg-xg"><b>${f2(m.fair.lam)}${m.fair.src === 'yz' ? ` <em class="kk-yz" title="${esc(m.fair.note || 'Yapay zekâ tahmini')}">YZ</em>` : ''}</b><small>site ${f2(m.site)}</small></span>`
      + `${formHtml(m.form)}</li>`;
  }
  const legsHead = () => `<li class="kk-leg kk-leg--head"><span>Saat</span><span>Maç</span><span>Beklenen ${SPORTS[state.sport].unit} ${info(TIP.xg)}</span><span>Son 5 maç ${info(TIP.formLeg)}</span></li>`;

  // Kuponun olasılığının nereden geldiğini anlatan kısa yorum (sayılardan üretilir).
  function commentText(c) {
    const u = SPORTS[c.sport || 'football'].unit;
    const over = c.side === 'OVER';
    const need = over ? Math.ceil(c.line) : Math.floor(c.line);
    const gap = c.lamFair - c.line;
    const legs = [...c.legs].sort((a, b) => b.fair.lam - a.fair.lam);
    const name = (m) => `${m.g.home}-${m.g.away}`;
    const s = [];
    s.push(`Bu ${c.legs.length} maçta toplam yaklaşık ${c.lamFair.toFixed(1)} ${u} bekleniyor; kupon ${over ? `en az ${need}` : `en fazla ${need}`} ${u} istiyor.`);
    if (c.sdFair) s.push(`Toplamın oynaklığı ±${c.sdFair.toFixed(1)} ${u} (maçların üçte ikisi bu aralıkta biter).`);
    const sideW = over ? (gap > 0 ? 'üstünde' : 'altında') : (gap < 0 ? 'altında' : 'üstünde');
    const helps = over ? gap > 0 : gap < 0;
    s.push(`Beklenen ${u} çizginin ${Math.abs(gap).toFixed(1)} ${sideW}; ${helps ? 'bu kuponun lehine' : 'bu kuponun aleyhine'}, tutma olasılığı bu yüzden %${(c.p * 100).toFixed(0)}.`);
    if (over) s.push(`En çok ${u} beklenen maç ${name(legs[0])} (${legs[0].fair.lam.toFixed(1)}). En zayıf halka ${name(legs[legs.length - 1])} (${legs[legs.length - 1].fair.lam.toFixed(1)} ${u}).`);
    else s.push(`En büyük risk ${name(legs[0])}: tek başına ${legs[0].fair.lam.toFixed(1)} ${u} bekleniyor.`);
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
      s.push(`Site bu maçlara ${c.lamSite.toFixed(1)} ${u} biçmiş, normal maç oranları ${c.lamFair.toFixed(1)} gösteriyor; ${effect} (değer ${pct(c.ev)}).`);
    }
    return s.join(' ');
  }

  const TIP = {
    sort: 'Olasılık: tutma ihtimali en yüksek kuponlar önce gelir (sitenin payından kötü olanlar elenir). Değer: sitenin oranının adil orandan en yüksek olduğu kuponlar önce gelir.',
    ev: 'Değer = tutma olasılığı × oran − 1. Örnek: %60 olasılık ve 1.80 oran → 0.60 × 1.80 − 1 = +%8. Artı ise site adil orandan yüksek oran veriyor (uzun vadede lehine), eksi ise düşük veriyor. Tek kuponun tutacağını göstermez.',
    fair: 'Adil oran = 1 ÷ tutma olasılığı. Sitenin payı olmasaydı bu kupona verilmesi gereken oran.',
    prob: 'Tutma olasılığı: maçların normal Alt/Üst oranlarından payı çıkarılarak bulunan gol beklentisiyle hesaplanır. Oran yükseldikçe olasılık düşer (yaklaşık 1 ÷ oran).',
    data: 'Ekranda görünenler değil, önümüzdeki 7 gündeki bütün Goal Mix maçları okunur (yakın maçların oranları 20 dakikada, 1–3 gün sonrakiler 2 saatte, daha uzaktakiler 6 saatte bir yenilenir). Adil oran 6q\'nun normal bültenindeki maç sonu Alt/Üst oranlarından hesaplanır: 1.5–4.5 arası dengeli çizgilerden payı atılmış olasılıklarla beklenen gol (Poisson) bulunur, ortancası alınır. Bültende Alt/Üst oranı olmayan maç kuponlara girmez (YZ tahmini dahil edilmedikçe). Basketbolda bültenin uzatmalar dahil Alt/Üst çizgilerinden maçın beklenen sayısı ve oynaklığı (normal dağılım) bulunur; Goal Mix de uzatmaları sayar.',
    order: 'Oluşan kuponları yeniden sıralar; hesap değişmez.',
    auto: 'Açıkken Kuponları oluştur önce senin oran ve maç sayısı aralığında Alt/Üst ve maç sayısı kombinasyonlarını tarar; Öncelik\'e göre en iyi kupon setini veren ayarı seçer ve kuponları onunla oluşturur. Otomatik seçilen alanlar (Alt/Üst, çizgi) kilitlenir.',
    yz: 'Normal bültende Alt/Üst oranı olmayan maçlar için günde iki kez (00:00 ve 12:00) yapay zekâ beklenen gol (basketbolda uzatmalar dahil toplam sayı) tahmini yapar. Dahil: bu maçlar da kuponlara girer, maç satırında YZ etiketiyle. Tahmin, oranlardan çıkan beklentiden daha az isabetlidir.',
    line: 'Kuponun toplam gol (basketbolda sayı) çizgisi sınırı. Örnek: Alt, en az 5.5, en çok 8.5 → sadece 5.5, 6.5, 7.5, 8.5 Alt kuponlar. Boş = sınırsız. Tam sayı yazılırsa en az yukarı (6 → 6.5), en çok aşağı (6 → 5.5) yuvarlanır.',
    xg: 'Maçın adil gol (basketbolda sayı) beklentisi (sitenin normal Alt/Üst oranlarından); altında Goal Mix\'in aynı maç için varsaydığı.',
    repeat: 'Tekrarlı: kuponların yarısı tamamen farklı maçlardan, kalan yarısı tekrara izin verilerek kurulur (bir maç en fazla 3 kupona girer). Tekrarsız: her maç en fazla bir kuponda. Ters çizgi: bir maç en fazla bir Üst ve bir Alt kupona girer. Tekrarsız ve ters çizgide istenenden az kupon çıkabilir.',
    set: 'Seçili kuponların birlikte hesabı: en az 1, en az 2… kuponun tutma olasılığı ve tam o kadar kupon tutarsa net kâr/zarar (ortalama; en kötü … en iyi). Kâra geçiş: ortalamada artıya geçmek için gereken en az tutan kupon sayısı. Her maçın golü adil beklentiyle 20.000 kez denendi; ortak maçlar birlikte sayıldı. Tahmindir, garanti değildir.',
    formLeg: 'Sadece bilgi, yüzdeye katılmaz (oranlar formu zaten içerir). Son 5 maç: attığı–yediği gol ortalaması, 2.5 üst biten maç sayısı ve sonuçlar (G galibiyet, B beraberlik, M mağlubiyet).',
    fav: 'Favoriler bu tarayıcıda saklanır. Oranlar ve olasılıklar kaydedildiği andaki değerlerdir; maçı başlamış kuponlar işaretlenir.',
  };
  const info = (text) => `<span class="kk-i" tabindex="0" role="button" aria-label="Açıklama" data-tip="${esc(text)}">i</span>`;

  // ---------- kupon seti hesabı ----------
  const keyOf = (c) => `${c.side}|${c.line}|${c.legs.map((m) => m.g.id).sort().join(',')}`;
  function setChance(list, runs = 20000) {
    if (!list.length) return null;
    const ids = [...new Set(list.flatMap((c) => c.legs.map((m) => m.g.id)))];
    const legOf = (id) => list.flatMap((c) => c.legs).find((m) => m.g.id === id);
    const lam = ids.map((id) => legOf(id).fair.lam);
    const sds = ids.map((id) => legOf(id).fair.sd || 0);
    const idx = list.map((c) => c.legs.map((m) => ids.indexOf(m.g.id)));
    let seed = 20261119;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const poisson = (l) => { const L = Math.exp(-l); let k = 0; let p = rnd(); while (p > L) { k++; p *= rnd(); } return k; };
    const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
    const byK = new Array(list.length + 1).fill(0);
    const payK = new Array(list.length + 1).fill(0);
    let pay = 0;
    const goals = new Array(ids.length);
    for (let i = 0; i < runs; i++) {
      for (let j = 0; j < ids.length; j++) goals[j] = sds[j] ? lam[j] + sds[j] * gauss() : poisson(lam[j]);
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
    const odds = list.map((c) => c.odds).sort((x, y) => x - y);
    const avgOdds = odds.reduce((t, o) => t + o, 0) / odds.length;
    const net = byK.map((cnt, k) => ({
      avg: cnt >= 50 ? payK[k] / cnt - list.length : k * avgOdds - list.length,
      min: odds.slice(0, k).reduce((t, o) => t + o, 0) - list.length,
      max: odds.slice(odds.length - k).reduce((t, o) => t + o, 0) - list.length,
    }));
    const even = net.findIndex((x) => x.avg > 0);
    return { n: list.length, atLeast, netK: net, even, pEven: even >= 0 ? atLeast[even] : 0, mean: byK.reduce((t, x, k) => t + x * k, 0) / runs, net: pay / runs - list.length, shared: ids.length < list.reduce((t, c) => t + c.legs.length, 0) };
  }
  const pctTxt = (p) => (p >= 0.9995 ? '%99.9+' : p >= 0.001 ? `%${(p * 100).toFixed(1)}` : '<%0.1');

  // ---------- favoriler ----------
  // chrome.storage'da: kuponun o anki hali (maçlar, çizgi, oran, olasılık). Başlamış maçlı kuponlar işaretlenir.
  const FAV_KEY = 'kkFavs';
  let favs = [];
  let favsLoaded = false;
  async function loadFavs() {
    if (favsLoaded) return favs;
    const v = await store.get(FAV_KEY);
    favs = Array.isArray(v) ? v : [];
    favsLoaded = true;
    return favs;
  }
  const saveFavs = () => store.set(FAV_KEY, favs);
  const isFav = (c) => favs.some((f) => keyOf(f) === keyOf(c));
  // Saklanacak sade kopya (gereksiz alanlar atılır).
  const snap = (c) => ({
    sport: c.sport || 'football', side: c.side, line: c.line, odds: c.odds, p: c.p, fair: c.fair, ev: c.ev, lamFair: c.lamFair, sdFair: c.sdFair ?? null, lamSite: c.lamSite, savedAt: Date.now(),
    legs: c.legs.map((m) => ({ g: { id: m.g.id, home: m.g.home, away: m.g.away, startsAt: m.g.startsAt, league: { name: m.g.league?.name || '' } }, fair: { lam: m.fair.lam, sd: m.fair.sd ?? null, mkt: m.fair.mkt, src: m.fair.src, note: m.fair.note || '' }, site: m.site, siteSd: m.siteSd ?? null, form: m.form || null })),
  });
  function toggleFav(c) {
    const k = keyOf(c);
    if (favs.some((f) => keyOf(f) === k)) favs = favs.filter((f) => keyOf(f) !== k);
    else favs = [snap(c), ...favs];
    saveFavs();
  }
  const couponState = (c) => {
    const now = Date.now();
    const starts = c.legs.map((m) => Date.parse(m.g.startsAt));
    if (Math.min(...starts) > now) return null;
    if (Math.max(...starts) + 2.5 * 3600 * 1000 < now) return { cls: 'done', txt: 'Maçlar bitti' };
    return { cls: 'live', txt: 'Başladı' };
  };

  // ---------- görünüm durumu ----------
  let tab = 'build'; // 'build' | 'favs'
  let lastList = [];
  let lastStats = null;
  let autoNote = '';
  const offSet = new Set(); // hesaptan çıkarılan kuponlar (oluşturulanlar)
  const offFav = new Set(); // hesaptan çıkarılan favoriler
  let selKey = null;
  let favSel = null;
  const sportOf = (c) => c.sport || 'football';
  const favsCur = () => favs.filter((f) => sportOf(f) === state.sport);
  const curList = () => (tab === 'favs' ? favsCur() : lastList);
  const curOff = () => (tab === 'favs' ? offFav : offSet);

  const ORDERS = [['prob', 'Olasılık'], ['ev', 'Değer'], ['oddsDesc', 'Oran ↓'], ['oddsAsc', 'Oran ↑'], ['legs', 'Maç'], ['time', 'Saat']];
  const firstStart = (c) => Math.min(...c.legs.map((m) => Date.parse(m.g.startsAt)));
  function sortList(list) {
    const f = {
      prob: (a, b) => b.p - a.p,
      ev: (a, b) => b.ev - a.ev,
      oddsDesc: (a, b) => b.odds - a.odds,
      oddsAsc: (a, b) => a.odds - b.odds,
      legs: (a, b) => a.legs.length - b.legs.length || b.p - a.p,
      time: (a, b) => firstStart(a) - firstStart(b),
    }[state.order || 'prob'] || ((a, b) => b.p - a.p);
    return [...list].sort(f);
  }

  function seg(name, value, opts, disabled = false) {
    return `<div class="kk-seg" data-name="${name}" role="group">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(v) === String(value) ? 'is-on' : ''}"${disabled ? ' disabled' : ''}>${l}</button>`).join('')}</div>`;
  }
  const legSelect = (name, v) => `<select class="kk-input" name="${name}">${Array.from({ length: maxLegsNow() - 1 }, (_, i) => i + 2).map((k) => `<option value="${k}"${k === v ? ' selected' : ''}>${k} maç</option>`).join('')}</select>`;
  const COUNTS = [5, 10, 15, 20, 25, 30, 40, 50];

  // ---------- ülke / lig ----------
  const REGION_TR = { 'GB-ENG': 'İngiltere', 'GB-SCT': 'İskoçya', 'GB-WLS': 'Galler', 'GB-NIR': 'K. İrlanda', HK: 'Hong Kong', MO: 'Makao', KR: 'G. Kore', KP: 'K. Kore', US: 'ABD', AE: 'BAE', CZ: 'Çekya',
    'X-INT': 'Uluslararası', 'X-WRL': 'Dünya', 'X-EUR': 'Avrupa', 'X-NAM': 'K. Amerika', 'X-SAM': 'G. Amerika',
    'X-CAM': 'Orta Amerika', 'X-AFR': 'Afrika', 'X-ASI': 'Asya', 'X-ASIA': 'Asya', 'X-EU': 'Avrupa', 'X-AS': 'Asya', 'X-AF': 'Afrika', 'X-OCE': 'Okyanusya' };
  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(['tr'], { type: 'region' }); } catch { regionNames = null; }
  function countryName(code) {
    const c = String(code || '').toUpperCase();
    if (!c) return '';
    if (REGION_TR[c]) return REGION_TR[c];
    if (c.startsWith('X-')) return 'Uluslararası';
    try { return regionNames?.of(c.slice(0, 2)) || c; } catch { return c; }
  }
  const leagueKey = (e) => e.leagueId || e.league || 'Diğer';
  const leagueLabelOf = (e) => (e.country ? `${e.league || 'Diğer'} · ${countryName(e.country)}` : e.league || 'Diğer');
  const leagueSelected = (e, sel) => sel.includes(leagueKey(e)) || sel.includes(e.league);
  // Büyük ligler: ülke kodu + lig adı (kadın, genç, rezerv ligleri hariç).
  const MAJOR = [
    ['X-EU', /^(uefa )?(champions league|europa league|conference league)\b/],
    ['GB-ENG', /^(premier league|championship)$/], ['ES', /^la ?liga$/], ['IT', /^serie a$/], ['DE', /^(2\. )?bundesliga$/],
    ['FR', /^ligue 1$/], ['NL', /^eredivisie$/], ['PT', /^(liga portugal|primeira liga)/], ['TR', /^super lig$/],
    ['BE', /(jupiler )?pro league$/], ['GB-SCT', /^premiership$/], ['BR', /^serie a$/],
    ['AR', /^liga profesional/], ['SA', /^saudi professional league$/],
  ];
  const leagueNorm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const MAJOR_BB = [
    ['US', /^(nba|ncaa)\b/], ['*', /^(euroleague|eurocup|basketball champions league)\b/], ['ES', /^(liga )?(acb|endesa)/],
    ['IT', /^(lega ?a|lba|serie a)\b/], ['TR', /^(bsl|super lig|basketbol super ligi)/], ['DE', /^(bbl|basketball bundesliga|bundesliga)\b/],
    ['FR', /^(lnb|pro a|betclic elite|elite)\b/], ['GR', /^(basket league|a1|greek basket)/],
  ];
  function isMajor(e) {
    const n = leagueNorm(e.league);
    if (state.sport === 'basketball') {
      if (/women|kadin|u1\d|u2\d|youth|wnba/.test(n)) return false;
      const cc = String(e.country || '').toUpperCase();
      return MAJOR_BB.some(([c, re]) => (c === '*' || c === cc) && re.test(n));
    }
    if (/women|kadin|u1\d|u2\d|youth|reserve|cup|kupa/.test(n) && !/champions league|europa league|conference league/.test(n)) return false;
    const c = String(e.country || '').toUpperCase();
    return MAJOR.some(([cc, re]) => cc === c && re.test(n));
  }
  // Bayrak: iki harfli ülke kodundan emoji; İngiltere bölgeleri ve kıtalar için yakın karşılık.
  // Ülke rozeti: kısa kod (Windows bayrak emojisi göstermediği için yazı). İngiltere bölgeleri ve kıtalar okunur kodla.
  function flagOf(code) {
    const c = String(code || '').toUpperCase();
    if (!c) return 'INT';
    const map = { 'GB-ENG': 'ENG', 'GB-SCT': 'SCO', 'GB-WLS': 'WAL', 'GB-NIR': 'NIR' };
    if (map[c]) return map[c];
    if (c.startsWith('X-')) return c.includes('EU') ? 'EU' : 'INT';
    return c.slice(0, 3);
  }
  function leagueList() {
    const now = Date.now();
    const map = new Map();
    const labels = new Map();
    // Bütün Goal Mix maçları sayılır; n = adil oranı hesaplanabilen (kupona girebilen), all = toplam.
    const data = D();
    const priced = new Set((data?.events || []).map((e) => e.id));
    const seenIds = new Set();
    for (const e of [...(data?.events || []), ...(data?.missing || [])]) {
      if (seenIds.has(e.id)) continue;
      seenIds.add(e.id);
      const t = Date.parse(e.startsAt);
      if (t <= now + 3 * 60 * 1000 || t >= now + state.hours * 3600 * 1000) continue;
      const k = leagueKey(e);
      if (!map.has(k)) map.set(k, { label: leagueLabelOf(e), name: e.league || 'Diğer', country: e.country || '', logo: null, major: isMajor(e), n: 0, all: 0 });
      const v = map.get(k);
      v.all++;
      if (priced.has(e.id) || (e.src === 'yz' && state.useYz === 1)) v.n++;
      if (!v.logo && e.logoId) v.logo = e.logoId;
    }
    for (const v of map.values()) labels.set(v.label, (labels.get(v.label) || 0) + 1);
    const seen = new Map();
    for (const v of map.values()) {
      if (labels.get(v.label) > 1) { const i = (seen.get(v.label) || 0) + 1; seen.set(v.label, i); v.label = `${v.label} (${i})`; v.name = `${v.name} (${i})`; }
    }
    for (const k of state.leagues) if (!map.has(k)) map.set(k, { label: k, name: k, country: '', logo: null, major: false, n: 0, all: 0 });
    return [...map.entries()].sort((x, y) => (y[1].major - x[1].major) || y[1].n - x[1].n || x[1].label.localeCompare(y[1].label, 'tr'));
  }
  const labelOfKey = (k) => leagueList().find(([key]) => key === k)?.[1].label || k;
  const leagueLabel = () => (!state.leagues.length ? 'Tüm ligler' : state.leagues.length === 1 ? labelOfKey(state.leagues[0]) : `${state.leagues.length} lig seçili`);
  const logoHtml = (v) => (v.logo
    ? `<span class="kk-lg-logo"><img src="https://sb.6q.net/league-icons/id/${encodeURIComponent(v.logo)}.png" alt="" loading="lazy" data-flag="${flagOf(v.country)}"></span>`
    : `<span class="kk-lg-logo kk-lg-flag">${flagOf(v.country)}</span>`);

  // ---------- lig seçim penceresi ----------
  // Ortada açılan pencere: arama, "Major ligler" / "Tümü" / "Temizle" hızlı seçimleri, logolu lig kartları. Seçim
  // "Uygula" ile kaydedilir, "Vazgeç" ile eski hali kalır.
  let lpDraft = null;
  function openLeagues() {
    lpDraft = new Set(state.leagues);
    let lp = modal.querySelector('.kk-lp');
    if (!lp) {
      lp = document.createElement('div');
      lp.className = 'kk-lp';
      modal.querySelector('.kk-shell').appendChild(lp);
    }
    lp.hidden = false;
    lp.innerHTML = '<div class="kk-lp-back"></div><section class="kk-lp-box" role="dialog" aria-label="Lig seç">'
      + `<header class="kk-lp-head"><div><h3>Lig seç</h3><p>Goal Mix'te seçili başlama aralığındaki (${state.hours === 168 ? '7 gün' : `${state.hours} sa`}) ligler · sayı: kupona girebilen maç (adil oranı olan) / toplam · boş seçim = bütün ligler</p></div><button type="button" class="kk-icon-btn kk-lp-x" aria-label="Kapat">${ICON.close}</button></header>`
      + '<div class="kk-lp-tools"><input class="kk-input kk-lp-search" type="search" placeholder="Lig ya da ülke ara…">'
      + `<button type="button" class="kk-chip kk-lp-major">${ICON.star}Sadece major ligler</button><button type="button" class="kk-chip kk-lp-all">Tüm ligler</button><button type="button" class="kk-chip kk-lp-none">Seçimi temizle</button></div>`
      + '<div class="kk-lp-list"></div>'
      + '<footer class="kk-lp-foot"><span class="kk-lp-sum"></span><button type="button" class="kk-btn kk-btn--ghost kk-lp-cancel">Vazgeç</button><button type="button" class="kk-btn kk-btn--primary kk-lp-apply">Uygula</button></footer></section>';
    renderLeagues();
    lp.querySelector('.kk-lp-search').focus();
  }
  function renderLeagues() {
    const lp = modal.querySelector('.kk-lp');
    if (!lp || lp.hidden) return;
    const list = leagueList();
    const q = lp.querySelector('.kk-lp-search')?.value.trim().toLocaleLowerCase('tr') || '';
    const shown = list.filter(([, v]) => !q || `${v.label} ${countryName(v.country)}`.toLocaleLowerCase('tr').includes(q));
    const card = ([key, v]) => `<button type="button" class="kk-lg${lpDraft.has(key) ? ' is-on' : ''}" data-key="${esc(key)}" aria-pressed="${lpDraft.has(key)}">`
      + `<i class="kk-lg-check" aria-hidden="true"></i>${logoHtml(v)}<span class="kk-lg-txt"><b>${esc(v.name)}</b><small>${esc(countryName(v.country) || 'Uluslararası')}</small></span>`
      + `${v.major ? `<span class="kk-lg-major" title="Major lig">${ICON.star}</span>` : ''}<em class="${v.n ? '' : 'is-zero'}" title="${v.n} maçın adil oranı var (kupona girebilir) · Goal Mix'te toplam ${v.all} maç">${v.n === v.all ? v.n : `${v.n}/${v.all}`}</em></button>`;
    const majors = shown.filter(([, v]) => v.major);
    const others = shown.filter(([, v]) => !v.major);
    lp.querySelector('.kk-lp-list').innerHTML = !list.length
      ? '<p class="kk-dd-empty">Maç verisi toplanınca ligler burada çıkar.</p>'
      : (majors.length ? `<h4>Major ligler</h4><div class="kk-lg-grid">${majors.map(card).join('')}</div>` : '')
        + (others.length ? `<h4>Diğer ligler</h4><div class="kk-lg-grid">${others.map(card).join('')}</div>` : '')
        + (!shown.length ? '<p class="kk-dd-empty">Aramaya uyan lig yok.</p>' : '');
    const nMatch = list.filter(([k]) => lpDraft.has(k)).reduce((t, [, v]) => t + v.n, 0);
    lp.querySelector('.kk-lp-sum').innerHTML = lpDraft.size ? `<b>${lpDraft.size}</b> lig seçili · ${nMatch} maç` : '<b>Bütün ligler</b> (seçim yok)';
  }
  function closeLeagues(apply) {
    const lp = modal.querySelector('.kk-lp');
    if (apply && lpDraft) { state.leagues = [...lpDraft]; save(); }
    lpDraft = null;
    if (lp) lp.hidden = true;
    refreshLeagues();
  }
  function leagueBtnHtml() {
    const majors = state.leagues.length && leagueList().filter(([, v]) => v.major).every(([k]) => state.leagues.includes(k))
      && state.leagues.every((k) => leagueList().find(([kk]) => kk === k)?.[1].major);
    return `<span>${esc(majors ? 'Major ligler' : leagueLabel())}</span><em>Değiştir</em>`;
  }
  function refreshLeagues() {
    const b = modal?.querySelector('.kk-lg-btn');
    if (b) b.innerHTML = leagueBtnHtml();
    renderLeagues();
  }

  // ---------- ayarlar (sol panel) ----------
  function renderForm() {
    const body = modal.querySelector('.kk-side-body');
    const lock = state.auto === 1;
    const lk = lock ? ' is-locked' : '';
    const dis = lock ? ' disabled' : '';
    const field = (label, html, cls = '') => `<div class="kk-field${cls}"><label>${label}</label>${html}</div>`;
    const section = (title, html, hint = '') => `<section class="kk-sec"><h4>${title}${hint}</h4>${html}</section>`;
    body.innerHTML = section('Strateji',
      `<label class="kk-toggle${lock ? ' is-on' : ''}"><input type="checkbox" role="switch" name="auto"${lock ? ' checked' : ''}><i aria-hidden="true"></i><span><b>En iyi ayar</b><small>Alt/Üst ve maç sayısını kendisi seçer</small></span>${info(TIP.auto)}</label>`
      + field(`Alt / Üst${lock ? ' <em>otomatik</em>' : ''}`, seg('side', state.side, [['OVER', 'Üst'], ['UNDER', 'Alt'], ['BOTH', 'İkisi']], lock), lk)
      + field(`Öncelik ${info(TIP.sort)}`, seg('sort', state.sort, [['PROB', 'Tutma olasılığı'], ['EV', 'Değer']])))
      + section('Kupon',
        field('Maç sayısı', `<div class="kk-pair">${legSelect('minLegs', state.minLegs)}<span>–</span>${legSelect('maxLegs', state.maxLegs)}</div>`)
        + field('Kupon sayısı', `<select class="kk-input" name="count">${COUNTS.map((k) => `<option value="${k}"${k === state.count ? ' selected' : ''}>${k} kupon</option>`).join('')}</select>`)
        + field(`Aynı maç ${info(TIP.repeat)}`, seg('repeat', state.repeat, [[1, 'Tekrarlı'], [0, 'Tekrarsız'], [2, 'Ters çizgi']])))
      + section('Oran ve çizgi',
        `<div class="kk-grid2">${field('En az oran', `<input class="kk-input" name="minOdds" type="number" inputmode="decimal" min="1.01" step="0.05" value="${state.minOdds}">`)}`
        + `${field('En çok oran', `<input class="kk-input" name="maxOdds" type="number" inputmode="decimal" min="1.05" step="0.25" value="${state.maxOdds}">`)}`
        + `${field(`En az çizgi ${info(TIP.line)}`, `<input class="kk-input" name="minLine" type="number" inputmode="decimal" min="0.5" step="1" placeholder="${lock ? 'otomatik' : 'sınırsız'}" value="${lock ? '' : state.minLine ?? ''}"${dis}>`, lk)}`
        + `${field('En çok çizgi', `<input class="kk-input" name="maxLine" type="number" inputmode="decimal" min="0.5" step="1" placeholder="${lock ? 'otomatik' : 'sınırsız'}" value="${lock ? '' : state.maxLine ?? ''}"${dis}>`, lk)}</div>`)
      + section('Maçlar',
        field('Başlama', seg('hours', state.hours, [[12, '12 sa'], [24, '24 sa'], [48, '48 sa'], [72, '72 sa'], [168, '7 gün']]))
        + field('Lig', `<button type="button" class="kk-input kk-lg-btn">${leagueBtnHtml()}</button>`)
        + field(`YZ tahmini ${info(TIP.yz)}`, seg('useYz', state.useYz, [[0, 'Hariç'], [1, 'Dahil']])));
  }

  function save() {
    localStorage.setItem(OPTS_KEY(state.sport), JSON.stringify(state));
    localStorage.setItem('kkSport', state.sport);
  }
  function readInputs() {
    if (!modal) return;
    const val = (n) => Number(String(modal.querySelector(`input[name="${n}"]`)?.value ?? '').replace(',', '.'));
    const mo = val('minOdds');
    state.minOdds = mo > 1 ? mo : 1.5;
    const xo = val('maxOdds');
    state.maxOdds = xo > state.minOdds ? xo : Math.max(state.minOdds + 0.5, 4);
    const ln = (n, up) => {
      const el = modal.querySelector(`input[name="${n}"]`);
      const raw = String(el?.value ?? '').trim();
      if (!raw) return null;
      const v = Number(raw.replace(',', '.'));
      if (!Number.isFinite(v) || v <= 0) { if (el) el.value = ''; return null; }
      const r = Math.max(0.5, (up ? Math.ceil(v - 0.5) : Math.floor(v - 0.5)) + 0.5);
      if (el) el.value = String(r);
      return r;
    };
    const sel = (n) => Number(modal.querySelector(`select[name="${n}"]`)?.value) || null;
    state.count = COUNTS.includes(sel('count')) ? sel('count') : state.count || 10;
    state.minLegs = sel('minLegs') || state.minLegs || 2;
    state.maxLegs = sel('maxLegs') || state.maxLegs || 5;
    if (state.maxLegs < state.minLegs) [state.minLegs, state.maxLegs] = [state.maxLegs, state.minLegs];
    state.sizes = legRange();
    if (state.auto !== 1) {
      state.minLine = ln('minLine', true);
      state.maxLine = ln('maxLine', false);
    }
    if (state.minLine != null && state.maxLine != null && state.maxLine < state.minLine) [state.minLine, state.maxLine] = [state.maxLine, state.minLine];
  }

  // ---------- ana alan ----------
  const money = (v) => {
    const st = state.stake > 0 ? state.stake : 1;
    return `${v > 0.005 ? '+' : v < -0.005 ? '−' : ''}${Math.abs(v * st).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}`;
  };
  const tone = (v) => (v > 0.005 ? 'is-up' : v < -0.005 ? 'is-down' : '');

  // Kupon seti: tek satır. Solda başlık + tutar, ortada beklenen net ve kâra geçiş, sağda "en az k tutar" çubuk grafiği
  // (boy = olasılık, yeşil = o kadar tutarsa kâr, kırmızı = zarar). Bir çubuğa basınca/üstüne gelince ayrıntısı yazılır.
  let setK = null; // seçili çubuk (tutan kupon sayısı)
  let setCache = null; // son hesap: çubuğa basınca yeniden simülasyon yapılmasın
  function setHtml() {
    const list = curList();
    const off = curOff();
    const sel = list.filter((c) => !off.has(keyOf(c)));
    const r = setChance(sel);
    setCache = r;
    const st = state.stake > 0 ? state.stake : 1;
    const left = `<div class="kk-set-id"><h4>${tab === 'favs' ? 'Favori seti' : 'Kupon seti'} ${info(TIP.set)}</h4>`
      + `<span><button type="button" class="kk-link kk-set-all" title="Hepsini hesaba kat">${sel.length}/${list.length} kupon</button>${sel.length ? ' · <button type="button" class="kk-link kk-set-none">temizle</button>' : ''}</span></div>`
      + `<label class="kk-stake" title="Her kupona yatırılacak tutar">Kupon başı<input type="number" min="0.01" step="any" inputmode="decimal" name="stake" value="${st}"></label>`;
    if (!r) return `<section class="kk-set">${left}<p class="kk-set-empty">Hesaba katmak için kuponlardaki kutucuğu işaretle.</p></section>`;
    if (setK == null || setK > r.n || setK < 1) setK = r.even > 0 ? r.even : Math.max(1, Math.round(r.mean));
    const mid = `<div class="kk-set-kpi"><small>Beklenen net</small><b class="${tone(r.net)}">${money(r.net)}</b><em>${(r.n * st).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} yatırılır</em></div>`
      + `<div class="kk-set-kpi"><small>Kâra geçiş</small><b>${r.even > 0 ? `${r.even}/${r.n} kupon` : '—'}</b><em>${r.even > 0 ? `olasılık ${pctTxt(r.pEven)}` : 'ortalamada kâr yok'}</em></div>`;
    const bars = Array.from({ length: r.n }, (_, i) => {
      const k = i + 1;
      const h = Math.max(4, Math.round(r.atLeast[k] * 100));
      const cls = r.netK[k].avg > 0.005 ? 'is-up' : 'is-down';
      return `<button type="button" class="kk-bar ${cls}${k === setK ? ' is-sel' : ''}${k === r.even ? ' is-even' : ''}" data-k="${k}" title="En az ${k}: ${pctTxt(r.atLeast[k])}"><i style="height:${h}%"></i>${r.n <= 16 || k % Math.ceil(r.n / 12) === 0 || k === r.n ? `<em>${k}</em>` : ''}</button>`;
    }).join('');
    return `<section class="kk-set">${left}<div class="kk-set-kpis">${mid}</div>`
      + `<div class="kk-set-chart"><div class="kk-bars" role="group" aria-label="En az k kupon tutma olasılığı">${bars}</div>${setDetail(r)}</div></section>`;
  }
  function setDetail(r) {
    const x = r.netK[setK];
    const range = Math.abs(x.max - x.min) > 0.005 ? `<em>${money(x.min)} … ${money(x.max)}</em>` : '';
    return `<div class="kk-set-detail"><small>En az <b>${setK}</b> kupon tutar</small><b>${pctTxt(r.atLeast[setK])}</b>`
      + `<span>tam ${setK} tutarsa <i class="${tone(x.avg)}">${money(x.avg)}</i></span>${range}</div>`;
  }
  // Listedeki bütün kuponların metni (görünen sıra): her kupon başlık satırı + maçları, aralarında boş satır.
  function allCopyText(list) {
    return sortList(list).map((c, i) => {
      const side = sideTxt(c.side).toLocaleUpperCase('tr');
      const head = `${i + 1}) ${c.legs.length} maç · Toplam ${c.line} ${side} · ${c.odds.toFixed(2)} · tutma %${(c.p * 100).toFixed(0)}`;
      const legs = [...c.legs].sort((a, b) => Date.parse(a.g.startsAt) - Date.parse(b.g.startsAt))
        .map((m) => `${day(m.g.startsAt)} ${hm(m.g.startsAt)}  ${m.g.home} - ${m.g.away}`);
      return [head, ...legs].join('\n');
    }).join('\n\n');
  }
  function listHeadHtml() {
    const list = curList();
    const allFav = tab === 'build' && list.length && list.every(isFav);
    const favBtn = tab === 'build'
      ? `<button type="button" class="kk-chip kk-fav-all${allFav ? ' is-on' : ''}" title="Listedeki bütün kuponları favorilere ekle">${ICON.star}<span>${allFav ? 'Hepsi favoride' : 'Tümünü favorile'}</span></button>`
      : '';
    return `<div class="kk-list-top"><span>${list.length} kupon</span>${seg('order', state.order || 'prob', ORDERS)}</div>`
      + `<div class="kk-list-acts"><button type="button" class="kk-chip kk-copy-all" title="Listedeki bütün kuponların maçlarını kopyala">${ICON.copy}<span>${tab === 'favs' ? 'Favorileri kopyala' : 'Tümünü kopyala'}</span></button>${favBtn}</div>`;
  }
  function rowHtml(c, i) {
    const k = keyOf(c);
    const st = couponState(c);
    const on = !curOff().has(k);
    const fav = isFav(c);
    const sk = tab === 'favs' ? favSel : selKey;
    const t = firstStart(c);
    return `<article class="kk-row${k === sk ? ' is-sel' : ''}${st ? ` is-${st.cls}` : ''}" data-key="${esc(k)}" tabindex="0">`
      + `<button type="button" class="kk-check${on ? ' is-on' : ''}" data-key="${esc(k)}" aria-pressed="${on}" title="Kupon setine kat / çıkar"></button>`
      + `<div class="kk-row-main"><b>${c.legs.length} maç · ${c.line} ${sideTxt(c.side)}</b>`
      + `<small>${st ? `<span class="kk-tag kk-tag--${st.cls}">${st.txt}</span>` : `${esc(day(t))} ${esc(hm(t))} ·`} <span class="${tone(c.ev)}">değer ${pct(c.ev)}</span></small></div>`
      + `<div class="kk-row-num"><b>%${(c.p * 100).toFixed(0)}</b><small>tutma</small></div>`
      + `<span class="kk-odds">${c.odds.toFixed(2)}</span>`
      + `<button type="button" class="kk-star${fav ? ' is-on' : ''}" data-key="${esc(k)}" title="${fav ? 'Favorilerden çıkar' : 'Favorilere ekle'}" aria-pressed="${fav}">${ICON.star}</button></article>`;
  }

  function detailHtml(c) {
    if (!c) return `<div class="kk-empty-box">${ICON.ball}<b>Bir kupon seç</b><span>Soldaki listeden bir kupona bas; maçları, yorumu ve ayrıntıları burada görünür.</span></div>`;
    const side = sideTxt(c.side).toLocaleUpperCase('tr');
    const copy = c.legs.map((m) => `${m.g.home} - ${m.g.away}`).join('\n') + `\nToplam ${c.line} ${side} · ${c.odds.toFixed(2)}`;
    const fav = isFav(c);
    const st = couponState(c);
    const kp = (label, value, tip, cls = '') => `<div class="kk-kpi ${cls}"><small>${label} ${tip ? info(tip) : ''}</small><b>${value}</b></div>`;
    return `<div class="kk-detail">`
      + `<header class="kk-detail-head"><div><h3>${c.legs.length} maç · Toplam ${c.line} ${side}</h3>`
      + `<p>Beklenen toplam ${SPORTS[c.sport || 'football'].unit} <b>${f2(c.lamFair)}</b> · sitenin hesabı ${f2(c.lamSite)}${st ? ` · <span class="kk-tag kk-tag--${st.cls}">${st.txt}</span>` : ''}${c.savedAt ? ` · kaydedildi ${esc(day(c.savedAt))} ${esc(hm(c.savedAt))}` : ''}</p></div>`
      + `<span class="kk-odds kk-odds--lg">${c.odds.toFixed(2)}</span></header>`
      + `<div class="kk-detail-kpis">${kp('Tutma', `%${(c.p * 100).toFixed(1)}`, TIP.prob, 'is-accent')}${kp('Adil oran', c.fair.toFixed(2), TIP.fair)}${kp('Değer', pct(c.ev), TIP.ev, tone(c.ev))}</div>`
      + `<div class="kk-detail-actions"><button type="button" class="kk-btn kk-btn--ghost kk-star-btn${fav ? ' is-on' : ''}" data-key="${esc(keyOf(c))}">${ICON.star}<span>${fav ? 'Favorilerde' : 'Favorilere ekle'}</span></button>`
      + `<button type="button" class="kk-btn kk-btn--ghost kk-copy" data-copy="${esc(copy)}">${ICON.copy}<span>Maçları kopyala</span></button></div>`
      + `<p class="kk-note">${esc(commentText(c))}</p>`
      + `<ol class="kk-legs">${legsHead()}${[...c.legs].sort((a, b) => Date.parse(a.g.startsAt) - Date.parse(b.g.startsAt)).map(legHtml).join('')}</ol></div>`;
  }

  function statusHtml() {
    const data = D();
    if (!data) return '<span class="kk-status">Veri toplanıyor…</span>';
    const mins = Math.round((Date.now() - data.at) / 60000);
    return `<span class="kk-status" title="${esc(TIP.data)}"><i></i>${data.events?.length || 0} maç hazır · ${mins < 1 ? 'az önce' : `${mins} dk önce`}</span>`;
  }

  function renderMain() {
    const main = modal.querySelector('.kk-main');
    modal.querySelector('.kk-tab[data-tab="favs"] em').textContent = favsCur().length;
    modal.querySelectorAll('.kk-tab').forEach((x) => x.classList.toggle('is-on', x.dataset.tab === tab));
    modal.querySelector('.kk-shell').classList.toggle('is-favs', tab !== 'build');
    modal.querySelector('.kk-status-wrap').innerHTML = statusHtml();
    if (tab === 'cal') { renderCal(); return; }
    const list = curList();
    if (tab === 'favs' && !list.length) {
      main.innerHTML = `<div class="kk-empty-box kk-empty-box--big">${ICON.star}<b>Henüz favori yok</b><span>Oluşturulan kuponlardaki ☆ simgesine basarak kaydet; burada birlikte kâr/zarar ve tutma olasılığı hesaplanır.</span></div>`;
      return;
    }
    if (tab === 'build' && !list.length) {
      if (!main.querySelector('.kk-wait')) {
        main.innerHTML = `<div class="kk-empty-box kk-empty-box--big">${ICON.spark}<b>Kuponları oluşturmaya hazır</b><span>Soldan ayarları seç ve <b>Kuponları oluştur</b>a bas. Maçlar 6q açıkken arka planda toplanıyor; veri hazırsa sonuç birkaç saniyede gelir.</span></div>`;
      }
      return;
    }
    const sorted = sortList(list);
    if (tab === 'favs') { if (!favSel || !list.some((c) => keyOf(c) === favSel)) favSel = keyOf(sorted[0]); }
    else if (!selKey || !list.some((c) => keyOf(c) === selKey)) selKey = keyOf(sorted[0]);
    const s = lastStats;
    const notes = tab === 'build'
      ? (autoNote ? `<p class="kk-banner kk-banner--accent">${ICON.spark}${esc(autoNote)}</p>` : '')
        + (s?.short ? `<p class="kk-banner kk-banner--warn">İstenenden az kupon kurulabildi: bu oran/çizgi aralığında yeterli uygun kombinasyon yok.</p>` : '')
      : `<p class="kk-banner">${info(TIP.fav)} Favoriler kaydedildiği andaki oran ve olasılıklarla gösterilir. <span class="kk-banner-btns"><button type="button" class="kk-chip kk-fav-clean">Geçmiş maçlıları temizle</button><button type="button" class="kk-chip kk-chip--danger kk-fav-clear">${ICON.trash}Tümünü temizle</button></span></p>`;
    main.innerHTML = notes + setHtml()
      + `<div class="kk-split"><section class="kk-list"><div class="kk-list-head">${listHeadHtml()}</div>`
      + `<div class="kk-rows">${sorted.map(rowHtml).join('')}</div></section><section class="kk-pane"></section></div>`;
    showDetail();
  }
  // ---------- kalibrasyon ekranı ----------
  const pc = (x) => (x == null ? '—' : `%${(x * 100).toFixed(1)}`);
  const diffCls = (pred, act) => (pred == null || act == null ? '' : Math.abs(act - pred) < 0.03 ? 'is-up' : act < pred ? 'is-down' : 'is-up');
  async function renderCal() {
    const main = modal.querySelector('.kk-main');
    main.innerHTML = '<div class="kk-wait"><div class="kk-spinner"></div><b>Sonuçlar güncelleniyor…</b><span>Başlamış maçların skoru 6q bülteninden okunuyor.</span></div>';
    try { await calUpdate(true); } catch { /* yine de göster */ }
    if (tab !== 'cal') return;
    const st = calStats();
    const head = `<section class="kk-cal-intro"><div><h3>Kalibrasyon · futbol</h3><p>Eklentinin tahminleri gerçek sonuçlarla karşılaştırılır. Her veri toplamasında maçların maç öncesi tahmini, her oluşturmada kuponlar kaydedilir; maçlar bitince 6q bülteninden 90 dakikanın skoru okunur. Son ${CAL_DAYS} gün saklanır.</p></div>`
      + `<div class="kk-cal-counts"><span><b>${st?.logged || 0}</b> maç kayıtlı</span><span><b>${st?.matches?.n || 0}</b> maç sonuçlandı</span><span><b>${st?.pending || 0}</b> maç sonuç bekliyor</span><span><b>${st?.coupons || 0}</b> / ${st?.loggedCoupons || 0} kupon sonuçlandı</span></div></section>`;
    if (!st || !st.matches) {
      main.innerHTML = head + `<div class="kk-empty-box">${ICON.spark}<b>Henüz sonuç yok</b><span>6q açıkken tahminler kendiliğinden kaydediliyor. İlk maçlar bittikten sonra (yaklaşık 2 saat) burada isabet oranları görünmeye başlar; anlamlı sonuç için birkaç gün beklemek gerekir.</span></div>`;
      return;
    }
    const mRow = (title, g) => (g ? `<tr><th>${title}</th><td>${g.n}</td><td>${g.lam.toFixed(2)}</td><td>${g.site.toFixed(2)}</td><td class="${Math.abs(g.goals - g.lam) < 0.15 ? 'is-up' : 'is-down'}">${g.goals.toFixed(2)}</td>`
      + g.lines.map((x) => `<td>${pc(x.pred)} → <b class="${diffCls(x.pred, x.act)}">${pc(x.act)}</b></td>`).join('') + `<td>${g.brier.toFixed(3)}</td></tr>` : '');
    const matchTable = `<section class="kk-cal-card"><h4>Maç düzeyi</h4><p>Beklenen gol ve "üst" olasılıkları gerçekleşenle. Ok: tahmin → gerçekleşen. Fark küçükse tahmin isabetli.</p>`
      + `<table class="kk-cal-table"><thead><tr><th></th><th>Maç</th><th>Beklenen gol</th><th>Sitenin</th><th>Gerçek gol</th><th>1.5 üst</th><th>2.5 üst</th><th>3.5 üst</th><th>Brier (2.5)</th></tr></thead>`
      + `<tbody>${mRow('Hepsi', st.matches)}${mRow('Oranlı (6q)', st.m6q)}${mRow('YZ tahmini', st.myz)}</tbody></table></section>`;
    const bars = st.buckets.map((b) => {
      const label = `%${Math.round(b.lo * 100)}–${Math.min(100, Math.round(b.hi * 100))}`;
      if (!b.n) return `<div class="kk-rel"><span>${label}</span><div class="kk-rel-bar"></div><em>kupon yok</em></div>`;
      return `<div class="kk-rel"><span>${label}</span><div class="kk-rel-bar"><i class="kk-rel-pred" style="width:${b.pred * 100}%"></i><i class="kk-rel-act ${diffCls(b.pred, b.act)}" style="width:${b.act * 100}%"></i></div>`
        + `<em>${b.n} kupon · tahmin ${pc(b.pred)} · tuttu <b class="${diffCls(b.pred, b.act)}">${pc(b.act)}</b></em></div>`;
    }).join('');
    const sides = st.sides.map((x) => `<span>${sideTxt(x.side)}: ${x.n} kupon · tahmin ${pc(x.pred)} · tuttu <b class="${diffCls(x.pred, x.act)}">${pc(x.act)}</b></span>`).join('');
    const couponCard = `<section class="kk-cal-card"><h4>Kupon düzeyi</h4><p>Oluşturulan kuponlar tahmin edilen tutma olasılığına göre dilimlendi. Gri çizgi tahmin, renkli çizgi gerçekte tutma oranı.</p>`
      + (st.coupons ? `<div class="kk-rels">${bars}</div><div class="kk-cal-foot">${sides}<span>Her kupona 1 birim: ortalama getiri <b class="${tone(st.roi)}">${pct(st.roi)}</b></span></div>`
        : '<p class="kk-set-empty">Henüz bütün maçları bitmiş kupon yok.</p>') + '</section>';
    const note = '<p class="kk-banner">Az sayıda maçla yüzdeler çok oynar; 100+ maç ve 50+ kupondan sonra güvenilir hale gelir. Brier puanı ne kadar küçükse o kadar iyi (rastgele tahmin ≈ 0.25).</p>';
    main.innerHTML = head + note + `<div class="kk-cal-grid">${matchTable}${couponCard}</div>`;
  }

  function showDetail() {
    const pane = modal.querySelector('.kk-pane');
    const k = tab === 'favs' ? favSel : selKey;
    if (pane) pane.innerHTML = detailHtml(curList().find((c) => keyOf(c) === k) || null);
    modal.querySelectorAll('.kk-row').forEach((x) => x.classList.toggle('is-sel', x.dataset.key === k));
  }
  function redrawSet() {
    const el = modal.querySelector('.kk-set');
    if (el) el.outerHTML = setHtml();
  }
  function redrawRows() {
    const rows = modal.querySelector('.kk-rows');
    if (!rows) return renderMain();
    rows.innerHTML = sortList(curList()).map(rowHtml).join('');
    const lh = modal.querySelector('.kk-list-head');
    if (lh) lh.innerHTML = listHeadHtml();
    showDetail();
  }
  // Bekleme paneli: adım adı + yüzde çubuğu. Yüzde, toplama adımından (progFor()) ya da "a/b" ilerlemesinden gelir.
  let uiStep = '';
  function say(t) {
    uiStep = t;
    const m = /(\d+)\/(\d+)/.exec(t);
    const pct = progFor() ? progFor().pct : m ? Math.round((100 * m[1]) / Math.max(1, m[2])) : null;
    paintWait(t, pct);
  }
  function paintWait(t, pct) {
    const main = modal?.querySelector('.kk-main');
    if (!main) return;
    const bar = pct != null ? `<div class="kk-prog"><i style="width:${pct}%"></i></div><em class="kk-prog-pct">%${pct}</em>` : '';
    let w = main.querySelector('.kk-wait');
    if (!w) { main.innerHTML = '<div class="kk-wait"></div>'; w = main.querySelector('.kk-wait'); }
    w.innerHTML = `<div class="kk-spinner"></div><b>${esc(t)}</b>${bar}<span>${progFor() && !busy ? 'Maç verisi arka planda okunuyor; bitince kuponlar hesaplanacak.' : 'Bu sırada pencereyi kapatabilirsin; hesap sürer.'}</span>`;
    paintGo(pct, t);
  }
  // Düğme: meşgulken içinde ince bir dolum çubuğu ve kısa durum + yüzde.
  function paintGo(pct, t) {
    const go = modal?.querySelector('.kk-go');
    if (!go) return;
    const on = busy || !!progFor();
    go.classList.toggle('is-busy', on);
    if (!on) { go.innerHTML = 'Kuponları oluştur'; go.disabled = false; return; }
    // Sadece arka planda veri okunuyorsa düğme basılabilir kalır: basınca toplama bitince kuponlar hesaplanır.
    if (!busy) {
      go.innerHTML = `<span class="kk-go-fill" style="width:${pct ?? 0}%"></span><span class="kk-go-txt">Kuponları oluştur · veri %${pct ?? 0}</span>`;
      go.disabled = false;
      return;
    }
    const short = String(t || uiStep || 'Hazırlanıyor').replace(/….*$/, '').replace(/\s+\d+\/\d+$/, '');
    go.innerHTML = `<span class="kk-go-fill" style="width:${pct ?? 0}%"></span><span class="kk-go-txt">${esc(short)}${pct != null ? ` · %${pct}` : '…'}</span>`;
    go.disabled = true;
  }
  function setBusy(on) {
    busy = on;
    paintSport();
    if (!on) uiStep = '';
    paintGo(progFor()?.pct ?? null, progFor()?.text || uiStep);
  }

  // ---------- branş ----------
  // Futbol ve basketbol ayrı: ayarlar, oluşturulan kuponlar, favoriler ve maç verisi branşa göre tutulur.
  const stash = {};
  const sportSeg = () => SPORT_KEYS.map((k) => `<button type="button" data-sport="${k}" class="${k === state.sport ? 'is-on' : ''}" aria-pressed="${k === state.sport}">${k === 'football' ? ICON.ball : ICON.bball}<span>${SPORTS[k].label}</span></button>`).join('');
  function paintSport() {
    modal?.querySelectorAll('.kk-sport button').forEach((b) => { const on = b.dataset.sport === state.sport; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on); b.disabled = busy && !on; });
    modal?.querySelector('.kk-shell')?.setAttribute('data-sport', state.sport);
  }
  function switchSport(sp) {
    if (busy || !SPORTS[sp] || sp === state.sport) return;
    readInputs();
    save();
    stash[state.sport] = { lastList, lastStats, autoNote, selKey, favSel, off: [...offSet], offF: [...offFav] };
    loadState(sp);
    save();
    const x = stash[sp] || {};
    lastList = x.lastList || [];
    lastStats = x.lastStats || null;
    autoNote = x.autoNote || '';
    selKey = x.selKey || null;
    favSel = x.favSel || null;
    offSet.clear(); (x.off || []).forEach((k) => offSet.add(k));
    offFav.clear(); (x.offF || []).forEach((k) => offFav.add(k));
    setK = null;
    if (tab === 'cal' && sp !== 'football') tab = 'build';
    const lp = modal.querySelector('.kk-lp');
    if (lp) lp.hidden = true;
    paintSport();
    renderForm();
    modal.querySelector('.kk-main').innerHTML = '';
    renderMain();
    paintGo(progFor()?.pct ?? null, progFor()?.text);
    ensureData(false).then(() => {
      if (state.sport !== sp || !modal) return;
      refreshLeagues();
      if (!progFor()) modal.querySelector('.kk-status-wrap').innerHTML = statusHtml();
    }).catch(() => {});
  }

  // ---------- çalıştırma ----------
  async function runAuto() {
    if (busy) return;
    readInputs();
    save();
    tab = 'build';
    setBusy(true);
    let best;
    try {
      best = await autoTune({ ...state }, say);
    } catch (err) {
      modal.querySelector('.kk-main').innerHTML = `<div class="kk-empty-box kk-empty-box--big is-bad"><b>Ayar bulunamadı</b><span>${esc(err?.message || err)}</span></div>`;
      setBusy(false);
      return;
    }
    setBusy(false);
    state.side = best.side;
    state.minLine = null;
    state.maxLine = null;
    save();
    renderForm();
    autoNote = `En iyi ayar: ${sideTxt(best.side)} · ${best.k} maç (aralığın ${state.minLegs}–${state.maxLegs}) · oran ${state.minOdds}–${state.maxOdds} · ${state.sort === 'EV' ? 'değere' : 'tutma olasılığına'} göre`;
    run(false, [best.k]);
  }

  async function run(force = false, sizesOverride = null) {
    if (busy) return;
    readInputs();
    if (!state.sizes.length) state.sizes = legRange();
    save();
    tab = 'build';
    renderTabsOnly();
    setBusy(true);
    say(progFor() ? progFor().text : 'Kuponlar hazırlanıyor…');
    try {
      const { list, stats } = await build({ ...state, sizes: sizesOverride || [...state.sizes].sort((a, b) => a - b) }, say, force);
      lastList = list;
      if (state.sport === 'football') calLogCoupons(list).catch(() => {});
      lastStats = stats;
      offSet.clear();
      selKey = null;
      if (!list.length) {
        modal.querySelector('.kk-main').innerHTML = `<div class="kk-empty-box kk-empty-box--big"><b>Bu ayarlarla kupon bulunamadı</b><span>En az oranı düşür, saat aralığını ya da lig seçimini genişlet.</span></div>`;
      } else renderMain();
    } catch (err) {
      modal.querySelector('.kk-main').innerHTML = `<div class="kk-empty-box kk-empty-box--big is-bad"><b>Hesaplanamadı</b><span>${esc(err?.message || err)}</span></div>`;
    } finally {
      setBusy(false);
      modal.querySelector('.kk-status-wrap').innerHTML = statusHtml();
    }
  }
  function renderTabsOnly() {
    modal.querySelectorAll('.kk-tab').forEach((x) => x.classList.toggle('is-on', x.dataset.tab === tab));
    modal.querySelector('.kk-shell').classList.toggle('is-favs', tab !== 'build');
    modal.querySelector('.kk-tab[data-tab="favs"] em').textContent = favsCur().length;
  }

  // ---------- açıklama balonu ----------
  let tip = null;
  let tipPinned = false;
  function showTip(el, pin = false) {
    if (!tip) { tip = document.createElement('div'); tip.className = 'kk-tip'; modal.appendChild(tip); }
    if (pin) tipPinned = !(tipPinned && tip.dataset.for === el.dataset.tip);
    tip.dataset.for = el.dataset.tip;
    tip.textContent = el.dataset.tip;
    tip.hidden = pin && !tipPinned;
    const r = el.getBoundingClientRect();
    const w = 300;
    tip.style.width = `${w}px`;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    const h = tip.offsetHeight;
    tip.style.top = `${r.top - h - 10 > 8 ? r.top - h - 10 : r.bottom + 10}px`;
  }
  function hideTip() { if (tip) tip.hidden = true; }

  // ---------- pencere ----------
  async function openModal() {
    await loadFavs();
    if (modal) { modal.hidden = false; refreshLeagues(); renderTabsOnly(); if (tab === 'favs') renderMain(); return; }
    modal = document.createElement('div');
    modal.className = 'kk-modal';
    modal.innerHTML = '<div class="kk-backdrop"></div>'
      + '<section class="kk-shell" role="dialog" aria-modal="true" aria-label="Goal Mix kupon asistanı">'
      + '<header class="kk-top">'
      + `<div class="kk-brand"><span class="kk-logo">${ICON.ball}</span><div><h2>Kupon Asistanı</h2><p>Goal Mix · adil oranla kupon önerisi</p></div></div>`
      + `<div class="kk-sport" role="group" aria-label="Branş">${sportSeg()}</div>`
      + '<nav class="kk-tabs" role="tablist"><button type="button" class="kk-tab is-on" data-tab="build" role="tab">Kupon oluştur</button>'
      + `<button type="button" class="kk-tab" data-tab="favs" role="tab">${ICON.star}Favoriler <em>0</em></button>`
      + '<button type="button" class="kk-tab" data-tab="cal" role="tab">Kalibrasyon</button></nav>'
      + `<div class="kk-top-right"><span class="kk-status-wrap"></span><button type="button" class="kk-icon-btn kk-refresh" title="Maç verisini yenile">${ICON.refresh}</button>`
      + `<button type="button" class="kk-icon-btn kk-x" aria-label="Kapat">${ICON.close}</button></div></header>`
      + '<div class="kk-body"><aside class="kk-side"><div class="kk-side-body"></div>'
      + '<div class="kk-side-foot"><button type="button" class="kk-btn kk-btn--primary kk-go">Kuponları oluştur</button>'
      + '<p>Tahmindir, garanti değildir. Eklenti bahis yapmaz.</p></div></aside>'
      + '<main class="kk-main"></main></div></section>';
    document.body.appendChild(modal);
    paintSport();
    renderForm();
    renderMain();
    progSubs.add((p, sp) => {
      if (!modal || modal.hidden || sp !== state.sport) return;
      if (p && (busy || modal.querySelector('.kk-wait'))) paintWait(p.text, p.pct);
      else paintGo(p?.pct ?? null, p?.text);
      const sw = modal.querySelector('.kk-status-wrap');
      if (sw) sw.innerHTML = p ? `<span class="kk-status is-busy"><i></i>Veri okunuyor · %${p.pct}</span>` : statusHtml();
    });
    if (progFor()) paintGo(progFor().pct, progFor().text);
    ensureData(false).then(() => { refreshLeagues(); modal.querySelector('.kk-status-wrap').innerHTML = statusHtml(); }).catch(() => {});

    modal.addEventListener('mouseover', (ev) => {
      const ib = ev.target.closest?.('.kk-i');
      if (ib) showTip(ib);
      const bar = ev.target.closest?.('.kk-bar');
      if (bar && setCache) {
        const keep = setK;
        setK = Number(bar.dataset.k);
        modal.querySelector('.kk-set-detail').outerHTML = setDetail(setCache);
        setK = keep; // üstünden çekilince seçili çubuğa döner
      }
    });
    modal.addEventListener('mouseleave', () => {}, true);
    modal.addEventListener('mouseout', (ev) => {
      if (ev.target.closest?.('.kk-bars') && !ev.relatedTarget?.closest?.('.kk-bars') && setCache) modal.querySelector('.kk-set-detail').outerHTML = setDetail(setCache);
    });
    modal.addEventListener('mouseout', (ev) => { if (ev.target.closest?.('.kk-i') && !tipPinned) hideTip(); });
    modal.addEventListener('error', (ev) => {
      const img = ev.target;
      if (img?.tagName === 'IMG' && img.dataset.flag != null) { const sp = img.parentElement; sp.classList.add('kk-lg-flag'); sp.textContent = img.dataset.flag; }
    }, true);
    modal.addEventListener('focusin', (ev) => { if (ev.target.classList?.contains('kk-i')) showTip(ev.target); });
    modal.addEventListener('focusout', (ev) => { if (ev.target.classList?.contains('kk-i')) { tipPinned = false; hideTip(); } });
    modal.addEventListener('input', (ev) => {
      if (ev.target.classList.contains('kk-lp-search')) renderLeagues();
    });
    modal.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.name === 'auto') {
        readInputs();
        state.auto = t.checked ? 1 : 0;
        if (state.auto === 1) { state.minLine = null; state.maxLine = null; }
        save();
        renderForm();
        return;
      }
      if (t.name === 'stake') {
        const v = Number(String(t.value).replace(',', '.'));
        state.stake = v > 0 ? v : 1;
        save();
        redrawSet();
        return;
      }
      if (t.closest?.('.kk-side')) { readInputs(); save(); }
    });
    modal.addEventListener('keydown', (ev) => {
      const row = ev.target.closest?.('.kk-row');
      if (row && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); row.click(); }
    });
    modal.addEventListener('click', (ev) => {
      const t = ev.target;
      if (t.closest('.kk-x') || t.classList.contains('kk-backdrop')) { modal.hidden = true; return; }
      const spb = t.closest('.kk-sport button');
      if (spb) { switchSport(spb.dataset.sport); return; }
      const tb = t.closest('.kk-tab');
      if (tb) { tab = tb.dataset.tab; renderMain(); return; }
      if (t.closest('.kk-refresh')) { run(true); return; }
      const ib = t.closest('.kk-i');
      if (ib) { showTip(ib, true); return; }
      const b = t.closest('.kk-seg button');
      if (b) {
        const name = b.parentElement.dataset.name;
        if (name === 'order') { state.order = b.dataset.v; save(); redrawRows(); return; }
        state[name] = name === 'side' || name === 'sort' ? b.dataset.v : Number(b.dataset.v);
        readInputs();
        save();
        renderForm();
        return;
      }
      if (t.closest('.kk-go')) { if (state.auto === 1) runAuto(); else { autoNote = ''; run(); } return; }
      // favori yıldızı (satır ya da ayrıntı)
      const sb = t.closest('.kk-star, .kk-star-btn');
      if (sb) {
        const c = [...lastList, ...favs].find((x) => keyOf(x) === sb.dataset.key);
        if (c) toggleFav(c);
        if (tab === 'favs') { offFav.delete(sb.dataset.key); renderMain(); } else { redrawRows(); renderTabsOnly(); }
        return;
      }
      const ck = t.closest('.kk-check');
      if (ck) {
        const off = curOff();
        const k = ck.dataset.key;
        if (off.has(k)) off.delete(k); else off.add(k);
        ck.classList.toggle('is-on', !off.has(k));
        redrawSet();
        return;
      }
      const bar = t.closest('.kk-bar');
      if (bar && setCache) {
        setK = Number(bar.dataset.k);
        modal.querySelectorAll('.kk-bar').forEach((x) => x.classList.toggle('is-sel', x === bar));
        modal.querySelector('.kk-set-detail').outerHTML = setDetail(setCache);
        return;
      }
      if (t.closest('.kk-set-all')) { curOff().clear(); modal.querySelectorAll('.kk-check').forEach((x) => x.classList.add('is-on')); redrawSet(); return; }
      if (t.closest('.kk-set-none')) { curList().forEach((c) => curOff().add(keyOf(c))); modal.querySelectorAll('.kk-check').forEach((x) => x.classList.remove('is-on')); redrawSet(); return; }
      // Tümünü temizle: iki adımlı (ilk basış onay ister, 4 sn içinde ikinci basış siler).
      const fc = t.closest('.kk-fav-clear');
      if (fc) {
        if (!fc.classList.contains('is-confirm')) {
          fc.classList.add('is-confirm');
          fc.innerHTML = `${ICON.trash}Emin misin? ${favsCur().length} favori silinir · Evet, sil`;
          setTimeout(() => { if (fc.isConnected) { fc.classList.remove('is-confirm'); fc.innerHTML = `${ICON.trash}Tümünü temizle`; } }, 4000);
          return;
        }
        favs = favs.filter((f) => sportOf(f) !== state.sport);
        offFav.clear();
        favSel = null;
        saveFavs();
        renderMain();
        return;
      }
      if (t.closest('.kk-fav-clean')) {
        favs = favs.filter((c) => couponState(c)?.cls !== 'done' && couponState(c)?.cls !== 'live');
        saveFavs();
        renderMain();
        return;
      }
      const row = t.closest('.kk-row');
      if (row) {
        if (tab === 'favs') favSel = row.dataset.key; else selKey = row.dataset.key;
        showDetail();
        return;
      }
      // lig penceresi
      if (t.closest('.kk-lg-btn')) { openLeagues(); return; }
      if (modal.querySelector('.kk-lp:not([hidden])') && t.closest('.kk-lp')) {
        const lg = t.closest('.kk-lg');
        if (lg) { const k = lg.dataset.key; if (lpDraft.has(k)) lpDraft.delete(k); else lpDraft.add(k); renderLeagues(); return; }
        if (t.closest('.kk-lp-major')) { lpDraft = new Set(leagueList().filter(([, v]) => v.major).map(([k]) => k)); renderLeagues(); return; }
        if (t.closest('.kk-lp-all') || t.closest('.kk-lp-none')) { lpDraft = new Set(); renderLeagues(); return; }
        if (t.closest('.kk-lp-apply')) { closeLeagues(true); return; }
        if (t.closest('.kk-lp-cancel') || t.closest('.kk-lp-x') || t.classList.contains('kk-lp-back')) { closeLeagues(false); return; }
        return;
      }
      if (t.closest('.kk-dd-btn')) {
        const p = modal.querySelector('.kk-dd-panel');
        p.hidden = !p.hidden;
        if (!p.hidden) { refreshLeagues(); p.querySelector('.kk-dd-search').focus({ preventScroll: true }); p.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        return;
      }
      if (t.closest('.kk-dd-clear')) { state.leagues = []; save(); refreshLeagues(); return; }
      if (t.closest('.kk-dd-close')) { modal.querySelector('.kk-dd-panel').hidden = true; return; }
      if (!t.closest('.kk-dd')) { const p = modal.querySelector('.kk-dd-panel'); if (p) p.hidden = true; }
      const ca = t.closest('.kk-copy-all');
      if (ca) {
        const list = curList();
        if (!list.length) return;
        navigator.clipboard?.writeText(allCopyText(list)).then(() => {
          const sp = ca.querySelector('span');
          const old = sp.textContent;
          sp.textContent = `${list.length} kupon kopyalandı`;
          ca.classList.add('is-on');
          setTimeout(() => { if (ca.isConnected) { sp.textContent = old; ca.classList.remove('is-on'); } }, 1600);
        });
        return;
      }
      const fa = t.closest('.kk-fav-all');
      if (fa) {
        const add = lastList.filter((c) => !isFav(c));
        if (!add.length) return;
        favs = [...add.map(snap), ...favs];
        saveFavs();
        redrawRows();
        renderTabsOnly();
        const sp = modal.querySelector('.kk-fav-all span');
        if (sp) { sp.textContent = `${add.length} kupon eklendi`; setTimeout(() => { if (sp.isConnected) sp.textContent = 'Hepsi favoride'; }, 1600); }
        return;
      }
      const cp = t.closest('.kk-copy');
      if (cp) {
        navigator.clipboard?.writeText(cp.dataset.copy).then(() => {
          const sp = cp.querySelector('span');
          if (sp) { sp.textContent = 'Kopyalandı'; setTimeout(() => { sp.textContent = 'Maçları kopyala'; }, 1500); }
        });
      }
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !modal || modal.hidden) return;
      if (modal.querySelector('.kk-lp:not([hidden])')) { closeLeagues(false); return; }
      modal.hidden = true;
    });
  }

  function sync() {
    const on = PAGE_RE.test(location.pathname);
    if (on && !fab) {
      fab = document.createElement('button');
      fab.type = 'button';
      fab.className = 'kk-fab';
      fab.innerHTML = `${ICON.ball}<span>Kupon asistanı</span>`;
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
