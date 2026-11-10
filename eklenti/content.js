// Kupon Canlı Skor: Bahislerim kartlarına, karttaki maçların canlı skorunu ekler.
// Maç adları, saatleri ve canlı skorlar veri servisinden gelir (background.js çeker, chrome.storage); 6q'ya hiçbir
// istek atılmaz, sadece ekrandaki kupon kartları okunur. SofaScore ve Livescore kaldırıldı.
(() => {
  if (window.__kcsLoaded) return;
  window.__kcsLoaded = true;

  // Bahislerim sayfasının filtre çubuğu: eklenti sadece bu varsa çalışır, rozet de buraya konur.
  const BETS_PAGE = '.section--my-bets .my-bets-desktop-filters';

  // Eşleşmede anlamı olmayan kelimeler (kulüp ekleri vb.).
  const STOP = new Set([
    'fc', 'cf', 'sc', 'ac', 'cd', 'ca', 'afc', 'club', 'de', 'do', 'da', 'del', 'la', 'el', 'the',
    'sv', 'fk', 'sk', 'if', 'bk', 'cp', 'ud', 'sd', 'rc', 'us', 'as', 'ss', 'fsv', 'vfb', 'vfl',
    'tsg', 'u19', 'u20', 'u21', 'u23', 'women', 'kadin', 'and', 'vs', 'spor', 'kulubu', 'clube',
    'futbol', 'calcio', 'sport', 'stade', 'al', 'kv', 'ksv', 'cfp', 'pfk', 'sbv', 'acf', 'gks',
  ]);

  // Kuponda bütün olarak geçen kısaltmalar → listedeki adda geçen kelimeler.
  const PHRASE_ALIAS = {
    'psg': 'paris saint germain',
    'az': 'alkmaar zaanstreek',
    'az ii': 'alkmaar zaanstreek ii',
    'jong az': 'alkmaar zaanstreek ii',
    'usg': 'union saint gilloise',
    'union sg': 'union saint gilloise',
    'lask': 'linzer athletik',
    'r madrid': 'real madrid',
    'a madrid': 'atletico madrid',
    'c pia': 'casa pia',
    'man utd': 'manchester united',
    'm united': 'manchester united',
    'm utd': 'manchester united',
    'man city': 'manchester city',
    'm city': 'manchester city',
    'r vienna': 'rapid',
    'r wien': 'rapid',
    'a vienna': 'austria wien',
    'm gladbach': 'monchengladbach',
    'gladbach': 'monchengladbach',
  };

  // Tek kelimelik Türkçe/yerel yazımlar ve sık yazım hataları.
  const WORD_ALIAS = {
    kopenhag: 'kobenhavn', kopenhagen: 'kobenhavn', copenhagen: 'kobenhavn',
    munih: 'munchen', munich: 'munchen',
    marsilya: 'marseille', vienna: 'wien', viyana: 'wien', prag: 'praha',
    bukres: 'bucuresti', bucharest: 'bucuresti', lizbon: 'lisboa', belgrad: 'beograd',
    moskova: 'moskva', atina: 'athens', rennes: 'rennais', plezn: 'plzen', pilsen: 'plzen',
    alnassr: 'nassr', alhilal: 'hilal', qadisiyah: 'qadsiah', villerael: 'villarreal',
    graafchap: 'graafschap', brugge: 'brugge', bruj: 'brugge',
  };

  const MIN_SIDE_SCORE = 0.6;
  // Yedek/altyapı takımları: "PSV II", "Jong AZ", "Braga B", "Benfica U23".
  const RESERVE_RE = /\b(ii|u19|u20|u21|u23|jong)\b|\sb$/;
  const WOMEN_RE = /\b(women|womens|w|wfc|ladies|kadin|femenino|feminin|frauen)\b/;

  // ---------- yardımcılar ----------

  function norm(s) {
    return String(s || '')
      .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
      .toLowerCase()
      .replace(/ł/g, 'l').replace(/đ/g, 'd').replace(/ø/g, 'o').replace(/æ/g, 'ae')
      .replace(/œ/g, 'oe').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function tokens(s) {
    return norm(s).split(' ').filter((t) => t.length >= 3 && !STOP.has(t))
      .map((t) => WORD_ALIAS[t] || t)
      // Türk takımlarındaki "-spor" eki bazen ayrı yazılır: "Amedspor" = "Amed SK", "Eyüpspor" = "Eyüp".
      .map((t) => (t.length > 6 && t.endsWith('spor') ? t.slice(0, -4) : t));
  }

  // Kupondaki bir takım yazısı ("R.MADRID", "S.GRAZ", "PSG") → kelimeler + baş harfler.
  function sideInfo(text) {
    let n = norm(text);
    // Önce elle düzeltmelerden öğrenilen ad, sonra hazır kısaltma sözlüğü.
    if (learnedSides[n]) n = norm(learnedSides[n]);
    else if (PHRASE_ALIAS[n]) n = PHRASE_ALIAS[n];
    const words = n.split(' ').filter(Boolean);
    const own = tokens(n);
    const alias = aliasTokens(n);
    return {
      own, alias,
      toks: [...new Set([...own, ...alias])],
      // "R.MADRID" içindeki "r" gibi tek harfler: takım adındaki başka bir kelimenin baş harfi olabilir.
      initials: words.filter((w) => w.length === 1 && /[a-z]/.test(w)),
      reserve: RESERVE_RE.test(n),
      women: WOMEN_RE.test(n),
    };
  }

  const teamMemo = new Map();
  function teamInfo(name) {
    let info = teamMemo.get(name);
    if (!info) {
      const n = norm(name);
      info = { toks: tokens(n), words: n.split(' '), reserve: RESERVE_RE.test(n), women: WOMEN_RE.test(n), norm: n };
      if (teamMemo.size > 50000) teamMemo.clear();
      teamMemo.set(name, info);
    }
    return info;
  }

  function lev(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  const simMemo = new Map();

  function tokSim(a, b) {
    if (a === b) return 1;
    // a: listedeki takım kelimesi, b: kupondaki kelime. Kupon kısaltır ("ALANYA" → Alanyaspor),
    // tersi değil: "SANTANDER" kuponda varken "Santa ..." takımına uymamalı.
    if (a.length >= 4 && b.length >= 4 && a.startsWith(b)) return 0.9;
    if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 2) return 0;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    let v = simMemo.get(k);
    if (v === undefined) {
      const d = lev(a, b);
      v = d <= 1 || (d <= 2 && Math.min(a.length, b.length) >= 7) ? 0.75 : 0;
      if (simMemo.size > 200000) simMemo.clear();
      simMemo.set(k, v);
    }
    return v;
  }

  // Kupondaki takım yazısının listedeki takım adına ne kadar benzediği (0 = hiç).
  // Kupondaki kelimelerin ne kadarının takım adında geçtiğine bakar: "REAL MADRID" için
  // Real Madrid 1, Atlético de Madrid 0.5 alır.
  function sideScore(team, side) {
    // Kuponda yazmıyorsa kadın ve yedek takımı sayılmaz: asıl maç listede yokken "Benfica B" gösterilmesin.
    if ((team.women && !side.women) || (team.reserve && !side.reserve)) return 0;
    let sum = 0;
    let hit = 0;
    for (const x of side.own) {
      let best = 0;
      for (const t of team.toks) best = Math.max(best, tokSim(t, x));
      sum += best;
      if (best) hit++;
    }
    let s = hit ? sum / side.own.length : 0;
    // Tablodaki adlar kupon kelimesi gibi sayılmaz (çok adı olan kulübün puanı düşerdi): takımın adı bu adlarla
    // karşılanıyorsa yeter ("KIZILYILDIZ" → FK Crvena zvezda).
    const viaAlias = side.alias.length ? coverage(team, side.alias) : 0;
    if (viaAlias >= 0.7) s = Math.max(s, 0.9 * viaAlias);
    if (!s) return 0;
    // Takım adının ne kadarı karşılandı (eşitlikte kısa/tam eşleşen ad önce gelir).
    const covered = team.toks.filter((t) => side.toks.some((x) => tokSim(t, x))).length;
    s += 0.03 * covered / team.toks.length;
    // Baş harf eşleşirse küçük bir artı: "S.GRAZ" → Sturm Graz.
    for (const i of side.initials) if (team.words.some((w) => w[0] === i)) s += 0.05;
    if (side.reserve === team.reserve) s += 0.02;
    return s;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------- SofaScore verisi ve elle düzeltmeler (chrome.storage) ----------

  const hasStore = typeof chrome !== 'undefined' && !!chrome.storage?.local;
  const STORE_KEYS = ['skFeed', 'manualOrder', 'groupSpecial', 'groupBets', 'fullWidth', 'colsSpecial', 'colsBets', 'updateInfo', 'sbSort', 'skLinks', 'skEvents', 'skMeta', 'linkOpen', 'plOpen', 'multiStake', 'aiCalls', 'sofaEvents', 'sofaMeta', 'overrides', 'sofaResolved', 'goalLines', 'linesSeeded', 'cardSort', 'cardShow', 'lsMeta', 'learnedSides', 'arbLinks', 'arbLearned', 'featScores', 'featArb', 'featInfo', 'featPl', 'featLink', 'lsEvents', 'lsLive', 'scoreSource', 'siteTabs',
    ...['xbet', 'stake'].flatMap((k) => [`${k}Events`, `${k}Odds`, `${k}Meta`])];
  let sofaEvents = {};
  // Liste sürümleri: skor ya da oran güncellemesi taramayı yenilemez, sadece maç sayısı değişince artar.
  const listVersion = { sofa: 0, ls: 0, sk: 0 };
  const countOf = (x) => (Array.isArray(x) ? x.length : Object.keys(x || {}).length);
  let skEvents = {};       // veri servisi: dün/bugün/yarın maçları ve canlı skorlar (background.js çeker)
  let skMeta = {};
  let skLinks = {};        // kupon maç yazısı → veri servisi maç no (gece görevi not dosyasına yazar), 30 gün saklanır
  let lsEvents = {};       // livescore.in maçları (livescore.js): ikinci takım adı kaynağı
  let lsLive = {};         // livescore.in ekranından canlı skorlar
  let scoreSource = 'sofa'; // menüden: 'sofa' | 'livescore' | 'service' (veri servisi)
  let sofaMeta = {};
  let linkOpen = false;    // birbirine bağlı (ortak maçlı) kuponlar bölümü açık mı
  let plOpen = false;      // çok maçlı kâr/zarar bölümü açık mı (sayfa açılınca küçük gelir)
  let multiStake = 100;    // kâr/zarar hesabında çok maçlı kupon başına tutar
  let aiCalls = {};        // yapay zeka yorumlarının kopyası: not dosyası değişse de kupon altında kalır
  let overrides = {};      // kupon yazısı → SofaScore maç no (kullanıcı bağladı)
  let seededLines = false;
  let lsMeta = {};
  let updateInfo = {};     // { latest, checkedAt }: GitHub'daki son sürüm (background.js)
  let skFeed = {};         // veri servisi maç olayları: { maç no: { at, events } } (background.js)
  const trackedSk = new Set(); // kuponlardaki canlı maçlar: olayları istenir
  let manualOrder = { special: [], bets: [] }; // elle sıralama: kupon anahtarları sırayla
  let groupSpecial = 'none'; // Özel Oranlar gruplama: none, single (tekli önce), multi (çoklu önce)
  let groupBets = 'none';    // Bahislerim gruplama
  let kxDd = null;         // üst panelde açık olan liste (sırala, grupla...)
  let fullWidth = true;    // sayfa içeriği ekranın tamamını kaplasın (6q 1328 px ile sınırlıyor)
  let colsSpecial = 0;     // Özel Oranlar: satır başına kart (0 = sitenin düzeni)
  let colsBets = 0;        // Bahislerim: satır başına kupon (0 = sitenin düzeni)
  let sbSort = 'site';      // Bahislerim: site, start, live, goal
  let cardShow = 'all';    // Özel Oranlar: all, single, multi
  let cardFolds = {};      // "arb|kart": true küçük, false açık; yoksa foldAll geçerli. Saklanmaz.
  let foldAll = true;      // sayfa her açıldığında bölümler küçük gelir
  let cardSort = 'site';   // Özel Oranlar sırası: site, arb, start
  let goalLines = {};      // kupon yazısı → { line, side, at } (Özel Oranlar'dan öğrenilen Alt/Üst çizgisi)
  let sofaResolved = {};   // kupon yazısı → { id } (SofaScore aramasıyla bulundu)
  let learnedSides = {};   // kupondaki takım yazısı → SofaScore takım adı (elle düzeltmelerden öğrenildi)
  let features = { scores: true, arb: true, info: true, pl: true, link: false }; // üst şeritten ve menüden açılıp kapatılır
  let siteTabs = {};       // { sofa, ls, xbet, stake }: sekme açık mı (background.js)
  let matchDirty = true;   // maç eşleşmeleri yeniden bakılmalı
  let onBetsPage = false;  // sayfada kupon kartı var
  let lastScanReq = 0;
  const requested = new Set();

  async function loadStore() {
    if (!hasStore) return;
    const s = await chrome.storage.local.get(STORE_KEYS);
    sofaEvents = s.sofaEvents || {};
    for (const k in listVersion) listVersion[k]++;
    matchDirty = true;
    sofaMeta = s.sofaMeta || {};
    aiCalls = s.aiCalls || {};
    multiStake = Number(s.multiStake) > 0 ? Number(s.multiStake) : 100;
    plOpen = s.plOpen === true;
    linkOpen = s.linkOpen === true;
    overrides = s.overrides || {};
    sofaResolved = s.sofaResolved || {};
    goalLines = s.goalLines || {};
    seededLines = seededLines || !!s.linesSeeded;
    cardSort = s.cardSort || 'site';
    lsMeta = s.lsMeta || {};
    cardShow = ['all', 'single', 'multi'].includes(s.cardShow) ? s.cardShow : 'all';
    sbSort = ['site', 'start', 'live', 'goal', 'manual'].includes(s.sbSort) ? s.sbSort : 'site';
    updateInfo = s.updateInfo || {};
    colsSpecial = [0, 1, 2, 3, 4, 5, 6].includes(s.colsSpecial) ? s.colsSpecial : 0;
    fullWidth = s.fullWidth !== false;
    manualOrder = { special: s.manualOrder?.special || [], bets: s.manualOrder?.bets || [] };
    skFeed = s.skFeed || {};
    groupSpecial = ['none', 'single', 'multi'].includes(s.groupSpecial) ? s.groupSpecial : 'none';
    groupBets = ['none', 'single', 'multi'].includes(s.groupBets) ? s.groupBets : 'none';
    colsBets = [0, 1, 2, 3, 4, 5, 6].includes(s.colsBets) ? s.colsBets : 0;
    applyTheme();
    learnedSides = s.learnedSides || {};
    arbLinks = s.arbLinks || {};
    arbLearned = s.arbLearned || {};
    lsEvents = s.lsEvents || {};
    skEvents = s.skEvents || {};
    skMeta = s.skMeta || {};
    skLinks = s.skLinks || {};
    lsLive = s.lsLive || {};
    scoreSource = s.scoreSource || 'sofa';
    siteTabs = s.siteTabs || {};
    features = { scores: s.featScores !== false, arb: s.featArb !== false, info: s.featInfo !== false, pl: s.featPl !== false, link: s.featLink === true };
    for (const k in books) {
      books[k] = { events: s[`${k}Events`] || [], odds: s[`${k}Odds`] || {}, meta: s[`${k}Meta`] || {}, index: null };
    }
  }

  function listenStore() {
    if (!hasStore) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      // Sayfayı sadece gerçekten değişen veri yeniden çizer; sekmelerin "açığım" yazımları ve eklentinin kendi
      // kayıtları (aranacak maçlar vb.) çizim tetiklemez. Sekme durumu 30 saniyelik çizimde güncellenir.
      let redraw = false;
      if (changes.sofaEvents) {
        const next = changes.sofaEvents.newValue || {};
        if (countOf(next) !== countOf(sofaEvents)) { listVersion.sofa++; matchDirty = true; redraw = true; }
        sofaEvents = next;
        if (onBetsPage) redraw = true;
      }
      if (changes.sofaMeta) sofaMeta = changes.sofaMeta.newValue || {};
      if (changes.aiCalls) aiCalls = changes.aiCalls.newValue || {};
      if (changes.overrides) { overrides = changes.overrides.newValue || {}; redraw = true; }
      if (changes.sofaResolved) { sofaResolved = changes.sofaResolved.newValue || {}; redraw = true; }
      if (changes.goalLines) { goalLines = changes.goalLines.newValue || {}; redraw = true; }
      if (changes.lsMeta) lsMeta = changes.lsMeta.newValue || {};
      if (changes.cardSort) { cardSort = changes.cardSort.newValue || 'site'; redraw = true; }
      if (changes.learnedSides) { learnedSides = changes.learnedSides.newValue || {}; listCacheKey = ''; redraw = true; }
      if (changes.arbLinks) { arbLinks = changes.arbLinks.newValue || {}; matchDirty = true; redraw = true; }
      if (changes.arbLearned) { arbLearned = changes.arbLearned.newValue || {}; matchDirty = true; redraw = true; }
      if (changes.skMeta) skMeta = changes.skMeta.newValue || {};
      if (changes.skFeed) { skFeed = changes.skFeed.newValue || {}; if (onBetsPage) redraw = true; }
      if (changes.updateInfo) { updateInfo = changes.updateInfo.newValue || {}; redraw = true; }
      if (changes.skEvents) {
        const next = changes.skEvents.newValue || {};
        if (countOf(next) !== countOf(skEvents)) { listVersion.sk++; matchDirty = true; redraw = true; }
        skEvents = next;
        if (onBetsPage) redraw = true;
      }
      if (changes.lsEvents) {
        const next = changes.lsEvents.newValue || {};
        if (countOf(next) !== countOf(lsEvents)) { listVersion.ls++; matchDirty = true; redraw = true; }
        lsEvents = next;
        lsMemo.clear();
      }
      if (changes.lsLive) { lsLive = changes.lsLive.newValue || {}; if (scoreSource === 'livescore' && onBetsPage) redraw = true; }
      if (changes.scoreSource) { scoreSource = changes.scoreSource.newValue || 'sofa'; redraw = true; }
      if (changes.siteTabs) { siteTabs = changes.siteTabs.newValue || {}; redraw = true; }
      if (changes.featScores) { features.scores = changes.featScores.newValue !== false; redraw = true; }
      if (changes.featArb) { features.arb = changes.featArb.newValue !== false; redraw = true; }
      if (changes.featInfo) { features.info = changes.featInfo.newValue !== false; redraw = true; }
      if (changes.featPl) { features.pl = changes.featPl.newValue !== false; redraw = true; }
      if (changes.featLink) { features.link = changes.featLink.newValue === true; redraw = true; }
      for (const k in books) {
        if (changes[`${k}Events`]) {
          const next = changes[`${k}Events`].newValue || [];
          const grown = next.length !== books[k].events.length;
          if (grown) { matchDirty = true; redraw = true; books[k].index = null; }
          books[k].events = next;
        }
        if (changes[`${k}Odds`]) { books[k].odds = changes[`${k}Odds`].newValue || {}; redraw = true; }
        if (changes[`${k}Meta`]) {
          // Kapalıdan bağlıya geçince hemen çiz; "açığım" yazımları için çizme.
          if (!bookConnected(k)) redraw = true;
          books[k].meta = changes[`${k}Meta`].newValue || {};
        }
      }
      if (changes.arbLearnReq?.newValue) onLearnReq(changes.arbLearnReq.newValue);
      if (redraw) scheduleRender();
    });
  }

  // Sekme gerçekten açık mı (arka plan izler) ve veri geliyor mu.
  const sofaConnected = () => false; // SofaScore kaldırıldı

  // SofaScore maçını görünümdeki ortak biçime çevirir; dakika her çizimde yeniden hesaplanır.
  const SK_DONE = new Set(['FINISHED', 'AWARDED', 'AFTER_EXTRA_TIME', 'AFTER_PENALTIES', 'FT', 'AET', 'FT_PEN']);
  const SK_WAIT = new Set(['SCHEDULED', 'NOT_STARTED', 'TBA', 'NS', '']);
  const SK_OFF = new Set(['POSTPONED', 'CANCELLED', 'CANCELED', 'SUSPENDED', 'ABANDONED', 'INTERRUPTED', 'DELAYED']);
  // Veri servisi maçı: dakika servisten gelir (en çok 1 dk eski).
  function fromSk(e) {
    const ended = SK_DONE.has(e.status);
    const live = !ended && !SK_WAIT.has(e.status) && !SK_OFF.has(e.status);
    let clock = '';
    if (e.status === 'HALFTIME') clock = 'İY';
    else if (live) clock = e.minute != null ? `${e.minute}${e.added ? `+${e.added}` : ''}'` : (e.label || 'Canlı');
    else if (ended) clock = 'MS';
    else if (SK_OFF.has(e.status)) clock = e.label || e.status;
    return {
      id: `k${e.id}`,
      home: e.home, away: e.away, homeShort: '', awayShort: '',
      homeLogo: e.homeLogo || '', awayLogo: e.awayLogo || '',
      homeTid: e.homeTid ?? null, awayTid: e.awayTid ?? null,
      hs: e.hs, as: e.as,
      isLive: live, ended,
      hasScore: e.hs != null && e.as != null && (live || ended),
      start: e.start ? new Date(e.start * 1000) : null,
      url: null,
      clock: e.sport === 'basketball' && live ? (e.label || 'Canlı') : clock,
      sport: e.sport || 'football',
      src: 'Veri servisi',
    };
  }

  function fromSofa(e) {
    if (e?.sk) return fromSk(skEvents[e.sk] || e.skRaw);
    const now = Date.now() / 1000;
    const live = e.type === 'inprogress';
    let clock = '';
    if (live) {
      const m = e.periodStart ? Math.floor((now - e.periodStart) / 60) + 1 : null;
      if (e.code === 6) clock = m == null ? '1Y' : (m > 45 ? "45+'" : `${m}'`);
      else if (e.code === 7) clock = m == null ? '2Y' : (m > 45 ? "90+'" : `${45 + m}'`);
      else if (e.code === 31) clock = 'İY';
      else if (e.code === 41 || e.code === 42) clock = 'UZ';
      else if (e.code === 50) clock = 'PEN';
      else clock = e.desc || 'Canlı';
    } else if (e.type === 'finished') {
      clock = 'MS';
    } else if (e.type !== 'notstarted') {
      clock = e.desc || e.type || '';
    }
    return {
      id: e.id,
      home: e.home, away: e.away,
      homeShort: e.homeShort || '', awayShort: e.awayShort || '',
      homeId: e.homeId, awayId: e.awayId,
      hs: e.hs, as: e.as,
      isLive: live, ended: e.type === 'finished',
      hasScore: e.hs != null && e.as != null && e.type !== 'notstarted',
      start: e.startTs ? new Date(e.startTs * 1000) : null,
      url: e.slug && e.customId ? `https://www.sofascore.com/tr/football/match/${e.slug}/${e.customId}#id:${e.id}` : null,
      clock,
    };
  }

  // ---------- eşleştirme ----------

  let listCache = null;
  let listCacheKey = '';

  // SofaScore sekmesi kapalıysa maçlar veri servisinden bulunur (sekme gerekmez).
  const useSkList = () => countOf(skEvents) > 0;

  function fixtureList() {
    const key = `${sofaMeta.updatedAt}|${useSkList() ? listVersion.sk : '-'}`;
    if (listCache && key === listCacheKey) return listCache;
    listCacheKey = key;
    // SofaScore'da kısa adlar da var ("Man Utd"); eşleşmede uzun adla birlikte kullanılır.
    const sofa = [].map((e) => ({
      id: `s${e.id}`, raw: e,
      h: teamInfo(`${e.home} ${e.homeShort || ''}`), a: teamInfo(`${e.away} ${e.awayShort || ''}`),
    }));
    const sk = useSkList() ? Object.values(skEvents).map((e) => ({
      id: `k${e.id}`, raw: { sk: e.id, skRaw: e, startTs: e.start, type: SK_DONE.has(e.status) ? 'finished' : SK_WAIT.has(e.status) ? 'notstarted' : 'inprogress' },
      h: teamInfo(e.home), a: teamInfo(e.away),
    })) : [];
    listCache = [...sofa, ...sk].filter((x) => x.h.toks.length && x.a.toks.length);
    // Binlerce maç var; her kupon satırını hepsiyle karşılaştırmamak için kelimelerin ilk iki
    // harfine göre dizin tut ve eşleşme sonuçlarını liste değişene kadar sakla.
    listCache.byPrefix = new Map();
    for (const item of listCache) {
      for (const t of [...item.h.toks, ...item.a.toks]) {
        const p = t.slice(0, 2);
        if (!listCache.byPrefix.has(p)) listCache.byPrefix.set(p, new Set());
        listCache.byPrefix.get(p).add(item);
      }
    }
    listCache.pairMemo = new Map();
    return listCache;
  }

  function candidates(list, ...sides) {
    const out = new Set();
    for (const side of sides) {
      for (const t of side.toks) for (const item of list.byPrefix?.get(t.slice(0, 2)) || []) out.add(item);
    }
    return out;
  }

  // Bir maç yazısının ("A-B", "A vs B", tiresiz "LAZIO CAGLIARI") olası iki takıma bölünüşleri.
  function splits(pairText) {
    let parts = pairText.split(/\s*-\s*|\s+vs\.?\s+|\s+–\s+/i).filter(Boolean);
    if (parts.length < 2) parts = pairText.trim().split(/\s+/);
    const out = [];
    for (let cut = 1; cut < parts.length; cut++) {
      out.push([parts.slice(0, cut).join(' '), parts.slice(cut).join(' ')]);
    }
    return out;
  }

  // Kupondaki bir maç için en iyi fikstürü bulur; iki takım da tutmalı.
  function matchPair(pairText, list) {
    if (list.pairMemo?.has(pairText)) return list.pairMemo.get(pairText);
    let best = null;
    for (const [x, y] of splits(pairText)) {
      const a = sideInfo(x);
      const b = sideInfo(y);
      if (!a.toks.length || !b.toks.length) continue;
      for (const item of candidates(list, a, b)) {
        const straight = Math.min(sideScore(item.h, a), sideScore(item.a, b));
        const swapped = Math.min(sideScore(item.h, b), sideScore(item.a, a));
        let s = Math.max(straight, swapped);
        // İki takımdan biri zayıf tutuyorsa (örn. "R.MADRID" için sadece "Real" kelimesi) eşleştirme.
        if (s < MIN_SIDE_SCORE) continue;
        if (item.raw.type === 'inprogress') s += 0.01;
        if (!best || s > best.s) best = { s, item };
      }
    }
    const result = best ? best.item : null;
    list.pairMemo?.set(pairText, result);
    return result;
  }

  const rowKey = (label) => norm(label);

  // ---------- skor kaynağı: SofaScore ya da livescore.in ----------
  // Maç her zaman SofaScore üzerinden bulunur (elle bağlama, arama, "SofaScore'da bul" aynen çalışır). Menüden
  // livescore seçildiyse skor, dakika ve durum aynı maçın livescore'daki karşılığından gösterilir: canlıda açık
  // livescore sekmesinin ekranından (lsLive), değilse veri adresinden (lsEvents). Bulunamazsa SofaScore'unki kalır.
  const lsMemo = new Map();

  function lsMatch(f) {
    const key = `${f.id}|${f.start?.getTime() || ''}`;
    if (lsMemo.has(key)) return lsMemo.get(key);
    const start = f.start ? f.start.getTime() / 1000 : null;
    const ht = tokens(`${f.home} ${f.homeShort || ''}`);
    const at = tokens(`${f.away} ${f.awayShort || ''}`);
    let best = null;
    for (const x of hubIndex(HUBS[1])) {
      if (start && x.e.start && Math.abs(x.e.start - start) > 20 * 60) continue;
      const s = Math.min(coverage(x.h, [...ht, ...aliasTokens(f.home)]), coverage(x.a, [...at, ...aliasTokens(f.away)]));
      if (s >= 0.5 && (!best || s > best.s)) best = { s, e: x.e };
    }
    const out = best?.e || null;
    if (lsMemo.size > 2000) lsMemo.clear();
    lsMemo.set(key, out);
    return out;
  }

  function lsClock(stage, live, st, code) {
    if (/bitti|maç sonu|ms/i.test(stage) || st === 3) return { clock: 'MS', isLive: false, ended: true };
    if (/devre/i.test(stage) || code === 38) return { clock: 'İY', isLive: true, ended: false };
    if (/uzatma/i.test(stage)) return { clock: 'UZ', isLive: true, ended: false };
    if (/penalt/i.test(stage)) return { clock: 'PEN', isLive: true, ended: false };
    if (live && /^\d+(\+\d+)?$/.test(stage)) return { clock: `${stage}'`, isLive: true, ended: false };
    if (live || st === 2) return { clock: stage || (code === 13 ? '2Y' : '1Y'), isLive: true, ended: false };
    if (stage && !/^\d/.test(stage)) return { clock: stage, isLive: false, ended: false }; // Ertelendi, Hükmen
    return { clock: '', isLive: false, ended: false };
  }

  const skMemo = new Map();
  function skMatch(f) {
    const key = `${f.id}|${f.start?.getTime() || ''}|${listVersion.sk}`;
    if (skMemo.has(key)) return skMemo.get(key);
    const start = f.start ? f.start.getTime() / 1000 : null;
    const ht = tokens(`${f.home} ${f.homeShort || ''}`);
    const at = tokens(`${f.away} ${f.awayShort || ''}`);
    let best = null;
    for (const x of hubIndex(HUBS[2])) {
      if (start && x.e.start && Math.abs(x.e.start - start) > 20 * 60) continue;
      const s = Math.min(coverage(x.h, [...ht, ...aliasTokens(f.home)]), coverage(x.a, [...at, ...aliasTokens(f.away)]));
      if (s >= 0.5 && (!best || s > best.s)) best = { s, id: x.e.id };
    }
    const out = best?.id ?? null;
    if (skMemo.size > 2000) skMemo.clear();
    skMemo.set(key, out);
    return out;
  }

  function applySource(f) {
    return f;
  }

  function applySourceOld(f) {
    if (f && scoreSource === 'service' && f.src !== 'Veri servisi') {
      const id = skMatch(f);
      const e = id != null ? skEvents[id] : null;
      return e ? { ...fromSk(e), id: f.id, homeId: f.homeId, awayId: f.awayId } : { ...f, src: 'SofaScore (veri servisinde yok)' };
    }
    if (!f || scoreSource !== 'livescore') return f;
    const e = lsMatch(f);
    if (!e) return { ...f, src: 'SofaScore (Livescore\'da yok)' };
    const live = lsLive.events?.[e.id];
    const hs = live?.hs ?? e.hs;
    const as = live?.as ?? e.as;
    const c = lsClock(live?.stage || '', !!live?.live, e.st, e.stage);
    return {
      ...f,
      hs: hs === '' || hs == null ? null : Number(hs),
      as: as === '' || as == null ? null : Number(as),
      ...c,
      hasScore: hs != null && hs !== '' && (c.isLive || c.ended),
      url: `https://www.livescore.in/tr/mac/${e.id}/`,
      src: 'Livescore',
    };
  }

  // Öncelik: elle bağlanan maç > yazıdan otomatik eşleşme > SofaScore aramasının bulduğu maç.
  function resolve(label, auto) {
    const r = resolveSofa(label, auto);
    return { ...r, f: applySource(r.f) };
  }

  function resolveSofa(label, auto) {
    const key = rowKey(label);
    const manualId = overrides[key];
    // Eski SofaScore bağlamaları (sayı) geçersiz: otomatiğe düşer.
    if (manualId != null && String(manualId).startsWith('k')) {
      const e = skEvents[String(manualId).slice(1)];
      return { f: e ? fromSk(e) : null, how: 'manual', waiting: !e };
    }
    const linked = skLinks[key]?.id ?? notesMap.get(key)?.skId;
    if (linked != null) {
      const e = skEvents[linked];
      if (e) return { f: fromSk(e), how: 'file' };
    }
    if (auto) return { f: fromSofa(auto.raw), how: 'auto' };
    return { f: null, how: 'none' };
  }

  const MONTHS = { oca: 0, sub: 1, mar: 2, nis: 3, may: 4, haz: 5, tem: 6, agu: 7, eyl: 8, eki: 9, kas: 10, ara: 11 };

  // "1 Kas 01:58" gibi kupon saatini tarihe çevirir (aramada doğru maçı seçmek için).
  function parsePlaced(card) {
    const own = card.querySelector('.kcs-legs');
    const text = norm(card.innerText.replace(own?.innerText || '', ''));
    const m = text.match(/\b(\d{1,2}) (oca|sub|mar|nis|may|haz|tem|agu|eyl|eki|kas|ara)\w* (\d{1,2}) (\d{2})\b/);
    if (!m) return null;
    const now = new Date();
    const d = new Date(now.getFullYear(), MONTHS[m[2]], Number(m[1]), Number(m[3]), Number(m[4]));
    if (d - now > 30 * 864e5) d.setFullYear(d.getFullYear() - 1);
    return d.getTime();
  }

  function analyzeCard(card, list) {
    const titleEl = card.querySelector('.bet__title-name');
    const title = titleEl ? titleEl.textContent.trim() : '';
    const rows = [];
    const custom = card.classList.contains('bet--custom-event-history') || /\s[I|]\s/.test(title);

    if (custom) {
      // Özel etkinlik: başlık "A-B I C-D I E-F" şeklinde birden çok maç içerir.
      for (const pair of title.split(/\s+[I|]\s+|\s*\|\s*|\s*\/\s*/)) {
        if (!pair.trim()) continue;
        const auto = overrides[rowKey(pair)] != null ? null : matchPair(pair, list);
        rows.push({ label: pair.trim(), ...resolve(pair, auto) });
      }
    } else {
      // Normal kupon: her bacakta "Ev vs Deplasman" alanı ve spora göre bir bağlantı var.
      // Veri sadece futbol için olduğundan diğer sporları (NBA vb.) atla.
      for (const teams of card.querySelectorAll('[class*="leg-teams"]')) {
        if (teams.closest('.kcs-legs')) continue;
        const link = teams.closest('a[href]');
        if (link && !/\/(soccer|football)\//.test(link.getAttribute('href'))) continue;
        const names = [...teams.children].filter((el) => !/\bvs\b/i.test(el.className) && el.textContent.trim().toLowerCase() !== 'vs');
        if (names.length < 2) continue;
        const label = `${names[0].textContent.trim()} - ${names[names.length - 1].textContent.trim()}`;
        const auto = overrides[rowKey(label)] != null ? null : matchPair(label, list);
        rows.push({ label, ...resolve(label, auto) });
      }
    }

    const own = card.querySelector('.kcs-legs');
    const m = card.innerText.replace(own?.innerText || '', '').match(/TOPLAM\s*GOL\s*(\d+[.,]5)\s*(ÜST|UST|ALT)/i);
    const totalLine = m ? { line: parseFloat(m[1].replace(',', '.')), over: !/ALT/i.test(m[2]) } : null;
    return { custom, rows, totalLine, placedAt: custom ? parsePlaced(card) : null };
  }

  // ---------- öğrenme: elle düzeltilen maçtan takım yazılarını öğren ----------
  // "SANTANDER-R.MADRID" elle "Real Racing Club - Real Madrid"e bağlandıysa, bundan sonra başka
  // kuponlarda geçen "SANTANDER" ve "R.MADRID" yazıları da bu takımlarla eşleşir.

  async function learnFrom(label, e) {
    const parts = label.split(/\s*-\s*|\s+vs\.?\s+/i).filter(Boolean);
    if (parts.length !== 2 || !e) return;
    const [x, y] = parts;
    const [hx, hy] = [teamInfo(e.home), teamInfo(e.away)];
    const ax = sideInfo(x);
    const ay = sideInfo(y);
    // Kupondaki sıra ev/deplasmanla ters olabilir; daha iyi tutan yönü seç.
    const straight = sideScore(hx, ax) + sideScore(hy, ay);
    const swapped = sideScore(hx, ay) + sideScore(hy, ax);
    const [toX, toY] = swapped > straight ? [e.away, e.home] : [e.home, e.away];
    const next = { ...learnedSides, [norm(x)]: toX, [norm(y)]: toY };
    learnedSides = next;
    listCacheKey = '';
    if (hasStore) await chrome.storage.local.set({ learnedSides: next });
  }

  // ---------- görünüm: sitenin kendi bacak kartı biçiminde ----------

  let editing = null; // { key, error }

  const dayText = (d) => d.toLocaleDateString('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'short' });
  const timeText = (d) => d.toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' });
  // Takım logosu veri servisinden gelir (adres https olmalı); yoksa boş yer tutucu.
  const logoSrc = (url) => (/^https:\/\//.test(url || '') ? url : '');
  const logo = (url) => (logoSrc(url)
    ? `<span class="bet__multi-leg-logo"><img src="${esc(logoSrc(url))}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
    : '<span class="bet__multi-leg-logo"></span>');

  function clockHtml(f) {
    if (f.isLive) return `<span class="kcs-clock kcs-clock--live"><i></i>${esc(f.clock || 'Canlı')}</span>`;
    if (f.ended) return '<span class="kcs-clock kcs-clock--done">MS</span>';
    if (f.clock) return `<span class="kcs-clock kcs-clock--warn">${esc(f.clock)}</span>`;
    return '';
  }

  function editHtml(key, manual, label = '') {
    const err = editing?.error ? `<div class="kcs-err">${esc(editing.error)}</div>` : '';
    const q = editing?.q ?? label;
    return `<div class="kcs-edit" data-key="${esc(key)}" data-label="${esc(label)}">`
      + '<div class="kcs-edit-hint">Doğru maçı seç (dün, bugün ve yarının maçları). Takım adı yazarak arayabilirsin:</div>'
      + `<div class="kcs-edit-row"><input class="kcs-input kcs-pick-q" type="text" value="${esc(q)}" placeholder="Takım adı">`
      + '<button type="button" class="kcs-btn kcs-cancel">Vazgeç</button></div>'
      + `<div class="kcs-pick-list">${pickListHtml(q)}</div>`
      + (manual ? '<button type="button" class="kcs-link kcs-unlink">Elle bağlamayı kaldır, otomatiğe dön</button>' : '')
      + err + '</div>';
  }

  const HOW = { manual: 'elle bağlandı', auto: 'otomatik', file: 'eşleştirildi' };

  // Elle bağlama listesi: yazının kelimeleri (3+ harf) takım adlarında aranır; en çok kelime tutan, sonra saati
  // şimdiye en yakın maçlar önce. En çok 8 maç.
  function pickListHtml(q) {
    const words = [...new Set(norm(q).split(/[^a-z0-9]+/).filter((w) => w.length >= 3))];
    if (!words.length) return '<div class="kcs-edit-hint">En az 3 harf yaz.</div>';
    const now = Date.now() / 1000;
    const hits = [];
    for (const e of Object.values(skEvents)) {
      const text = norm(`${e.home} ${e.away}`);
      const n = words.filter((w) => text.includes(w)).length;
      if (n) hits.push({ e, n });
    }
    hits.sort((a, b) => b.n - a.n || Math.abs((a.e.start || 0) - now) - Math.abs((b.e.start || 0) - now));
    if (!hits.length) return '<div class="kcs-edit-hint">Maç bulunamadı.</div>';
    return hits.slice(0, 8).map(({ e }) => {
      const when = e.start ? new Date(e.start * 1000).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      return `<button type="button" class="kcs-btn kcs-pick-sk" data-id="${esc(e.id)}"><b>${esc(e.home)} - ${esc(e.away)}</b><small>${esc([when, e.league].filter(Boolean).join(' · '))}</small></button>`;
    }).join('');
  }

  // Arama kutusuna yazdıkça liste kutu yeniden çizilmeden güncellenir.
  function onPickInput(ev) {
    const input = targetOf(ev);
    if (!input.matches?.('.kcs-pick-q')) return;
    if (editing) editing.q = input.value;
    const list = input.closest('.kcs-edit')?.querySelector('.kcs-pick-list');
    if (list) list.innerHTML = pickListHtml(input.value);
  }

  function legHtml({ label, f, how, waiting, searching }) {
    const key = rowKey(label);
    // Elle bağlama yok: bulunamayan maçı gece görevi raporlar, eşleştirme not dosyasına yazılır (skId).
    const fixBtn = '';
    const edit = '';
    if (!f) {
      const [x = label, y = ''] = label.split(/\s*-\s*/);
      let note = 'Maç bulunamadı';
      if (waiting) note = 'Veri servisinden bekleniyor…';
      return '<div class="bet__multi-leg-card kcs-leg kcs-leg--missing"><div class="bet__multi-leg-fixture">'
        + `<div class="bet__multi-leg-meta"><span class="kcs-clock kcs-clock--warn">?</span><span>${note}</span></div>`
        + '<span class="bet__multi-leg-logos" aria-hidden="true">' + logo() + logo() + '</span>'
        + `<div class="bet__multi-leg-teams"><span class="bet__multi-leg-team-row">${esc(x)}</span><span class="bet__multi-leg-vs">vs</span><span>${esc(y)}</span></div>`
        + '<span class="bet__info-col line bet__multi-leg-score"><span>–</span><span>–</span></span>'
        + `</div><div class="kcs-leg-foot"><span>Kupon: ${esc(label)}</span>${fixBtn}</div></div>${edit}`;
    }
    const tag = f.url ? `a class="bet__multi-leg-fixture" href="${esc(f.url)}" target="_blank" rel="noopener"` : 'div class="bet__multi-leg-fixture"';
    const close = f.url ? 'a' : 'div';
    const g = (n) => (f.hasScore ? n : '–');
    const flash = f.hasScore && f.sport !== 'basketball' ? scoreFlash(f.id, f.hs, f.as, f.isLive) : null;
    return `<div class="bet__multi-leg-card kcs-leg${f.isLive ? ' kcs-leg--live' : ''}${flash ? ' kcs-flash' : ''}">`
      + `<${tag}>`
      + `<div class="bet__multi-leg-meta">${f.start ? `<span>${esc(dayText(f.start))}</span><span>${esc(timeText(f.start))}</span>` : ''}${clockHtml(f)}</div>`
      + `<span class="bet__multi-leg-logos" aria-hidden="true">${logo(f.homeLogo)}${logo(f.awayLogo)}</span>`
      + `<div class="bet__multi-leg-teams"><span class="bet__multi-leg-team-row">${esc(f.home)}</span><span class="bet__multi-leg-vs">vs</span><span>${esc(f.away)}</span></div>`
      + `<span class="bet__info-col line bet__multi-leg-score${f.isLive ? ' kcs-score--live' : ''}"><span>${g(f.hs)}</span><span>${g(f.as)}</span></span>`
      + `</${close}>`
      + `<div class="kcs-leg-foot"><span>Kupon: ${esc(label)} · ${HOW[how] || ''}</span>${fixBtn}</div>`
      + `</div>${edit}`;
  }

  function totalHtml(rows, totalLine) {
    const scored = rows.filter((r) => r.f?.hasScore);
    const goals = scored.reduce((s, r) => s + r.f.hs + r.f.as, 0);
    const allKnown = scored.length === rows.length;
    const allDone = allKnown && rows.every((r) => r.f.ended);
    const target = Math.floor(totalLine.line) + 1;
    let note;
    let cls = '';
    if (totalLine.over && goals >= target) { note = 'Tuttu'; cls = 'ok'; }
    else if (!totalLine.over && goals >= target) { note = 'Tutmadı'; cls = 'bad'; }
    else if (!allKnown) note = `${scored.length}/${rows.length} maçın skoru biliniyor`;
    else if (allDone) { note = totalLine.over ? 'Tutmadı' : 'Tuttu'; cls = totalLine.over ? 'bad' : 'ok'; }
    else note = totalLine.over ? `${target - goals} gol daha lazım` : `En fazla ${target - 1 - goals} gol daha olabilir`;
    const pct = Math.min(100, Math.round((goals / target) * 100));
    return `<div class="kcs-total${cls ? ` kcs-total--${cls}` : ''}">`
      + `<div class="kcs-total-top"><span>Toplam gol</span><b>${goals} <small>/ ${totalLine.line} ${totalLine.over ? 'Üst' : 'Alt'}</small></b></div>`
      + `<div class="kcs-bar"><i style="width:${pct}%"></i></div>`
      + `<div class="kcs-total-note">${esc(note)}</div></div>`;
  }

  // Sayfanın filtre çubuğuna tek bir SofaScore durum rozeti ve düğmesi.
  // ---------- yeni 6q Bahislerim sayfası (shadow DOM) ----------
  // Tek maçlık kartta skoru site kendisi gösterir. Çok maçlı özel oranda sadece "A-B I C-D I E-F" yazısı var; maçlar
  // bu yazının altına sitenin kendi maç kutusu sınıflarıyla çizilir, böylece aynı görünür.
  const SB_BET = '.sb-mb';

  function analyzeSb(card, list) {
    const text = card.querySelector('.sb-mb-textbet')?.textContent || '';
    const rows = [];
    for (const pair of text.trim().split(/\s+[I|]\s+|\s{2,}|\s*\|\s*/)) {
      if (!pair.includes('-')) continue;
      const auto = overrides[rowKey(pair)] != null ? null : matchPair(pair, list);
      rows.push({ label: pair.trim(), ...resolve(pair, auto) });
    }
    return { rows, placedAt: parsePlaced(card), title: text, goal: goalLines[lineKey(text)] || goalLines[norm(text)] || null };
  }

  // Skor değişince maç kutusu 45 sn boyunca işaretlenir: kutu yanıp söner, "GOL" etiketi çıkar, golü atan tarafın
  // sayısı vurgulanır. Sayfa açıldığında gelen ilk skor değişiklik sayılmaz.
  const FLASH_MS = 45 * 1000;
  const scoreSeen = new Map();
  function scoreFlash(id, hs, as, live = true) {
    if (id == null || hs == null || as == null) return null;
    const prev = scoreSeen.get(id);
    if (!prev) { scoreSeen.set(id, { hs, as, at: 0, home: false, away: false }); return null; }
    // Canlı olmayan maçta skor düzeltmesi (veri kaynağının son skoru) işaretlenmez.
    if (!live) { if (prev.hs !== hs || prev.as !== as) scoreSeen.set(id, { hs, as, at: 0, home: false, away: false }); return null; }
    if (prev.hs !== hs || prev.as !== as) {
      // Skor düştüyse gol iptal edilmiştir (VAR): GOL değil "GOL İPTAL" gösterilir.
      scoreSeen.set(id, { hs, as, at: Date.now(), home: hs !== prev.hs, away: as !== prev.as, cancel: hs + as < prev.hs + prev.as });
    }
    const cur = scoreSeen.get(id);
    return Date.now() - cur.at < FLASH_MS ? cur : null;
  }

  // ---------- Göz at / Canlı akış: maçın ayrıntısı (veri servisi) ----------
  // Panel sadece açılınca istenir (background.js 'skDetail'). Canlı maçta 30 sn'de bir, bitmiş maçta 10 dk'da bir yenilenir.
  const peekOpen = new Map(); // maç no → açık sekme
  const peekData = new Map(); // maç no → { d, at, loading, error }
  const PEEK_ICON = {"genel":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 11v5M12 7.5v.5\"/></svg>","akis":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M3 12h4l2.5-6 4 12 2.5-6H21\"/></svg>","ist":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M5 20V11M12 20V5M19 20v-6\"/></svg>","baski":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 3c1 3.5 5 5.5 5 10a5 5 0 01-10 0c0-2.2 1-3.7 2.3-5 .2 1.8 1 2.8 2.2 3.2C11.3 8.6 11 6 12 3z\"/></svg>","h2h":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M7 4l-3 3 3 3M4 7h11M17 14l3 3-3 3M20 17H9\"/></svg>","puan":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M8 4h8v5a4 4 0 01-8 0V4zM8 6H5a3 3 0 003 4M16 6h3a3 3 0 01-3 4M12 13v4M8.5 20h7M10 17h4\"/></svg>","kadro":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M8 3l-5 3 2 4 2-1v12h10V9l2 1 2-4-5-3c-.5 1.5-2 2.5-4 2.5S8.5 4.5 8 3z\"/></svg>","sira":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 20V14h4v6M10 20V9h4v11M16 20v-8h4v8M3 20h18\"/></svg>","ref":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M4 10h9a4 4 0 11-3.9 5H6a2 2 0 01-2-2v-3zM13 10V7h6\"/><circle cx=\"13\" cy=\"14\" r=\"1\"/></svg>","coach":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"5\" y=\"4\" width=\"14\" height=\"17\" rx=\"2\"/><path d=\"M9 4V3h6v1M9 10h6M9 14h6M9 18h3\"/></svg>","stad":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 21s-6-5.5-6-10.5a6 6 0 0112 0C18 15.5 12 21 12 21z\"/><circle cx=\"12\" cy=\"10.5\" r=\"2.2\"/></svg>","hava":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M7 18h10a4 4 0 00.6-7.95A5.5 5.5 0 006.2 11.2 3.4 3.4 0 007 18z\"/></svg>","tv":"<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"3\" y=\"6\" width=\"18\" height=\"12\" rx=\"2\"/><path d=\"M8 21h8M9 2.5l3 3.5 3-3.5\"/></svg>"};
  PEEK_ICON.fark = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h18"/><path d="M3 15l4-6 4 5 3-8 3 10 4-4"/></svg>';
  const PEEK_TABS = [['genel', 'Genel'], ['akis', 'Canlı akış'], ['ist', 'İstatistik'], ['baski', 'Baskı'], ['h2h', 'Karşılaşmalar'], ['puan', 'Puan durumu'], ['kadro', 'Kadro']];
  const PEEK_LIVE = new Set(['LIVE', 'HALFTIME', 'EXTRA_TIME', 'BREAK', 'PENALTIES', 'IN_PLAY']);
  const skIdOf = (f) => { const id = String(f?.id || '').replace(/^k/, ''); return /^b?\d+$/.test(id) ? id : null; };

  function peekRedraw() {
    renderPeekModal();
    for (const el of queryAll('.kcs-legs, .kcs-arb-wrap')) el.__kcsHtml = null;
    scheduleRender();
  }

  function peekRequest(id) {
    if (!hasStore) return;
    const cur = peekData.get(id) || {};
    if (cur.loading) return;
    peekData.set(id, { ...cur, loading: true });
    chrome.runtime.sendMessage({ type: 'skDetail', id }).then((res) => {
      if (res?.ok) peekData.set(id, { d: res.d, at: Date.now() });
      else peekData.set(id, { ...cur, loading: false, error: res?.error || 'alınamadı', at: Date.now() });
      peekRedraw();
    }).catch(() => { peekData.set(id, { ...cur, loading: false, error: 'alınamadı', at: Date.now() }); });
  }

  // Pencere: açık maçın bilgisi sayfanın üstünde. Kapatma: ×, dışarıya tıklama ya da Esc.
  function renderPeekModal() {
    const [id] = peekOpen.keys();
    const host = queryOne('.kcs-legs, .kcs-arb-wrap, .kcs-status, .kcs-info');
    const root = host?.getRootNode();
    let modal = queryOne('.kcs-modal');
    if (!id || !root) { modal?.remove(); return; }
    if (!modal || modal.getRootNode() !== root) {
      modal?.remove();
      modal = document.createElement('div');
      modal.className = 'kcs-modal';
      styleRoot(root);
      (root === document ? document.body : root).append(modal);
    }
    const fx = peekData.get(id)?.d?.detail?.fixture;
    const title = fx ? `${fx.home?.name || ''} - ${fx.away?.name || ''}` : 'Maç ayrıntısı';
    const html = `<div class="kcs-modal-box" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="kcs-modal-top"><b>${markHtml()}${esc(title)}</b>`
      + `<button type="button" class="kcs-modal-close" aria-label="Kapat">×</button></div>${peekHtml(id)}</div>`;
    if (modal.__kcsHtml !== html) {
      const keep = modal.querySelector('.kcs-modal-box > .kcs-peek')?.scrollTop || 0;
      const feed = modal.querySelector('.kcs-feed')?.scrollTop || 0;
      const prevTab = modal.querySelector('.kcs-peek-pane')?.dataset.tab;
      const prevInd = modal.querySelector('.kcs-peek-ind');
      const indFrom = prevInd ? { l: prevInd.offsetLeft, w: prevInd.offsetWidth } : null;
      const stripX = modal.querySelector('.kcs-peek-tabs')?.scrollLeft || 0;
      const tl = modal.querySelector('.kcs-tl-scroll');
      const tlTop = tl ? tl.scrollTop : 0;
      const tlEnd = tl ? tl.scrollHeight - tl.scrollTop - tl.clientHeight < 48 : true;
      const tlCount = tl ? tl.querySelectorAll('.kcs-tl-row').length : 0;
      modal.innerHTML = html;
      modal.__kcsHtml = html;
      // Yenilenince kaydırma yeri korunsun.
      const box = modal.querySelector('.kcs-modal-box > .kcs-peek');
      // aynı sekmede yenilenince kaydırma yeri korunur; sekme değişince baştan
      if (box && modal.querySelector('.kcs-peek-pane')?.dataset.tab === prevTab) box.scrollTop = keep;
      const f = modal.querySelector('.kcs-feed');
      if (f) f.scrollTop = feed;
      pzApply(true);
      peekTabFx(modal, prevTab, indFrom, stripX);
      // Canlı akış: ilk açılışta en sona gider; yeni olay gelince (kullanıcı yukarıda okumuyorsa) yumuşakça kayar.
      const t2 = modal.querySelector('.kcs-tl-scroll');
      if (t2) {
        t2.scrollTop = tl ? tlTop : t2.scrollHeight;
        const rowsNow = t2.querySelectorAll('.kcs-tl-row');
        if (tl && rowsNow.length > tlCount) {
          for (let i = tlCount; i < rowsNow.length; i++) rowsNow[i].classList.add('is-new');
          if (tlEnd) requestAnimationFrame(() => t2.scrollTo({ top: t2.scrollHeight, behavior: 'smooth' }));
        }
      }
    }
  }
  // Sekme geçişi: içerik yeni sekmenin yönünden kayarak gelir, alttaki gösterge eski sekmeden yenisine kayar.
  function peekTabFx(modal, prevTab, indFrom, stripX) {
    const strip = modal.querySelector('.kcs-peek-tabs');
    const on = strip?.querySelector('.kcs-peek-tab.is-on');
    const ind = strip?.querySelector('.kcs-peek-ind');
    const pane = modal.querySelector('.kcs-peek-pane');
    if (!strip || !on || !ind) return;
    strip.scrollLeft = stripX;
    const to = { l: on.offsetLeft, w: on.offsetWidth };
    const put = (p) => { ind.style.transform = `translateX(${p.l}px)`; ind.style.width = `${p.w}px`; };
    const changed = prevTab && pane && prevTab !== pane.dataset.tab;
    if (changed && indFrom) {
      ind.style.transition = 'none';
      put(indFrom);
      void ind.offsetWidth;
      ind.style.transition = '';
    }
    put(to);
    if (changed) {
      const order = [...strip.querySelectorAll('.kcs-peek-tab')].map((b) => b.dataset.tab);
      pane.classList.add(order.indexOf(pane.dataset.tab) > order.indexOf(prevTab) ? 'is-from-r' : 'is-from-l');
      // seçili sekme şeritte görünür olsun (sayfa dikey kaymadan)
      const r = to.l + to.w - strip.clientWidth + 24;
      if (to.l - 24 < strip.scrollLeft) strip.scrollTo({ left: Math.max(0, to.l - 24), behavior: 'smooth' });
      else if (r > strip.scrollLeft) strip.scrollTo({ left: r, behavior: 'smooth' });
    }
  }
  function closePeek() {
    peekOpen.clear();
    renderPeekModal();
    for (const el of queryAll('.kcs-legs, .kcs-arb-wrap')) el.__kcsHtml = null;
    scheduleRender();
  }

  const peekBtns = (id) => {
    if (!id) return '';
    const tab = peekOpen.get(id);
    return `<span class="kcs-peek-btns"><button type="button" class="kcs-peek-btn${tab ? ' is-on' : ''}" data-sk="${esc(id)}" data-tab="genel">Göz at</button></span>`;
  };

  const STAT_LABELS = [
    ['SHOTS_ON_TARGET', 'İsabetli şut'], ['SHOTS_TOTAL', 'Toplam şut'], ['BIG_CHANCES_CREATED', 'Büyük fırsat'], ['DANGEROUS_ATTACKS', 'Tehlikeli atak'],
    ['ATTACKS', 'Atak'], ['BALL_POSSESSION', 'Topa sahip olma'], ['CORNERS', 'Korner'], ['SAVES', 'Kurtarış'], ['SHOTS_INSIDEBOX', 'Ceza sahası içi şut'],
    ['OFFSIDES', 'Ofsayt'], ['FOULS', 'Faul'], ['YELLOW_CARDS', 'Sarı kart'], ['RED_CARDS', 'Kırmızı kart'], ['SUCCESSFUL_PASSES_PERCENTAGE', 'Pas isabeti'],
  ];
  const EVENT_NAMES = {
    GOAL: ['GOL', 'goal'], OWN_GOAL: ['KENDİ KALESİNE', 'goal'], PENALTY: ['PENALTI GOLÜ', 'goal'], MISSED_PENALTY: ['PENALTI KAÇTI', 'pen'],
    YELLOW_CARD: ['SARI KART', 'yellow'], SECOND_YELLOW: ['2. SARI → KIRMIZI', 'red'], RED_CARD: ['KIRMIZI KART', 'red'], SUBSTITUTION: ['DEĞİŞİKLİK', 'sub'], VAR: ['VAR', 'var'],
  };
  const VAR_TEXT = { GOAL_DISALLOWED: 'Gol iptal', GOAL_AWARDED: 'Gol verildi', PENALTY_CANCELLED: 'Penaltı iptal', PENALTY_CONFIRMED: 'Penaltı verildi', CARD_ADJUSTED: 'Kart değişti' };

  function peekHtml(id) {
    if (!id || !peekOpen.has(id)) return '';
    const p = peekData.get(id);
    const isBk = p?.d?.sport === 'basketball' || /^b/.test(id);
    const tabList = isBk ? PEEK_TABS_BK : PEEK_TABS;
    const tab = tabList.some(([k]) => k === peekOpen.get(id)) ? peekOpen.get(id) : 'genel';
    const fx = p?.d?.detail?.fixture;
    const live = fx && PEEK_LIVE.has(fx.status);
    if (!p || (!p.loading && Date.now() - (p.at || 0) > (live ? 15 * 1000 : 10 * 60 * 1000))) peekRequest(id);
    const tabs = `<div class="kcs-peek-tabs">${tabList.map(([k, label]) => `<button type="button" class="kcs-peek-tab${k === tab ? ' is-on' : ''}" data-sk="${esc(id)}" data-tab="${k}">${PEEK_ICON[k] || ''}<span>${label}</span></button>`).join('')}<i class="kcs-peek-ind"></i></div>`;
    if (!p?.d) return `<div class="kcs-peek">${tabs}<div class="kcs-peek-empty kcs-peek-pane" data-tab="${tab}">${p?.error ? 'Bilgi alınamadı, biraz sonra tekrar dene.' : 'Yükleniyor…'}</div></div>`;
    const d = p.d;
    if (d.sport === 'basketball') {
      return `<div class="kcs-peek">${tabs}<div class="kcs-peek-pane" data-tab="${tab}">${bkHead(d.detail.fixture)}${bkBody(d, tab)}</div>`
        + `<div class="kcs-peek-foot">${live ? 'Canlı · 10 sn\'de bir yenilenir' : 'Maç ayrıntısı'}${p.at ? ` · ${esc(new Date(p.at).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}` : ''}</div></div>`;
    }
    const homeId = fx?.home?.id;
    const awayId = fx?.away?.id;
    const homeName = fx?.home?.name || 'Ev';
    const awayName = fx?.away?.name || 'Deplasman';
    const logo = (t) => (logoSrc(t?.logoUrl) ? `<img src="${esc(logoSrc(t.logoUrl))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '');
    const head = `<div class="kcs-peek-head"><b>${esc(homeName)}${logo(fx?.home)}</b><span>${fx?.score ? `${fx.score.home ?? '-'} - ${fx.score.away ?? '-'}` : 'v'}</span><b>${logo(fx?.away)}${esc(awayName)}</b>`
      + `<em>${esc(live ? `${fx.minute ?? ''}${fx.addedMinute ? `+${fx.addedMinute}` : ''}' canlı` : (fx?.stateLabel || ''))}</em></div>`;
    let body = '';
    if (tab === 'akis') body = peekFeed(d, homeId, awayId);
    else if (tab === 'ist') body = peekStats(d, homeId, awayId, STAT_LABELS);
    else if (tab === 'baski') body = peekPressure(d, homeId, awayId, homeName, awayName);
    else if (tab === 'h2h') body = peekH2h(d, homeId);
    else if (tab === 'puan') body = peekTable(d, homeId, awayId);
    else if (tab === 'kadro') body = peekLineups(d, homeId, awayId, homeName, awayName);
    else body = peekOverview(d, homeId, awayId, homeName, awayName);
    return `<div class="kcs-peek">${tabs}<div class="kcs-peek-pane" data-tab="${tab}">${head}${body}</div><div class="kcs-peek-foot">${live ? 'Canlı · 30 sn\'de bir yenilenir' : 'Maç ayrıntısı'}${p.at ? ` · ${esc(new Date(p.at).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}` : ''}</div></div>`;
  }

  const statOf = (d, code, teamId) => d.detail?.statistics?.find((s) => s.code === code && s.teamId === teamId && !s.period)?.value
    ?? d.detail?.statistics?.find((s) => s.code === code && s.teamId === teamId)?.value;

  function peekStats(d, homeId, awayId, labels) {
    const rows = labels.map(([code, label]) => {
      const a = statOf(d, code, homeId);
      const b = statOf(d, code, awayId);
      if (a == null && b == null) return '';
      const na = parseFloat(a) || 0;
      const nb = parseFloat(b) || 0;
      const pct = na + nb ? Math.round((na / (na + nb)) * 100) : 50;
      const unit = /POSSESSION|PERCENTAGE/.test(code) ? '%' : '';
      return `<div class="kcs-stat"><b>${esc(String(a ?? 0))}${unit}</b><span>${label}</span><b>${esc(String(b ?? 0))}${unit}</b>`
        + `<div class="kcs-stat-bar"><i style="width:${pct}%"></i><u style="width:${100 - pct}%"></u></div></div>`;
    }).join('');
    return rows || '<div class="kcs-peek-empty">İstatistik henüz yok.</div>';
  }

  // Baskı: tehlikeli atakların 5 dakikalık dilimlerdeki artışı; üstte ev sahibi, altta deplasman.
  // Baskı: saha üzerinde 5 dakikalık dilimlerle oynayan animasyon. Ev sahibi sağa, deplasman sola hücum eder.
  // Baskı puanı = atak + 2.5 × tehlikeli atak + 4 × şut + 6 × isabetli şut + 3 × korner (o dilimde yapılanlar).
  const PZ_W = { ATTACKS: 1, DANGEROUS_ATTACKS: 2.5, SHOTS_TOTAL: 4, SHOTS_ON_TARGET: 6, CORNERS: 3 };
  const pzState = new Map();
  function peekPressure(d, homeId, awayId, homeName, awayName) {
    const fx = d.detail?.fixture;
    const tr = (d.detail?.trends || []).filter((t) => PZ_W[t.code]);
    if (!tr.length) return '<div class="kcs-peek-empty">Baskı verisi henüz yok.</div>';
    const lastMin = Math.max(...tr.map((t) => t.minute || 0));
    const live = fx && PEEK_LIVE.has(fx.status);
    const endMin = Math.max(lastMin, live ? fx.minute || 0 : 90);
    const n = Math.min(26, Math.max(1, Math.ceil(endMin / 5)));
    const score = (teamId) => {
      const out = new Array(n).fill(0);
      for (const code of Object.keys(PZ_W)) {
        const pts = tr.filter((t) => t.code === code && t.teamId === teamId).map((t) => [t.minute || 0, parseFloat(t.value) || 0]).sort((x, y) => x[0] - y[0]);
        let prev = 0;
        for (const [m, v] of pts) { out[Math.min(n - 1, Math.floor(m / 5))] += Math.max(0, v - prev) * PZ_W[code]; prev = Math.max(prev, v); }
      }
      return out;
    };
    const h = score(homeId);
    const aw = score(awayId);
    const max = Math.max(1, ...h, ...aw);
    const evs = (d.detail?.events || []).filter((e) => /GOAL|PENALTY|RED_CARD|SECOND_YELLOW/.test(e.kind) && e.kind !== 'MISSED_PENALTY');
    const frames = h.map((hv, i) => {
      const av = aw[i];
      const m0 = i * 5;
      const m1 = i === n - 1 && endMin > m0 + 5 ? endMin : m0 + 5;
      const ev = evs.filter((e) => (e.minute ?? 0) > m0 && (e.minute ?? 0) <= m1 || (i === 0 && (e.minute ?? 0) === 0))
        .map((e) => `<span class="is-${e.teamId === awayId ? 'away' : 'home'}">${EV_ICON[EV_KIND_ICON[e.kind] || 'goal']}${e.minute ?? ''}' ${esc(e.player || '')}${e.score && /GOAL|PENALTY/.test(e.kind) ? ` · ${e.score.home}-${e.score.away}` : ''}</span>`).join('');
      return { m0, m1, h: Math.round(hv), a: Math.round(av), p: hv + av ? +((hv - av) / (hv + av)).toFixed(3) : 0, hn: +(hv / max).toFixed(3), an: +(av / max).toFixed(3), ev };
    });
    // Alt şerit: baskı dalgası (üst yarı ev sahibi, alt yarı deplasman)
    const W = n * 10;
    const pts = frames.map((f, i) => `${i * 10 + 5},${(20 - f.p * 17).toFixed(1)}`).join(' L');
    const goals = evs.filter((e) => /GOAL|PENALTY/.test(e.kind)).map((e) => `<circle cx="${Math.min(W, ((e.minute ?? 0) / (n * 5)) * W).toFixed(1)}" cy="${e.teamId === awayId ? 36 : 4}" r="2.4" class="is-${e.teamId === awayId ? 'away' : 'home'}"/>`).join('');
    const wave = `<svg class="kcs-pz-wave" viewBox="0 0 ${W} 40" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="kcsPzG" x1="0" y1="0" x2="0" y2="40" gradientUnits="userSpaceOnUse">`
      + `<stop offset="0" stop-color="#7aa5ff" stop-opacity=".75"/><stop offset=".5" stop-color="#7aa5ff" stop-opacity=".12"/><stop offset=".5" stop-color="#e46b8f" stop-opacity=".12"/><stop offset="1" stop-color="#e46b8f" stop-opacity=".75"/></linearGradient></defs>`
      + `<path d="M0,20 L${pts} L${W},20 Z" fill="url(#kcsPzG)"/><path d="M${pts}" fill="none" stroke="rgba(255,255,255,.55)" stroke-width=".8" vector-effect="non-scaling-stroke"/>`
      + `<line x1="0" y1="20" x2="${W}" y2="20" stroke="rgba(255,255,255,.18)" stroke-width="1" vector-effect="non-scaling-stroke"/>${goals}</svg>`;
    const data = esc(JSON.stringify({ frames, home: homeName, away: awayName }));
    const id = String(fx?.id ?? '');
    return `<div class="kcs-pz" data-sk="${esc(id)}" data-pz="${data}">`
      + `<div class="kcs-pitch-legend"><span class="is-home">${esc(homeName)} →</span><span class="is-away">← ${esc(awayName)}</span></div>`
      + `<div class="kcs-pitch kcs-pz-pitch"><b class="kcs-pz-fill kcs-pz-fill--h"></b><b class="kcs-pz-fill kcs-pz-fill--a"></b><b class="kcs-pz-glow kcs-pz-glow--h"></b><b class="kcs-pz-glow kcs-pz-glow--a"></b>`
      + `<i class="kcs-pitch-mid"></i><i class="kcs-pitch-circle"></i><i class="kcs-pitch-box kcs-pitch-box--l"></i><i class="kcs-pitch-box kcs-pitch-box--r"></i>`
      + `<span class="kcs-pz-front"><em></em></span>`
      + `<div class="kcs-pz-hud"><span class="kcs-pz-h"></span><strong class="kcs-pz-min"></strong><span class="kcs-pz-a"></span></div>`
      + `<div class="kcs-pz-who"></div><div class="kcs-pz-flash"></div></div>`
      + `<div class="kcs-pz-track">${wave}<span class="kcs-pz-head"></span></div>`
      + `<div class="kcs-pz-ctrl"><button type="button" class="kcs-pz-play">▶ Oynat</button><input type="range" class="kcs-pz-range" min="0" max="${n - 1}" step="1" value="0" aria-label="Dakika"></div>`
      + `<div class="kcs-press-axis"><span>0'</span><span>${Math.round(endMin / 2)}'</span><span>${endMin}'</span></div>`
      + `<div class="kcs-peek-note">Çizgi baskının dengesini gösterir: ev sahibi bastıkça sağa, deplasman bastıkça sola kayar. Parlama o dilimdeki baskının gücü. Atak, tehlikeli atak, şut ve kornerlerden hesaplanır.</div></div>`;
  }
  function pzApply(still) {
    const el = queryOne('.kcs-pz');
    if (!el) return;
    if (!el.__f) { try { el.__f = JSON.parse(el.dataset.pz); } catch { return; } }
    const F = el.__f;
    const n = F.frames.length;
    const id = el.dataset.sk;
    let st = pzState.get(id);
    if (!st) { st = { i: 0, playing: true, n }; pzState.set(id, st); }
    if (st.n !== n) { if (!st.playing && st.i >= st.n - 1) st.i = n - 1; st.n = n; }
    st.i = Math.max(0, Math.min(n - 1, st.i));
    const f = F.frames[st.i];
    if (still) el.classList.add('is-still');
    el.style.setProperty('--front', `${(50 + f.p * 38).toFixed(1)}%`);
    el.style.setProperty('--hi', f.hn);
    el.style.setProperty('--ai', f.an);
    el.style.setProperty('--x', `${(((st.i + 0.5) / n) * 100).toFixed(2)}%`);
    const set = (sel, txt) => { const x = el.querySelector(sel); if (x && x.textContent !== txt) x.textContent = txt; };
    set('.kcs-pz-min', `${f.m0}'–${f.m1}'`);
    set('.kcs-pz-h', `${F.home} ${f.h}`);
    set('.kcs-pz-a', `${f.a} ${F.away}`);
    set('.kcs-pz-who', f.h + f.a === 0 ? 'Bu dilimde atak yok' : f.p > 0.25 ? `${F.home} bastırıyor` : f.p < -0.25 ? `${F.away} bastırıyor` : 'Dengeli');
    const fl = el.querySelector('.kcs-pz-flash');
    if (fl && fl.__ev !== f.ev) { fl.__ev = f.ev; fl.innerHTML = f.ev; fl.classList.toggle('is-on', !!f.ev); }
    const r = el.querySelector('.kcs-pz-range');
    if (r && +r.value !== st.i) r.value = st.i;
    set('.kcs-pz-play', st.playing ? '❚❚ Durdur' : st.i >= n - 1 ? '↺ Baştan oynat' : '▶ Oynat');
    if (still) { void el.offsetWidth; el.classList.remove('is-still'); }
  }
  function pzTick() {
    const el = queryOne('.kcs-pz');
    if (!el) return;
    const st = pzState.get(el.dataset.sk);
    if (!st?.playing) return;
    if (st.i >= st.n - 1) st.playing = false; else st.i++;
    pzApply();
  }
  function onPzInput(ev) {
    const t = targetOf(ev);
    if (!t.matches?.('.kcs-pz-range')) return;
    const el = t.closest('.kcs-pz');
    const st = el && pzState.get(el.dataset.sk);
    if (!st) return;
    st.i = +t.value;
    st.playing = false;
    pzApply();
  }

  function peekTable(d, homeId, awayId) {
    let rows = d.standings || [];
    if (!rows.length) return '<div class="kcs-peek-empty">Puan durumu yok (kupa ya da lig dışı maç olabilir).</div>';
    const side = (r) => (r.team?.id === homeId ? 'home' : r.team?.id === awayId ? 'away' : '');
    // Gruplu liglerde yalnız bu maçın takımlarının grubu
    const g = rows.find((r) => side(r));
    if (g) rows = rows.filter((r) => (r.group ?? null) === (g.group ?? null) && (r.stage ?? null) === (g.stage ?? null));
    rows = [...rows].sort((x, y) => x.position - y.position);
    const n = rows.length;
    const logo = (t) => (t?.logoUrl ? `<img src="${esc(t.logoUrl)}" alt="" loading="lazy">` : '<i></i>');
    const zone = (p) => (p === 1 ? ' z-lead' : p <= 4 ? ' z-top' : n >= 10 && p > n - 3 ? ' z-low' : '');
    const per = (x, r) => (x / Math.max(1, r.played)).toFixed(1);
    const pair = ['home', 'away'].map((k) => rows.find((r) => side(r) === k)).filter(Boolean);
    let cmp = '';
    if (pair.length) {
      cmp = `<div class="kcs-st-cmp">${pair.map((r) => `<div class="kcs-st-team is-${side(r)}">${logo(r.team)}<div><b>${esc(r.team?.name || '')}</b>`
        + `<span><em>${r.position}.</em> sıra · <em>${r.points}</em> puan</span><small>Maç başı ${per(r.goalsFor, r)} atıyor · ${per(r.goalsAgainst, r)} yiyor</small></div></div>`).join('')}</div>`;
      if (pair.length === 2) {
        const dp = Math.abs(pair[0].points - pair[1].points);
        const lead = pair[0].points === pair[1].points ? '' : esc((pair[0].points > pair[1].points ? pair[0] : pair[1]).team?.name || '');
        cmp += `<div class="kcs-st-gap">${lead ? `${lead} <b>${dp} puan</b> önde` : 'Puanlar <b>eşit</b>'} · aralarında <b>${Math.abs(pair[0].position - pair[1].position)}</b> sıra var</div>`;
      }
    }
    const head = '<div class="kcs-st-row is-head"><span>#</span><span>Takım</span><span>O</span><span>G</span><span>B</span><span>M</span><span>Gol</span><span>Av</span><span>P</span></div>';
    const body = rows.map((r) => {
      const gd = r.goalDifference ?? 0;
      return `<div class="kcs-st-row${side(r) ? ` is-${side(r)}` : ''}${zone(r.position)}"><span class="kcs-st-pos">${r.position}</span>`
        + `<span class="kcs-st-name">${logo(r.team)}<span>${esc(r.team?.name || '')}</span></span><span>${r.played}</span><span>${r.won}</span><span>${r.drawn}</span><span>${r.lost}</span>`
        + `<span>${r.goalsFor}:${r.goalsAgainst}</span><span class="${gd > 0 ? 'is-pos' : gd < 0 ? 'is-neg' : ''}">${gd > 0 ? '+' : ''}${gd}</span><b>${r.points}</b></div>`;
    }).join('');
    const legend = `<div class="kcs-st-legend"><span class="z-lead">Lider</span><span class="z-top">İlk 4</span>${n >= 10 ? '<span class="z-low">Son 3</span>' : ''}<span class="is-home">Ev sahibi</span><span class="is-away">Deplasman</span></div>`;
    return `${cmp}<div class="kcs-st">${head}${body}</div>${legend}`;
  }

  // Olay simgeleri (küçük SVG): gol topu, sarı/kırmızı kart, değişiklik okları, VAR ekranı, penaltı.
  const EV_ICON = {
    goal: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#fff" stroke="#0b0f14" stroke-width="1.6"/><path d="M12 7.6l3.3 2.4-1.3 3.9h-4l-1.3-3.9z" fill="#0b0f14"/><path d="M12 3v4.6M15.3 10l4.4-1.3M14 13.9l2.6 3.8M10 13.9l-2.6 3.8M8.7 10L4.3 8.7" stroke="#0b0f14" stroke-width="1.2"/></svg>',
    own: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#ff6b7a" stroke="#0b0f14" stroke-width="1.6"/><path d="M12 7.6l3.3 2.4-1.3 3.9h-4l-1.3-3.9z" fill="#0b0f14"/></svg>',
    yellow: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="3.5" width="11" height="17" rx="2" fill="#f8c14d" stroke="#0b0f14" stroke-width="1.2"/></svg>',
    red: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="3.5" width="11" height="17" rx="2" fill="#ff4757" stroke="#0b0f14" stroke-width="1.2"/></svg>',
    second: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="10" height="15" rx="2" fill="#f8c14d" stroke="#0b0f14" stroke-width="1.2"/><rect x="10" y="6" width="10" height="15" rx="2" fill="#ff4757" stroke="#0b0f14" stroke-width="1.2"/></svg>',
    sub: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v15M3.5 15.5L7 19l3.5-3.5" stroke="#78e54b"/><path d="M17 20V5M13.5 8.5L17 5l3.5 3.5" stroke="#ff6b7a"/></svg>',
    var: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="#b18cff" stroke-width="1.8"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20.5h6M12 16.5v4"/><path d="M7.5 8.5l2 4 2-4M13 12.5l1.3-4 1.3 4M13.4 11.2h1.8" stroke-width="1.4"/></svg>',
    pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#7cc4ff" stroke="#0b0f14" stroke-width="1.6"/><path d="M9.5 16.5V7.5h3.2a2.4 2.4 0 010 4.8H9.5" fill="none" stroke="#0b0f14" stroke-width="1.8"/></svg>',
    miss: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="#7cc4ff" stroke="#0b0f14" stroke-width="1.6"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" stroke="#0b0f14" stroke-width="2"/></svg>',
  };
  const EV_KIND_ICON = { GOAL: 'goal', OWN_GOAL: 'own', PENALTY: 'pen', MISSED_PENALTY: 'miss', YELLOW_CARD: 'yellow', SECOND_YELLOW: 'second', RED_CARD: 'red', SUBSTITUTION: 'sub', VAR: 'var' };

  // Olay ayrıntısının Türkçesi (veri servisi İngilizce veriyor).
  const DETAIL_TR = {
    'Foul': 'Faul', 'Right foot shot': 'Sağ ayakla şut', 'Left foot shot': 'Sol ayakla şut', 'Header': 'Kafa vuruşu', 'Argument': 'İtiraz',
    'Penalty': 'Penaltı', 'Own Goal': 'Kendi kalesine', 'Unsportsmanlike conduct': 'Sportmenlik dışı hareket', 'Holding': 'Tutma',
    'Off the ball foul': 'Top dışı faul', 'Persistent fouling': 'Sürekli faul', 'Simulation': 'Rol yapma', 'Offside': 'Ofsayt',
    'Violent conduct': 'Şiddet içeren hareket', 'Free Kick': 'Serbest vuruş', 'Time wasting': 'Zaman geçirme', 'Handball': 'Elle oynama',
    'Dangerous play': 'Tehlikeli oyun', 'Professional foul': 'Taktik faul', 'Shirt pull': 'Forma çekme', 'Dissent': 'İtiraz',
  };
  const KIND_TEXT = {
    GOAL: 'Gol', OWN_GOAL: 'Kendi kalesine gol', PENALTY: 'Penaltı golü', MISSED_PENALTY: 'Penaltı kaçtı', YELLOW_CARD: 'Sarı kart',
    SECOND_YELLOW: 'İkinci sarıdan kırmızı', RED_CARD: 'Kırmızı kart', SUBSTITUTION: 'Oyuncu değişikliği', VAR: 'VAR',
  };

  // Canlı akış: maçın başından itibaren, ortada zaman çizgisi; ev sahibi solda, deplasman sağda.
  function peekFeed(d, homeId, awayId) {
    const fx = d.detail?.fixture;
    const code = (t) => t?.shortCode || (t?.name || '').slice(0, 3).toLocaleUpperCase('tr-TR');
    const evs = [...(d.detail?.events || [])].sort((a, b) => (a.minute ?? 0) - (b.minute ?? 0) || (a.addedMinute ?? 0) - (b.addedMinute ?? 0) || (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    if (!evs.length) return '<div class="kcs-peek-empty">Henüz olay yok.</div>';
    const rows = evs.map((e) => {
      const side = e.teamId === awayId ? 'away' : 'home';
      const team = side === 'away' ? fx?.away : fx?.home;
      const kind = e.kind === 'VAR' ? `VAR · ${VAR_TEXT[e.decision] || 'inceleme'}` : KIND_TEXT[e.kind] || e.kind;
      let sub = kind;
      if (/GOAL|PENALTY/.test(e.kind) && e.kind !== 'MISSED_PENALTY' && e.relatedPlayer) sub += ` · Asist: ${e.relatedPlayer}`;
      if (e.kind === 'SUBSTITUTION' && e.relatedPlayer) sub += ` · Çıkan: ${e.relatedPlayer}`;
      const detail = e.detail && !/^(Penalty|Own Goal)$/.test(e.detail) ? DETAIL_TR[e.detail] || e.detail : '';
      const score = e.score && /GOAL|PENALTY/.test(e.kind) && e.kind !== 'MISSED_PENALTY' ? `<i class="kcs-tl-score">${e.score.home}-${e.score.away}</i>` : '';
      const iconKey = e.kind === 'VAR' ? 'var' : EV_KIND_ICON[e.kind] || 'sub';
      const card = `<div class="kcs-tl-card"><em>${e.minute ?? ''}${e.addedMinute ? `+${e.addedMinute}` : ''}'</em><span class="kcs-tl-ic">${EV_ICON[iconKey]}</span>`
        + `<div class="kcs-tl-body"><b>${esc(e.player || '')}${score}</b><span>${esc(sub)}</span>${detail ? `<small>${esc(detail)}</small>` : ''}</div><u>${esc(code(team))}</u></div>`;
      return `<div class="kcs-tl-row kcs-tl-row--${side}">${side === 'home' ? `${card}<i class="kcs-tl-dot"></i><span></span>` : `<span></span><i class="kcs-tl-dot"></i>${card}`}</div>`;
    }).join('');
    return `<div class="kcs-tl-head">Maçın başından itibaren · dakikalar maç süresine göre</div><div class="kcs-tl-scroll"><div class="kcs-tl">${rows}</div></div>`;
  }

  // Aralarındaki maçlar: bu maçtan önce biten karşılaşmalar (bu maç sayılmaz).
  function peekH2h(d, homeId) {
    const fx = d.detail?.fixture;
    const curId = fx?.id;
    const list = (d.h2h?.fixtures || []).filter((f) => f.status === 'FINISHED' && f.id !== curId)
      .sort((a, b) => Date.parse(b.kickoffAt || 0) - Date.parse(a.kickoffAt || 0));
    if (!list.length) return '<div class="kcs-peek-empty">Bu maçtan önce aralarında biten maç yok.</div>';
    let hw = 0; let dr = 0; let aw = 0; let gh = 0; let ga = 0;
    for (const f of list) {
      const h = f.score?.home ?? 0;
      const a = f.score?.away ?? 0;
      const homeIsOurs = f.home?.id === homeId;
      const our = homeIsOurs ? h : a;
      const their = homeIsOurs ? a : h;
      gh += our; ga += their;
      if (our > their) hw++; else if (our < their) aw++; else dr++;
    }
    const homeName = fx?.home?.name || 'Ev sahibi';
    const awayName = fx?.away?.name || 'Deplasman';
    const rows = list.map((f) => {
      const date = f.kickoffAt ? new Date(f.kickoffAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const h = f.score?.home ?? '-';
      const a = f.score?.away ?? '-';
      const win = h > a ? 'home' : h < a ? 'away' : '';
      return `<div class="kcs-h2h-match"><small>${esc(date)}${f.competition?.name ? ` · ${esc(f.competition.name)}` : ''}</small>`
        + `<div><span class="${win === 'home' ? 'is-win' : ''}">${esc(f.home?.name || '')}</span><b>${h} : ${a}</b><span class="${win === 'away' ? 'is-win' : ''}">${esc(f.away?.name || '')}</span></div></div>`;
    }).join('');
    return `<div class="kcs-h2h-title">İkili rekabet</div><div class="kcs-h2h-sub">Bu maçtan önce biten karşılaşmalar</div>`
      + `<div class="kcs-h2h-big"><div class="is-home"><b>${hw}</b><span>${esc(homeName)}</span></div><div><b>${dr}</b><span>Beraberlik</span></div><div class="is-away"><b>${aw}</b><span>${esc(awayName)}</span></div></div>`
      + `<div class="kcs-h2h-sum">Toplam ${list.length} karşılaşma · Goller ${gh}–${ga} · maç başı ${((gh + ga) / list.length).toFixed(2)} gol</div>${rows}`;
  }

  // Kadro saha üzerinde: yatay saha, ev sahibi solda, deplasman sağda. Diziliş (4-1-4-1 gibi) sıralara bölünür;
  // oyuncular kaleci, defans, orta saha, forvet sırasıyla bu sıralara yerleşir.
  function pitchSide(lu, tid, formation, side) {
    const order = { Goalkeeper: 0, Defender: 1, Midfielder: 2, Attacker: 3 };
    const st = lu.filter((x) => x.teamId === tid && x.starter).sort((a, b) => (order[a.position] ?? 4) - (order[b.position] ?? 4));
    if (!st.length) return '';
    const gk = st.find((x) => x.position === 'Goalkeeper') || st[0];
    const field = st.filter((x) => x !== gk);
    let rows = String(formation || '').split('-').map(Number).filter((n) => n > 0);
    if (rows.reduce((s, n) => s + n, 0) !== field.length) {
      const by = [1, 2, 3].map((p) => field.filter((x) => (order[x.position] ?? 2) === p).length).filter(Boolean);
      rows = by.length ? by : [field.length];
    }
    const lines = [[gk]];
    let at = 0;
    for (const n of rows) { lines.push(field.slice(at, at + n)); at += n; }
    if (at < field.length) lines[lines.length - 1].push(...field.slice(at));
    const short = (name) => { const p = String(name || '').trim().split(/\s+/); return p.length > 1 ? p[p.length - 1] : p[0] || ''; };
    const cols = lines.length;
    return lines.map((line, li) => line.map((pl, pi) => {
      // x: kaleden orta sahaya (ev %4→%46, deplasman %96→%54); y: sıradaki oyuncular eşit aralıkla.
      const x = 4 + (li / Math.max(1, cols - 1)) * 42;
      const y = ((pi + 1) / (line.length + 1)) * 100;
      return `<div class="kcs-plr kcs-plr--${side}" style="left:${side === 'home' ? x : 100 - x}%;top:${y}%" title="${esc(`${pl.number ?? ''} ${pl.player} · ${pl.position || ''}`)}"><b>${pl.number ?? ''}</b><span>${esc(short(pl.player))}</span></div>`;
    }).join('')).join('');
  }

  function peekLineups(d, homeId, awayId, homeName, awayName) {
    const lu = d.detail?.lineups || [];
    if (!lu.length) return '<div class="kcs-peek-empty">Kadro henüz açıklanmadı.</div>';
    const form = (tid) => d.detail?.formations?.find((f) => f.teamId === tid)?.formation || '';
    const bench = (tid) => lu.filter((x) => x.teamId === tid && !x.starter).map((x) => `${x.number ?? ''} ${esc(x.player)}`).join(' · ');
    return `<div class="kcs-peek-note">${d.detail?.lineupConfirmed ? 'İlk 11 açıklandı' : 'Tahmini kadro (henüz kesinleşmedi)'}</div>`
      + `<div class="kcs-pitch-legend"><span class="is-home">${esc(homeName)} ${form(homeId) ? `· ${esc(form(homeId))}` : ''}</span><span class="is-away">${form(awayId) ? `${esc(form(awayId))} · ` : ''}${esc(awayName)}</span></div>`
      + `<div class="kcs-pitch"><i class="kcs-pitch-mid"></i><i class="kcs-pitch-circle"></i><i class="kcs-pitch-box kcs-pitch-box--l"></i><i class="kcs-pitch-box kcs-pitch-box--r"></i>`
      + `${pitchSide(lu, homeId, form(homeId), 'home')}${pitchSide(lu, awayId, form(awayId), 'away')}</div>`
      + `<div class="kcs-bench"><div><b>${esc(homeName)} yedekler</b><span>${bench(homeId) || '-'}</span></div><div><b>${esc(awayName)} yedekler</b><span>${bench(awayId) || '-'}</span></div></div>`;
  }

  function peekOverview(d, homeId, awayId, homeName, awayName) {
    const c = d.ctx || {};
    const ref = c.referees?.find((r) => r.role === 'REFEREE')?.person?.name;
    const coach = (tid) => c.coaches?.find((x) => x.teamId === tid)?.person?.name;
    const tv = [...new Set((c.broadcasts || []).filter((b) => b.turkey).map((b) => b.name))].slice(0, 3).join(', ');
    const w = c.weather;
    const v = c.venue;
    const st = (tid) => d.standings?.find((r) => r.team?.id === tid);
    const h = d.h2h;
    const rows = [
      ['sira', 'Sıralama', [st(homeId), st(awayId)].every(Boolean) ? `${esc(homeName)} ${st(homeId).position}. · ${esc(awayName)} ${st(awayId).position}.` : ''],
      ['h2h', 'Aralarındaki maçlar', h?.played ? `${h.played} maç · maç başı ${(((h.homeGoals || 0) + (h.awayGoals || 0)) / h.played).toFixed(2)} gol` : ''],
      ['ref', 'Hakem', ref ? esc(ref) : ''],
      ['coach', 'Teknik direktörler', coach(homeId) || coach(awayId) ? `${esc(coach(homeId) || '?')} · ${esc(coach(awayId) || '?')}` : ''],
      ['stad', 'Stat', v?.name ? `${esc(v.name)}${v.city ? `, ${esc(v.city)}` : ''}${v.capacity ? ` · ${Number(v.capacity).toLocaleString('tr-TR')} kişilik` : ''}` : ''],
      ['hava', 'Hava', w ? `${esc(w.description || '')}${w.temperatureC != null ? ` · ${Math.round(w.temperatureC)}°C` : ''}${w.humidity ? ` · nem ${esc(w.humidity)}` : ''}` : ''],
      ['tv', 'TV (Türkiye)', tv ? esc(tv) : ''],
      ['kadro', 'Kadro', d.detail?.lineups?.length ? (d.detail.lineupConfirmed ? 'İlk 11 açıklandı' : 'Tahmini kadro') : 'Henüz açıklanmadı'],
    ].filter(([, , val]) => val);
    const key = peekStats(d, homeId, awayId, STAT_LABELS.slice(0, 6).filter(([code]) => code !== 'ATTACKS'));
    return `<div class="kcs-peek-info kcs-peek-info--ic">${rows.map(([icon, k, val]) => `<div><i class="kcs-info-ic">${PEEK_ICON[icon] || ''}</i><span>${k}</span><b>${val}</b></div>`).join('')}</div>${/kcs-stat/.test(key) ? key : ''}`;
  }

  // ---------- önemli maç olayları ----------
  const EV_INFO = (e) => {
    if (e.kind === 'RED_CARD') return { cls: 'red', text: 'Kırmızı kart', icon: 'red' };
    if (e.kind === 'SECOND_YELLOW') return { cls: 'red', text: 'İkinci sarıdan kırmızı', icon: 'red' };
    if (e.kind === 'MISSED_PENALTY') return { cls: 'pen', text: 'Penaltı kaçtı' };
    if (e.kind === 'PENALTY') return { cls: 'pen', text: 'Penaltı golü' };
    if (e.kind === 'OWN_GOAL') return { cls: 'pen', text: 'Kendi kalesine gol' };
    if (e.kind === 'VAR') {
      return {
        GOAL_DISALLOWED: { cls: 'var', text: 'Gol iptal (VAR)' }, GOAL_AWARDED: { cls: 'var', text: 'Gol verildi (VAR)' },
        PENALTY_CANCELLED: { cls: 'var', text: 'Penaltı iptal (VAR)' }, PENALTY_CONFIRMED: { cls: 'var', text: 'Penaltı verildi (VAR)' },
        CARD_ADJUSTED: { cls: 'var', text: 'Kart değişti (VAR)' },
      }[e.decision] || { cls: 'var', text: 'VAR incelemesi' };
    }
    return null;
  };
  const evSeen = new Map(); // olay no → ilk görüldüğü an (sayfa açılınca gelenler eski sayılır)
  let evPrimed = false;
  const evFeedSeen = new Set(); // olayları en az bir kez görülmüş maçlar

  // Maçın önemli olayları: kırmızı kart sayısı (takım başına), son olaylar ve yeni (45 sn) olay.
  function matchEvents(f) {
    const id = String(f?.id || '').replace(/^k/, '');
    if (f?.isLive && /^\d+$/.test(id)) trackedSk.add(id);
    const feed = skFeed[id];
    if (!feed) return null;
    const list = feed.events.map((e) => ({ e, info: EV_INFO(e) })).filter((x) => x.info);
    const now = Date.now();
    const firstSight = !evFeedSeen.has(id);
    evFeedSeen.add(id);
    for (const { e } of list) if (!evSeen.has(e.id)) evSeen.set(e.id, evPrimed && !firstSight && f.isLive ? now : 0);
    const reds = { home: 0, away: 0 };
    for (const { e, info } of list) if (info.icon === 'red') reds[e.teamId === f.homeTid ? 'home' : e.teamId === f.awayTid ? 'away' : 'home']++;
    const side = (e) => (e.teamId === f.homeTid ? f.home : e.teamId === f.awayTid ? f.away : '');
    const fresh = f.isLive ? list.filter(({ e }) => now - evSeen.get(e.id) < FLASH_MS).pop() || null : null;
    const last = list.slice(-2).map(({ e, info }) => ({ ...info, text: `${e.minute ?? ''}${e.added ? `+${e.added}` : ''}' ${info.text}${e.player ? ` · ${e.player}` : ''}${side(e) ? ` (${side(e)})` : ''}` }));
    const freshLine = fresh ? last.find((x) => x.text.includes(fresh.info.text)) || { ...fresh.info } : null;
    return { reds, last, fresh: fresh ? { ...fresh.info } : null, freshLine };
  }
  const redIcons = (n) => (n > 0 ? `<span class="kcs-reds" title="${n} kırmızı kart">${'<i></i>'.repeat(Math.min(n, 3))}</span>` : '');
  // Olaylar kalıcı değil: sadece yeni olay (45 sn) yazılır, sonra kaybolur (gol efekti gibi).
  const evLines = (ev) => (ev?.freshLine ? `<div class="kcs-evs"><span class="kcs-ev kcs-ev--${ev.freshLine.cls}">${esc(ev.freshLine.text)}</span></div>` : '');
  const evLinesOld = (ev) => (ev?.last.length ? `<div class="kcs-evs">${ev.last.map((x) => `<span class="kcs-ev kcs-ev--${x.cls}">${esc(x.text)}</span>`).join('')}</div>` : '');

  function sbLegHtml({ label, f, how, waiting, searching }) {
    const key = rowKey(label);
    // Elle bağlama yok: bulunamayan maçı gece görevi raporlar, eşleştirme not dosyasına yazılır (skId).
    const fixBtn = '';
    const edit = '';
    if (!f) {
      const note = waiting ? 'Veri servisinden bekleniyor…' : 'Maç bulunamadı';
      return `<div class="sb-mb-leg kcs-sb-leg"><div class="sb-mb-leg-top"><span class="sb-mb-leg-pick"><span class="sb-mb-leg-pick-name">${esc(label)}</span></span>${fixBtn}</div>`
        + `<div class="sb-mb-leg-sub"><span class="sb-mb-leg-market">${note}</span></div></div>${edit}`;
    }
    const open = f.url ? `a href="${esc(f.url)}" target="_blank" rel="noopener"` : 'div';
    const close = f.url ? 'a' : 'div';
    const date = f.start ? `${esc(dayText(f.start))} - ${esc(timeText(f.start))}` : '';
    const flash = f.hasScore && f.sport !== 'basketball' ? scoreFlash(f.id, f.hs, f.as, f.isLive) : null;
    const ev = matchEvents(f);
    // Yeni önemli olay varsa onun etiketi, yoksa skor değişimi (GOL / GOL İPTAL).
    const goalTag = ev?.fresh ? `<span class="kcs-goal-tag kcs-goal-tag--${ev.fresh.cls}">${esc(ev.fresh.text.toLocaleUpperCase('tr-TR'))}</span>`
      : flash ? (flash.cancel ? '<span class="kcs-goal-tag kcs-goal-tag--var">GOL İPTAL</span>' : '<span class="kcs-goal-tag">GOL</span>') : '';
    const flashCls = ev?.fresh ? ` kcs-flash kcs-flash--${ev.fresh.cls}` : flash ? (flash.cancel ? ' kcs-flash kcs-flash--var' : ' kcs-flash') : '';
    const state = f.isLive
      ? `<span class="sb-mb-live"><span class="sb-mb-live-dot"></span><span>${esc(f.clock || 'Canlı')}</span></span>${goalTag}`
      : (f.ended ? `<span class="kcs-done-badge">${esc(f.clock || 'MS')}</span>${goalTag}` : esc(f.clock || '') + goalTag + (f.start ? countdownHtml(f.start.getTime() / 1000) : ''));
    const team = (name, url, reds = 0) => `<div class="sb-mb-team"><span class="sb-mb-team-logo">${logoSrc(url) ? `<img class="sb-team-logo sb-team-logo-img" src="${esc(logoSrc(url))}" alt="" width="22" height="22" loading="lazy" referrerpolicy="no-referrer">` : ''}</span><span class="sb-mb-team-name">${esc(name)}</span>${redIcons(reds)}</div>`;
    const g = (n) => (f.hasScore ? n : '–');
    return `<div class="kcs-sb-row"><${open} class="sb-mb-leg kcs-sb-leg${f.isLive ? ' is-live' : ''}${flashCls}${f.ended ? ' is-done' : ''}">`
      + `<div class="sb-mb-leg-top"><span class="sb-mb-leg-pick"><span class="sb-mb-leg-date">${date}</span></span></div>`
      + (state ? `<div class="sb-mb-leg-sub"><span class="sb-mb-leg-market">${state}</span></div>` : '')
      + `<div class="sb-mb-leg-teams"><div class="sb-mb-leg-names">${team(f.home, f.homeLogo)}${team(f.away, f.awayLogo)}</div>`
      + `<div class="sb-mb-score${f.isLive ? ' is-live' : ''}"><span class="sb-score-digit${flash?.home ? ' is-new' : ''}">${g(f.hs)}</span><span class="sb-score-digit${flash?.away ? ' is-new' : ''}">${g(f.as)}</span></div></div>${evLines(ev)}${f.sport === 'basketball' && f.hasScore ? `<div class="kcs-evs"><span class="kcs-ev kcs-ev--bk">Toplam ${f.hs + f.as} sayı</span></div>` : ''}`
      + `</${close}><div class="kcs-sb-foot"><span>${esc(label)}</span>${peekBtns(skIdOf(f))}</div></div>${edit}`;
  }

  // ---------- gol durumu: Alt/Üst tuttu mu ----------
  // Bahislerim'deki çok maçlı kartta çizgi yazmaz; "ÜÇ MAÇ TOPLAM GOL 8.5 ALT" Özel Oranlar kartında ya da sitenin
  // kendi yanıtında geçer. Buradan öğrenilir, kupon yazısıyla saklanır (bitmiş kartlar sitede kalmadığı için).
  const GOAL_LINE = /(\d{1,2}[.,]5)\s*(?:GOL\s*)?(ALT|ÜST|UST)(?![A-ZÇĞİÖŞÜa-zçğıöşü])/i;
  const OTHER_MARKET = /KORNER|CORNER|KART/i;
  const LINE_DAYS = 40;

  // Maçlar kimi kuponda " I " ile, kiminde boşlukla ayrılıyor: ayraç anahtara girmez.
  const lineKey = (title) => norm(title).split(' ').filter((w) => w !== 'i').join(' ');

  let lineQueue = Promise.resolve();
  const sameLine = (cur, line, side) => cur && cur.line === Number(String(line).replace(',', '.')) && cur.side === (/alt/i.test(side) ? 'alt' : 'ust');

  // Depodaki son hali okunur, üstüne eklenir: başka sekme ya da geç yüklenen veri kaydı silmesin.
  function saveLines(items) {
    if (!items.some((x) => x.manual || !sameLine(goalLines[lineKey(x.title)], x.line, x.side))) return lineQueue;
    lineQueue = lineQueue.then(async () => {
      if (hasStore) {
        const { goalLines: fresh = {} } = await chrome.storage.local.get('goalLines');
        goalLines = { ...goalLines, ...fresh };
      }
      writeLines(items);
    }).catch(() => {});
    return lineQueue;
  }

  function writeLines(items) {
    const next = {};
    const cut = Date.now() - LINE_DAYS * 864e5;
    for (const [k, v] of Object.entries(goalLines)) if (v.at > cut && !k.startsWith('kcstest')) next[k] = v;
    let changed = false;
    for (const { title, line, side, manual } of items) {
      const key = lineKey(title);
      const value = { line: Number(String(line).replace(',', '.')), side: /alt/i.test(side) ? 'alt' : 'ust', at: Date.now(), ...(manual ? { manual: true } : {}) };
      if (!key || !value.line) continue;
      if (next[key]?.line === value.line && next[key]?.side === value.side) continue;
      // Siteden öğrenilen çizgi elle girileni ezmez.
      if (next[key]?.manual && !manual) continue;
      next[key] = value;
      changed = true;
    }
    if (!changed) return;
    goalLines = next;
    if (hasStore) chrome.storage.local.set({ goalLines: next });
  }

  const SEEN_LINES = [
    ['ANDERLECHT-SALZBURG I TRABZONSPOR-FREIBURG I ST.TRUIDENSE-BRANN', '7.5', 'ALT'],
    ['BENFICA-L.POZNAN I B.LEVERKUSEN-MARSILYA I CELTIC-BESIKTAS', '8.5', 'ALT'],
    ['CASTELLON-EIBAR I HAMBURG-M.GLADBACH I TOULOUSE-STRASBOURG', '11.5', 'ÜST'],
    ['EVERTON-COVENTRY I GRENOBLE-REIMS I MONTPEILLER-METZ', '10.5', 'ÜST'],
    ['KUOPION-GENT I AARHUS-BRAGA I THUN-HEARTS', '11.5', 'ÜST'],
    ['LILLESTROM-V.PLZEN I STURM GRAZ-CELJE I SUNDERLAND-D.ZAGREB', '11.5', 'ÜST'],
    ['MJALLBY-B.LUKA I S.PRAG-BOURNEMOUTH I R.SOCIEDAD-LYON', '7.5', 'ALT'],
    ['MONACO-NORDSJAELLAND I KOPENHAG-IBERIA I C.VIGO-UNION SG', '7.5', 'ALT'],
    ['NEC NIJMEGEN-OMONIA I MILAN-FERENCVAROS I C.PALACE-HOFFENHEIM', '7.5', 'ALT'],
    ['TWENTE-PAFOS MIDTJYLLAND-AJAX KIZILYILDIZ-I.ESCALDES', '7.5', 'ALT'],
  ];

  function seedLines() {
    if (seededLines || !hasStore) return;
    seededLines = true;
    saveLines(SEEN_LINES.filter(([t]) => !goalLines[lineKey(t)]).map(([title, line, side]) => ({ title, line, side })));
    chrome.storage.local.set({ linesSeeded: true });
  }

  function removeLine(title) {
    const next = { ...goalLines };
    delete next[lineKey(title)];
    delete next[norm(title)];
    goalLines = next;
    if (hasStore) chrome.storage.local.set({ goalLines: next });
  }

  // Özel Oranlar'daki çok maçlı kartlar.
  function learnLines() {
    const items = [];
    for (const card of queryAll('article.sb-custom-bet-card')) {
      const block = card.querySelector('.sb-cbt-textblock');
      if (!block) continue;
      const title = card.querySelector('.sb-cbt-team')?.textContent;
      const text = block.textContent || '';
      const m = OTHER_MARKET.test(text) ? null : GOAL_LINE.exec(text);
      if (title && m) items.push({ title, line: m[1], side: m[2] });
    }
    if (items.length) saveLines(items);
  }

  // total: şu ana kadarki gol, final: bütün maçlar bitti mi.
  function goalVerdict(total, line, side, final) {
    const over = total > line;
    if (side === 'alt') return over ? 'lost' : (final ? 'won' : 'open');
    return over ? 'won' : (final ? 'lost' : 'open');
  }

  // Çizgisi kaçmış kupon: kullanıcı kendisi girer, sonrası aynı hesap.
  const goalAskHtml = (title) => `<div class="kcs-goal kcs-goal--none" data-title="${esc(title)}"><span>Çizgi kayıtlı değil, elle gir:</span>`
    + '<input class="kcs-input kcs-line-input" inputmode="decimal" placeholder="8.5" aria-label="Gol çizgisi">'
    + '<button type="button" class="kcs-line-save" data-side="alt">Alt</button><button type="button" class="kcs-line-save" data-side="ust">Üst</button></div>';

  // Kupon sitede sonuçlandıysa (Kazanıldı / Kaybedildi) sonuç sitenin dediğidir: bazı maçlar bulunamasa,
  // skor eksik ya da eski olsa bile. Açık kuponda null.
  function siteResult(card) {
    const el = card?.querySelector?.('.sb-mb-status');
    if (!el) return null;
    const cls = el.className || '';
    const text = norm(el.textContent || '');
    if (/tone-(won|win)/.test(cls) || /kazan/.test(text)) return 'won';
    if (/tone-(lost|lose)/.test(cls) || /kaybed/.test(text)) return 'lost';
    if (/tone-(void|refund|cancel)/.test(cls) || /iade|iptal/.test(text)) return 'void';
    return null;
  }

  function siteResultHtml(res, title = '') {
    const v = res === 'won' ? 'won' : res === 'lost' ? 'lost' : 'open';
    const badge = { won: 'Tuttu', lost: 'Tutmadı', open: 'İade' }[v];
    return `<div class="kcs-goal kcs-goal--${v}" data-title="${esc(title)}"><div class="kcs-goal-text"><span>Kupon sitede sonuçlandı</span>`
      + `<span class="kcs-goal-badge">${badge}</span></div><div class="kcs-goal-track"><i style="width:100%"></i></div></div>`;
  }

  function goalHtml(total, goal, final, title = '', forced = null) {
    const { line, side } = goal;
    const v = forced === 'won' || forced === 'lost' ? forced : goalVerdict(total, line, side, final);
    const left = Math.ceil(line) - total;
    const unit = line >= 40 ? 'sayı' : 'gol';
    const note = forced === 'won' || forced === 'lost' ? 'sitede sonuçlandı' : (v !== 'open' ? '' : (side === 'alt' ? `${left} ${unit} daha gelirse yatar` : `${left} ${unit} daha lazım`));
    const badge = { won: 'Tuttu', lost: 'Tutmadı', open: 'Devam ediyor' }[v];
    const pct = Math.min(100, Math.round(total / Math.ceil(line) * 100));
    const undo = goal.manual ? '<button type="button" class="kcs-line-del" title="Elle girilen çizgiyi sil">Sil</button>' : '';
    return `<div class="kcs-goal kcs-goal--${v}" data-title="${esc(title)}"><div class="kcs-goal-text"><span><b>${total}</b> ${unit} / ${line} ${side === 'alt' ? 'Alt' : 'Üst'}${note ? ` · ${note}` : ''}${undo}</span>`
      + `<span class="kcs-goal-badge">${badge}</span></div><div class="kcs-goal-track"><i style="width:${pct}%"></i></div></div>`;
  }

  // Bahislerim kombine kartı (her maçın kendi seçimi var): maçlar tek tek okunur, Özel Oranlar'daki maç maç görünümle çizilir.
  function readSbLegs(card, els) {
    const res = siteResult(card);
    const legs = els.map((el) => {
      const pair = [...el.querySelectorAll('.sb-mb-team-name')].map((x) => x.textContent.trim()).filter(Boolean);
      if (pair.length !== 2) return null;
      const pickText = el.querySelector('.sb-mb-leg-pick-name')?.textContent.trim() || '';
      const mk = el.querySelector('.sb-mb-leg-market');
      const market = mk ? [...mk.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim() : '';
      const m = /^([\d.,]+)\s*(Alt|Üst|Ust)$/i.exec(pickText);
      const totals = m && !/korner|kart|yarı|yari|devre|çeyrek|ceyrek|takım|takim/i.test(market);
      const digits = [...el.querySelectorAll('.sb-mb-score .sb-score-digit')].map((x) => x.textContent.trim());
      const hasScore = digits.length === 2 && digits.every((d) => /^\d+$/.test(d));
      const logos = [...el.querySelectorAll('.sb-mb-team-logo img')].map((x) => x.getAttribute('src') || '');
      const cls = el.className || '';
      const forced = /result-(won|win)/.test(cls) ? 'won' : /result-(lost|lose)/.test(cls) ? 'lost' : null;
      const label = pair.join(' - ');
      return {
        label, key: `leg|${norm(pair.join(' '))}`, match: pair.join(' '), pair, time: '', market, pickText,
        line: totals ? num(m[1]) : null, side: totals && /alt/i.test(m[2]) ? 'under' : 'over', forced,
        site: {
          hs: hasScore ? Number(digits[0]) : null, as: hasScore ? Number(digits[1]) : null,
          live: el.matches('.is-live'), ended: !el.matches('.result-pending') || !!res,
          clock: el.querySelector('.sb-mb-live [data-kind]')?.textContent.trim() || '',
          start: parseLegDate(el.querySelector('.sb-mb-leg-date')?.textContent || ''),
          homeLogo: logos[0] || '', awayLogo: logos[1] || '',
        },
      };
    });
    if (legs.some((x) => !x)) return null;
    const odds = num(card.querySelector('.sb-mb-foot .sb-mb-odds')?.textContent || '');
    return { title: legs.map((x) => x.label).join(' | '), legs, odds: odds > 1 ? odds : null };
  }

  function renderSbLegs(card, lc) {
    const res = siteResult(card);
    const evs = lc.legs.map((leg) => legEvent(leg));
    const starts = lc.legs.map((leg, i) => (evs[i]?.start ? evs[i].start * 1000 : leg.site.start)).filter(Boolean);
    const verdicts = lc.legs.map((leg, i) => {
      if (leg.forced) return leg.forced;
      const e = evs[i];
      const total = e && (e.hs != null) ? e.hs + e.as : leg.site.hs != null ? leg.site.hs + leg.site.as : null;
      if (total == null || leg.line == null) return 'open';
      return goalVerdict(total, leg.line, leg.side === 'under' ? 'alt' : 'ust', e ? SK_DONE.has(e.status) : leg.site.ended);
    });
    sbInfo.set(card, {
      start: starts.length ? Math.min(...starts) : null,
      live: lc.legs.some((leg, i) => leg.site.live || (evs[i] && fromSk(evs[i]).isLive)),
      goal: res === 'won' || res === 'lost' ? res : verdicts.includes('lost') ? 'lost' : verdicts.every((v) => v === 'won') ? 'won' : 'open',
    });
    const rows = lc.legs.map((leg, i) => ({ f: evs[i] ? fromSk(evs[i]) : { home: leg.pair[0], away: leg.pair[1] } }));
    const key = lc.title;
    const html = poweredHtml() + (sbSort === 'manual' ? moveHtml('bets') : '') + (res ? `<div class="kcs-sb-status">${siteResultHtml(res, key)}</div>` : '')
      + legsCardHtml(lc) + aiSection(key, aiCalls[norm(key)] || legsAi(rows));
    let box = card.querySelector(':scope > .kcs-legs');
    if (!box) {
      box = document.createElement('div');
      box.className = 'kcs-legs kcs-legs--sb';
      styleRoot(card.getRootNode());
      card.append(box);
    }
    box.__kcsKey = key;
    if (box.__kcsHtml !== html) { box.innerHTML = html; box.__kcsHtml = html; }
    sbCache.set(sbKeyOf(card), { html, key });
  }

  // Tek maçlık kart: seçim ve skor sitenin kendi kutusunda yazıyor.
  function renderSbSingle(card) {
    const legEls = [...card.querySelectorAll('.sb-mb-leg:not(.kcs-sb-leg)')].filter((x) => !x.closest('.kcs-legs'));
    if (legEls.length >= 2) {
      const lc = readSbLegs(card, legEls);
      if (lc) { renderSbLegs(card, lc); return; }
    }
    const leg = card.querySelector('.sb-mb-leg:not(.kcs-sb-leg)');
    const pick = /^\s*(\d+(?:\.\d+)?)\s*(Alt|Üst)\s*$/i.exec(leg?.querySelector('.sb-mb-leg-pick-name')?.textContent || '');
    const digits = [...(leg?.querySelectorAll('.sb-mb-score .sb-score-digit') || [])].map((e) => e.textContent.trim());
    const hasGoal = pick && digits.length === 2 && digits.every((d) => /^\d+$/.test(d));
    const isBk = !!pick && Number(pick[1]) >= 40;
    const flash = hasGoal && !isBk ? scoreFlash(`tek|${sbKeyOf(card)}`, Number(digits[0]), Number(digits[1]), !!leg?.matches('.is-live')) : null;
    leg?.classList.toggle('kcs-flash', !!flash);
    const teams = [...(leg?.querySelectorAll('.sb-mb-team') || [])].map((e) => e.textContent.trim());
    const key = teams.join(' - ');
    const res = siteResult(card);
    sbInfo.set(card, {
      start: parseLegDate(leg?.querySelector('.sb-mb-leg-date')?.textContent || ''),
      live: !!leg?.matches('.is-live'),
      goal: res === 'won' || res === 'lost' ? res : (hasGoal ? goalVerdict(Number(digits[0]) + Number(digits[1]), Number(pick[1]), /alt/i.test(pick[2]) ? 'alt' : 'ust', !leg.matches('.result-pending')) : null),
    });
    const ai = teams.length === 2 ? aiForTeams(teams[0], teams[1]) : null;
    const soonStart = parseLegDate(leg?.querySelector('.sb-mb-leg-date')?.textContent || '');
    const upcoming = soonStart && soonStart > Date.now() - 10 * 60 * 1000 && soonStart - Date.now() < 24 * 3600 * 1000;
    if (!hasGoal && !ai && !flash && !upcoming && sbSort !== 'manual' && teams.length !== 2) return;
    const status = hasGoal ? `<div class="kcs-sb-status">${goalHtml(Number(digits[0]) + Number(digits[1]), { line: Number(pick[1]), side: /alt/i.test(pick[2]) ? 'alt' : 'ust' }, !!res || !leg.matches('.result-pending'), '', res)}</div>` : '';
    const skItem = teams.length === 2 ? matchPair(`${teams[0]}-${teams[1]}`, fixtureList()) : null;
    const ev = skItem?.raw?.sk != null ? matchEvents(fromSk(skEvents[skItem.raw.sk] || skItem.raw.skRaw)) : null;
    const evAlert = ev?.fresh ? `<div class="kcs-goal-alert"><span class="kcs-goal-tag kcs-goal-tag--${ev.fresh.cls}">${esc(ev.fresh.text.toLocaleUpperCase('tr-TR'))}</span></div>` : '';
    const goalAlert = flash ? (flash.cancel ? `<div class="kcs-goal-alert"><span class="kcs-goal-tag kcs-goal-tag--var">GOL İPTAL</span> Skor ${esc(digits[0])} - ${esc(digits[1])} oldu</div>`
      : `<div class="kcs-goal-alert"><span class="kcs-goal-tag">GOL</span> Skor ${esc(digits[0])} - ${esc(digits[1])} oldu</div>`) : '';
    const reds = '' && ev && (ev.reds.home || ev.reds.away) ? `<div class="kcs-evs"><span class="kcs-ev kcs-ev--red">Kırmızı kart: ${esc(teams[0])} ${ev.reds.home} · ${esc(teams[1])} ${ev.reds.away}</span></div>` : '';
    const legStartMs = parseLegDate(leg?.querySelector('.sb-mb-leg-date')?.textContent || '');
    const countdown = !leg?.matches('.is-live') && !hasGoal && legStartMs ? countdownHtml(legStartMs / 1000) : '';
    const singleSk = skItem?.raw?.sk != null ? String(skItem.raw.sk) : null;
    const peek = singleSk ? `<div class="kcs-sb-status kcs-peek-line"><span>${esc(teams.join(' - '))}</span>${peekBtns(singleSk)}</div>` : '';
    const html = poweredHtml() + (sbSort === 'manual' ? moveHtml('bets') : '') + peek + (countdown ? `<div class="kcs-sb-status kcs-sb-left">Maça ${countdown}</div>` : '') + evAlert + goalAlert + reds + evLines(ev) + status + aiSection(key, ai);
    let box = card.querySelector(':scope > .kcs-legs');
    if (!box) {
      box = document.createElement('div');
      box.className = 'kcs-legs kcs-legs--sb';
      styleRoot(card.getRootNode());
      card.append(box);
    }
    box.__kcsKey = key;
    if (box.__kcsHtml !== html) { box.innerHTML = html; box.__kcsHtml = html; }
    sbCache.set(sbKeyOf(card), { html, key: box.__kcsKey });
  }

  function renderSb(card, data) {
    let box = card.querySelector(':scope > .kcs-legs');
    if (!box) {
      box = document.createElement('div');
      box.className = 'kcs-legs kcs-legs--sb';
      styleRoot(card.getRootNode());
      card.append(box);
    }
    const live = data.rows.filter((r) => r.f?.isLive).length;
    const done = data.rows.filter((r) => r.f?.ended).length;
    const goals = data.rows.filter((r) => r.f?.hasScore).reduce((n, r) => n + Number(r.f.hs) + Number(r.f.as), 0);
    const summary = [live && `${live} canlı`, done && `${done} bitti`, `${data.rows.length} maç`, `toplam ${goals} gol`].filter(Boolean).join(' · ');
    const res = siteResult(card);
    const final = !!res || data.rows.every((row) => row.f?.ended);
    let status;
    if (data.goal) status = goalHtml(goals, data.goal, final, data.title, res);
    else status = res === 'won' || res === 'lost' ? siteResultHtml(res, data.title) : goalAskHtml(data.title);
    const starts = data.rows.map((row) => row.f?.start?.getTime()).filter(Boolean);
    sbInfo.set(card, {
      start: starts.length ? Math.min(...starts) : null,
      live: live > 0,
      goal: res === 'won' || res === 'lost' ? res : (data.goal ? goalVerdict(goals, data.goal.line, data.goal.side, final) : null),
    });
    const key = data.title;
    const html = `${poweredHtml()}${sbSort === 'manual' ? moveHtml('bets') : ''}<div class="kcs-sb-status">${status}</div>${sectionHtml('legs', key, 'Maç takibi', esc(summary), data.rows.map(sbLegHtml).join(''))}${aiSection(key, aiCalls[norm(key)] || legsAi(data.rows))}`;
    box.__kcsKey = key;
    const active = card.getRootNode().activeElement;
    if (box.contains(active) && active.matches('.kcs-input')) return;
    if (box.__kcsHtml !== html) { box.innerHTML = html; box.__kcsHtml = html; }
    sbCache.set(sbKeyOf(card), { html, key: box.__kcsKey });
  }

  // ---------- Bahislerim: sıralama ve üst panel ----------
  const sbInfo = new WeakMap(); // kupon kartı → { start (ms), live, goal: won | open | lost | null }
  const sbOrderMap = new Map(); // kupon anahtarı → sıra (site kartları yeniden koyunca aynen geri verilir)
  let sbSortUntil = Date.now() + 20000;

  // "8 Kas - 21:00" → ms (Türkiye saati). Yıl: bugüne en yakın.
  function parseLegDate(text) {
    const m = norm(text).match(/(\d{1,2})\W+(oca|sub|mar|nis|may|haz|tem|agu|eyl|eki|kas|ara)\w*\W+(\d{1,2})\W+(\d{2})/);
    if (!m) return null;
    const now = new Date();
    let best = null;
    for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
      const t = Date.UTC(y, MONTHS[m[2]], Number(m[1]), Number(m[3]) - 3, Number(m[4]));
      if (best == null || Math.abs(t - now) < Math.abs(best - now)) best = t;
    }
    return best;
  }

  // Sütunlar sitenin iki ayrı kutusu: sıralama açıkken sütunlar tek ızgaraya açılır (display: contents), kartlar
  // order ile dizilir. Stil shadow köküne eklenir, site listeyi yeniden kursa da kalır.
  function sbGridStyle(root, on, cols, gap) {
    let st = root.querySelector('style[data-kcs-sbsort]');
    if (!on) { st?.remove(); return; }
    const css = `.sb-mb-grid{display:grid!important;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:${gap};align-items:start}.sb-mb-col{display:contents!important}`;
    if (!st) { st = document.createElement('style'); st.dataset.kcsSbsort = '1'; root.append(st); }
    if (st.textContent !== css) st.textContent = css;
  }

  let sbGap = null;
  function applySbSort() {
    const grid = queryOne('.sb-mb-grid');
    if (!grid) return;
    const root = grid.getRootNode();
    const cards = queryAll(SB_BET);
    const siteCols = [...grid.querySelectorAll(':scope > .sb-mb-col')];
    groupHeads(grid, groupBets, cards);
    if (sbSort === 'site' && !colsBets && groupBets === 'none') {
      sbGridStyle(root, false);
      for (const c of cards) if (c.style.order !== '') c.style.order = '';
      sbOrderMap.clear();
      return;
    }
    if (sbGap == null && !root.querySelector('style[data-kcs-sbsort]')) {
      const col = siteCols[0];
      const gap = (col && getComputedStyle(col).rowGap) || '16px';
      sbGap = gap === 'normal' ? '16px' : gap;
    }
    sbGridStyle(root, true, colsBets || Math.max(1, siteCols.length), sbGap || '16px');
    if (sbSort === 'site') {
      // Sitenin sırası: site kuponları sütunlara sırayla dağıtıyor (1. sütun, 2. sütun, 1. sütun…).
      const n = Math.max(1, siteCols.length);
      siteCols.forEach((col, c) => [...col.querySelectorAll(':scope > .sb-mb')].forEach((card, i) => setOrder(card, String(i * n + c))));
      sbOrderMap.clear();
      return;
    }
    const items = cards.map((card, at) => ({ card, at, key: sbKeyOf(card), ...(sbInfo.get(card) || {}) }));
    if (sbSort === 'manual') {
      sbOrderMap.clear();
      manualSorted(items, manualOrder.bets, (x) => x.key).forEach((x, i) => { sbOrderMap.set(x.key, i); setOrder(x.card, String(i)); });
      return;
    }
    if (Date.now() > sbSortUntil && sbOrderMap.size) {
      // Okurken kartlar yer değiştirmesin: sıra donar, yeni kupon sona eklenir.
      let next = sbOrderMap.size;
      for (const x of items) {
        if (!sbOrderMap.has(x.key)) sbOrderMap.set(x.key, next++);
        setOrder(x.card, String(sbOrderMap.get(x.key)));
      }
      return;
    }
    const goalRank = { won: 0, open: 1, lost: 2 };
    const byStart = (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity);
    const rank = (a, b) => {
      if (sbSort === 'live') return (b.live ? 1 : 0) - (a.live ? 1 : 0) || byStart(a, b);
      if (sbSort === 'goal') return (goalRank[a.goal] ?? 3) - (goalRank[b.goal] ?? 3) || byStart(a, b);
      return byStart(a, b);
    };
    sbOrderMap.clear();
    [...items].sort((a, b) => rank(a, b) || a.at - b.at).forEach((x, i) => {
      sbOrderMap.set(x.key, i);
      setOrder(x.card, String(i));
    });
  }

  // Yeni sürüm uyarısı: iki panelin en üstünde.
  const versionNewer = (a, b) => {
    const x = String(a).split('.').map(Number);
    const y = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  function updateHtml() {
    const cur = hasStore ? chrome.runtime.getManifest?.().version : null;
    if (!cur || !updateInfo.latest || !versionNewer(updateInfo.latest, cur)) return '';
    return `<div class="kx-update"><span><b>Yeni sürüm ${esc(updateInfo.latest)}</b> hazır (yüklü: ${esc(cur)}).</span><button type="button" class="kcs-update-btn">Güncelle</button></div>`;
  }

  // Açılır liste: düğmede başlık ve seçili değer; içinde sitenin eski düğmeleri (aynı sınıflar, aynı tıklama).
  const ddHtml = (id, label, current, body, wide = false) => `<div class="kx-dd${kxDd === id ? ' is-open' : ''}${wide ? ' kx-dd--wide' : ''}">`
    + `<button type="button" class="kx-dd-btn" data-dd="${id}" aria-expanded="${kxDd === id}"><span>${label}</span><b>${current}</b><i class="kcs-ci-chev"></i></button>`
    + `<div class="kx-dd-menu">${body}</div></div>`;
  const warnIcon = (text) => `<span class="kx-warn-ic" title="${esc(text)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg></span>`;
  const featSum = (special = false) => { const list = [features.scores, features.arb, features.info, ...(special ? [features.pl, features.link] : [])]; const on = list.filter(Boolean).length; return on === list.length ? 'Hepsi açık' : on ? `${on}/${list.length} açık` : 'Kapalı'; };
  const GROUP_TXT = { none: 'Yok', single: 'Tekli önce', multi: 'Çoklu önce' };
  const colsTxt = (v) => (v ? `${v} kupon` : 'Site');
  function betsPanelHtml() {
    const cards = queryAll(SB_BET);
    const info = cards.map((c) => sbInfo.get(c) || {});
    const n = (f) => info.filter(f).length;
    const stat = (cls, count, label) => `<span class="kx-stat kx-stat--${cls}"><i></i><b>${count}</b>${label}</span>`;
    const sorts = [['site', 'Site'], ['start', 'Maç saati'], ['live', 'Canlı önce'], ['goal', 'Gol durumu'], ['manual', 'Elle']]
      .map(([k, label]) => `<button type="button" class="kcs-sbsort${sbSort === k ? ' is-on' : ''}" data-sbsort="${k}">${label}</button>`).join('');
    const group = (name, body) => `<div class="kx-group"><span class="kx-label">${name}</span>${body}</div>`;
    const sortTxt = { site: 'Site', start: 'Maç saati', live: 'Canlı önce', goal: 'Gol durumu', manual: 'Elle' }[sbSort] || 'Site';
    return `${updateHtml()}<header class="kx-head"><div class="kx-brand">${markHtml()}<div><b>KOKLEYİCİ SPORTS</b></div></div>`
      + `<div class="kx-stats">${stat('live', n((x) => x.live), 'canlı')}${stat('won', n((x) => x.goal === 'won'), 'tuttu')}${stat('open', n((x) => x.goal === 'open'), 'devam')}${stat('lost', n((x) => x.goal === 'lost'), 'tutmadı')}</div>`
      + `<div class="kx-sync"><span>${esc(`Canlı skor ${scoreTimes().replace(/^Veri servisi /, '')}`)}</span></div></header>`
      + `<div class="kx-controls">${ddHtml('b-sort', 'Sırala', sortTxt, `<span class="kcs-seg">${sorts}</span>`)}${ddHtml('b-group', 'Grupla', GROUP_TXT[groupBets] || 'Yok', groupHtml('bets', groupBets))}`
      + `${ddHtml('b-cols', 'Satır başı', colsTxt(colsBets), colsHtml('bets', colsBets), true)}${ddHtml('b-feat', 'Özellikler', featSum(), featHtml())}${wideHtml()}<button type="button" class="kcs-fold-all">${foldAll ? 'Tümünü aç' : 'Tümünü küçült'}</button></div>`;
    void group;
  }

  // Bahislerim üstündeki saatler: skor verisinin son geldiği an. Livescore'un "açığım" yazımı sayılmaz.
  function scoreTimes() {
    const clock = (at) => (at ? new Date(at).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' }) : 'veri yok');
    const lsOn = siteTabs.ls !== false && Date.now() - (lsMeta.updatedAt || 0) < 3 * 60 * 1000;
    const sofa = `SofaScore ${sofaConnected() ? clock(sofaMeta.updatedAt) : 'kapalı'}`;
    const ls = `Livescore ${lsOn ? clock(Math.max(lsMeta.scannedAt || 0, lsLive.at || 0)) : 'kapalı'}`;
    const skOn = Date.now() - (skMeta.liveAt || 0) < 3 * 60 * 1000;
    const sk = `Veri servisi ${skOn ? clock(skMeta.liveAt) : (skMeta.error ? 'hata' : 'kapalı')}`;
    return sk;
  }

  function renderStatus() {
    applyFullWidth();
    // Yeni Bahislerim sayfası: başlığın altına tam genişlikte panel.
    const viewHead = !document.querySelector(BETS_PAGE) && !document.querySelector('.my-bets-desktop-filters') ? queryOne('.sb-bets-view-head') : null;
    if (viewHead) {
      styleRoot(viewHead.getRootNode());
      let panel = queryOne('.kcs-status');
      if (!panel || panel.previousElementSibling !== viewHead) {
        panel?.remove();
        panel = document.createElement('div');
        panel.className = 'kcs-status kx kx-bets';
        viewHead.after(panel);
      }
      const html = betsPanelHtml();
      if (panel.__kcsHtml !== html) { panel.innerHTML = html; panel.__kcsHtml = html; }
      return;
    }
    const bar = document.querySelector(BETS_PAGE) || document.querySelector('.my-bets-desktop-filters') || queryOne('.sb-bets-view-head');
    if (!bar) return;
    styleRoot(bar.getRootNode());
    let el = queryOne('.kcs-status');
    if (!el || el.parentElement !== bar) {
      el?.remove();
      el = document.createElement('div');
      el.className = 'kcs-status';
      if (bar.matches('.sb-bets-view-head')) bar.append(el); else bar.prepend(el);
    }
    const html = `${markHtml()}${featHtml()}${sitesHtml()}<span class="kcs-bar-time">${esc(scoreTimes())}</span>`;
    if (el.__kcsHtml !== html) { el.innerHTML = html; el.__kcsHtml = html; }
  }

  // Kuponun kendisine dokunmadan kartın en altına ayrı bir "Maç takibi" bölümü ekler; maçlar
  // sitenin bacak kartı biçiminde (bet__multi-leg-*) gösterilir.
  function renderTrack(card, data) {
    // Kartın en sonuna (Oran/Tutar/Kazanç bölümünün de altına).
    const host = card;
    let box = host.querySelector(':scope > .kcs-legs');
    if (!box) {
      box = document.createElement('div');
      box.className = 'kcs-legs';
      host.append(box);
    } else if (box !== host.lastElementChild) {
      host.append(box); // Site kartı yeniden çizdiyse bölümü tekrar en alta al.
    }
    const live = data.rows.filter((r) => r.f?.isLive).length;
    const done = data.rows.filter((r) => r.f?.ended).length;
    const summary = [live && `${live} canlı`, done && `${done} bitti`, `${data.rows.length} maç`].filter(Boolean).join(' · ');
    const html = `<div class="kcs-track-head"><span>${markHtml()}Maç takibi</span><span>${summary}</span></div>`
      + '<div class="bet__legs bet__legs--multi"><div class="bet__multi-leg-stack">'
      + data.rows.map(legHtml).join('')
      + (data.totalLine ? totalHtml(data.rows, data.totalLine) : '')
      + '</div></div>';
    // Kullanıcı link yazarken yeniden çizme (yazdığı silinmesin).
    if (box.contains(document.activeElement) && document.activeElement.matches('.kcs-input')) return;
    if (box.__kcsHtml !== html) { box.innerHTML = html; box.__kcsHtml = html; }
  }

  // ---------- Özel Oranlar: 1xBet ve Stake'teki ters oranla arbitraj ----------
  // Sadece tek maçlık "Toplam Gol X.5 Alt/Üst" kartları. Kart ekrandan okunur (6q'ya istek yok).
  // Maç, açık 1xBet / Stake sekmelerinin (xbet.js / stake.js) bildiği maçlar arasında takım adı ve
  // saatle bulunur (ya da kullanıcı elle seçer); aynı çizgideki ters taraf (Alt↔Üst) oranıyla kâr
  // yüzdesi hesaplanır: kâr % = (1 / (1/O₁ + 1/O₂) − 1) × 100.

  // Özel Oranlar kartları: eski sağlayıcı (çerçevede) ve 6q'nun yeni sayfası (shadow DOM içinde).
  const SPECIAL_CARD = 'article.special-odd-card, article.sb-custom-bet-card';

  // 6q'nun yeni spor sayfası açık bir shadow DOM içinde; document.querySelector oraya giremez.
  // Kök öğe stil özniteliği taşıyan bir div, bu yüzden bütün sayfa taranmaz.
  function roots() {
    const out = [document];
    for (const e of document.querySelectorAll('div[style]')) if (e.shadowRoot) out.push(e.shadowRoot);
    return out;
  }
  const queryAll = (sel) => roots().flatMap((root) => [...root.querySelectorAll(sel)]);
  const queryOne = (sel) => queryAll(sel)[0] || null;
  // Olay shadow DOM içinden gelince ev.target kök öğe olur; asıl öğe composedPath'te.
  const targetOf = (ev) => ev.composedPath?.()[0] || ev.target;

  // Sayfanın stilleri shadow DOM'a işlemez: eklentinin stil dosyası oraya da bağlanır.
  // Eklenti renkleri: kullanıcı üst şeritten seçer.
  // Renkler: tek vurgu limon yeşili, koyu paneller, ince gri çizgiler.
  const THEME = { a: '#1e3f8f', ink: '#ffffff', text: '#7aa5ff', bg: '#111821', panel: '#161f2a', fg: '#f4f7fa', muted: '#9aa6b2', ok: '#78e54b', warn: '#ff8a4c', line: '#22303d' };

  function themeCss() {
    const t = THEME;
    return `:root, :host { --kcs-a: ${t.a}; --kcs-ink: ${t.ink}; --kcs-text: ${t.text}; --kcs-bg: ${t.bg}; --kcs-panel: ${t.panel}; --kcs-fg: ${t.fg}; --kcs-muted: ${t.muted}; --kcs-ok: ${t.ok}; --kcs-warn: ${t.warn}; --kcs-line: ${t.line}; }`;
  }

  function applyTheme() {
    for (const root of roots()) {
      const host = root === document ? document.head : root;
      let el = host?.querySelector(':scope > style[data-kcs-theme]');
      if (!el && host && (root !== document || document.querySelector('.kcs-status, .kcs-info, .kcs-legs'))) {
        el = document.createElement('style');
        el.dataset.kcsTheme = '1';
        host.append(el);
      }
      if (el && el.textContent !== themeCss()) el.textContent = themeCss();
    }
  }

  function styleRoot(root) {
    if (root === document || !(root instanceof ShadowRoot) || root.querySelector('link[data-kcs]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = logoUrl('styles.css');
    link.dataset.kcs = '1';
    root.append(link);
    applyTheme();
  }
  const BOOKS = [
    { key: 'xbet', name: '1xBet', open: 'openXbet', logo: 'icons/1xbet.png' },
    { key: 'stake', name: 'Stake', open: 'openStake', logo: 'icons/stake.ico' },
  ];
  // Sitenin simgesi eklentinin içinde (icons/); sitelere istek gitmez.
  const logoUrl = (path) => (typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(path) : path);
  // Eklentiden gelen her şeyin yanındaki küçük işaret.
  const poweredHtml = () => `<div class="kcs-powered">${markHtml()}powered by <b>KOKLEYİCİ SPORTS</b></div>`;
  // Eklentinin işareti: limon yeşili rozet, hız çizgili top (icons/icon*.png ile aynı çizim).
  const markHtml = () => '<svg class="kcs-mark" viewBox="0 0 24 24" role="img" aria-label="KOKLEYİCİ SPORTS eklentisi"><defs><linearGradient id=\"kcsg\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#3463d9\"/><stop offset=\"1\" stop-color=\"#12275e\"/></linearGradient><clipPath id=\"kcsb\"><circle cx=\"13.6\" cy=\"12\" r=\"6.3\"/></clipPath></defs><rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"6\" fill=\"url(#kcsg)\"/><g stroke=\"#ffffff\" stroke-width=\"1.7\" stroke-linecap=\"round\"><path d=\"M3.4 9h2.4M2.6 12h3.2M3.4 15h2.4\"/></g><circle cx=\"13.6\" cy=\"12\" r=\"6.3\" fill=\"#fff\"/><g clip-path=\"url(#kcsb)\" fill=\"#0b0f14\"><path d=\"M13.6 9.6 15.88 11.26 15.01 13.94 12.19 13.94 11.32 11.26Z\"/><path d=\"M13.6 5.2 15.2 6.4 13.6 7.4 12 6.4Z\"/><path d=\"M20.4 10.2 19.6 12.3 18.4 10.6 19.3 8.9Z\"/><path d=\"M18.3 18.2 16.2 18.4 16.9 16.5 18.9 16.1Z\"/><path d=\"M8.9 18.2 11 18.4 10.3 16.5 8.3 16.1Z\"/><path d=\"M6.8 10.2 7.6 12.3 8.8 10.6 7.9 8.9Z\"/></g><g stroke=\"#0b0f14\" stroke-width=\"0.9\" stroke-linecap=\"round\" clip-path=\"url(#kcsb)\"><path d=\"M13.6 9.6V7.2M15.88 11.26 18.5 10.4M15.01 13.94 16.6 16.3M12.19 13.94 10.6 16.3M11.32 11.26 8.7 10.4\"/></g><circle cx=\"13.6\" cy=\"12\" r=\"6.3\" fill=\"none\" stroke=\"#0b0f14\" stroke-width=\"1.3\"/></svg>';
  const logoHtml = (b) => `<img class="kcs-book-logo" src="${logoUrl(b.logo)}" alt="${b.name}">`;
  // Her site için: maç listesi, Alt/Üst oranları, sekme durumu (xbet.js / stake.js yazar).
  const books = Object.fromEntries(BOOKS.map((b) => [b.key, { events: [], odds: {}, meta: {}, index: null }]));
  let arbLinks = {}; // { xbet: { kartAnahtarı: maçNo }, stake: {...} } — elle seçilen maçlar
  const bookConnected = (k) => siteTabs[k] !== false && Date.now() - (books[k].meta.updatedAt || 0) < 3 * 60 * 1000;
  const num = (s) => parseFloat(String(s).replace(',', '.'));

  function readSpecial(card) {
    let match;
    let pair = null; // yeni kartta takımlar ayrı yazıyor
    let time;
    let market;
    let pick;
    let odds;
    if (card.matches('.sb-custom-bet-card')) {
      // Yeni sayfa: tek maçlık kartta iki ayrı takım satırı var, kombinede tek satırda üç maç.
      // Saat yazmıyor. Pazar tek satırda: "Toplam Gol · 2.5 Alt".
      const teams = [...card.querySelectorAll('.sb-cbt-team')].map((e) => e.textContent.trim());
      if (teams.length !== 2) return null;
      match = teams.join(' ');
      pair = teams;
      time = '';
      [market = '', pick = ''] = (card.querySelector('.sb-cbt-pick')?.textContent || '').split('·').map((x) => x.trim());
      odds = num(card.querySelector('.sb-cbt-odds-num')?.textContent);
    } else {
      const legs = card.querySelectorAll('.special-odd-leg');
      if (legs.length !== 1) return null; // kombineler atlanır
      match = legs[0].querySelector('.special-odd-leg__match')?.textContent.trim();
      time = legs[0].querySelector('.special-odd-leg__time')?.textContent.trim();
      market = legs[0].querySelector('.special-odd-pickline__market')?.textContent.trim() || '';
      pick = legs[0].querySelector('.special-odd-pickline__selection')?.textContent.trim() || '';
      odds = num(card.querySelector('.special-odd-card__head-stat strong')?.textContent);
    }
    // "Alt 2.5" (eski) ya da "2.5 Alt" (yeni).
    const after = pick.match(/(Alt|Üst|Ust)\s*([\d.,]+)/i);
    const before = pick.match(/([\d.,]+)\s*(Alt|Üst|Ust)/i);
    const m = after || (before && [before[0], before[2], before[1]]);
    if (!match || !odds) return null;
    const key = `${norm(match)}|${time || ''}`;
    // Karşılıklı gol (KG Var / Yok), maçın tamamı için.
    const mk = norm(`${market} ${pick}`);
    if (/karsilikli gol|her iki takim|both teams|\bkg\b|btts/.test(mk) && !/yari|devre|half|\bve\b|\balt\b|\bust\b|toplam/.test(mk)) {
      const side = /\b(var|evet|yes)\b/.test(norm(pick)) ? 'yes' : (/\b(yok|hayir|no)\b/.test(norm(pick)) ? 'no' : null);
      if (side) return { key, match, pair, time, odds, kind: 'btts', side };
    }
    // Devre, korner, kart vb. golleri desteklenmiyor; sadece maç sonu toplam gol (maçın ya da bir takımın).
    if (!/gol/i.test(market) || !m || /yari|devre|korner|kart|dakika|half/.test(norm(market))) {
      return { key, match, pair, time, odds, unsupported: `${market} ${pick}`.trim() };
    }
    return { key, match, pair, time, odds, side: /alt/i.test(m[1]) ? 'under' : 'over', line: num(m[2]), team: teamOfMarket(market, match) };
  }

  // Pazar bir takımın golü mü: "Ev Sahibi Toplam Gol 1.5", "Takım 2 Toplam Gol", "Alanyaspor Toplam Gol".
  // null: maçın toplamı. 'home' / 'away': belli. { name }: takım adı yazıyor ama kartın başında/sonunda
  // değil; hangisi olduğu bulunan maçın takım adlarıyla karar verilir (teamSide).
  function teamOfMarket(market, match) {
    // Sadece çizgi sayıları (1.5) silinir; "Takım 2" içindeki 2 kalmalı.
    const rest = norm(market.replace(/\d+[.,]\d+/g, ' '))
      .split(' ').filter((w) => w && !/^(toplam|gol|golu|golleri|sayisi|alt|ust|mac|macin|sonucu|ms)$/.test(w)).join(' ');
    if (!rest) return null;
    if (/^(ev sahibi|ev|evsahibi|1 takim|takim 1|1)$/.test(rest)) return 'home';
    if (/^(deplasman|dep|2 takim|takim 2|2)$/.test(rest)) return 'away';
    const n = norm(match);
    if (n.startsWith(`${rest} `)) return 'home';
    if (n.endsWith(` ${rest}`)) return 'away';
    return { name: rest };
  }

  // Bulunan maçta kartın takımı ev sahibi mi deplasman mı (maçın toplamıysa null, bilinmiyorsa 'unknown').
  function teamSide(sp, e) {
    if (!sp.team) return null;
    if (typeof sp.team === 'string') return sp.team;
    const toks = tokens(sp.team.name);
    const h = coverage(teamInfo(`${e.home} ${e.homeEng || ''}`), toks);
    const a = coverage(teamInfo(`${e.away} ${e.awayEng || ''}`), toks);
    return h > a ? 'home' : (a > h ? 'away' : 'unknown');
  }

  // Kart yazısı ile maçın takım adı ne kadar uyuşuyor (kısa ad, uzun ad ve takma adlar dahil).
  function nameFit(k, team, name, text) {
    if (arbLearned[k]?.[norm(text)] === name || learnedSides[norm(text)] === name) return 1;
    const side = sideInfo(text);
    return Math.max(sideScore(team, side), coverage(team, side.toks));
  }

  function teamsFit(k, sp, e) {
    if (sp.pair?.length !== 2) return true;
    const [x, y] = sp.pair;
    const h = teamInfo(`${e.home} ${e.homeEng || ''}`);
    const a = teamInfo(`${e.away} ${e.awayEng || ''}`);
    const straight = Math.min(nameFit(k, h, e.home, x), nameFit(k, a, e.away, y));
    const swapped = Math.min(nameFit(k, h, e.home, y), nameFit(k, a, e.away, x));
    return Math.max(straight, swapped) >= 0.5;
  }

  // Bulunan maç şüpheli mi: takımlar karta uymuyor ya da diğer kaynakların saati tutmuyor. Elle bağlanan maça dokunulmaz.
  const TIME_GAP = 30 * 60;
  function suspectOf(k, sp, m) {
    if (!m?.e || m.how === 'manual' || m.how === 'file') return null;
    const mk = `sus|${k}|${sp.key}`;
    if (matchMemo.has(mk)) return matchMemo.get(mk);
    let why = null;
    if (!teamsFit(k, sp, m.e)) {
      why = 'takımlar karta uymuyor';
    } else if (m.e.start) {
      const others = refMatches(k, sp).map((x) => x.e.start).filter(Boolean);
      if (others.length && !others.some((t) => Math.abs(t - m.e.start) <= TIME_GAP)) {
        why = `saat tutmuyor (${whenText(m.e.start)}, diğer kaynak ${whenText(others[0])})`;
      }
    }
    matchMemo.set(mk, why);
    return why;
  }

  // Güvenilen maç: bulundu ve şüpheli değil.
  function goodEvent(k, sp) {
    const m = findMatch(k, sp);
    return m && !suspectOf(k, sp, m) ? m.e : null;
  }

  // Ters taraf: aynı çizginin Alt ↔ Üst'ü, maçın ya da aynı takımın toplamında.
  // Aynı maç sitede birden çok numarayla olabilir (1xBet'te maç başlayınca canlı maçın numarası değişir,
  // arama sonucu ile maç sayfası farklı numara verebilir). Oranlar birinde kalır, seçilen öbürü olabilir;
  // bu yüzden aynı takımlı ve yakın saatli kayıtların oranlarına birlikte bakılır, en yeni olan önce gelir.
  function oddsRecs(st, e) {
    const own = st.odds[e.id];
    if (!st.events) return own ? [own] : [];
    if (st.twinSrc !== st.events) {
      st.twinSrc = st.events;
      st.twins = new Map();
      for (const x of st.events) {
        const key = `${teamInfo(x.home).norm}|${teamInfo(x.away).norm}`;
        if (!st.twins.has(key)) st.twins.set(key, []);
        st.twins.get(key).push(x);
      }
    }
    return (st.twins.get(`${teamInfo(e.home).norm}|${teamInfo(e.away).norm}`) || [e])
      .filter((x) => !x.start || !e.start || Math.abs(x.start - e.start) < 6 * 3600)
      .map((x) => st.odds[x.id])
      .filter(Boolean)
      .sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  // Bu maçın karttaki pazarda bilinen çizgileri ("yok" satırında gösterilir; neden yok anlaşılsın).
  function knownLines(st, e, sp) {
    if (sp.kind === 'btts') return [];
    const side = teamSide(sp, e);
    const out = new Set();
    for (const rec of oddsRecs(st, e)) for (const line of Object.keys((side ? rec[side] : rec.lines) || {})) out.add(line);
    return [...out].sort((a, b) => Number(a) - Number(b));
  }

  function counterOdds(st, e, sp) {
    const recs = oddsRecs(st, e);
    if (sp.kind === 'btts') {
      const other = sp.side === 'yes' ? 'no' : 'yes';
      return { name: `KG ${other === 'yes' ? 'Var' : 'Yok'}`, odds: recs.map((x) => x.btts?.[other]).find(Boolean) };
    }
    const side = teamSide(sp, e);
    const other = sp.side === 'under' ? 'over' : 'under';
    const team = side === 'home' ? e.home : (side === 'away' ? e.away : '');
    const name = `${team ? `${team} ` : ''}${other === 'over' ? 'Üst' : 'Alt'} ${sp.line}`;
    if (side === 'unknown') return { name: `takım (${sp.team.name})`, odds: null, unknown: true };
    return { name, odds: recs.map((x) => (side ? x[side] : x.lines)?.[String(sp.line)]?.[other]).find(Boolean) };
  }

  // Ön eleme: iki takımın da en az bir kelimesi aranan kelimelerle aynı üç harfle başlamıyorsa maç hiç
  // karşılaştırılmaz. Tarama binlerce maç yerine birkaç aday üzerinden yapılır.
  const prefixes = (toks) => new Set(toks.map((t) => t.slice(0, 3)));

  function withPrefixes(idx) {
    const byPre = new Map();
    idx.forEach((x, i) => {
      x.i = i;
      x.ap = prefixes(x.a.toks);
      for (const p of prefixes(x.h.toks)) {
        const list = byPre.get(p);
        if (list) list.push(x); else byPre.set(p, [x]);
      }
    });
    idx.byPre = byPre;
    return idx;
  }

  function candidates2(index, toks) {
    const pre = prefixes(toks);
    const seen = new Set();
    const out = [];
    for (const p of pre) {
      for (const x of index.byPre.get(p) || []) {
        if (seen.has(x)) continue;
        seen.add(x);
        for (const q of x.ap) if (pre.has(q)) { out.push(x); break; }
      }
    }
    return out.sort((a, b) => a.i - b.i);
  }

  function bookIndex(k) {
    const b = books[k];
    if (!b.index) {
      b.index = withPrefixes(b.events.map((e) => ({ e, h: teamInfo(`${e.home} ${e.homeEng || ''}`), a: teamInfo(`${e.away} ${e.awayEng || ''}`) }))
        .filter((x) => x.h.toks.length && x.a.toks.length));
    }
    return b.index;
  }

  const minutesOf = (start) => { const d = new Date(start * 1000); return d.getHours() * 60 + d.getMinutes(); };
  const clockDiff = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1440 - d); };

  // Kartta sadece saat var; özel oranlar yakın maçlar için. Aynı takımların başka gündeki maçı
  // (rövanş, sıradaki maç) seçilmesin diye maç 4 saat öncesi ile 36 saat sonrası arasında olmalı.
  const inWindow = (start) => {
    const t = start * 1000 - Date.now();
    return t > -4 * 3600 * 1000 && t < 36 * 3600 * 1000;
  };

  // Pek çok takımda geçen sıradan kelimeler ("Real", "United", "Sporting"): takımı belirlemez, az sayılır.
  // Böylece kart "Real Madrid" iken "Real Sociedad" yarım tutmuş sayılmaz. Sabit listeye ek olarak
  // SofaScore'un 3 günlük listesinde 12'den çok takımın adında geçen kelimeler de sıradan sayılır.
  const GENERIC = new Set(['real', 'united', 'city', 'town', 'athletic', 'atletico', 'sporting', 'deportivo', 'club',
    'sport', 'sports', 'racing', 'inter', 'dynamo', 'dinamo', 'olympique', 'royal', 'union', 'calcio', 'futbol',
    'football', 'kulubu', 'rovers', 'wanderers', 'county', 'albion', 'borussia', 'hapoel', 'maccabi', 'saint',
    'sankt', 'internacional', 'nacional', 'academy', 'stade', 'standard', 'young', 'boys', 'association', 'esporte']);
  let dfSrc = null;
  let df = new Map();
  function tokWeight(t) {
    if (dfSrc !== listVersion.sk) {
      dfSrc = listVersion.sk;
      df = new Map();
      const seen = new Set();
      for (const e of Object.values(skEvents)) {
        for (const name of [e.home, e.away]) {
          if (!name || seen.has(name)) continue;
          seen.add(name);
          for (const w of new Set(tokens(name))) df.set(w, (df.get(w) || 0) + 1);
        }
      }
    }
    return GENERIC.has(t) || (df.get(t) || 0) > 12 ? 0.3 : 1;
  }

  // Takım adındaki kelimelerin ne kadarı yazıda geçiyor (0..1); sıradan kelimeler az sayılır.
  function coverage(team, toks) {
    let sum = 0;
    let hit = 0;
    for (const t of team.toks) {
      const w = tokWeight(t);
      sum += w;
      if (toks.some((x) => tokSim(t, x) || tokSim(x, t))) hit += w;
    }
    return sum ? hit / sum : 0;
  }

  // Elle seçimlerden öğrenilen takım adları: { xbet: { kart yazısı parçası: sitedeki takım adı } }.
  // Kart yazısında öğrenilmiş parça geçerse sitedeki adın kelimeleri de aranır; böylece aynı takım
  // ertesi gün başka rakiple oynasa da bulunur ("Sønderjysk Elitesport" → "SønderjyskE").
  let arbLearned = {};

  // ---------- takım adları tablosu (teams.json) ----------
  // Wikidata'daki ~14 bin kulübün bütün adları ve takma adları (ör. "FC København", "FC Copenhagen",
  // "F.C. Kopenhag" aynı satırda). Yazıda bir kulübün adı geçerse o kulübün diğer adlarının kelimeleri de
  // aranır. Belirsiz adlar kullanılmaz: ikiden çok kulübe ait olan ya da tek kelime ve 5 harften kısa olan.
  let aliasMap = null; // sadeleşmiş ad → kulüp satırları
  const aliasMemo = new Map();

  async function loadAliases() {
    if (aliasMap || typeof chrome === 'undefined' || !chrome.runtime?.getURL) return;
    try {
      const clubs = await (await fetch(chrome.runtime.getURL('teams.json'))).json();
      const map = new Map();
      for (const names of clubs) {
        for (const n of names) {
          const list = map.get(n);
          if (!list) map.set(n, [names]);
          else if (list.length < 4 && !list.includes(names)) list.push(names);
        }
      }
      aliasMap = map;
      aliasMemo.clear();
      listCacheKey = ''; // kupon eşleşmeleri tabloyla yeniden hesaplansın
      matchDirty = true;
      scheduleRender();
    } catch {
      // Tablo yüklenemedi: eşleştirme tablosuz devam eder.
    }
  }

  // Yazıda adı geçen kulüpler (en uzun ad önce; her kulüp, adlarının listesi).
  function aliasClubs(text) {
    if (!aliasMap) return [];
    const out = [];
    const words = norm(text).split(' ').filter(Boolean);
    const used = new Array(words.length).fill(false);
    for (let len = Math.min(6, words.length); len >= 1; len--) {
      for (let i = 0; i + len <= words.length; i++) {
        if (used.slice(i, i + len).some(Boolean)) continue;
        const phrase = words.slice(i, i + len).join(' ');
        let clubs = aliasMap.get(phrase);
        // İkiden çok kulübe ait ad: biri ötekilerden çok daha fazla ada sahipse (asıl kulüp) sadece o alınır.
        if (clubs?.length > 2) {
          const sorted = [...clubs].sort((a, b) => b.length - a.length);
          clubs = sorted[0].length >= 2 * sorted[1].length ? [sorted[0]] : null;
        }
        if (!clubs || (len === 1 && phrase.length < 5) || !tokens(phrase).length) continue;
        for (let j = i; j < i + len; j++) used[j] = true;
        for (const names of clubs) if (!out.includes(names)) out.push(names);
      }
    }
    return out;
  }

  // Yazıdaki kulüplerin bütün adlarının kelimeleri.
  function aliasTokens(text) {
    if (!aliasMap) return [];
    const n = norm(text);
    let out = aliasMemo.get(n);
    if (out) return out;
    out = [];
    for (const names of aliasClubs(n)) for (const name of names) out.push(...tokens(name));
    out = [...new Set(out)];
    if (aliasMemo.size > 5000) aliasMemo.clear();
    aliasMemo.set(n, out);
    return out;
  }

  function cardTokens(k, text) {
    const n = ` ${norm(text)} `;
    const toks = [...tokens(text), ...aliasTokens(text)];
    const lists = [learnedSides, ...BOOKS.map((b) => arbLearned[b.key] || {})];
    if (k) lists.unshift(arbLearned[k] || {});
    for (const list of lists) {
      for (const [phrase, name] of Object.entries(list)) {
        if (n.includes(` ${phrase} `)) toks.push(...tokens(name));
      }
    }
    return toks;
  }

  // Bir sitenin listesinde kart yazısının kelimeleriyle (toks) maç arar. Önce sıkı kural: iki takımın da
  // en az yarısı yazıda geçmeli. Olmazsa saat dilimi içinde esnek kural: kart saatinde (±20 dk) bir
  // takımı tam, diğerini kısmen tutan tek bir maç varsa o alınır (how: 'loose').
  function scanBook(k, sp, toks) {
    return scanList(bookIndex(k), sp, toks);
  }

  // Kart saati (dakika); yeni sayfada kartta saat yok: null, saat kontrolü yapılmaz.
  function cardClock(sp) {
    const m = (sp.time || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function scanList(index, sp, toks) {
    const clock = cardClock(sp);
    // Kartta U19/U21/II/B ya da kadın takımı yazmıyorsa öyle bir maçla asla eşleştirme
    // (aynı adlı gençler maçı yanlış bir "arbitraj" gösterir).
    const n = norm(sp.match);
    const cardReserve = RESERVE_RE.test(n);
    const cardWomen = WOMEN_RE.test(n);
    let best = null;
    const loose = [];
    for (const x of index.byPre ? candidates2(index, toks) : index) {
      if (x.h.reserve !== cardReserve || x.a.reserve !== cardReserve) continue;
      if (x.h.women !== cardWomen || x.a.women !== cardWomen) continue;
      if (x.e.start && !inWindow(x.e.start)) continue;
      const ch = coverage(x.h, toks);
      const ca = coverage(x.a, toks);
      if (!ch && !ca) continue;
      if (clock != null && x.e.start && clockDiff(minutesOf(x.e.start), clock) > 20) continue;
      const s = Math.min(ch, ca);
      if (s >= 0.5) {
        if (!best || s > best.s) best = { s, e: x.e };
      } else if (Math.max(ch, ca) >= 0.9 && s > 0.25 && clock != null && x.e.start) {
        // Diğer takımdan en az bir belirleyici kelime tutmalı (sadece "Real" gibi sıradan kelime yetmez).
        loose.push(x.e);
      }
    }
    if (best) return { e: best.e, how: 'auto' };
    // Aynı saatte birden çok aday varsa hangisi olduğu belli değil: hiçbirini alma.
    if (loose.length === 1) return { e: loose[0], how: 'loose' };
    return null;
  }

  // Maçı bulur: elle seçilen maç, sonra kart yazısı (+ öğrenilmiş adlar). Bulunamazsa diğer sitede
  // kesin bulunmuş maçın takım adlarıyla da aranır (how: 'cross'): 1xBet "F.C. Copenhagen" diyorsa
  // Stake'te "FC Copenhagen" kart yazısı "København" olsa da bulunur. Bulunan böyle maçtan kart
  // yazısının parçaları bu site için de öğrenilir, ertesi gün diğer sitede maç olmasa da tanınır.
  const matchMemo = new Map(); // maç listesi ya da bağlantılar değişince sıfırlanır
  let memoAt = 0;
  function findMatch(k, sp, cross = true) {
    const mk = `${k}|${sp.key}|${cross}`;
    if (!matchMemo.has(mk)) matchMemo.set(mk, findMatchRaw(k, sp, cross) || fileMatch(k, sp));
    return matchMemo.get(mk);
  }

  // Ad kaynakları: SofaScore ve livescore.in (Flashscore) — dün/bugün/yarının futbol maçları (sofa.js,
  // livescore.js). Adları kısa ve düzgün ("Mallorca", "Sonderjyske", "FC Copenhagen"); kart yazısı uzun resmi
  // ad olsa da ("Real Club Deportivo Mallorca") içinde geçtikleri için kart burada kolay bulunur. Bulunan
  // maçın adları 1xBet/Stake'te de aranır. livescore.in adları İngilizce/sade, Stake'in aramasına uygun.
  const HUBS = [
    {
      name: 'SofaScore (kaldırıldı)',
      list: () => ({}),
      version: () => listVersion.sofa,
      conv: (e) => ({ id: e.id, home: e.home, away: e.away, homeEng: e.homeShort || '', awayEng: e.awayShort || '', start: e.startTs, league: e.tournament || '' }),
    },
    { name: 'Livescore (kaldırıldı)', list: () => ({}), version: () => 0, conv: (e) => ({ ...e, homeEng: '', awayEng: '' }) },
    { name: 'Veri servisi', list: () => skEvents, version: () => listVersion.sk, conv: (e) => ({ id: e.id, home: e.home, away: e.away, homeEng: '', awayEng: '', start: e.start, league: e.league }) },
  ];
  const hubCache = new Map(); // ad → { src, idx }

  function hubIndex(hub) {
    const src = hub.list();
    let c = hubCache.get(hub.name);
    if (!c || c.version !== hub.version()) {
      const idx = Object.values(src || {}).map((e) => {
        const x = hub.conv(e);
        return { e: x, h: teamInfo(`${x.home} ${x.homeEng}`), a: teamInfo(`${x.away} ${x.awayEng}`) };
      }).filter((x) => x.e.home && x.e.away && x.h.toks.length && x.a.toks.length);
      withPrefixes(idx);
      c = { version: hub.version(), idx };
      hubCache.set(hub.name, c);
    }
    return c.idx;
  }

  function findHub(hub, sp) {
    const mk = `${hub.name}|${sp.key}`;
    if (!matchMemo.has(mk)) {
      const m = scanList(hubIndex(hub), sp, cardTokens(null, sp.match));
      matchMemo.set(mk, m?.how === 'auto' ? m : null);
    }
    return matchMemo.get(mk);
  }

  // Kesin bulunmuş referans maçlar: diğer siteler ve ad kaynakları.
  function refMatches(k, sp) {
    const out = [];
    for (const b of BOOKS) {
      if (b.key === k) continue;
      const ref = findMatch(b.key, sp, false);
      if (ref && ref.how !== 'loose') out.push({ e: ref.e, name: b.name });
    }
    for (const hub of HUBS) {
      const m = findHub(hub, sp);
      if (m) out.push({ e: m.e, name: hub.name });
    }
    return out;
  }

  // Maç kendiliğinden bulunamazsa not dosyasındaki 1xBet maç kodu kullanılır (PickTheOdds'tan alınır). Oran yine 1xBet'ten gelir.
  function fileMatch(k, sp) {
    if (k !== 'xbet') return null;
    const id = notesMap.get(norm(sp.match))?.xbetId;
    if (!/^\d{6,}$/.test(String(id ?? ''))) return null;
    const known = books.xbet.events.find((x) => String(x.id) === String(id));
    const e = known || { id: String(id), home: sp.pair?.[0] || sp.match, away: sp.pair?.[1] || '', start: null, league: '', homeEng: '', awayEng: '', guess: true };
    return { e, how: 'file' };
  }

  function findMatchRaw(k, sp, cross) {
    const linked = arbLinks[k]?.[sp.key];
    if (linked != null) {
      const e = books[k].events.find((x) => String(x.id) === String(linked));
      return e ? { e, how: 'manual' } : null;
    }
    const toks = cardTokens(k, sp.match);
    const own = scanBook(k, sp, toks);
    if (own?.how === 'auto' || !cross) return own;
    for (const ref of refMatches(k, sp)) {
      const extra = tokens(`${ref.e.home} ${ref.e.homeEng || ''} ${ref.e.away} ${ref.e.awayEng || ''}`);
      const via = scanBook(k, sp, [...toks, ...extra]);
      if (via?.how !== 'auto') continue;
      queueLearn(k, sp, via.e, ref.e);
      return { e: via.e, how: 'cross', via: ref.name };
    }
    return own;
  }

  const findEvent = (k, sp) => findMatch(k, sp)?.e || null;

  // Kart yazısını sitedeki ev sahibi/deplasman adlarına göre ikiye böler. Kartta takımlar ayrılmadan
  // yazılıyor ("Sønderjysk Elitesport Fodbold FC København"); yazı her noktadan bölünür, iki ada en çok
  // uyan bölünme seçilir. Hiçbir kelime tutmuyorsa bölünme tahmindir: null.
  function splitCard(sp, e) {
    const words = norm(sp.match).split(' ').filter(Boolean);
    const h = teamInfo(`${e.home} ${e.homeEng || ''}`);
    const a = teamInfo(`${e.away} ${e.awayEng || ''}`);
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const left = words.slice(0, i).join(' ');
      const right = words.slice(i).join(' ');
      const sc = coverage(h, tokens(left)) + coverage(a, tokens(right));
      if (!best || sc > best.sc) best = { sc, left, right };
    }
    return best && best.sc > 0 ? best : null;
  }

  // Bu sitenin maçı (e) için kart parçası → takım adı öğrenir. Bölünme e'nin ya da (siteler arası
  // öğrenmede) diğer sitenin maçının (ref) adlarına göre yapılır; siteler ev sahibini aynı yazar.
  async function learnArb(book, sp, e, ref = e) {
    // Adresten tahmin edilen adlar öğrenilmez.
    if (!sp || !e || e.guess || ref?.guess) return;
    const learned = {};
    if (sp.pair) {
      // Yeni kartta takımlar ayrı yazıyor: adlar hiç benzemese de doğrudan öğrenilir; sadece sıra ters mi diye bakılır.
      const [x, y] = sp.pair;
      const straight = coverage(teamInfo(e.home), tokens(x)) + coverage(teamInfo(e.away), tokens(y));
      const swapped = coverage(teamInfo(e.home), tokens(y)) + coverage(teamInfo(e.away), tokens(x));
      learned[norm(x)] = swapped > straight ? e.away : e.home;
      learned[norm(y)] = swapped > straight ? e.home : e.away;
    } else {
      const split = ref ? splitCard(sp, ref) : null;
      if (!split) return;
      if (tokens(split.left).length) learned[split.left] = e.home;
      if (tokens(split.right).length) learned[split.right] = e.away;
    }
    const cur = arbLearned[book] || {};
    if (Object.entries(learned).every(([p, name]) => cur[p] === name)) return;
    arbLearned = { ...arbLearned, [book]: { ...cur, ...learned } };
    matchDirty = true;
    // Aynı ad kuponlarda da tanınsın (kupondaki kendi öğrenilmişleri ezilmez).
    const sides = { ...learned, ...learnedSides };
    learnedSides = sides;
    listCacheKey = '';
    if (hasStore) await chrome.storage.local.set({ arbLearned, learnedSides: sides });
  }

  // 1xBet sayfasındaki "bu maç mı?" çubuğundan bağlanan maçtan takım adlarını öğren.
  function onLearnReq(req) {
    const wrap = queryAll('.kcs-arb-wrap').find((w) => w.__kcsSp?.key === req.cardKey);
    const e = books[req.book]?.events.find((x) => String(x.id) === String(req.id));
    if (wrap && e) learnArb(req.book, wrap.__kcsSp, e);
  }

  const learnQueued = new Set();
  function queueLearn(k, sp, e, ref) {
    const key = `${k}|${sp.key}|${e.id}`;
    if (learnQueued.has(key)) return;
    learnQueued.add(key);
    setTimeout(() => learnArb(k, sp, e, ref), 0);
  }

  // 1xBet'te maçın numarası: sekme öne gelir, numara sitenin arama kutusuna yazılır (xbet.js).
  const gameIdOf = (b, e) => (b.key === 'xbet' && e && /^\d+$/.test(String(e.id)) ? String(e.id) : '');

  // Bulunan maçın kimliği satırın altında: sitedeki takımlar, lig, tarih-saat, erkek/kadın, gençler.
  // Kullanıcı yanlış maçı fark etsin diye şüpheli bilgiler (saat farkı, kartta olmayan kadın/gençler
  // maçı) turuncu gösterilir.
  function matchInfoHtml(e, sp, m = null) {
    const how = m?.how;
    if (!e) return '<span class="kcs-arb-sub">—</span>';
    const card = norm(sp.match);
    const site = norm(`${e.home} ${e.away} ${e.league || ''}`);
    const women = WOMEN_RE.test(site);
    const reserve = RESERVE_RE.test(site);
    const clock = cardClock(sp);
    const timeOff = e.start && clock != null && clockDiff(minutesOf(e.start), clock) > 5;
    const mark = (text, bad) => (bad ? `<em>${esc(text)}</em>` : esc(text));
    const parts = [esc(`${e.home} - ${e.away}`)];
    if (e.league) parts.push(esc(e.league));
    if (e.start) {
      const d = new Date(e.start * 1000).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      parts.push(mark(d, timeOff));
    }
    parts.push(mark(women ? 'Kadın' : 'Erkek', women !== WOMEN_RE.test(card)));
    if (reserve) parts.push(mark('Gençler/Yedek', !RESERVE_RE.test(card)));
    // Esnek eşleşmede takımlardan biri kart yazısında tam geçmiyor: kullanıcı kontrol etsin.
    if (how === 'loose') parts.push(mark('esnek eşleşme, kontrol et', true));
    if (how === 'cross') parts.push(esc(`${m.via} adlarıyla bulundu`));
    return `<span class="kcs-arb-sub">${parts.join(' · ')}</span>`;
  }

  // Satırlar sabit yükseklikte (iki satırlık): Özel Oranlar kartları Splide şeridinde ve kartın boyu
  // değişince şerit başa sarıyor. Ayrıntı (takımlar, ne yapılmalı) fareyle üstüne gelince de görünür.
  function bookLineHtml(b, sp) {
    const st = books[b.key];
    const goBtn = (label) => `<button type="button" class="kcs-fix kcs-go-site" data-book="${b.key}" title="${esc(b.name)}'te maçın sayfasını aç, üstte çıkan çubuktan bağla">${label}</button>`;
    const pickBtn = goBtn(`${b.name}'e git`);
    const muted = (text, tip, btn = pickBtn, e = null, m = null) => `<div class="kcs-arb kcs-arb--muted" title="${esc(tip || text)}">${logoHtml(b)}`
      + `<span class="kcs-arb-main"><span class="kcs-arb-text">${esc(text)}</span>${matchInfoHtml(e, sp, m)}</span>${btn}</div>`;
    if (!bookConnected(b.key)) return muted(`${b.name} kapalı`, `${b.name} sekmesi açık değil`, `<button type="button" class="kcs-btn kcs-open-book" data-open="${b.open}">${b.name}'i aç</button>`);
    if (!st.events.length) {
      // Tanı: o sitenin sekmesinden hangi yanıtlar geldi (fareyle üstüne gelince görünür).
      const seen = st.meta.urls?.length ? ` · gelen yanıtlar: ${st.meta.urls.join(' ; ')}` : '';
      return muted(`${b.name}: maç yüklenmedi`, `${b.name} sekmesinde futbol listesini aç${seen}`, '');
    }
    const m = findMatch(b.key, sp);
    const e = m?.e;
    const manual = m?.how === 'manual';
    // Maç bulunduysa: yanlışsa değiştirilir; elle bağlandıysa bağlantı kaldırılır.
    const changeBtn = manual ? `<button type="button" class="kcs-fix kcs-unlink-arb" data-book="${b.key}">Kaldır</button>` : goBtn('Değiştir');
    const counter = e ? counterOdds(st, e, sp) : { name: '', odds: null };
    if (b.key === 'xbet' && !e) {
      return muted(`${b.name}: maç yok`,
        `${b.name}'te bu maç bulunamadı. Siteye gidip maçın sayfasını aç, üstte çıkan çubuktan bağla.`, pickBtn, null, null);
    }
    if (!e) {
      return muted(`${b.name}: maç yok`, `${b.name}'te bu maç bulunamadı. Siteye gidip maçın sayfasını aç, üstte çıkan çubuktan bağla.`);
    }
    const bad = suspectOf(b.key, sp, m);
    if (bad) {
      const trust = `<button type="button" class="kcs-fix kcs-arb-trust" data-book="${b.key}" data-id="${esc(e.id)}" title="Bu maç doğru, bağla">Doğru</button>`;
      return `<div class="kcs-arb kcs-arb--muted kcs-arb--check" title="${esc(`${e.home} - ${e.away}: ${bad}. Yüzde gösterilmiyor; maçı kontrol et.`)}">${logoHtml(b)}`
        + `<span class="kcs-arb-main"><span class="kcs-arb-text">${b.name}: Kontrol et · ${esc(bad)}</span>${matchInfoHtml(e, sp, m)}</span>`
        + `<span class="kcs-arb-right">${gotoBtn(b, e)}${trust}${changeBtn}</span></div>`;
    }
    const otherName = counter.name;
    const o2 = counter.odds;
    if (counter.unknown) {
      return muted(`${b.name}: hangi takım belli değil`,
        `Pazardaki "${sp.team.name}" ${e.home} ya da ${e.away} ile eşleşmedi. Doğru maçsa bu kart için arbitraj hesaplanamaz.`, changeBtn, e, m);
    }
    if (!o2) {
      const lines = knownLines(st, e, sp);
      const known = lines.length ? ` · var: ${lines.slice(0, 5).join(', ')}` : '';
      return muted(`${b.name}: ${otherName} yok${manual ? ' · elle' : ''}${known}`,
        `${e.home} - ${e.away}: ${otherName} oranı henüz yok. ${lines.length ? `Bu maçta gelen çizgiler: ${lines.join(', ')}.` : 'Bu maçın hiç Alt/Üst oranı gelmedi.'} Maçı ${b.name}'te açınca gelir.`, gotoBtn(b, e) + changeBtn, e, m);
    }
    return oddsRowHtml(b, sp, e, m, otherName, o2, manual ? 'elle' : '', changeBtn, manual ? 'elle seçildi' : '');
  }

  // Maçı sitesinde açan düğme: oynamadan önce kontrol için; oranı gelmemiş maçta sayfa açılınca oranlar buraya gelir.
  function gotoBtn(b, e) {
    const game = gameIdOf(b, e);
    if (!game && !e.url) return '';
    return `<button type="button" class="kcs-fix kcs-pick-goto" data-book="${b.key}" data-href="${esc(e.url || '')}" data-game="${esc(game)}" title="Maçı ${esc(b.name)}'te aç">Aç</button>`;
  }

  // ---------- çok maçlı kart: adil oran ----------
  // "ÜÇ MAÇ TOPLAM GOL 10.5 ÜST": her maçın 1xBet/Stake Alt/Üst oranlarından kâr payı atılır, buna uyan beklenen
  // gol (Poisson λ) bulunur. Maçlar bağımsız sayılır, λ'lar toplanır; toplam golün çizgiyi geçme olasılığı adil orandır.
  function overProb(lambda, line) {
    let term = Math.exp(-lambda);
    let sum = term;
    for (let i = 1; i <= Math.floor(line); i++) { term *= lambda / i; sum += term; }
    return Math.max(0, 1 - sum);
  }

  function lambdaFor(p, line) {
    let lo = 0.01;
    let hi = 40;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (overProb(mid, line) < p) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Bir kayıttaki gerçek gol çizgileri. Yüksek çizgiler (korner gibi) beklenen golü şişirir, alınmaz.
  function halfLines(lines) {
    const all = [];
    for (const [key, o] of Object.entries(lines || {})) {
      const line = Number(key);
      if (line < 1.5 || line > 4.5 || (line * 2) % 2 !== 1 || !o.over || !o.under) continue;
      const p = (1 / o.over) / (1 / o.over + 1 / o.under);
      all.push({ line, p, off: Math.abs(p - 0.5), over: o.over, under: o.under });
    }
    return all.sort((a, b) => a.off - b.off);
  }

  // Beklenen gol: dengeli çizgilerin (%20-80) ortancası, yoksa en dengeli çizgi. Ortanca: tek bozuk çizgi kaydırmasın.
  function lambdaOf(lines) {
    const all = halfLines(lines);
    if (!all.length) return null;
    const near = all.filter((x) => x.off <= 0.3);
    const vals = (near.length ? near : all.slice(0, 1)).map((x) => lambdaFor(x.p, x.line)).sort((a, b) => a - b);
    const mid = vals.length >> 1;
    return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }

  // Maçın beklenen golü (iki site varsa ortalama) ve gösterilecek ana çizgi.
  function legInfo(sp) {
    const vals = [];
    let show = null;
    for (const b of BOOKS) {
      const st = books[b.key];
      if (!st.events.length) continue;
      const e = goodEvent(b.key, sp);
      const rec = e && oddsRecs(st, e).find((x) => lambdaOf(x.lines) != null);
      if (!rec) continue;
      vals.push(lambdaOf(rec.lines));
      show = show || { book: b.name, ...halfLines(rec.lines)[0] };
    }
    return { l: vals.length ? vals.reduce((n, x) => n + x, 0) / vals.length : null, show };
  }

  function readMulti(card) {
    const block = card.querySelector('.sb-cbt-textblock');
    const title = card.querySelector('.sb-cbt-team')?.textContent.trim();
    const odds = num(card.querySelector('.sb-cbt-odds-num')?.textContent);
    if (!block || !title || !odds || OTHER_MARKET.test(block.textContent)) return null;
    const m = GOAL_LINE.exec(block.textContent);
    if (!m) return null;
    const legs = title.split(/\s+[I|]\s+|\s{2,}|\s*\|\s*/).filter((x) => x.includes('-')).map((label) => {
      const pair = label.trim().split(/\s*-\s*/);
      const match = pair.join(' ');
      return { label: label.trim(), key: `leg|${norm(match)}`, match, pair: pair.length === 2 ? pair : null, time: '', odds, side: 'under', line: 2.5, team: null };
    });
    return legs.length > 1 ? { title, legs, odds, line: num(m[1]), side: /alt/i.test(m[2]) ? 'alt' : 'ust' } : null;
  }

  // Maçın başlama saati: bulunduğu sitelerden ve ad kaynaklarından en erkeni (yanılırsa erken tarafa yanılsın).
  function legStart(sp) {
    const times = [];
    for (const b of BOOKS) {
      if (!books[b.key].events.length) continue;
      const t = goodEvent(b.key, sp)?.start;
      if (t) times.push(t);
    }
    for (const hub of HUBS) {
      const t = findHub(hub, sp)?.e?.start;
      if (t) times.push(t);
    }
    return times.length ? Math.min(...times) : null;
  }

  const infoRow = (label, value, cls = '', tip = '') => `<div class="kcs-ci-row${cls ? ` kcs-ci--${cls}` : ''}"${tip ? ` title="${esc(tip)}"` : ''}><span>${label}</span><b>${value}</b></div>`;

  function leftText(sec) {
    const min = Math.ceil(sec / 60);
    if (min < 60) return `${min} dk kaldı`;
    const h = Math.floor(min / 60);
    return h < 24 ? `${h} sa ${min % 60} dk kaldı` : `${Math.floor(h / 24)} gün ${h % 24} sa kaldı`;
  }

  const whenText = (t) => new Date(t * 1000).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  const HOT_SEC = 15 * 60;

  // Maçın yanındaki geri sayım: 24 saatten yakınsa "N dk kaldı", 15 dk'dan azsa vurgulu, başlama saati geçtiyse "Başlıyor".
  function countdownHtml(startSec) {
    if (!startSec) return '';
    const left = startSec - Date.now() / 1000;
    if (left > 24 * 3600) return '';
    if (left <= 0) return left > -10 * 60 ? '<span class="kcs-left is-soon">Başlıyor</span>' : '';
    return `<span class="kcs-left${left <= HOT_SEC ? ' is-soon' : ''}">${esc(leftText(left))}</span>`;
  }

  // Tek maçta saat; çok maçlıda bütün maçlar saat sırasıyla (oranlarıyla), en erkeni vurgulu. Altında oynama süresi.
  function startRows(legs, known) {
    const all = legs.map((sp, i) => ({ sp, t: legStart(sp), info: known?.[i] }));
    const found = all.filter((x) => x.t).sort((a, b) => a.t - b.t);
    const lost = all.filter((x) => !x.t);
    const soloSk = legs.length === 1 ? skIdOf({ id: findHub(HUBS[2], legs[0])?.e?.id }) : null;
    const soloPeek = soloSk ? `<div class="kcs-peek-line">${peekBtns(soloSk)}</div>` : '';
    if (!found.length && legs.length === 1) return infoRow('En erken maç', 'saat bulunamadı', 'warn') + soloPeek;
    const first = found[0];
    const left = first ? first.t - Date.now() / 1000 : 0;
    const hot = left > 0 && left <= HOT_SEC;
    const legNote = (x) => {
      const o = x.info?.show;
      if (!o) return '<div class="kcs-ci-note kcs-ci-note--warn">oran yok</div>';
      return `<div class="kcs-ci-note">${esc(o.book)} · Üst ${o.line}: ${Number(o.over.toFixed(2))} · Alt ${o.line}: ${Number(o.under.toFixed(2))} · ${x.info.l.toFixed(2)} gol</div>`;
    };
    const rows = legs.length > 1
      ? [...found, ...lost].map((x) => {
        const cls = !x.t ? 'warn' : (x === first ? (hot ? 'hot' : 'first') : '');
        const sk = skIdOf({ id: findHub(HUBS[2], x.sp)?.e?.id });
        return infoRow(esc(x.sp.label), x.t ? `${esc(whenText(x.t))}${countdownHtml(x.t)}` : 'saat yok', `leg${cls ? ` kcs-ci--${cls}` : ''}`) + legNote(x)
          + (sk ? `<div class="kcs-peek-line">${peekBtns(sk)}</div>` : '');
      }).join('')
      : infoRow('En erken maç', esc(whenText(first.t)), hot ? 'hot' : (left > 0 ? '' : 'warn'));
    if (!first) return rows + soloPeek;
    const note = left > 0 ? `${legs.length > 1 ? 'En erken maçtan' : 'Bu saatten'} önce oynanmalı · ${leftText(left)}` : 'Maç başlamış görünüyor';
    const partial = lost.length ? '<br>Saati bulunmayan maç daha erken olabilir.' : '';
    const cls = hot ? ' kcs-ci-note--hot' : (left > 0 && !lost.length ? '' : ' kcs-ci-note--warn');
    const oneSk = legs.length === 1 ? skIdOf({ id: findHub(HUBS[2], legs[0])?.e?.id }) : null;
    return `${rows}<div class="kcs-ci-note kcs-ci-countdown${cls}">${esc(note)}${partial}</div>${oneSk ? `<div class="kcs-peek-line">${peekBtns(oneSk)}</div>` : ''}`;
  }

  // Oranlardan kurala bağlı üretilen kısa yorum (yapay zekâ değil, ek istek atmaz).
  function lineComment(total, line, side) {
    const gap = total - line;
    const pos = `Beklenen ${total.toFixed(2)} gol, ${line} çizgisinin ${Math.abs(gap).toFixed(2)} ${gap >= 0 ? 'üstünde' : 'altında'}.`;
    if (Math.abs(gap) < 0.5) return `${pos} Çizgiye çok yakın, tek gol sonucu değiştirir.`;
    const same = (gap > 0) === (side === 'ust');
    return `${pos} Seçim (${side === 'alt' ? 'Alt' : 'Üst'}) oranların gösterdiği yönle ${same ? 'aynı' : 'ters'}.`;
  }

  function commentHtml(text, notes = '') {
    if (!text && !notes) return '';
    return `<div class="kcs-ci-comment" title="Tahmindir, tavsiye değildir."><b>Yorum</b>${text ? `<div class="kcs-ci-noteline">${esc(text)}</div>` : ''}${notes}</div>`;
  }

  function multiComment(multi, known) {
    const total = known.reduce((n, x) => n + x.l, 0);
    const sorted = [...known].sort((a, b) => b.l - a.l);
    const hi = sorted[0];
    const lo = sorted[sorted.length - 1];
    return `${lineComment(total, multi.line, multi.side)} En çok gol beklenen ${hi.sp.label} (${hi.l.toFixed(2)}), en az ${lo.sp.label} (${lo.l.toFixed(2)}).`;
  }

  function singleComment(sp) {
    if (sp.unsupported || sp.kind === 'btts' || sp.team) return '';
    const { l } = legInfo(sp);
    return l == null ? '' : lineComment(l, sp.line, sp.side === 'under' ? 'alt' : 'ust');
  }

  const fairRows = (p, odds, detail, tip) => {
    const edge = (odds * p - 1) * 100;
    return infoRow('Adil oran', `${(1 / p).toFixed(2)} · kart ${odds.toFixed(2)} <i class="kcs-ci-pct kcs-ci-pct--${edge > 0 ? 'ok' : 'no'}">${edge > 0 ? '+' : '−'}%${Math.abs(edge).toFixed(2)}</i>`, '', tip)
      + infoRow('Seçim olasılığı', `%${(p * 100).toFixed(1)}${detail ? ` · ${detail}` : ''}`, '', 'Tahmindir: oranlardan hesaplandı, maçlar bağımsız sayıldı, garanti değildir.');
  };

  function multiRows(multi, known) {
    const saved = goalLines[lineKey(multi.title)] || goalLines[norm(multi.title)];
    const label = `${multi.line} ${multi.side === 'alt' ? 'Alt' : 'Üst'}`;
    const html = infoRow('Çizgi', `${label} · ${saved ? 'Kaydedildi' : 'Kaydedilmedi'}`, saved ? 'ok' : 'warn');
    const missing = known.filter((x) => x.l == null).map((x) => x.sp.label);
    if (missing.length) {
      return html + infoRow('Adil oran', `${known.length - missing.length}/${known.length} maçın oranı var`, 'warn', `Oranı gelmeyen maçlar: ${missing.join(', ')}. Maçın sayfasını sitede açınca gelir.`)
        + (Number(cardNote(multi.title)?.prob) > 0
          ? infoRow('Seçim olasılığı', `%${Number(cardNote(multi.title).prob)} · Claude tahmini`, '', 'Oranı eksik maç için son maçlardan tahmin edildi, garanti değildir.')
          : infoRow('Seçim olasılığı', 'oran eksik, hesaplanamadı', 'warn'));
    }
    const total = known.reduce((n, x) => n + x.l, 0);
    const over = overProb(total, multi.line);
    return html + fairRows(multi.side === 'alt' ? 1 - over : over, multi.odds, `beklenen ${total.toFixed(2)} gol`, 'Tahmindir: maçlar bağımsız, goller Poisson sayıldı.');
  }

  // Maç notları: Claude'a "yorumları yaz" denince notes.json'a yazılır, eklenti buradan okur. Otomatik güncellenmez.
  // { updatedAt, notes: [{ keys: ["Parma - Bologna", "PARMA-BOLOGNA"], text, at }] }
  let notesAt = null;
  let notesSig = '';
  const notesMap = new Map();

  // 24 saatten eski not gösterilmez. Ortak dosya sonra okunur, aynı maçta onun notu geçerlidir.
  const NOTE_MAX_MS = 24 * 3600 * 1000;
  function setNotes(...sources) {
    notesMap.clear();
    notesAt = null;
    for (const data of sources) {
      if (data?.updatedAt && (!notesAt || data.updatedAt > notesAt)) notesAt = data.updatedAt;
      for (const note of Array.isArray(data?.notes) ? data.notes : []) {
        if (typeof note?.text !== 'string' && typeof note?.comment !== 'string' && note?.skId == null) continue;
        if (note.at && Date.now() - Date.parse(note.at) > NOTE_MAX_MS) continue;
        for (const key of Array.isArray(note.keys) ? note.keys : []) notesMap.set(norm(key), note);
      }
    }
  }

  const parseNotes = (text) => {
    try { return JSON.parse(text); } catch { return null; }
  };

  // Yerel dosya dakikada bir, ortak dosya beş dakikada bir okunur (GitHub dosyayı zaten birkaç dakika önbellekte tutar).
  let sharedText = null;
  let sharedAt = 0;
  async function loadNotes() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return;
    let local = '';
    try { local = await (await fetch(logoUrl('notes.json'), { cache: 'no-store' })).text(); } catch { /* dosya yok */ }
    if (Date.now() - sharedAt >= 5 * 60 * 1000) {
      sharedAt = Date.now();
      try {
        const res = await chrome.runtime.sendMessage({ type: 'fetchNotes' });
        if (res?.text) sharedText = res.text;
      } catch { /* arka plan uyanamadı: sonraki turda */ }
    }
    const sig = `${local}\n${sharedText || ''}`;
    if (sig === notesSig) return;
    notesSig = sig;
    setNotes(parseNotes(local), parseNotes(sharedText));
    saveAiCalls();
    matchDirty = true;
    for (const el of queryAll('.kcs-arb-wrap')) el.__kcsHtml = null;
    scheduleRender();
  }

  // Not dosyası her gece yenilenir ve 24 saatten eski not düşer: oynanmış kuponda da görünsün diye kopyası 30 gün saklanır.
  const AI_KEEP_MS = 30 * 24 * 3600 * 1000;
  function saveAiCalls() {
    const next = {};
    for (const [k, v] of Object.entries(aiCalls)) if (Date.now() - Date.parse(v.at) < AI_KEEP_MS) next[k] = v;
    let changed = Object.keys(next).length !== Object.keys(aiCalls).length;
    for (const [k, note] of notesMap) {
      if (typeof note.comment !== 'string') continue;
      if (next[k]?.comment === note.comment && next[k]?.prob === note.prob) continue;
      next[k] = { comment: note.comment, prob: note.prob, at: note.at || new Date().toISOString() };
      changed = true;
    }
    saveSkLinks();
    if (!changed) return;
    aiCalls = next;
    if (hasStore) chrome.storage.local.set({ aiCalls });
  }

  function saveSkLinks() {
    const next = {};
    for (const [k, v] of Object.entries(skLinks)) if (Date.now() - (v.at || 0) < AI_KEEP_MS) next[k] = v;
    let changed = Object.keys(next).length !== Object.keys(skLinks).length;
    for (const [k, note] of notesMap) {
      // Futbol: sayı; basketbol: "b" önekli kod (b401909952).
      const id = /^b\d+$/.test(String(note.skId)) ? String(note.skId) : Number(note.skId);
      if (!(typeof id === 'string' || id > 0) || next[k]?.id === id) continue;
      next[k] = { id, at: Date.now() };
      changed = true;
    }
    if (!changed) return;
    skLinks = next;
    if (hasStore) chrome.storage.local.set({ skLinks });
  }

  // Tek maçlık kupon: Bahislerim uzun ad yazar ("Racing Santander"), kayıt kısa olabilir ("MALAGA-SANTANDER").
  function aiForTeams(home, away) {
    const exact = aiCalls[norm(`${home} - ${away}`)];
    if (exact) return exact;
    const word = (name) => norm(name).split(/[^a-z0-9]+/).sort((a, b) => b.length - a.length)[0] || '';
    const a = word(home);
    const b = word(away);
    if (a.length < 3 || b.length < 3) return null;
    // Çok maçlı başlıkta başka maçlar da var: sadece tek maçlık kayıtlar aranır.
    const hit = Object.keys(aiCalls).find((k) => !/\si\s/.test(k) && k.includes(a) && k.includes(b));
    return hit ? aiCalls[hit] : null;
  }

  // Kuponun kendi kaydı yoksa maçların tek tek tahminleri birleştirilir (basketbol kuponları gibi).
  function legsAi(rows) {
    const list = rows.map((r) => (r.f ? { r, ai: aiForTeams(r.f.home, r.f.away) } : null)).filter((x) => x?.ai);
    if (!list.length) return null;
    const probs = list.map((x) => Number(x.ai.prob)).filter((p) => p > 0 && p < 100);
    const prob = list.length === rows.length && probs.length === rows.length ? Math.round(probs.reduce((t, p) => t * p / 100, 1) * 100) : null;
    return { comment: list.map((x) => `${x.r.f.home} - ${x.r.f.away}: ${x.ai.comment}`).join(' '), prob, at: list.map((x) => x.ai.at).sort().pop() };
  }

  function aiSection(key, ai) {
    if (!ai) return '';
    const p = Number(ai.prob);
    const sum = p > 0 && p < 100 ? `%${p}` : '';
    const written = ai.at ? infoRow('Yazıldığı saat', esc(noteTime(ai.at))) : '';
    return sectionHtml('info', key, 'Yapay zeka tahmini', sum, probRow(ai) + written + commentHtml(ai.comment));
  }

  const noteTime = (iso) => new Date(iso).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  function notesHtml(sps) {
    const found = sps.map((sp) => ({ sp, note: notesMap.get(norm(sp.match)) })).filter((x) => typeof x.note?.text === 'string');
    return found.map(({ sp, note }) => `<div class="kcs-ci-noteline">${sps.length > 1 ? `<u>${esc(sp.label)}</u> ` : ''}${esc(note.text)}${note.at ? ` <small>(${esc(noteTime(note.at))})</small>` : ''}</div>`).join('');
  }

  function howText(k, sp) {
    const m = findMatch(k, sp);
    if (!m) return null;
    if (suspectOf(k, sp, m)) return 'Kontrol et';
    return { manual: 'Elle bağlandı', auto: 'Otomatik', loose: 'Esnek', file: 'PickTheOdds kodu', cross: `${m.via} adıyla` }[m.how] || 'Otomatik';
  }

  function matchRow(sps) {
    const hows = BOOKS.filter((b) => books[b.key].events.length).map((b) => ({ b, list: sps.map((sp) => howText(b.key, sp)) }));
    if (!hows.length) return '';
    if (sps.length === 1) {
      return infoRow('Eşleşme', esc(hows.map(({ b, list }) => `${b.name}: ${list[0] || 'yok'}`).join(' · ')), hows.some(({ list }) => list[0] === 'Kontrol et') ? 'warn' : '');
    }
    const found = sps.filter((_, i) => hows.some(({ list }) => list[i] && list[i] !== 'Kontrol et')).length;
    const both = sps.filter((_, i) => hows.length > 1 && hows.every(({ list }) => list[i] && list[i] !== 'Kontrol et')).length;
    const count = {};
    for (const { list } of hows) for (const h of list) if (h) count[h] = (count[h] || 0) + 1;
    const tip = Object.entries(count).map(([k, n]) => `${k}: ${n}`).join(' · ');
    return infoRow('Eşleşme', `${found}/${sps.length} maç bulundu${hows.length > 1 ? ` · ${both}/${sps.length} iki sitede` : ''}`, found < sps.length ? 'warn' : '', tip);
  }

  function scenarioRows(multi, known) {
    const n = multi.legs.length;
    const need = multi.side === 'alt' ? Math.floor(multi.line) : Math.ceil(multi.line);
    let html = infoRow('Gol senaryosu', `${multi.side === 'alt' ? 'Alt' : 'Üst'} için maç başına ${multi.side === 'alt' ? 'en çok' : 'en az'} ${(need / n).toFixed(2)} gol`);
    const have = known.filter((x) => x.l != null);
    if (have.length === n) {
      const sorted = [...have].sort((a, b) => a.l - b.l);
      const key = multi.side === 'alt' ? sorted[n - 1] : sorted[0];
      html += infoRow('Kritik maç', `${esc(key.sp.label)} · ${key.l.toFixed(2)} gol`, '', multi.side === 'alt' ? 'Alt için en çok zorlayan maç: beklenen golü en yüksek.' : 'Üst için en çok zorlayan maç: beklenen golü en düşük.');
    }
    return html;
  }

  // Elle yazılan yorum varsa otomatik yorumun yerini alır. Olasılık sadece not dosyasından gelir.
  function cardNote(title) {
    const note = notesMap.get(norm(title));
    return typeof note?.comment === 'string' ? note : null;
  }

  function probRow(note) {
    const p = Number(note?.prob);
    return p > 0 && p < 100 ? infoRow('Seçim olasılığı', `%${p}`, '', 'Tahmindir: oranlardan ve son maçlardan hesaplandı, garanti değildir.') : '';
  }

  const isClosed = (id, key) => cardFolds[`${id}|${key}`] ?? foldAll;

  function sectionHtml(id, key, title, sum, body) {
    const closed = isClosed(id, key);
    return `<section class="kcs-ci kcs-ci--${id}${closed ? ' is-closed' : ''}"><button type="button" class="kcs-ci-title kcs-fold" data-fold="${id}" aria-expanded="${!closed}">`
      + `<span class="kcs-ci-name">${title}</span>${sum ? `<span class="kcs-ci-sum">${sum}</span>` : ''}<i class="kcs-ci-chev"></i></button>`
      + `<div class="kcs-ci-body">${body}</div></section>`;
  }

  function arbSum(sp) {
    const p = sp.unsupported ? null : bestProfit(sp);
    if (p == null) return 'oran yok';
    return `<em class="kcs-ci-pct kcs-ci-pct--${p > 0 ? 'ok' : 'no'}">${p > 0 ? '+' : '−'}%${Math.abs(p).toFixed(2)}</em>`;
  }

  function infoSum(legs, prob) {
    const times = legs.map(legStart).filter(Boolean);
    const when = times.length ? whenText(Math.min(...times)) : '';
    return [when, prob ? `%${prob}` : ''].filter(Boolean).map(esc).join(' · ');
  }

  function cardInfoHtml(sp, multi) {
    let body;
    let prob = null;
    if (multi) {
      const known = multi.legs.map((leg) => ({ sp: leg, ...legInfo(leg) }));
      body = startRows(multi.legs, known) + multiRows(multi, known)
        + scenarioRows(multi, known) + matchRow(multi.legs);
      if (known.every((x) => x.l != null)) {
        const over = overProb(known.reduce((n, x) => n + x.l, 0), multi.line);
        prob = ((multi.side === 'alt' ? 1 - over : over) * 100).toFixed(1);
      }
      const note = cardNote(multi.title);
      if (prob == null && Number(note?.prob) > 0) prob = Number(note.prob);
      const auto = known.every((x) => x.l != null) ? multiComment(multi, known) : '';
      body += commentHtml(note ? note.comment : auto, notesHtml(multi.legs));
    } else {
      const one = [{ ...sp, label: sp.match }];
      body = startRows(one) + matchRow(one);
      const note = cardNote(sp.match);
      prob = Number(note?.prob) || null;
      body += probRow(note) + commentHtml(note ? note.comment : singleComment(sp), notesHtml(one));
    }
    const legs = multi ? multi.legs : [sp];
    return sectionHtml('info', multi ? multi.title : sp.key, 'MAÇ BİLGİLERİ', infoSum(legs, prob), body);
  }

  // Ters oranı bilinen satır: kâr yüzdesi, tıklayınca tutar hesabı. note: oranın yanında küçük not.
  function oddsRowHtml(b, sp, e, m, otherName, o2, note, pickBtn, tipNote) {
    const profit = (1 / (1 / sp.odds + 1 / o2) - 1) * 100;
    const cls = profit > 0 ? 'kcs-arb--ok' : 'kcs-arb--no';
    const sign = profit > 0 ? '+' : '−';
    const s = stakes(CALC_DEFAULT, sp.odds, o2);
    const tip = `${e.home} - ${e.away}${tipNote ? ` · ${tipNote}` : ''}\n`
      + `${CALC_DEFAULT} için: 6q ${s.a} · ${b.name} ${s.b} → dönüş ${s.ret} (tıkla: tutarı değiştir)`;
    // Oran 1.773 gibi üç basamaklı olabilir; yuvarlamadan göster ki elle hesap tutsun.
    return `<div class="kcs-arb kcs-arb--calc ${cls}" title="${esc(tip)}" data-o1="${sp.odds}" data-o2="${o2}" data-book="${esc(b.name)}">`
      + `${logoHtml(b)}<span class="kcs-arb-main"><span class="kcs-arb-text">${b.name} ${otherName}: <b>${Number(o2.toFixed(3))}</b>${note ? `<small> · ${esc(note)}</small>` : ''}</span>${matchInfoHtml(e, sp, m)}</span>`
      + `<span class="kcs-arb-right"><span class="kcs-arb-pct">${sign}%${Math.abs(profit).toFixed(2)}</span>${gotoBtn(b, e)}${pickBtn}</span></div>`;
  }

  // ---------- tutar hesabı ----------
  // İki tarafa yatırılacak tutar: her biri toplamın (1/oran) / Σ(1/oran) kadarı; hangisi tutarsa
  // tutsun dönüş aynı olur: toplam / Σ(1/oran).
  const CALC_DEFAULT = 1000;
  let calcTotal = CALC_DEFAULT;
  let calcRow = null; // tutar penceresi açık olan satır

  function stakes(total, o1, o2) {
    const sum = 1 / o1 + 1 / o2;
    const f = (v) => v.toFixed(2);
    return { a: f(total / o1 / sum), b: f(total / o2 / sum), ret: f(total / sum), gain: f(total / sum - total) };
  }

  function calcResultHtml(row) {
    const s = stakes(calcTotal, Number(row.dataset.o1), Number(row.dataset.o2));
    const sign = Number(s.gain) >= 0 ? '+' : '';
    return `<div class="kcs-calc-row"><span>6q (@ ${row.dataset.o1})</span><b>${s.a}</b></div>`
      + `<div class="kcs-calc-row"><span>${esc(row.dataset.book)} (@ ${Number(Number(row.dataset.o2).toFixed(3))})</span><b>${s.b}</b></div>`
      + `<div class="kcs-calc-row kcs-calc-row--total${Number(s.gain) < 0 ? ' kcs-calc-row--loss' : ''}"><span>Hangisi tutarsa dönüş</span><b>${s.ret} <small>(${sign}${s.gain})</small></b></div>`;
  }

  // Satıra tıklayınca, satırın altında yüzen küçük hesap penceresi (kartın boyunu değiştirmez).
  function showCalc(row) {
    document.querySelector('body > .kcs-calc')?.remove();
    calcRow = row;
    const pop = document.createElement('div');
    pop.className = 'kcs-pop kcs-calc';
    pop.innerHTML = '<div class="kcs-calc-head"><span>Toplam tutar</span>'
      + `<input class="kcs-input kcs-calc-input" type="number" min="1" step="10" value="${calcTotal}"></div>`
      + `<div class="kcs-calc-out">${calcResultHtml(row)}</div>`;
    document.body.append(pop);
    const r = row.getBoundingClientRect();
    const w = 280;
    pop.style.width = `${w}px`;
    pop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.right - w))}px`;
    pop.style.top = `${Math.min(innerHeight - 40, r.bottom + 6)}px`;
    const input = pop.querySelector('.kcs-calc-input');
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (v > 0) calcTotal = v;
      pop.querySelector('.kcs-calc-out').innerHTML = calcResultHtml(calcRow);
    });
    input.focus({ preventScroll: true });
    input.select();
  }

  function closeCalc() {
    calcRow = null;
    document.querySelector('body > .kcs-calc')?.remove();
  }

  function arbHtml(sp) {
    if (sp.unsupported) {
      const text = `Arbitraj: bu pazar desteklenmiyor (${sp.unsupported})`;
      return `<div class="kcs-arb kcs-arb--muted" title="${esc(text)}"><span class="kcs-arb-text">${esc(text)}</span></div>`;
    }
    return BOOKS.map((b) => bookLineHtml(b, sp)).join('');
  }

  // Sitenin sekmesine (Stake / 1xBet) aranacak maçlar ve kelimeleri. Stake'in araması yazımı birebir ister
  // ("Beşiktaş" bulur, "Besiktas" bulmaz; "Brondby" bulur, "Brøndby" bulmaz), uzun resmi adı bulmaz
  // ("Galatasaray Spor Kulübü"), kelime başını bulur ("Stutt"). Bu yüzden takımı belirleyen tek kelimeler,
  // hem asıl yazımıyla hem sade hâliyle aranır; sıradan kelimeler ("Spor", "Kulübü", "FC") aranmaz.
  // Sıra: diğer sitelerde ve SofaScore'da bulunmuş maçın takım adları, bu site için öğrenilmiş adlar, kart yazısı.
  // id: maç bu sitede bulunduysa numarası (1xBet oranlarını maç isteğiyle getirir).
  // found: maç ve ters oran biliniyor; sekme bunları sadece tazeler.
  function keyWords(text) {
    return String(text || '').split(/[\s\-–/.,()]+/).filter((w) => {
      const n = norm(w);
      return n.length >= 4 && !/^\d+$/.test(n) && !STOP.has(n) && !GENERIC.has(n) && tokens(w).length
        && !RESERVE_RE.test(n) && !WOMEN_RE.test(n);
    });
  }

  function searchTerms(k, sp) {
    const out = [];
    const add = (w) => {
      for (const v of [w.trim(), norm(w)]) if (v.length >= 3 && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    };
    // Bir takım adından: kısa adsa tamamı ("VfB Stuttgart"), sonra en uzun belirleyici kelimesi.
    const fromName = (name) => {
      const words = keyWords(name);
      if (!words.length) return;
      if (String(name).trim().split(/\s+/).length <= 2) add(String(name));
      add(words.sort((a, b) => b.length - a.length)[0]);
    };
    for (const ref of refMatches(k, sp).reverse()) { fromName(ref.e.home); fromName(ref.e.away); }
    const n = ` ${norm(sp.match)} `;
    for (const [phrase, name] of Object.entries(arbLearned[k] || {})) if (n.includes(` ${phrase} `)) fromName(name);
    // Kart yazısı: en nadir (SofaScore listesinde en az takımda geçen), eşitse en uzun kelimeler önce.
    tokWeight('');
    const rare = keyWords(sp.match).sort((a, b) => (df.get(norm(a)) || 0) - (df.get(norm(b)) || 0) || b.length - a.length);
    for (const w of rare.slice(0, 4)) add(w);
    // Takım adları tablosu: kartta adı geçen kulübün kartta yazmayan, en az 3 adında geçen kelimesi
    // ("København" kartı için "copenhagen"; Stake çoğunlukla İngilizce yazımı kullanıyor). Takma adlar elenir.
    const cardToks = tokens(sp.match);
    for (const names of aliasClubs(sp.match)) {
      const count = new Map();
      for (const name of names) for (const w of new Set(keyWords(name))) count.set(w, (count.get(w) || 0) + 1);
      const best = [...count].filter(([w, c]) => c >= 3 && !cardToks.some((x) => tokSim(norm(w), x) || tokSim(x, norm(w))))
        .sort((a, b) => b[1] - a[1])[0];
      if (best) add(best[0]);
    }
    return out.slice(0, 12);
  }

  function wantItem(k, sp) {
    const terms = searchTerms(k, sp);
    const e = findEvent(k, sp);
    const found = !!(e && counterOdds(books[k], e, sp).odds);
    // id yoksa kart bu sitede bulunamadı: site sekmesi açılan maç sayfasında bu kartları önerir (bar.js).
    return { key: sp.key, terms, id: e?.id ?? null, found, pick: e ? undefined : pickOf(k, sp) };
  }

  const lastWant = {};
  function sendWant(want) {
    if (!hasStore) return;
    for (const k in want) {
      const json = JSON.stringify(want[k]);
      if (json === lastWant[k]) continue;
      lastWant[k] = json;
      chrome.storage.local.set({ [`${k}Want`]: want[k] });
    }
  }

  // En iyi arbitraj kârı (%); oranı olmayan kartta null.
  function bestProfit(sp) {
    if (sp.unsupported) return null;
    let best = null;
    for (const b of BOOKS) {
      const st = books[b.key];
      // Satırda "kapalı" yazan site özette ve sıralamada sayılmaz.
      if (!st.events.length || !bookConnected(b.key)) continue;
      const e = goodEvent(b.key, sp);
      const o2 = e ? counterOdds(st, e, sp).odds : null;
      if (!o2) continue;
      const p = (1 / (1 / sp.odds + 1 / o2) - 1) * 100;
      if (best == null || p > best) best = p;
    }
    return best;
  }

  // Sıra sadece sayfa açılınca ve düğmeye basınca değişir: oranlar yenilendikçe kartlar yer değiştirip sayfa kaymış gibi görünmesin.
  let sortOpenUntil = Date.now() + 25000;
  const orderMap = new Map();

  // Sıra bir kartı yerinden oynattı mı: oynattıysa sayfa o kartın peşinden kaydırılmaz (ölçüldü: 940 px zıplatıyordu).
  let sortMoved = false;
  // Gruplama: tekli ve çoklu kuponlar ayrı bloklarda. Sıra numarasına grubun payı eklenir (1. grup 0, 2. grup 1000);
  // grup başlığı her grubun en başında (pay - 1).
  const isMultiCard = (card) => (card.matches?.(SB_BET) ? !!card.querySelector?.('.sb-mb-textbet') : specialIsMulti(card));
  const groupModeOf = (card) => (card.matches?.(SB_BET) ? groupBets : groupSpecial);
  const groupRank = (mode, multi) => (mode === 'none' ? 0 : (mode === 'single') === !multi ? 0 : 1);
  const specialKey = (card) => (card.querySelector('.sb-cbt-team') || !card.querySelector('.sb-cbt-leg')
    ? `${card.querySelector('.sb-cbt-team')?.textContent}|${card.querySelector('.sb-cbt-pick')?.textContent}`
    : `legs|${[...card.querySelectorAll('.sb-cbt-leg')].map((e) => e.textContent.trim()).join('/')}`);
  const specialIsMulti = (card) => !!card.querySelector?.('.sb-cbt-textblock') || (card.querySelectorAll?.('.sb-cbt-leg')?.length || 0) > 1;
  const setOrder = (card, base) => {
    const mode = groupModeOf(card);
    const order = base === '' || mode === 'none' ? base : String(Number(base) + groupRank(mode, isMultiCard(card)) * 1000);
    if (card.style.order === order) return;
    if (card.style.order !== '') sortMoved = true;
    card.style.order = order;
  };

  function groupHeads(grid, mode, cards) {
    if (!grid) return;
    const heads = [...grid.querySelectorAll(':scope > .kcs-group-head')];
    if (mode === 'none') { heads.forEach((h) => h.remove()); return; }
    const multiN = cards.filter(isMultiCard).length;
    const want = [[false, cards.length - multiN], [true, multiN]].filter(([, n]) => n > 0);
    for (const [multi, n] of want) {
      const id = multi ? 'multi' : 'single';
      let h = heads.find((x) => x.dataset.group === id);
      if (!h) {
        h = document.createElement('div');
        h.className = 'kcs-group-head';
        h.dataset.group = id;
        grid.append(h);
      }
      const html = `${markHtml()}<b>${multi ? 'Çoklu kuponlar' : 'Tekli kuponlar'}</b><span>${n}</span>`;
      if (h.__kcsHtml !== html) { h.innerHTML = html; h.__kcsHtml = html; }
      const order = String(groupRank(mode, multi) * 1000 - 1);
      if (h.style.order !== order) h.style.order = order;
    }
    for (const h of heads) if (!want.some(([multi]) => h.dataset.group === (multi ? 'multi' : 'single'))) h.remove();
  }

  // Elle sıralama: kayıtlı sıradaki kuponlar önce, yeni gelenler sitenin sırasıyla sona.
  function manualSorted(items, list, keyOf) {
    const pos = new Map(list.map((k, i) => [k, i]));
    return [...items].sort((a, b) => (pos.get(keyOf(a)) ?? 1e6 + a.at) - (pos.get(keyOf(b)) ?? 1e6 + b.at));
  }

  function applySort(items) {
    applySortCore(items);
    groupHeads(queryOne('.sb-custom-bets-grid'), groupSpecial, items.map((x) => x.card));
  }

  function applySortCore(items) {
    const keyOf = (x) => x.key ?? x.at;
    if (cardSort === 'manual') {
      orderMap.clear();
      manualSorted(items, manualOrder.special, keyOf).forEach((x, i) => { orderMap.set(keyOf(x), i); setOrder(x.card, String(i)); });
      return;
    }
    // Sayfa açılınca kartlar 25 sn boyunca veri geldikçe yeniden sıralanır. Kullanıcı aşağı indiyse sıra donar:
    // okurken kartlar yer değiştirmesin. Sıralama düğmesine basınca yine sıralanır.
    if (Date.now() <= sortOpenUntil && orderMap.size && typeof window !== 'undefined' && window.scrollY > 200 && Date.now() - userActAt > 2000) sortOpenUntil = 0;
    if (Date.now() > sortOpenUntil && cardSort !== 'site' && orderMap.size) {
      // Sonradan gelen kart sona eklenir, diğerleri yerinde kalır.
      let next = orderMap.size;
      for (const x of items) {
        if (!orderMap.has(keyOf(x))) orderMap.set(keyOf(x), next++);
        setOrder(x.card, String(orderMap.get(keyOf(x))));
      }
      return;
    }
    orderMap.clear();
    const rank = (a, b) => {
      // Kapanmış kart oynanamaz: seçilen sıralamada en alta.
      if (a.closed !== b.closed) return a.closed ? 1 : -1;
      if (cardSort === 'both') return (a.start ?? Infinity) - (b.start ?? Infinity) || (b.arb ?? -Infinity) - (a.arb ?? -Infinity);
      if (cardSort === 'arb') return (b.arb ?? -Infinity) - (a.arb ?? -Infinity);
      if (cardSort === 'start') return (a.start ?? Infinity) - (b.start ?? Infinity);
      return 0;
    };
    const sorted = [...items].sort((a, b) => rank(a, b) || a.at - b.at);
    sorted.forEach((x, i) => {
      orderMap.set(keyOf(x), i);
      setOrder(x.card, cardSort === 'site' && groupSpecial === 'none' ? '' : String(i));
    });
  }

  // Kartların üstündeki şerit: her sitenin oranının son geldiği saat, yenileme bağlantısı, kontrol uyarısı.
  let refreshUntil = 0;

  function lastOddsAt(k) {
    let at = 0;
    for (const rec of Object.values(books[k].odds)) if (rec.at > at) at = rec.at;
    return at;
  }

  const SITES = [
    { key: 'xbet', name: '1xBet', use: 'Özel Oranlar kartlarındaki ters oranı verir, arbitraj buna göre hesaplanır. Stake ile birlikte oran kaynağıdır.', open: 'openXbet', ok: () => bookConnected('xbet') },
    { key: 'stake', name: 'Stake', use: 'İkinci oran kaynağı: aynı kartta ters oranı verir, arbitraj 1xBet ile yan yana görünür.', open: 'openStake', ok: () => bookConnected('stake') },
    // SofaScore ve Livescore kaldırıldı.
  ];

  // Canlı skor / Arbitraj anahtarları: özellik kapalıyken de görünür, yoksa geri açılamaz.
  function featHtml(special = false) {
    const btn = (key, on, label) => `<button type="button" class="kcs-feat-btn${on ? ' is-on' : ''}" data-feat="${key}" aria-pressed="${on}" title="${label} ${on ? 'açık, kapat' : 'kapalı, aç'}"><i></i>${label}</button>`;
    return `<span class="kcs-feats">${btn('featScores', features.scores, 'Canlı skor')}${btn('featArb', features.arb, 'Arbitraj')}${btn('featInfo', features.info, 'Bilgiler')}${special ? btn('featPl', features.pl, 'Çok maçlı kuponlar · kâr/zarar') + btn('featLink', features.link, 'Bağlı kuponlar') : ''}</span>`;
  }

  function sitesHtml() {
    const chips = SITES.map((x) => {
      const on = x.ok();
      return `<button type="button" class="kcs-site-btn kcs-site-btn--${on ? 'on' : 'off'}" data-open="${x.open}" data-tip="${esc(x.use)}" data-state="${on ? 'Açık, tıklayınca sekmeye gider' : 'Kapalı, tıklayınca açılır'}" aria-label="${esc(x.name)}: ${esc(x.use)}"><i></i>${esc(x.name)}</button>`;
    }).join('');
    return `<span class="kcs-sites">${chips}</span>`;
  }

  // Site düğmesinin üstüne gelince hemen çıkan açıklama.
  let tipEl = null;
  let tipBtn = null;
  let tipTop = 0;
  const hideTip = () => { if (tipEl) tipEl.style.display = 'none'; tipBtn = null; };
  // Sitenin iç kutuları kendi kendine scroll olayı atar: baloncuk sadece düğme gerçekten yer değiştirdiyse kapanır.
  function onTipScroll() {
    if (tipBtn && (!tipBtn.isConnected || Math.abs(tipBtn.getBoundingClientRect().top - tipTop) > 2)) hideTip();
  }
  function onTipHover(ev) {
    const btn = targetOf(ev).closest?.('.kcs-site-btn');
    if (!btn) { hideTip(); return; }
    if (btn === tipBtn) return;
    if (!tipEl?.isConnected) {
      tipEl = document.createElement('div');
      tipEl.className = 'kcs-site-tip';
      tipEl.style.cssText = `position:fixed;z-index:2147483647;box-sizing:border-box;width:280px;padding:9px 11px;border:1px solid ${THEME.a};border-radius:6px;background:${THEME.bg};color:${THEME.fg};font:500 13px/1.4 system-ui,sans-serif;pointer-events:none;box-shadow:0 8px 22px rgba(0,0,0,.45)`;
      document.body.append(tipEl);
    }
    tipEl.textContent = btn.dataset.tip;
    const state = document.createElement('div');
    state.textContent = btn.dataset.state;
    state.style.cssText = `margin-top:5px;color:${THEME.muted};font-size:12px`;
    tipEl.append(state);
    tipEl.style.display = 'block';
    const box = btn.getBoundingClientRect();
    tipBtn = btn;
    tipTop = box.top;
    const h = tipEl.offsetHeight;
    tipEl.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - 288))}px`;
    tipEl.style.top = `${box.bottom + h + 14 > window.innerHeight ? box.top - h - 6 : box.bottom + 6}px`;
  }

  // Çok maçlı kuponlardan en az birinin tutma olasılığı. Maçın beklenen golü önce 1xBet/Stake oranından, yoksa
  // gece analizinin yazdığı tahminden (notlarda maç kaydının lambda alanı) alınır. Aynı maç birden çok kuponda olabilir:
  // her maçın golü bir kez çekilir, o maçı içeren bütün kuponlar aynı sonucu görür (Monte Carlo, sabit tohum).
  // Maç tahmini olmayan kuponda kuponun kendi olasılığı (prob) kullanılır ve diğerlerinden bağımsız sayılır.
  function multiChance(list, runs = 20000) {
    const full = list.filter((c) => c.legs.every((x) => x.l > 0));
    const loose = list.filter((c) => !full.includes(c) && c.p > 0 && c.p < 1);
    if (!full.length && !loose.length) return null;
    const keys = [...new Set(full.flatMap((c) => c.legs.map((x) => x.k)))];
    const lam = keys.map((k) => full.flatMap((c) => c.legs).find((x) => x.k === k).l);
    const idx = full.map((c) => c.legs.map((x) => keys.indexOf(x.k)));
    let seed = 20261108;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const poisson = (l) => { const L = Math.exp(-l); let k = 0; let p = rnd(); while (p > L) { k++; p *= rnd(); } return k; };
    let none = 0;
    let sum = 0;
    let paySum = 0;
    const byK = Array.from({ length: full.length + loose.length + 1 }, () => ({ n: 0, pay: 0 }));
    const goals = new Array(keys.length);
    for (let i = 0; i < runs; i++) {
      for (let j = 0; j < keys.length; j++) goals[j] = poisson(lam[j]);
      let hits = 0;
      let pay = 0; // tutan kuponların oranları toplamı (kupon başına 1 birim)
      full.forEach((c, n) => {
        const total = idx[n].reduce((t, j) => t + goals[j], 0);
        if (c.side === 'alt' ? total < c.line : total > c.line) { hits++; pay += c.odds || 0; }
      });
      for (const c of loose) if (rnd() < c.p) { hits++; pay += c.odds || 0; }
      if (!hits) none++;
      sum += hits;
      paySum += pay;
      byK[hits].n++;
      byK[hits].pay += pay;
    }
    const count = full.length + loose.length;
    // k kupon tutarsa: olasılığı ve ortalama net sonuç (birim başına; kuponların oranı farklı olduğundan ortalama)
    // k kupon tutarsa sonuç hangi kuponların tuttuğuna bağlı (oranlar farklı): en düşük ve en yüksek oranlı k kupon sınırları verir.
    // Ortalama: denemede yeterince görüldüyse oradan (olası kuponlar ağır basar), değilse ortalama oranla.
    const odds = [...full, ...loose].map((c) => c.odds || 0).sort((a, b) => a - b);
    const avgOdds = odds.reduce((t, o) => t + o, 0) / (odds.length || 1);
    const dist = byK.map((x, k) => ({
      k,
      p: x.n / runs,
      net: x.n >= 50 ? x.pay / x.n - count : k * avgOdds - count,
      min: odds.slice(0, k).reduce((t, o) => t + o, 0) - count,
      max: odds.slice(odds.length - k).reduce((t, o) => t + o, 0) - count,
    }));
    // Hiç denemede "hiçbiri" çıkmadıysa gerçek değer %100 değil, sadece çok küçük: alt sınır olarak gösterilir.
    return { atLeast1: 1 - none / runs, sure: none === 0, mean: sum / runs, count, dist, expNet: paySum / runs - count, full: full.length, loose: loose.length };
  }

  const money = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('tr-TR')}`;

  // Kaç kupon tutarsa ne olur: olasılığı %0.5'ten küçük satırlar gösterilmez.
  const pctText = (p) => (p >= 99.95 ? '%99.9 üstü' : p >= 0.1 ? `%${p.toFixed(1)}` : '%0.1 altı');
  const signCls = (v) => (v > 0 ? 'is-ok' : v < 0 ? 'is-bad' : '');

  // Üstteki dört kutucuk: olasılık, ortalama tutan, toplam tutar, ortalama sonuç.
  function tilesHtml(res) {
    if (!res) return '<div class="kx-tiles"><div class="kx-tile"><span>1 veya daha fazlası gelir</span><b>hesaplanamadı</b></div></div>';
    const pct = res.sure || res.atLeast1 >= 0.999 ? '%99.9 üstü' : `%${(res.atLeast1 * 100).toFixed(1)}`;
    const exp = res.expNet * multiStake;
    return `<div class="kx-tiles">`
      + `<div class="kx-tile kx-tile--main"><span>1 veya daha fazlası gelir</span><b>${pct}</b><small>olasılık</small></div>`
      + `<div class="kx-tile"><span>Ortalama tutan kupon</span><b>${res.mean.toFixed(1)}<em> / ${res.count}</em></b><small>20.000 denemenin ortalaması</small></div>`
      + `<div class="kx-tile"><span>Toplam tutar</span><b>${(res.count * multiStake).toLocaleString('tr-TR')}</b><small>kupon başına ${multiStake.toLocaleString('tr-TR')}</small></div>`
      + `<div class="kx-tile"><span>Ortalama sonuç</span><b class="${signCls(exp)}">${money(exp)}</b><small>bütün denemelerin ortalaması</small></div>`
      + '</div>';
  }

  // Kaç kupon gelirse: olasılık "en az k", tutar iki türlü: en kötü (en düşük oranlı k kupon tam gelir) ve ortalama
  // (denemelerde tam k kupon gelince ortalama). Satırlar iki sütuna bölünür, her sütunun kendi başlığı var.
  function plBodyHtml(res) {
    let tail = res.dist.reduce((t, x) => t + x.p, 0);
    const rows = res.dist.map((x) => {
      const atLeast = x.k ? tail : res.dist[0].p;
      tail -= x.p;
      const p = atLeast * 100;
      const worst = (x.k ? x.min : x.net) * multiStake;
      const avg = x.net * multiStake;
      const best = (x.k ? x.max : x.net) * multiStake;
      const tip = x.k
        ? `En az ${x.k} kuponun gelme olasılığı ${pctText(p)}. Tam ${x.k} kupon gelirse: en kötü ${money(worst)}, ortalama ${money(avg)}, en iyi ${money(best)}.`
        : `Hiçbir kuponun gelmeme olasılığı ${pctText(p)}.`;
      return `<div class="kx-row${p < 0.1 ? ' is-rare' : ''}" title="${esc(tip)}"><span class="kx-k">${x.k ? `en az ${x.k}` : 'hiçbiri'}</span>`
        + `<span class="kx-prob"><i style="width:${Math.max(1, Math.min(100, p)).toFixed(1)}%"></i><em>${pctText(p)}</em></span>`
        + `<b class="${signCls(worst)}">${money(worst)}</b><b class="${signCls(avg)}">${money(avg)}</b></div>`;
    });
    const head = '<div class="kx-row kx-row--head"><span>Gelen</span><span>Olasılık (en az)</span><span>En kötü</span><span>Ortalama</span></div>';
    const half = Math.ceil(rows.length / 2);
    const cols = rows.length > 8 ? [rows.slice(0, half), rows.slice(half)] : [rows];
    return `<div class="kx-pl-cols">${cols.map((c) => `<div class="kx-pl-col">${head}${c.join('')}</div>`).join('')}</div>`;
  }

  function plHtml(res) {
    return `<div class="kx-pl"><div class="kx-pl-head"><label>Kupon başına <input class="kcs-input kcs-stake-input" inputmode="decimal" value="${multiStake}" aria-label="Kupon başına tutar"></label>`
      + '<span>Olasılık: en az o kadar kuponun gelmesi. En kötü: gelenler en düşük oranlı kuponlar olursa. Ortalama: tam o kadar kupon gelince denemelerin ortalaması.</span></div>'
      + `<div class="kx-pl-body">${plBodyHtml(res)}</div></div>`;
  }

  // Tutar yazılınca (Enter ya da kutudan çıkınca) hesap yeniden gösterilir.
  // Kutu shadow DOM içinde: 'change' olayı oradan dışarı çıkmaz (composed değil), belgede hiç duyulmuyordu.
  // Enter ve kutudan çıkma (focusout) dışarı çıkar: Enter kutuyu bırakır, bırakınca hesap güncellenir.
  function onStakeKey(ev) {
    const input = targetOf(ev);
    if (ev.key === 'Enter' && input.matches?.('.kcs-stake-input')) { ev.preventDefault(); input.blur(); }
    if (ev.key === 'Escape' && peekOpen.size) closePeek();
  }
  function onStakeOut(ev) {
    const input = targetOf(ev);
    if (input.matches?.('.kcs-stake-input')) setTimeout(() => onStakeChange(input), 0);
  }

  // Yazarken hesap kendiliğinden güncellenir: kutu yeniden çizilmez (imleç kaybolmasın), sadece sonuç satırları değişir.
  let stakeTimer = null;
  function onStakeInput(ev) {
    const input = targetOf(ev);
    if (!input.matches?.('.kcs-stake-input')) return;
    clearTimeout(stakeTimer);
    stakeTimer = setTimeout(() => {
      const v = parseStake(input.value);
      const res = chanceMemo.res;
      const wrap = input.closest('.kcs-bar-chance');
      if (!(v > 0) || !res || !wrap) return;
      multiStake = v;
      const tpl = document.createElement('template');
      tpl.innerHTML = tilesHtml(res);
      wrap.querySelector('.kx-tiles')?.replaceWith(tpl.content.firstElementChild);
      const body = wrap.querySelector('.kx-pl-body');
      if (body) body.innerHTML = plBodyHtml(res);
      // Şerit sonraki çizimde yeni tutarla baştan çizilsin.
      const box = wrap.closest('.kcs-info');
      if (box) box.__kcsHtml = null;
      if (hasStore) chrome.storage.local.set({ multiStake });
    }, 250);
  }

  // 1.000 gibi binlik ayraçlı yazım da kabul edilir; virgül ondalıktır.
  function parseStake(value) {
    const raw = String(value).trim().replace(/\s/g, '');
    return Number(/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(',', '.'));
  }

  async function onStakeChange(input) {
    const v = parseStake(input.value);
    if (!(v > 0)) { input.value = multiStake; return; }
    multiStake = v;
    renderInfo();
    if (hasStore) await chrome.storage.local.set({ multiStake });
  }

  // Birbirine bağlı kuponlar: aynı maç birden çok kuponda. O maç bütün bu kuponları birlikte etkiler;
  // bir kuponda Alt, diğerinde Üst ise aynı maç ters yönde oynanmış olur.
  function linkInfo(all) {
    const byMatch = new Map();
    for (const c of all) {
      for (const leg of c.legs) {
        if (!byMatch.has(leg.k)) byMatch.set(leg.k, { label: leg.label, cs: [] });
        const g = byMatch.get(leg.k);
        if (!g.cs.includes(c)) g.cs.push(c);
      }
    }
    const shared = [...byMatch.values()].filter((g) => g.cs.length > 1).sort((a, b) => b.cs.length - a.cs.length);
    const linked = new Set(shared.flatMap((g) => g.cs));
    const btn = all.length > 1 ? `<button type="button" class="kcs-pl-toggle kcs-link-toggle${linkOpen ? '' : ' is-closed'}" aria-expanded="${linkOpen}">Bağlı kuponlar <span class="kcs-count">${linked.size}</span><i class="kcs-ci-chev"></i></button>` : '';
    const side = (c) => c.sideText || `${c.line} ${c.side === 'alt' ? 'Alt' : 'Üst'}`;
    const rows = shared.map((g) => {
      const opposite = g.cs.some((c) => c.side === 'alt') && g.cs.some((c) => c.side !== 'alt');
      const cps = g.cs.map((c) => `<span class="kcs-link-cp"><span>${esc(c.title)}</span><b class="kcs-link-side--${c.sideText ? 'mix' : c.side === 'alt' ? 'alt' : 'ust'}">${esc(side(c))}</b></span>`).join('');
      return `<div class="kcs-link-row"><div class="kcs-link-head"><b>${esc(g.label)}</b><span>${g.cs.length} kuponda</span>${opposite ? '<em>Ters yön: aynı maç hem Alt hem Üst kuponda</em>' : ''}</div><div class="kcs-link-cps">${cps}</div></div>`;
    }).join('');
    const head = shared.length
      ? `<div class="kcs-pl-note">${shared.length} maç birden çok kuponda, ${linked.size} kupon birbirine bağlı. Bu maçlardan biri bütün bağlı kuponları birlikte etkiler.</div>`
      : '<div class="kcs-pl-note">Ortak maçı olan kupon yok, kuponlar birbirinden bağımsız.</div>';
    return { btn, body: `<div class="kcs-link-list">${head}${rows}</div>` };
  }

  let chanceMemo = { sig: null, html: '' };
  function multiChanceHtml() {
    const list = [];
    let skipped = 0;
    const fromOdds = new Set();
    const fromNote = new Set();
    const all = []; // bağlı kupon bilgisi için: verisi olmayan kuponlar da
    let legCards = 0;
    for (const card of queryAll(SPECIAL_CARD)) {
      if (/KAPANDI/i.test(card.querySelector('.sb-cbt-action')?.textContent || '')) continue;
      const multi = readMulti(card);
      if (!multi) {
        const lc = readLegsCard(card);
        if (!lc || lc.legs.length < 2) continue;
        const ps = lc.legs.map((leg) => legProb(leg, legEvent(leg)));
        const p = ps.every((x) => x != null) ? ps.reduce((t, x) => t * x, 1) : null;
        all.push({ title: lc.title, sideText: lc.legs.map((l) => `${l.line} ${l.side === 'under' ? 'Alt' : 'Üst'}`).join(' / '), legs: lc.legs.map((leg) => ({ k: norm(leg.label), label: leg.label })) });
        if (p == null) skipped++;
        else { legCards++; list.push({ legs: [{ k: `kart|${lc.title}`, l: null }], line: 0, side: '', odds: lc.odds, p: Math.min(0.9999, Math.max(0.0001, p)) }); }
        continue;
      }
      const legs = multi.legs.map((leg) => {
        const k = norm(leg.label);
        const odd = legInfo(leg).l;
        if (odd != null) { fromOdds.add(k); return { k, l: odd }; }
        const n = Number(notesMap.get(k)?.lambda);
        if (n > 0) { fromNote.add(k); return { k, l: n }; }
        return { k, l: null };
      });
      all.push({ title: multi.title, line: multi.line, side: multi.side, legs: multi.legs.map((leg) => ({ k: norm(leg.label), label: leg.label })) });
      const p = Number(cardNote(multi.title)?.prob);
      const c = { legs, line: multi.line, side: multi.side, odds: multi.odds, p: p > 0 && p < 100 ? p / 100 : null };
      if (!c.legs.every((x) => x.l > 0) && c.p == null) skipped++; else list.push(c);
    }
    if (!list.length && !skipped) return '';
    const sig = JSON.stringify([list, skipped, fromOdds.size, fromNote.size, multiStake, features.pl, features.link, all]);
    if (sig === chanceMemo.sig) return chanceMemo.html;
    const res = multiChance(list);
    const pct = !res ? 'hesaplanamadı' : (res.sure || res.atLeast1 >= 0.999 ? '%99.9 üstü' : `%${(res.atLeast1 * 100).toFixed(1)}`);
    const mean = res ? `<span class="kcs-chance-mean">ortalama <b>${res.mean.toFixed(1)}</b> / ${res.count} kupon tutar</span>` : '';
    const parts = [`${list.length + skipped} kupon`, `${fromOdds.size} maç oranlardan`, fromNote.size && `${fromNote.size} maç analizden`,
      legCards && `${legCards} kupon skor ve çizgiden`, res?.loose - legCards > 0 && `${res.loose - legCards} kupon kendi olasılığıyla`, skipped && `${skipped} kuponun verisi yok, sayılmadı`].filter(Boolean);
    const link = linkInfo(all);
    const tip = 'Tahmindir, garanti değildir. Aynı maç birden çok kuponda varsa birlikte sayıldı; goller Poisson ile 20.000 kez denendi. Başlamış maçlarda oran canlı değişir.';
    const plBtn = '';
    const html = `<section class="kcs-bar-chance kx-multi"><div class="kx-multi-head"><div class="kx-multi-title" title="${esc(tip)}"><b>${markHtml()}Çok maçlı kuponlar</b><small>${esc(parts.join(' · '))}</small></div><div class="kx-multi-actions">${plBtn}</div></div>`
      + `${features.pl ? `${tilesHtml(res)}${res ? plHtml(res) : ''}` : ''}${features.link ? link.body : ''}</section>`;
    // İkisi de kapalıysa bölüm hiç çizilmez; sadece bağlı kuponlar açıksa başlık ve liste kalır.
    if (!features.pl && !features.link) { chanceMemo = { sig, html: '', res }; return ''; }
    chanceMemo = { sig, html, res };
    return html;
  }

  function infoHtml() {
    const times = BOOKS.map((b) => {
      if (!bookConnected(b.key)) return `${b.name} kapalı`;
      const at = lastOddsAt(b.key);
      return `${b.name} ${at ? new Date(at).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' }) : 'oran yok'}`;
    }).join(' · ');
    const open = BOOKS.some((b) => bookConnected(b.key));
    const busy = open && Date.now() < refreshUntil;
    const label = busy ? 'Yenileniyor…' : 'Yenile';
    const sorts = [['site', 'Site'], ['arb', 'Arbitraj'], ['start', 'Saat'], ['both', 'Saat + Arbitraj'], ['manual', 'Elle']]
      .map(([k, label]) => `<button type="button" class="kcs-sort-btn${cardSort === k ? ' is-on' : ''}" data-sort="${k}">${label}</button>`).join('');
    // Filtre düğmelerinde kaç kart olduğu: sayfadaki tüm kartlar sayılır, gizliler de.
    const cards = queryAll(SPECIAL_CARD);
    const multiN = cards.filter(specialIsMulti).length;
    const counts = { all: cards.length, single: cards.length - multiN, multi: multiN };
    const shows = [['all', 'Tümü'], ['single', 'Tek maç'], ['multi', 'Çok maç']]
      .map(([k, label]) => `<button type="button" class="kcs-show-btn kcs-sort-btn${cardShow === k ? ' is-on' : ''}" data-show="${k}">${label}<span class="kcs-count">${counts[k]}</span></button>`).join('');
    const refresh = `<button type="button" class="kcs-refresh${busy ? ' is-busy' : ''}"${busy || !open ? ' disabled' : ''} title="${open ? 'Oranları yenile' : 'Yenilemek için 1xBet ya da Stake sekmesini aç'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/></svg>${label}</button>`;
    const syncText = [notesAt && `Maç bilgileri ${noteTime(notesAt)}`, times].filter(Boolean).join(' · ');
    const warn = warnIcon('Oranlar her an değişebilir. Oynamadan önce maçı ve oranı sitede kontrol et.');
    const head = `${updateHtml()}<header class="kx-head"><div class="kx-brand">${markHtml()}<div><b>KOKLEYİCİ SPORTS</b></div></div>`
      + `<div class="kx-sources">${sitesHtml()}</div><div class="kx-sync"><span>${esc(syncText)}</span>${warn}${features.arb ? refresh : ''}</div></header>`;
    const showTxt = `${{ all: 'Tümü', single: 'Tek maç', multi: 'Çok maç' }[cardShow] || 'Tümü'} <em>${counts[cardShow] ?? counts.all}</em>`;
    const sortTxt = { site: 'Site', arb: 'Arbitraj', start: 'Saat', both: 'Saat + Arbitraj', manual: 'Elle' }[cardSort] || 'Site';
    const group = (name, body) => `<div class="kx-group"><span class="kx-label">${name}</span>${body}</div>`;
    void group;
    if (!features.arb) return `${head}<div class="kx-controls">${ddHtml('s-feat', 'Özellikler', featSum(true), featHtml(true))}</div>`;
    return `${head}<div class="kx-controls">${ddHtml('s-show', 'Göster', showTxt, `<span class="kcs-seg">${shows}</span>`)}${ddHtml('s-sort', 'Sırala', sortTxt, `<span class="kcs-seg">${sorts}</span>`)}`
      + `${ddHtml('s-group', 'Grupla', GROUP_TXT[groupSpecial] || 'Yok', groupHtml('special', groupSpecial))}${ddHtml('s-cols', 'Satır başı', colsTxt(colsSpecial), colsHtml('special', colsSpecial), true)}`
      + `${ddHtml('s-feat', 'Özellikler', featSum(true), featHtml(true))}${wideHtml()}<button type="button" class="kcs-fold-all">${foldAll ? 'Tümünü aç' : 'Tümünü küçült'}</button></div>`
      + multiChanceHtml()
      + `<footer class="kx-warn" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>Oranlar her an değişebilir. Oynamadan önce maçı ve oranı sitede kontrol et.</footer>`;
  }

  function applySpecialCols() {
    const grid = queryOne('.sb-custom-bets-grid');
    if (!grid) return;
    const root = grid.getRootNode();
    let st = root.querySelector('style[data-kcs-cols]');
    if (!colsSpecial) { st?.remove(); return; }
    const css = `.sb-custom-bets-grid{display:grid!important;grid-template-columns:repeat(${colsSpecial},minmax(0,1fr))!important;align-items:start}`;
    if (!st) { st = document.createElement('style'); st.dataset.kcsCols = '1'; root.append(st); }
    if (st.textContent !== css) st.textContent = css;
  }

  // Tam genişlik: 6q içeriği ortada en fazla 1200px + 6vw genişlikte tutuyor, iki yanda boşluk kalıyor.
  // Açıkken bu sınır kalkar (kenarda 40px pay kalır). Sadece 6q spor sayfalarında, sayfanın kendi stiline eklenir.
  function applyFullWidth() {
    if (!/(^|\.)6q\.net$/.test(location.hostname)) return;
    let st = document.getElementById('kcs-fullwidth');
    if (!fullWidth) { st?.remove(); return; }
    if (!st) {
      st = document.createElement('style');
      st.id = 'kcs-fullwidth';
      st.textContent = '[class*="max-w-[calc(1200px+6vw)]"]{max-width:none!important}';
      (document.head || document.documentElement).append(st);
    }
  }
  const groupHtml = (page, val) => `<span class="kcs-seg">${[['none', 'Yok'], ['single', 'Tekli önce'], ['multi', 'Çoklu önce']]
    .map(([k, label]) => `<button type="button" class="kcs-group-btn${val === k ? ' is-on' : ''}" data-page="${page}" data-group="${k}">${label}</button>`).join('')}</span>`;
  // Elle sıralamada her kuponun üstünde taşıma düğmeleri.
  const moveHtml = (page) => `<div class="kcs-move"><span>Sıra</span><button type="button" class="kcs-move-btn" data-page="${page}" data-move="top" title="En üste al">En üste</button>`
    + `<button type="button" class="kcs-move-btn" data-page="${page}" data-move="up" title="Bir yukarı">↑</button><button type="button" class="kcs-move-btn" data-page="${page}" data-move="down" title="Bir aşağı">↓</button>`
    + `<button type="button" class="kcs-move-btn" data-page="${page}" data-move="bottom" title="En alta al">En alta</button></div>`;
  const wideHtml = () => `<button type="button" class="kcs-wide-btn${fullWidth ? ' is-on' : ''}" aria-pressed="${fullWidth}" title="Sayfa ekranın tamamını kaplasın"><i></i>Tam genişlik</button>`;

  // Satır başına kupon seçimi (iki sayfada da).
  function colsHtml(page, val) {
    return `<span class="kcs-seg">${[[0, 'Site'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']]
      .map(([k, label]) => `<button type="button" class="kcs-cols-btn${val === k ? ' is-on' : ''}" data-page="${page}" data-cols="${k}" title="${k ? `Satırda ${k} kupon` : 'Sitenin kendi düzeni'}">${label}</button>`).join('')}</span>`;
  }

  function renderInfo() {
    applyFullWidth();
    applySpecialCols();
    const grid = queryOne('.sb-custom-bets-grid');
    let box = queryOne('.kcs-info');
    if (!grid) { box?.remove(); return; }
    // Stil dosyası kartlara kutu eklenince bağlanıyordu; futbol dışı kartlar (kutu yok) varken panel stilsiz kalıyordu.
    styleRoot(grid.getRootNode());
    if (!box) {
      box = document.createElement('div');
      box.className = 'kcs-info kx';
      grid.parentElement.insertBefore(box, grid);
    }
    const active = box.getRootNode().activeElement;
    if (active && box.contains(active) && active.matches('.kcs-stake-input')) return;
    const html = infoHtml();
    if (box.__kcsHtml !== html) { box.innerHTML = html; box.__kcsHtml = html; }
  }

  const SLICE_MS = 12;
  let specialsRun = 0;

  // 6q yaklaşık yarım dakikada bir kart listesinin tamamını silip yeniden koyuyor (ölçüldü). O an eklentinin kutuları
  // ve üst şerit kaybolur, sayfa kısalır, tarayıcı kaydırmayı yukarı iter; eklenti 300 ms sonra geri çizer. Bunu
  // önlemek için her kartın son kutusu saklanır ve değişiklik gözlemcisinde, ekran çizilmeden önce aynen geri konur
  // (sıra ve göster/gizle dahil). Asıl yeniden çizim sonra her zamanki gibi gelir.
  const boxCache = new Map();
  // Bahislerim kartları: kart adı + aynı addaki sırası (aynı maça birden çok kupon olabilir).
  const sbCache = new Map();
  let sbKeyMap = new Map();
  function sbKeyOf(card) {
    if (!sbKeyMap.has(card)) sbKeyMap = new Map(cardsKeyed().filter((x) => x.el.matches(SB_BET)).map((x) => [x.el, x.key]));
    return sbKeyMap.get(card);
  }
  function quickRestore() {
    let restored = 0;
    for (const card of queryAll(SB_BET)) {
      if (card.querySelector(':scope > .kcs-legs')) continue;
      const c = sbCache.get(sbKeyOf(card));
      if (!c) continue;
      const box = document.createElement('div');
      box.className = 'kcs-legs kcs-legs--sb';
      box.innerHTML = c.html;
      box.__kcsHtml = c.html;
      box.__kcsKey = c.key;
      for (const sec of box.querySelectorAll('.kcs-ci')) {
        const id = sec.querySelector(':scope > .kcs-fold')?.dataset.fold;
        if (id) sec.classList.toggle('is-closed', isClosed(id, c.key));
      }
      styleRoot(card.getRootNode());
      card.append(box);
      restored++;
    }
    if ((sbSort !== 'site' || colsBets) && queryOne('.sb-mb-grid')) applySbSort();
    for (const card of queryAll(SPECIAL_CARD)) {
      if (card.querySelector(':scope > .kcs-arb-wrap')) continue;
      const key = specialKey(card);
      const c = boxCache.get(key);
      if (!c) continue;
      const box = document.createElement('div');
      box.className = c.cls;
      box.innerHTML = c.html;
      box.__kcsHtml = c.html;
      box.__kcsKey = c.kcsKey;
      box.__kcsSp = c.sp;
      // Aç/kapa durumu kutu çizildikten sonra değişmiş olabilir.
      for (const sec of box.querySelectorAll('.kcs-ci')) {
        const id = sec.querySelector(':scope > .kcs-fold')?.dataset.fold;
        if (id) sec.classList.toggle('is-closed', isClosed(id, c.kcsKey));
      }
      styleRoot(card.getRootNode());
      card.append(box);
      if (c.ticket) card.classList.add('kcs-ticket');
      const shown = cardShow === 'all' || (cardShow === 'multi') === c.isMulti;
      card.style.display = shown ? '' : 'none';
      if (cardSort !== 'site' && orderMap.has(key)) card.style.order = String(orderMap.get(key));
      restored++;
    }
    if (restored && !queryOne('.kcs-info')) renderInfo();
    // Bahislerim üst paneli: site sayfayı yeniden kurunca panel de silinir, ekran çizilmeden geri konur.
    if (queryOne('.sb-bets-view-head') && !queryOne('.kcs-status')) renderStatus();
    return restored;
  }


  // ---------- basketbol: Göz at penceresi ----------
  const PEEK_TABS_BK = [['genel', 'Genel'], ['akis', 'Canlı akış'], ['ist', 'İstatistik'], ['fark', 'Skor farkı'], ['h2h', 'Karşılaşmalar'], ['puan', 'Puan durumu'], ['kadro', 'Oyuncular']];
  const bkLogo = (url, cls = '') => (logoSrc(url) ? `<img${cls ? ` class="${cls}"` : ''} src="${esc(logoSrc(url))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '');
  const bkTeamLogo = (abbr) => (abbr ? `https://a.espncdn.com/i/teamlogos/nba/500/${abbr.toLowerCase()}.png` : '');
  const bkPeriod = (p) => (p <= 4 ? `${p}. çeyrek` : `Uzatma${p > 5 ? ` ${p - 4}` : ''}`);
  const bkPeriodShort = (p) => (p <= 4 ? `Ç${p}` : `U${p - 4}`);
  // Saat "6:48" ya da son dakikada "45.3" (saniye)
  const bkLeft = (clock) => {
    const s = String(clock || '');
    if (s.includes(':')) { const [m, sec] = s.split(':').map(Number); return (m || 0) + (sec || 0) / 60; }
    return (parseFloat(s) || 0) / 60;
  };
  const bkElapsed = (period, clock) => (period <= 4 ? (period - 1) * 12 + (12 - bkLeft(clock)) : 48 + (period - 5) * 5 + (5 - bkLeft(clock)));

  // Oyun yazısının Türkçesi: "X makes 24-foot three point jumper (Y assists)" → oyuncu, atış türü, asist.
  function bkShot(desc) {
    const d = desc.toLowerCase();
    const ft = /free throw (?:- )?(\d) of (\d)/.exec(d);
    if (ft) return `serbest atış ${ft[1]}/${ft[2]}`;
    if (/free throw/.test(d)) return /technical/.test(d) ? 'teknik serbest atış' : 'serbest atış';
    const kind = /three point/.test(d) ? 'üçlük' : /dunk/.test(d) ? 'smaç' : /layup|finger roll/.test(d) ? 'turnike' : /hook/.test(d) ? 'kanca' : /tip/.test(d) ? 'tip-in' : /alley oop/.test(d) ? 'alley-oop' : 'şut';
    const ft2 = /(\d+)-foot/.exec(d);
    return ft2 ? `${kind} (${Math.max(1, Math.round(Number(ft2[1]) * 0.3048))} m)` : kind;
  }
  function bkPlayText(p) {
    const m = /^(.+?) (makes|misses) (.+?)(?: \((.+?) assists\))?$/.exec(p.text);
    if (m) return { who: m[1], what: `${m[2] === 'makes' ? '' : 'Kaçtı · '}${bkShot(m[3])[0].toLocaleUpperCase('tr-TR')}${bkShot(m[3]).slice(1)}`, assist: m[4] || '' };
    if (/End Period|End Game/i.test(p.type)) return { who: '', what: /End Game/i.test(p.type) ? 'Maç bitti' : `${bkPeriod(p.period)} bitti`, assist: '' };
    if (/Technical/i.test(p.type)) return { who: p.text.replace(/ technical foul.*$/i, ''), what: 'Teknik faul', assist: '' };
    if (/Flagrant/i.test(p.type)) return { who: p.text.replace(/ flagrant foul.*$/i, ''), what: 'Sert faul (flagrant)', assist: '' };
    if (/Challenge/i.test(p.type)) return { who: '', what: /Overturned/i.test(p.type) ? 'Koç itirazı · karar değişti' : 'Koç itirazı · karar aynı', assist: '' };
    if (/Ejection/i.test(p.type)) return { who: p.text.replace(/ ejected.*$/i, ''), what: 'Oyundan atıldı', assist: '' };
    return null;
  }

  function bkHead(fx) {
    const sc = fx.score ? `${fx.score.home} - ${fx.score.away}` : 'v';
    const live = PEEK_LIVE.has(fx.status);
    const when = fx.kickoffAt ? new Date(fx.kickoffAt).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const sub = live ? `${fx.stateLabel || 'Canlı'} · canlı` : fx.status === 'NOT_STARTED' ? `${when}${fx.kickoffAt ? countdownHtml(Date.parse(fx.kickoffAt) / 1000) : ''}` : esc(fx.stateLabel || '');
    return `<div class="kcs-peek-head"><b>${esc(fx.home?.name || '')}${bkLogo(fx.home?.logoUrl)}</b><span>${sc}</span><b>${bkLogo(fx.away?.logoUrl)}${esc(fx.away?.name || '')}</b>`
      + `<em>${live ? esc(sub) : sub}${fx.home?.record || fx.away?.record ? ` · ${esc(fx.home?.record || '?')} / ${esc(fx.away?.record || '?')}` : ''}</em></div>`;
  }

  function bkGenel(d) {
    const fx = d.detail.fixture;
    const q = fx.quarters || [];
    let quarters = '';
    if (q.length) {
      const heads = q.map((_, i) => `<span>${bkPeriodShort(i + 1)}</span>`).join('');
      const row = (t, k) => `<div class="kcs-bkq-row"><span class="kcs-bkq-team">${bkLogo(t.logoUrl)}<b>${esc(t.shortCode || t.name)}</b></span>${q.map((x) => `<span>${x[k] ?? '-'}</span>`).join('')}<strong>${fx.score ? fx.score[k ? 'away' : 'home'] : '-'}</strong></div>`;
      quarters = `<div class="kcs-bkq" style="--n:${q.length}"><div class="kcs-bkq-row is-head"><span></span>${heads}<strong>T</strong></div>${row(fx.home, 0)}${row(fx.away, 1)}</div>`;
    }
    const total = fx.score ? fx.score.home + fx.score.away : null;
    const inf = d.info || {};
    const rows = [
      ['sira', 'Toplam sayı', total != null ? `${total}${inf.line?.ou ? ` · çizgi ${inf.line.ou}` : ''}` : ''],
      ['h2h', 'Bahis çizgisi', inf.line && (inf.line.ou || inf.line.details) ? [inf.line.ou && `Toplam ${inf.line.ou}`, inf.line.details && `Handikap ${inf.line.details}`].filter(Boolean).join(' · ') : ''],
      ['ist', 'Kazanma olasılığı', inf.homeWin != null ? `${esc(fx.home.name)} %${inf.homeWin} · ${esc(fx.away.name)} %${100 - inf.homeWin}` : ''],
      ['stad', 'Salon', inf.venue ? `${esc(inf.venue)}${inf.attendance ? ` · ${Number(inf.attendance).toLocaleString('tr-TR')} seyirci` : ''}` : ''],
      ['ref', 'Hakemler', inf.officials?.length ? esc(inf.officials.join(', ')) : ''],
      ['tv', 'Yayın', inf.tv?.length ? esc(inf.tv.join(', ')) : ''],
      ['coach', 'Sezon serisi', d.series?.summary ? esc(bkSeriesText(d.series, fx)) : ''],
    ].filter(([, , v]) => v);
    const info = `<div class="kcs-peek-info kcs-peek-info--ic">${rows.map(([icon, k, v]) => `<div><i class="kcs-info-ic">${PEEK_ICON[icon] || ''}</i><span>${k}</span><b>${v}</b></div>`).join('')}</div>`;
    const CAT = { points: 'Sayı', rebounds: 'Ribaund', assists: 'Asist', Points: 'Sayı', Rebounds: 'Ribaund', Assists: 'Asist' };
    const lead = (d.leaders || []).map((t) => {
      const team = String(t.teamId) === String(fx.home.id) ? fx.home : fx.away;
      return `<div class="kcs-bkl${team === fx.away ? ' is-away' : ''}"><div class="kcs-bkl-team">${bkLogo(team.logoUrl)}<b>${esc(team.name)}</b></div>`
        + t.list.filter((x) => x.name).map((x) => `<div class="kcs-bkl-row">${x.photo ? `<img src="${esc(logoSrc(x.photo))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<i></i>'}<span>${esc(x.name)}<small>${CAT[x.cat] || esc(x.cat)}</small></span><strong>${esc(x.value)}</strong></div>`).join('') + '</div>';
    }).join('');
    return `${quarters}${lead ? `<div class="kcs-bkl-wrap">${lead}</div>` : ''}${info}`;
  }
  function bkSeriesText(s, fx) {
    const done = s.events.filter((e) => e.done);
    let h = 0; let a = 0;
    for (const e of done) { const w = e.teams.find((t) => t.winner); if (!w) continue; if (String(w.id) === String(fx.home.id)) h++; else a++; }
    return done.length ? `${fx.home.name} ${h} - ${a} ${fx.away.name} (${s.events.length} maçlık seri)` : `Bu sezon ilk karşılaşma (${s.events.length} maçlık seri)`;
  }

  function bkFeed(d) {
    const fx = d.detail.fixture;
    const homeId = String(fx.home.id);
    const plays = d.plays.filter((p) => p.scoring || /End Period|End Game|Technical|Flagrant|Challenge|Ejection/i.test(p.type));
    if (!plays.length) return '<div class="kcs-peek-empty">Henüz sayı yok.</div>';
    let lastPeriod = 0;
    const out = [];
    for (const p of plays) {
      const t = bkPlayText(p);
      if (!t) continue;
      if (p.period !== lastPeriod) { lastPeriod = p.period; out.push(`<div class="kcs-tl-sep"><span>${bkPeriod(p.period)}</span></div>`); }
      if (/End Period|End Game/i.test(p.type)) { out.push(`<div class="kcs-tl-sep kcs-tl-sep--end"><span>${esc(t.what)} · ${p.hs}-${p.as}</span></div>`); continue; }
      const side = p.teamId != null && String(p.teamId) !== homeId ? 'away' : 'home';
      const team = side === 'away' ? fx.away : fx.home;
      const pts = p.scoring ? `<span class="kcs-bk-pts kcs-bk-pts--${p.value}">+${p.value}</span>` : `<span class="kcs-bk-pts kcs-bk-pts--x">!</span>`;
      const score = p.scoring ? `<i class="kcs-tl-score">${p.hs}-${p.as}</i>` : '';
      const card = `<div class="kcs-tl-card"><em>${esc(p.clock)}</em><span class="kcs-tl-ic">${pts}</span><div class="kcs-tl-body"><b>${esc(t.who || team.name)}${score}</b>`
        + `<span>${esc(t.what)}${t.assist ? ` · Asist: ${esc(t.assist)}` : ''}</span></div><u>${esc(team.shortCode || '')}</u></div>`;
      out.push(`<div class="kcs-tl-row kcs-tl-row--${side}">${side === 'home' ? `${card}<i class="kcs-tl-dot"></i><span></span>` : `<span></span><i class="kcs-tl-dot"></i>${card}`}</div>`);
    }
    return `<div class="kcs-tl-head">Sayılar ve önemli anlar · saat çeyrekte kalan süre</div><div class="kcs-tl-scroll"><div class="kcs-tl">${out.join('')}</div></div>`;
  }

  const BK_STATS = [
    ['fieldGoalsMade-fieldGoalsAttempted', 'Saha içi (isabet-deneme)'], ['fieldGoalPct', 'Saha içi %'],
    ['threePointFieldGoalsMade-threePointFieldGoalsAttempted', 'Üçlük'], ['threePointFieldGoalPct', 'Üçlük %'],
    ['freeThrowsMade-freeThrowsAttempted', 'Serbest atış'], ['freeThrowPct', 'Serbest atış %'],
    ['totalRebounds', 'Ribaund'], ['offensiveRebounds', 'Hücum ribaundu'], ['assists', 'Asist'], ['steals', 'Top çalma'], ['blocks', 'Blok'],
    ['totalTurnovers', 'Top kaybı'], ['pointsInPaint', 'Boyalı alan sayısı'], ['fastBreakPoints', 'Hızlı hücum sayısı'], ['turnoverPoints', 'Top kaybından sayı'],
    ['largestLead', 'En büyük fark'], ['leadChanges', 'Önde olan değişimi'], ['fouls', 'Faul'],
  ];
  function bkStats(d) {
    const fx = d.detail.fixture;
    const H = d.teamStats?.[fx.home.id] || {};
    const A = d.teamStats?.[fx.away.id] || {};
    const rows = BK_STATS.map(([k, label]) => {
      if (H[k] == null && A[k] == null) return '';
      const pct = /Pct$/.test(k);
      const na = parseFloat(H[k]) || 0;
      const nb = parseFloat(A[k]) || 0;
      const w = na + nb ? Math.round((na / (na + nb)) * 100) : 50;
      return `<div class="kcs-stat"><b>${esc(String(H[k] ?? 0))}${pct ? '%' : ''}</b><span>${label}</span><b>${esc(String(A[k] ?? 0))}${pct ? '%' : ''}</b>`
        + `<div class="kcs-stat-bar"><i style="width:${w}%"></i><u style="width:${100 - w}%"></u></div></div>`;
    }).join('');
    return rows ? `<div class="kcs-pitch-legend"><span class="is-home">${esc(fx.home.name)}</span><span class="is-away">${esc(fx.away.name)}</span></div>${rows}` : '<div class="kcs-peek-empty">İstatistik maç başlayınca gelir.</div>';
  }

  // Skor farkı: maç boyunca ev sahibinin farkı (üst yarı ev sahibi önde, alt yarı deplasman önde). Çizgi soldan sağa çizilir.
  function bkFark(d) {
    const fx = d.detail.fixture;
    const pts = d.plays.filter((p) => p.scoring && p.hs != null).map((p) => ({ t: bkElapsed(p.period, p.clock), m: p.hs - p.as, p }));
    if (!pts.length) return '<div class="kcs-peek-empty">Maç başlayınca skor farkı çizilir.</div>';
    const maxP = Math.max(4, fx.period || 4, ...pts.map((x) => x.p.period));
    const T = maxP <= 4 ? 48 : 48 + (maxP - 4) * 5;
    const M = Math.max(8, ...pts.map((x) => Math.abs(x.m)));
    const W = 600;
    const H = 200;
    const X = (t) => ((t / T) * W).toFixed(1);
    const Y = (m) => (H / 2 - (m / M) * (H / 2 - 12)).toFixed(1);
    const line = `M0,${H / 2} ${pts.map((x) => `L${X(x.t)},${Y(x.m)}`).join(' ')}`;
    const area = `${line} L${X(pts[pts.length - 1].t)},${H / 2} Z`;
    const grid = [12, 24, 36, ...Array.from({ length: Math.max(0, maxP - 4) }, (_, i) => 48 + i * 5)].map((t) => `<line x1="${X(t)}" y1="0" x2="${X(t)}" y2="${H}" class="kcs-fark-q"/>`).join('');
    const labels = Array.from({ length: maxP }, (_, i) => { const s = i < 4 ? i * 12 : 48 + (i - 4) * 5; const e = i < 4 ? s + 12 : s + 5; return `<span style="left:${((s + e) / 2 / T) * 100}%">${bkPeriodShort(i + 1)}</span>`; }).join('');
    const hiH = Math.max(0, ...pts.map((x) => x.m));
    const hiA = Math.max(0, ...pts.map((x) => -x.m));
    let changes = 0;
    let prev = 0;
    for (const x of pts) { const s = Math.sign(x.m); if (s && prev && s !== prev) changes++; if (s) prev = s; }
    const last = pts[pts.length - 1];
    return `<div class="kcs-pitch-legend"><span class="is-home">${esc(fx.home.name)} önde ↑</span><span class="is-away">↓ ${esc(fx.away.name)} önde</span></div>`
      + `<div class="kcs-fark"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="kcsFarkG" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse">`
      + `<stop offset="0" stop-color="#7aa5ff" stop-opacity=".7"/><stop offset=".5" stop-color="#7aa5ff" stop-opacity=".08"/><stop offset=".5" stop-color="#e46b8f" stop-opacity=".08"/><stop offset="1" stop-color="#e46b8f" stop-opacity=".7"/></linearGradient></defs>`
      + `${grid}<line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" class="kcs-fark-zero"/><path d="${area}" fill="url(#kcsFarkG)" class="kcs-fark-area"/>`
      + `<path d="${line}" class="kcs-fark-line" pathLength="1"/><circle cx="${X(last.t)}" cy="${Y(last.m)}" r="4.5" class="kcs-fark-dot"/></svg><div class="kcs-fark-labels">${labels}</div></div>`
      + `<div class="kcs-fark-sum"><div class="is-home"><b>+${hiH}</b><span>${esc(fx.home.shortCode || fx.home.name)} en büyük fark</span></div><div><b>${changes}</b><span>önde olan değişti</span></div><div class="is-away"><b>+${hiA}</b><span>${esc(fx.away.shortCode || fx.away.name)} en büyük fark</span></div></div>`;
  }

  function bkTable(d) {
    const fx = d.detail.fixture;
    const groups = (d.standings || []).filter((g) => g.rows.length);
    if (!groups.length) return '<div class="kcs-peek-empty">Puan durumu yok.</div>';
    const mine = (id) => (String(id) === String(fx.home.id) ? ' is-home' : String(id) === String(fx.away.id) ? ' is-away' : '');
    const TR = (t) => t.replace('Atlantic', 'Atlantik').replace('Central', 'Merkez').replace('Southeast', 'Güneydoğu').replace('Northwest', 'Kuzeybatı').replace('Pacific', 'Pasifik').replace('Southwest', 'Güneybatı')
      .replace('Eastern Conference', 'Doğu Konferansı').replace('Western Conference', 'Batı Konferansı');
    return groups.map((g) => `<div class="kcs-st-title">${esc(TR(g.title))}</div><div class="kcs-st kcs-st--bk"><div class="kcs-st-row is-head"><span>#</span><span>Takım</span><span>G</span><span>M</span><span>%</span><span>Fark</span><span>Seri</span></div>`
      + g.rows.map((r, i) => `<div class="kcs-st-row${mine(r.id)}${i === 0 ? ' z-lead' : ''}"><span class="kcs-st-pos">${i + 1}</span><span class="kcs-st-name">${bkLogo(bkTeamLogo(r.abbr)) || '<i></i>'}<span>${esc(r.team || '')}</span></span>`
        + `<span>${esc(r.w ?? '')}</span><span>${esc(r.l ?? '')}</span><span>${esc(r.pct ?? '')}</span><span>${esc(r.gb ?? '')}</span><b class="${/^W/.test(r.strk || '') ? 'is-pos' : /^L/.test(r.strk || '') ? 'is-neg' : ''}">${esc((r.strk || '').replace(/^W/, 'G').replace(/^L/, 'M'))}</b></div>`).join('')
      + '</div>').join('') + '<div class="kcs-st-legend"><span class="is-home">Ev sahibi</span><span class="is-away">Deplasman</span><span>G galibiyet · M mağlubiyet · Seri: üst üste</span></div>';
  }

  function bkH2h(d) {
    const fx = d.detail.fixture;
    const s = d.series;
    const evs = (s?.events || []).filter((e) => e.done && !String(fx.id).endsWith(String(e.id || '')));
    if (!s || !s.events.length) return '<div class="kcs-peek-empty">Bu sezon aralarında maç yok.</div>';
    let h = 0; let a = 0;
    for (const e of s.events.filter((x) => x.done)) { const w = e.teams.find((t) => t.winner); if (!w) continue; if (String(w.id) === String(fx.home.id)) h++; else a++; }
    const rows = s.events.map((e) => {
      const home = e.teams.find((t) => t.homeAway === 'home') || {};
      const away = e.teams.find((t) => t.homeAway === 'away') || {};
      const date = e.date ? new Date(e.date).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return `<div class="kcs-h2h-match"><small>${esc(date)} · NBA${e.done ? '' : ' · oynanmadı'}</small><div><span class="${home.winner ? 'is-win' : ''}">${esc(home.name || '')}</span><b>${e.done ? `${esc(home.score)} : ${esc(away.score)}` : '–'}</b><span class="${away.winner ? 'is-win' : ''}">${esc(away.name || '')}</span></div></div>`;
    }).join('');
    void evs;
    return `<div class="kcs-h2h-title">Sezon serisi</div><div class="kcs-h2h-sub">Bu sezon aralarındaki maçlar</div>`
      + `<div class="kcs-h2h-big kcs-h2h-big--2"><div class="is-home"><b>${h}</b><span>${esc(fx.home.name)}</span></div><div class="is-away"><b>${a}</b><span>${esc(fx.away.name)}</span></div></div>`
      + `<div class="kcs-h2h-sum">${s.events.length} maçlık seri · ${s.events.filter((x) => x.done).length} maç oynandı</div>${rows}`;
  }

  function bkPlayers(d) {
    const fx = d.detail.fixture;
    if (!d.players?.length) return '<div class="kcs-peek-empty">Oyuncu bilgisi maç başlayınca gelir.</div>';
    const COLS = [['MIN', 'Dk'], ['PTS', 'Sayı'], ['REB', 'Rib'], ['AST', 'Ast'], ['FG', 'Saha'], ['3PT', '3lük'], ['+/-', '+/-']];
    return d.players.map((t) => {
      const team = String(t.teamId) === String(fx.home.id) ? fx.home : fx.away;
      const idx = COLS.map(([k]) => t.labels.indexOf(k));
      const head = `<div class="kcs-box-row is-head"><span>Oyuncu</span>${COLS.map(([, l]) => `<span>${l}</span>`).join('')}</div>`;
      const rows = t.athletes.map((x) => (x.dnp || !x.stats.length
        ? `<div class="kcs-box-row is-dnp"><span class="kcs-box-name">${esc(x.short || x.name)}<small>${esc(x.pos)}</small></span><span class="kcs-box-dnp">Oynamadı</span></div>`
        : `<div class="kcs-box-row${x.starter ? ' is-starter' : ''}"><span class="kcs-box-name">${esc(x.short || x.name)}<small>${esc(x.pos)}${x.starter ? ' · ilk 5' : ''}</small></span>${idx.map((i, n) => `<span${n === 1 ? ' class="kcs-box-pts"' : ''}>${i >= 0 ? esc(x.stats[i] ?? '') : ''}</span>`).join('')}</div>`)).join('');
      return `<div class="kcs-box${team === fx.away ? ' is-away' : ''}"><div class="kcs-box-team">${bkLogo(team.logoUrl)}<b>${esc(team.name)}</b></div>${head}${rows}</div>`;
    }).join('');
  }

  function bkBody(d, tab) {
    if (tab === 'akis') return bkFeed(d);
    if (tab === 'ist') return bkStats(d);
    if (tab === 'fark') return bkFark(d);
    if (tab === 'h2h') return bkH2h(d);
    if (tab === 'puan') return bkTable(d);
    if (tab === 'kadro') return bkPlayers(d);
    return bkGenel(d);
  }

  // ---------- olasılık: toplam sayı / gol çizgisi ----------
  const normCdf = (z) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const p = 0.3989423 * Math.exp(-z * z / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  };
  // NBA toplam sayı: maç öncesi çizgi (yoksa 225) ortalama, sapma ~18 sayı. Canlıda kalan süre, şimdiki tempoyla
  // maç öncesi tempo harmanlanarak (ilk 12 dakika ağırlıklı çizgiden) tahmin edilir; sapma kalan süreyle küçülür. Uzatma hesaba katılmaz.
  function bkOverProb(e, line) {
    const total = (e.hs ?? 0) + (e.as ?? 0);
    const ou = Number(e.ou) || 225;
    const live = !SK_WAIT.has(e.status) && !SK_DONE.has(e.status);
    let elapsed = 0;
    if (live) {
      const p = e.period || 1;
      elapsed = e.status === 'HALFTIME' ? 24 : e.status === 'BREAK' ? (p <= 4 ? p * 12 : 48 + (p - 4) * 5) : bkElapsed(p, e.clock);
    }
    const end = (e.period || 0) > 4 ? 48 + (e.period - 4) * 5 : 48;
    const rem = Math.max(0, end - elapsed);
    const rate = ((ou / 48) * 12 + total) / (12 + elapsed);
    const mean = total + rate * rem;
    const sd = Math.max(2.5, 18 * Math.sqrt(rem / 48));
    return 1 - normCdf((line - mean) / sd);
  }
  // Bir maçın (kartın bir bacağı) tutma olasılığı. Biten maç kesin; çizgi aşıldıysa Üst tuttu / Alt yattı.
  function legProb(leg, e) {
    if (leg.forced) return leg.forced === 'won' ? 1 : leg.forced === 'lost' ? 0 : null;
    if (!e || leg.line == null) return null;
    const over = leg.side === 'over';
    const total = (e.hs ?? 0) + (e.as ?? 0);
    if (SK_DONE.has(e.status)) return (over ? total > leg.line : total < leg.line) ? 1 : 0;
    if (total > leg.line) return over ? 1 : 0;
    if (e.sport === 'basketball') { const po = bkOverProb(e, leg.line); return over ? po : 1 - po; }
    const l = legInfo(leg).l ?? (Number(notesMap.get(norm(leg.label))?.lambda) || null);
    if (!l) return null;
    const lam = !SK_WAIT.has(e.status) && e.minute != null ? l * Math.max(0, 90 - e.minute) / 90 : l;
    const po = overProb(lam, leg.line - total);
    return over ? po : 1 - po;
  }

  // ---------- Özel Oranlar: her maçın kendi çizgisi olan kart ("A - B · Toplam … 227.5 Alt" satırları) ----------
  function readLegsCard(card) {
    const els = [...card.querySelectorAll('.sb-cbt-leg')];
    if (!els.length) return null;
    const odds = num(card.querySelector('.sb-cbt-odds-num')?.textContent);
    const legs = els.map((el) => {
      const label = el.querySelector('.sb-cbt-leg-event')?.textContent.trim() || '';
      const pickText = el.querySelector('.sb-cbt-leg-pick')?.textContent.trim() || '';
      const [market = '', pick = ''] = pickText.split('·').map((x) => x.trim());
      const m = /([\d.,]+)\s*(Alt|Üst|Ust)/i.exec(pick) || /(Alt|Üst|Ust)\s*([\d.,]+)/i.exec(pick);
      if (!label || !m) return null;
      const line = num(/\d/.test(m[1]) ? m[1] : m[2]);
      const alt = /alt/i.test(/\d/.test(m[1]) ? m[2] : m[1]);
      const pair = label.split(/\s+-\s+/);
      if (/korner|kart|yarı|yari|devre|çeyrek|ceyrek/i.test(market)) return null;
      return { label, key: `leg|${norm(pair.join(' '))}`, match: pair.join(' '), pair: pair.length === 2 ? pair : null, time: '', odds, market, line, side: alt ? 'under' : 'over' };
    });
    if (legs.some((x) => !x)) return null;
    return { title: legs.map((x) => x.label).join(' | '), legs, odds };
  }
  // Önce gece görevinin not dosyasına yazdığı eşleşme (skId), sonra ad ve saatle arama.
  const legEvent = (leg) => {
    const linked = notesMap.get(norm(leg.label))?.skId ?? notesMap.get(rowKey(leg.label))?.skId;
    if (linked != null && skEvents[linked]) return skEvents[linked];
    const h = findHub(HUBS[2], leg);
    return h ? skEvents[h.e.id] || null : null;
  };

  function legsCardHtml(lc) {
    const rows = lc.legs.map((leg) => { const e = legEvent(leg); return { leg, e, p: legProb(leg, e) }; });
    let won = 0; let lost = 0;
    const parts = rows.map(({ leg, e, p }) => {
      const pickTxt = leg.line == null ? (leg.pickText || '') : `${leg.line} ${leg.side === 'under' ? 'Alt' : 'Üst'}`;
      const sideTxt = leg.side === 'under' ? 'alt' : 'ust';
      // Bahislerim: veri serviste bulunamasa da site kendi skorunu yazıyor; o gösterilir.
      if (!e && leg.site) {
        const s = leg.site;
        const total = s.hs != null ? s.hs + s.as : null;
        const v = leg.forced || (total != null && leg.line != null ? goalVerdict(total, leg.line, sideTxt, s.ended) : 'open');
        if (v === 'won') won++;
        if (v === 'lost') lost++;
        const state = s.live ? `<span class="kcs-clock kcs-clock--live"><i></i>${esc(s.clock || 'Canlı')}</span>` : s.start ? `${esc(whenText(s.start / 1000))}${countdownHtml(s.start / 1000)}` : '';
        const team = (name, url) => `<span class="kcs-lg-team">${bkLogo(url)}<span>${esc(name)}</span></span>`;
        const score = `<div class="kcs-lg-score${s.live ? ' is-live' : ''}">${team(leg.pair?.[0] || leg.label, s.homeLogo)}<b>${total != null ? `${s.hs} - ${s.as}` : 'v'}</b>${team(leg.pair?.[1] || '', s.awayLogo)}</div>`;
        const bar = total != null && leg.line != null ? goalHtml(total, { line: leg.line, side: sideTxt }, s.ended) : '';
        return `<div class="kcs-lg${v === 'won' ? ' is-won' : v === 'lost' ? ' is-lost' : ''}"><div class="kcs-lg-head"><b>${esc(leg.market || 'Toplam')} · ${esc(pickTxt)}</b><span>${state}</span></div>${score}${bar}`
          + '<div class="kcs-ci-note">Maç ayrıntısı veri serviste bulunamadı; skor siteden.</div></div>';
      }
      if (!e) {
        const bk = leg.line >= 40;
        const why = bk && skMeta?.bkError ? 'Basketbol verisi alınamadı: eklentiyi güncelleyip uzantılar sayfasından yeniden yükle' : bk && !Object.values(skEvents).some((x) => x.sport === 'basketball') ? 'Basketbol listesi henüz gelmedi, birazdan yenilenir' : bk ? 'Maç bulunamadı · yalnızca NBA ve yakın saatteki maçlar aranır' : 'Maç bulunamadı';
        return `<div class="kcs-lg"><div class="kcs-lg-head"><b>${esc(leg.label)}</b><span class="kcs-lg-pick">${esc(pickTxt)}</span></div><div class="kcs-ci-note kcs-ci-note--warn">${esc(why)}</div></div>`;
      }
      const f = fromSk(e);
      const total = (e.hs ?? 0) + (e.as ?? 0);
      const final = SK_DONE.has(e.status);
      const v = leg.forced || (f.hasScore && leg.line != null ? goalVerdict(total, leg.line, sideTxt, final) : 'open');
      if (v === 'won') won++;
      if (v === 'lost') lost++;
      const state = f.isLive ? `<span class="kcs-clock kcs-clock--live"><i></i>${esc(f.clock || 'Canlı')}</span>`
        : f.ended ? `<span class="kcs-done-badge">${esc(f.clock || 'MS')}</span>`
        : `${e.start ? esc(whenText(e.start)) : ''}${e.start ? countdownHtml(e.start) : ''}`;
      const team = (name, url) => `<span class="kcs-lg-team">${bkLogo(url)}<span>${esc(name)}</span></span>`;
      const score = `<div class="kcs-lg-score${f.isLive ? ' is-live' : ''}">${team(e.home, e.homeLogo)}<b>${f.hasScore ? `${e.hs} - ${e.as}` : 'v'}</b>${team(e.away, e.awayLogo)}</div>`;
      const bar = f.hasScore && leg.line != null ? goalHtml(total, { line: leg.line, side: sideTxt }, final) : '';
      const pre = !f.hasScore && e.sport === 'basketball' && e.ou ? `<div class="kcs-ci-note">Maç öncesi çizgi: toplam ${e.ou}${e.spread ? ` · ${esc(e.spread)}` : ''}</div>` : '';
      const prob = p != null && !final ? `<div class="kcs-lg-prob"><span>Tutma olasılığı</span><b>${pctText(p * 100)}</b></div>` : '';
      const peek = skIdOf({ id: e.id });
      return `<div class="kcs-lg${v === 'won' ? ' is-won' : v === 'lost' ? ' is-lost' : ''}"><div class="kcs-lg-head"><b>${esc(leg.market || 'Toplam')} · ${esc(pickTxt)}</b><span>${state}</span></div>${score}${bar}${pre}${prob}`
        + (peek ? `<div class="kcs-peek-line">${peekBtns(peek)}</div>` : '') + '</div>';
    }).join('');
    const known = rows.every((x) => x.p != null);
    const pAll = known ? rows.reduce((t, x) => t * x.p, 1) : null;
    const n = rows.length;
    const status = lost ? `${lost} maç tutmadı · kupon yattı` : won === n ? 'Bütün maçlar tuttu' : `${won}/${n} maç tuttu`;
    let body = parts + infoRow('Kupon', status, lost ? 'warn' : won === n ? 'ok' : '');
    if (pAll != null && !lost && won < n) body += fairRows(Math.max(1e-6, pAll), lc.odds, `${n} maç birlikte`, 'Tahmindir: maçlar bağımsız sayıldı. Basketbolda toplam sayı maç öncesi çizgi etrafında dağılır, canlıda kalan süre ve tempo hesaba katılır; uzatma sayılmaz.');
    else if (pAll == null) body += infoRow('Seçim olasılığı', 'bilgisi eksik maç var', 'warn');
    const note = cardNote(lc.title);
    body += commentHtml(note ? note.comment : '', notesHtml(lc.legs));
    const prob = pAll != null && !lost && won < n ? (pAll * 100).toFixed(1) : (Number(note?.prob) > 0 ? Number(note.prob) : null);
    return sectionHtml('info', lc.title, 'MAÇ BİLGİLERİ', infoSum(lc.legs, prob), body);
  }

  function renderSpecials() {
    // Maç penceresi zamanla kayar: en geç on dakikada bir yeniden bakılır.
    if (matchDirty || Date.now() - memoAt > 10 * 60 * 1000) {
      matchMemo.clear();
      matchDirty = false;
      memoAt = Date.now();
    }
    const want = { stake: [], xbet: [] };
    const sortItems = [];
    for (const root of roots()) watchRoot(root);
    const one = (card) => {
      const isMulti = specialIsMulti(card);
      const shown = cardShow === 'all' || (cardShow === 'multi') === isMulti;
      const display = shown ? '' : 'none';
      if (card.style.display !== display) card.style.display = display;
      // Yeni kart bilet gibi: eklenenler iki sütunun da altına, kesik çizgiyle ayrılmış olarak gelir.
      const ticket = card.matches('.sb-custom-bet-card');
      const slot = card;
      let box = slot.querySelector(':scope > .kcs-arb-wrap');
      const active = features.arb || features.info;
      const sp = active ? readSpecial(card) : null;
      const multi = active && !sp ? readMulti(card) : null;
      const lc = active && !sp && !multi ? readLegsCard(card) : null;
      const closed = /KAPANDI/i.test(card.querySelector('.sb-cbt-action')?.textContent || '');
      const sortItem = { card, key: specialKey(card), at: sortItems.length, arb: null, start: null, closed };
      sortItems.push(sortItem);
      if (!sp && !multi && !lc) { box?.remove(); card.classList.remove('kcs-ticket'); return; }
      if ((cardSort === 'arb' || cardSort === 'both') && sp) sortItem.arb = bestProfit(sp);
      if (cardSort === 'start' || cardSort === 'both') {
        const times = (multi ? multi.legs : lc ? lc.legs : [sp]).map(legStart).filter(Boolean);
        sortItem.start = times.length ? Math.min(...times) : null;
      }
      // Bir karttaki hata diğer kartların satırlarını silmesin: o kartta hatayı göster, devam et.
      let html;
      try {
        html = lc ? (features.info ? legsCardHtml(lc) : '') : (multi || !features.arb ? '' : sectionHtml('arb', sp.key, 'ORANLAR', arbSum(sp), `<div class="kcs-arb-list">${arbHtml(sp)}</div>`))
          + (features.info ? cardInfoHtml(sp, multi) : '');
      } catch (err) {
        console.error('[kupon-skor] arbitraj satırı', sp?.match, err);
        html = `<div class="kcs-arb kcs-arb--muted" title="${esc(String(err?.stack || err))}"><span class="kcs-arb-text">Arbitraj: bu kartta hata oluştu (${esc(err?.message || err)})</span></div>`;
      }
      if (html) {
        html = poweredHtml() + (cardSort === 'manual' ? moveHtml('special') : '') + html;
        if (!box) {
          box = document.createElement('div');
          box.className = `kcs-arb-wrap${ticket ? ' kcs-arb-wrap--sb' : ''}`;
          styleRoot(card.getRootNode());
          slot.append(box);
        }
        if (ticket) card.classList.add('kcs-ticket');
        box.__kcsSp = sp;
        box.__kcsKey = multi ? multi.title : lc ? lc.title : sp.key;
        if (box.__kcsHtml !== html) { box.innerHTML = html; box.__kcsHtml = html; }
        boxCache.set(sortItem.key, { html, cls: box.className, kcsKey: box.__kcsKey, sp, ticket, isMulti });
      } else {
        box?.remove();
        card.classList.remove('kcs-ticket');
        boxCache.delete(sortItem.key);
      }
      // Çok maçlı kartta her maç ayrı aranır (ve "bu maç hangi özel oran?" çubuğunda seçilebilir).
      for (const item of multi ? multi.legs : lc ? [] : (sp.unsupported ? [] : [sp])) {
        for (const k in want) {
          try { want[k].push(wantItem(k, item)); } catch (err) { console.error('[kupon-skor] arama listesi', item.match, err); }
        }
      }
    };
    const cards = queryAll(SPECIAL_CARD);
    const run = ++specialsRun;
    let at = 0;
    const step = () => {
      if (run !== specialsRun) return;
      const began = performance.now();
      while (at < cards.length && performance.now() - began < SLICE_MS) one(cards[at++]);
      if (at < cards.length) { setTimeout(() => keepPlace(step), 0); return; }
      applySort(sortItems);
      sendWant(want);
      renderInfo();
    };
    step();
  }

  // Pencerenin dışına basılınca kapat.
  function onOutsidePress(ev) {
    if (calcRow && !targetOf(ev).closest?.('.kcs-calc, .kcs-arb--calc')) closeCalc();
  }

  async function saveArbLink(book, cardKey, id) {
    const next = { ...arbLinks, [book]: { ...(arbLinks[book] || {}) } };
    if (id == null) delete next[book][cardKey]; else next[book][cardKey] = id;
    arbLinks = next;
    matchDirty = true;
    if (hasStore) await chrome.storage.local.set({ arbLinks: next });
  }

  // Arbitraj kutusundaki düğmeler; işlendiyse true döner.
  const pickOf = (book, sp) => ({ book, cardKey: sp.key, match: sp.pair ? sp.pair.join(' - ') : sp.match, time: sp.time || '', kind: sp.kind || 'total', line: sp.line, side: sp.side, team: sp.team ?? null });

  async function onArbButton(btn) {
    if (btn.classList.contains('kcs-open-book')) {
      chrome.runtime.sendMessage({ type: btn.dataset.open });
      btn.textContent = 'Açılıyor…';
      return true;
    }
    if (btn.classList.contains('kcs-arb-trust')) {
      const card = btn.closest('.kcs-arb-wrap')?.__kcsSp;
      if (card) await saveArbLink(btn.dataset.book, card.key, btn.dataset.id);
      renderSpecials();
      return true;
    }
    if (btn.classList.contains('kcs-site-btn')) {
      // Açıksa sekmeye gider; kırmızıysa sekme yoktur ya da donmuştur: açar/yeniler ve öne getirir.
      const off = btn.classList.contains('kcs-site-btn--off');
      const label = btn.lastChild;
      const text = label.textContent;
      label.textContent = 'Açılıyor…';
      setTimeout(() => { label.textContent = text; }, 1500);
      try {
        await chrome.runtime.sendMessage({ type: btn.dataset.open, focus: true, reload: off });
      } catch {
        location.reload();
      }
      return true;
    }
    if (btn.classList.contains('kcs-fold')) {
      const section = btn.closest('.kcs-ci');
      const closed = !section.classList.contains('is-closed');
      section.classList.toggle('is-closed', closed);
      btn.setAttribute('aria-expanded', String(!closed));
      cardFolds[`${btn.dataset.fold}|${btn.closest('.kcs-arb-wrap, .kcs-legs').__kcsKey}`] = closed;
      return true;
    }
    if (btn.classList.contains('kcs-link-toggle')) {
      linkOpen = !linkOpen;
      if (hasStore) chrome.storage.local.set({ linkOpen });
      renderInfo();
      return true;
    }
    if (btn.classList.contains('kcs-pl-toggle')) {
      plOpen = !plOpen;
      if (hasStore) chrome.storage.local.set({ plOpen });
      renderInfo();
      return true;
    }
    if (btn.classList.contains('kcs-fold-all')) {
      foldAll = !foldAll;
      cardFolds = {};
      // İki sayfada da: Özel Oranlar kartları ve Bahislerim kuponları birlikte küçülür/açılır.
      for (const el of queryAll('.kcs-arb-wrap, .kcs-legs')) el.__kcsHtml = null;
      sbCache.clear();
      render();
      return true;
    }
    if (btn.classList.contains('kcs-feat-btn')) {
      const key = { featArb: 'arb', featInfo: 'info', featScores: 'scores', featPl: 'pl', featLink: 'link' }[btn.dataset.feat];
      features[key] = !features[key];
      if (hasStore) await chrome.storage.local.set({ [btn.dataset.feat]: features[key] });
      render();
      return true;
    }
    if (btn.classList.contains('kcs-update-btn')) {
      chrome.runtime.sendMessage({ type: 'openUpdate' });
      return true;
    }
    if (btn.classList.contains('kcs-peek-btn') || btn.classList.contains('kcs-peek-tab')) {
      const id = btn.dataset.sk;
      const tab = btn.dataset.tab;
      // "Göz at" açıkken tekrar basınca ya da aynı sekmenin düğmesine basınca kapanır.
      if (btn.classList.contains('kcs-peek-btn') && peekOpen.has(id) && (tab === 'genel' || peekOpen.get(id) === tab)) { closePeek(); return true; }
      if (!peekOpen.has(id)) peekOpen.clear();
      if (tab === 'baski') pzState.clear();
      peekOpen.set(id, tab);
      peekRedraw();
      return true;
    }
    if (btn.classList.contains('kcs-modal-close')) { closePeek(); return true; }
    if (btn.classList.contains('kcs-pz-play')) {
      const el = btn.closest('.kcs-pz');
      const st = el && pzState.get(el.dataset.sk);
      if (st) {
        if (st.playing) st.playing = false;
        else { if (st.i >= st.n - 1) st.i = 0; st.playing = true; }
        pzApply();
      }
      return true;
    }
    if (btn.classList.contains('kcs-group-btn')) {
      if (btn.dataset.page === 'bets') {
        groupBets = btn.dataset.group;
        if (hasStore) await chrome.storage.local.set({ groupBets });
        applySbSort();
        renderStatus();
      } else {
        groupSpecial = btn.dataset.group;
        if (hasStore) await chrome.storage.local.set({ groupSpecial });
        renderSpecials();
      }
      return true;
    }
    if (btn.classList.contains('kcs-move-btn')) {
      const bets = btn.dataset.page === 'bets';
      const card = btn.closest(bets ? SB_BET : SPECIAL_CARD);
      if (!card) return true;
      const keyFn = bets ? sbKeyOf : specialKey;
      // Ekranda görünen sıra (gruplar dahil): yer değiştirme aynı grup içinde anlamlı.
      const all = queryAll(bets ? SB_BET : SPECIAL_CARD).map((c, at) => ({ c, at, o: Number(c.style.order) || 0 }))
        .sort((a, b) => a.o - b.o || a.at - b.at).map((x) => keyFn(x.c));
      const k = keyFn(card);
      const i = all.indexOf(k);
      if (i < 0) return true;
      all.splice(i, 1);
      const j = { top: 0, bottom: all.length, up: Math.max(0, i - 1), down: Math.min(all.length, i + 1) }[btn.dataset.move] ?? i;
      all.splice(j, 0, k);
      manualOrder = { ...manualOrder, [bets ? 'bets' : 'special']: all };
      if (hasStore) await chrome.storage.local.set({ manualOrder });
      if (bets) applySbSort(); else renderSpecials();
      return true;
    }
    if (btn.classList.contains('kcs-wide-btn')) {
      fullWidth = !fullWidth;
      if (hasStore) await chrome.storage.local.set({ fullWidth });
      applyFullWidth();
      renderInfo();
      renderStatus();
      return true;
    }
    if (btn.classList.contains('kcs-cols-btn')) {
      const v = Number(btn.dataset.cols) || 0;
      if (btn.dataset.page === 'bets') {
        colsBets = v;
        if (hasStore) await chrome.storage.local.set({ colsBets });
        applySbSort();
        renderStatus();
      } else {
        colsSpecial = v;
        if (hasStore) await chrome.storage.local.set({ colsSpecial });
        renderInfo();
      }
      return true;
    }
    if (btn.classList.contains('kcs-sbsort')) {
      sbSort = btn.dataset.sbsort;
      sbSortUntil = Date.now() + 1500;
      if (hasStore) await chrome.storage.local.set({ sbSort });
      render();
      return true;
    }
    if (btn.classList.contains('kcs-show-btn')) {
      cardShow = btn.dataset.show;
      if (hasStore) await chrome.storage.local.set({ cardShow });
      renderSpecials();
      return true;
    }
    if (btn.classList.contains('kcs-sort-btn')) {
      sortOpenUntil = Date.now() + 1500;
      cardSort = btn.dataset.sort;
      if (hasStore) await chrome.storage.local.set({ cardSort });
      renderSpecials();
      return true;
    }
    if (btn.classList.contains('kcs-refresh')) {
      if (!BOOKS.some((b) => bookConnected(b.key))) return true;
      // 1xBet ve Stake sekmeleri kartların maçlarını hemen yeniden sorgular.
      refreshUntil = Date.now() + 8000;
      if (hasStore) await chrome.storage.local.set({ refreshReq: Date.now() });
      renderInfo();
      setTimeout(scheduleRender, 8100);
      return true;
    }
    // Maçı bilinen satır: sitede maçı aç.
    if (btn.classList.contains('kcs-pick-goto')) {
      chrome.runtime.sendMessage({ type: 'gotoBook', book: btn.dataset.book, url: btn.dataset.href || null, gameId: btn.dataset.game || null });
      return true;
    }
    const sp = btn.closest('.kcs-arb-wrap')?.__kcsSp;
    // Maç yok ya da yanlış maç: siteyi aç; kullanıcı maçın sayfasını açınca üstte "bu maç mı?" çubuğu çıkar (bar.js).
    if (btn.classList.contains('kcs-go-site')) {
      if (sp && hasStore) {
        await chrome.storage.local.set({ bookPick: { ...pickOf(btn.dataset.book, sp), at: Date.now() } });
      }
      chrome.runtime.sendMessage({ type: 'gotoBook', book: btn.dataset.book });
      return true;
    }
    if (btn.classList.contains('kcs-unlink-arb')) {
      if (sp) await saveArbLink(btn.dataset.book, sp.key, null);
      for (const el of queryAll('.kcs-arb-wrap')) el.__kcsHtml = null;
      renderSpecials();
      return true;
    }
    return false;
  }

  let observer = null;

  // Eklenti kartlara bölüm ekleyip kaldırınca, ekranın üstündeki kartın üstündeki içerik uzar ya da kısalır ve sayfa
  // kaymış görünür (tarayıcının kendi düzeltmesi, sayfa sonunda zıpladığı için kapalı). Çizimden önce ekranın tepesindeki
  // kartın sayfadaki yeri alınır, çizimden sonra yeri değiştiyse kaydırma aynı miktarda düzeltilir. Kullanıcının kendi
  // kaydırması sayfadaki yeri değiştirmez, ona karışılmaz. Düğmeye basınca (sıralama, aç/kapa) bir süre düzeltme yapılmaz.
  let userActAt = 0;
  // Sayfa sabitleme: ekranın tepesindeki kart (adıyla) ve sayfadaki yeri hep akılda tutulur. Site kartları yenileyince
  // (eski kart silinir, yenisi gelir, eklentinin kutusu bir an kaybolur) ya da eklenti bir şey çizince, aynı adlı kartın
  // yeri değiştiyse kaydırma aynı miktarda düzeltilir. Değişiklik gözlemcisinde çalışır: ekran çizilmeden önce.
  // Kullanıcının kaydırması kartın sayfadaki yerini değiştirmez, ona karışılmaz; sıralama kart taşıdıysa peşinden gidilmez.
  let pin = null;
  const cardKey = (el) => {
    const name = el.querySelector('.sb-cbt-team, .sb-mb-textbet')?.textContent
      || [...el.querySelectorAll('.sb-mb-team')].map((e) => e.textContent).join('-');
    const pick = el.querySelector('.sb-cbt-pick, .sb-mb-leg-pick-name')?.textContent || '';
    return `${(name || '').trim()}|${pick.trim()}`;
  };
  function cardsKeyed() {
    const seen = {};
    return queryAll(`${SPECIAL_CARD}, ${SB_BET}`).map((el) => {
      const k = cardKey(el);
      seen[k] = (seen[k] || 0) + 1;
      return { el, key: `${k}#${seen[k]}` };
    });
  }
  function pinTake() {
    pin = null;
    if (typeof window === 'undefined' || !window.scrollY) return;
    try {
      for (const c of cardsKeyed()) {
        const box = c.el.getBoundingClientRect();
        if (box.height && box.bottom > 0 && box.top < window.innerHeight) { pin = { key: c.key, y: box.top + window.scrollY }; return; }
      }
    } catch { /* ölçülemedi */ }
  }
  function pinRestore() {
    const moved = sortMoved;
    sortMoved = false;
    if (pin && !moved && Date.now() - userActAt >= 1500) {
      try {
        const c = cardsKeyed().find((x) => x.key === pin.key);
        if (c) {
          const d = c.el.getBoundingClientRect().top + window.scrollY - pin.y;
          if (Math.abs(d) >= 1) window.scrollTo({ top: window.scrollY + d, behavior: 'instant' });
        }
      } catch { /* ölçülemedi */ }
    }
    pinTake();
  }
  let pinFrame = 0;
  function onPinScroll() {
    if (pinFrame) return;
    pinFrame = requestAnimationFrame(() => { pinFrame = 0; pinTake(); });
  }
  function keepPlace(fn) {
    try { return fn(); } finally { pinRestore(); }
  }

  function render() {
    keepPlace(renderNow);
  }

  function renderNow() {
    // Eklenti yenilendiyse bu sekmedeki eski kod durur.
    if (hasStore && !chrome.runtime?.id) return;
    holdRecent();
    learnLines();
    renderSpecials();
    renderPeekModal();
    // Canlı skor kapalıysa eklenen bölümleri kaldır ve skor tarafını hiç çalıştırma.
    renderStatus();
    if (!features.scores) {
      queryAll('.kcs-legs').forEach((el) => el.remove());
      observer?.takeRecords();
      return;
    }
    const cards = document.querySelectorAll('.bet');
    const sbAll = queryAll(SB_BET);
    const sbCards = sbAll.filter((c) => c.querySelector('.sb-mb-textbet'));
    for (const card of sbAll) if (!sbCards.includes(card)) renderSbSingle(card);
    onBetsPage = cards.length + sbAll.length > 0;
    const list = onBetsPage ? fixtureList() : null;
    const ask = {};
    const items = [
      ...[...cards].map((card) => ({ card, read: analyzeCard, draw: renderTrack })),
      ...sbCards.map((card) => ({ card, read: analyzeSb, draw: renderSb })),
    ];
    for (const { card, read, draw } of items) {
      const data = read(card, list);
      if (!data.rows.length) continue;
      draw(card, data);
      for (const r of data.rows) {
        if (r.how === 'none' && !requested.has(rowKey(r.label))) ask[rowKey(r.label)] = { text: r.label, placedAt: data.placedAt };
        // Elle bağlanmış ve verisi gelmiş maçtan takım yazılarını öğren (bir kez).
        if (r.how === 'manual' && r.f) {
          const e = sofaEvents[overrides[rowKey(r.label)]];
          const [x] = r.label.split(/\s*-\s*/);
          if (e && learnedSides[norm(x)] == null) learnFrom(r.label, e);
        }
      }
    }
    if (sbAll.length) { applySbSort(); renderStatus(); }
    if (Object.keys(skFeed).length) evPrimed = true;
    observer?.takeRecords();
    if (!hasStore || !sofaConnected()) return;
    // Bulunamayanları SofaScore sekmesine aratmak üzere sıraya koy.
    const keys = Object.keys(ask);
    if (keys.length) {
      keys.forEach((k) => requested.add(k));
      chrome.storage.local.get('sofaResolveReq').then(({ sofaResolveReq = {} }) => {
        chrome.storage.local.set({ sofaResolveReq: { ...sofaResolveReq, ...ask } });
      });
    }
    if (keys.length && Date.now() - lastScanReq > 5 * 60 * 1000) {
      lastScanReq = Date.now();
      chrome.storage.local.set({ sofaScanReq: lastScanReq });
    }
  }

  // ---------- düğmeler ----------

  function parseSofaId(text) {
    const s = String(text || '').trim();
    const m = s.match(/#id:(\d+)/) || s.match(/^(\d{5,})$/) || s.match(/\/event\/(\d{5,})/);
    return m ? Number(m[1]) : null;
  }

  async function saveOverride(key, id) {
    const next = { ...overrides };
    if (id == null) delete next[key]; else next[key] = id;
    overrides = next;
    if (hasStore) await chrome.storage.local.set({ overrides: next });
  }

  const OWN = '.kcs-legs, .kcs-status, .kcs-arb-wrap, .kcs-pop, .kcs-info, .kcs-modal';

  // Düğmeler basıldığı anda (pointerdown) çalışır: Özel Oranlar kartları basınca yeniden çiziliyor,
  // bırakınca düğme artık aynı öğe olmadığından tarayıcı "click" üretmiyor. Klavyeyle (Enter/Boşluk)
  // basılınca sadece "click" gelir; onu da karşıla ama aynı basışı iki kez işleme.
  let lastPress = 0;

  function onPointerDown(ev) {
    if (ev.button !== 0) return;
    const t = targetOf(ev);
    const btn = t.closest?.('button');
    // Oranı olan arbitraj satırına (düğme dışında) basılınca tutar hesabı açılır/kapanır.
    const calc = !btn && t.closest?.('.kcs-arb--calc');
    if (calc) {
      ev.preventDefault();
      ev.stopPropagation();
      if (calcRow === calc) closeCalc(); else showCalc(calc);
      return;
    }
    if (kxDd && !btn?.classList.contains('kx-dd-btn')) { kxDd = null; setTimeout(() => { renderInfo(); renderStatus(); }, 0); }
    if (!btn || !btn.closest(OWN)) return;
    ev.preventDefault();
    ev.stopPropagation();
    lastPress = Date.now();
    handleButton(btn);
  }

  // Yakalama aşamasında dinlenir: kartın kendi tıklaması (bahis detayı açma) tetiklenmesin.
  function onClick(ev) {
    const t = targetOf(ev);
    // Pencerenin dışına (karartılmış alana) tıklayınca kapanır.
    if (t.classList?.contains('kcs-modal')) { ev.stopPropagation(); closePeek(); return; }
    const inOwn = t.closest?.(OWN);
    if (!inOwn) return;
    const btn = t.closest('button');
    // SofaScore linkleri yeni sekmede açılsın, kart tıklaması tetiklenmesin.
    if (!btn) { ev.stopPropagation(); return; }
    ev.preventDefault();
    ev.stopPropagation();
    if (Date.now() - lastPress < 1000) return; // basışta zaten işlendi
    handleButton(btn);
  }

  async function handleButton(btn) {
    userActAt = Date.now();
    // Eklenti yenilendiyse bu sekmedeki kod kopuktur, düğmeler sessizce ölür: sayfayı yenile.
    if (hasStore && !chrome.runtime?.id) { location.reload(); return; }
    if (btn.classList.contains('kx-dd-btn')) {
      kxDd = kxDd === btn.dataset.dd ? null : btn.dataset.dd;
      renderInfo();
      renderStatus();
      return;
    }
    if (await onArbButton(btn)) return;
    if (btn.classList.contains('kcs-line-save')) {
      const wrap = btn.closest('.kcs-goal');
      const input = wrap.querySelector('.kcs-line-input');
      const value = input.value.trim().replace(',', '.');
      if (!/^\d{1,2}(\.5)?$/.test(value) || !Number(value)) {
        input.classList.add('kcs-line-input--bad');
        return;
      }
      input.blur();
      saveLines([{ title: wrap.dataset.title, line: value, side: btn.dataset.side, manual: true }]);
      scheduleRender();
      return;
    }
    if (btn.classList.contains('kcs-line-del')) {
      removeLine(btn.closest('.kcs-goal').dataset.title);
      scheduleRender();
      return;
    }
    if (btn.classList.contains('kcs-open-sofa')) {
      chrome.runtime.sendMessage({ type: 'openSofa' });
      btn.textContent = 'Açılıyor…';
      return;
    }
    if (btn.classList.contains('kcs-sofa-find')) {
      // SofaScore sekmesi (sofa.js) maç sayfasında "bu maç mı?" çubuğunu bu kupon satırı için gösterir.
      const key = btn.closest('.kcs-edit').dataset.key;
      const label = btn.closest('.kcs-edit').dataset.label || key;
      await chrome.storage.local.set({ sofaPick: { key, label, at: Date.now() } });
      chrome.runtime.sendMessage({ type: 'findOnSofa' });
      btn.textContent = 'SofaScore açıldı';
      return;
    }
    if (btn.classList.contains('kcs-pick-sk')) {
      await saveOverride(btn.closest('.kcs-edit').dataset.key, `k${btn.dataset.id}`);
      editing = null;
    } else if (btn.classList.contains('kcs-fix')) {
      editing = editing?.key === btn.dataset.key ? null : { key: btn.dataset.key };
    } else if (btn.classList.contains('kcs-cancel')) {
      editing = null;
    } else if (btn.classList.contains('kcs-unlink')) {
      await saveOverride(btn.closest('.kcs-edit').dataset.key, null);
      editing = null;
    } else if (btn.classList.contains('kcs-save')) {
      const wrap = btn.closest('.kcs-edit');
      const id = parseSofaId(wrap.querySelector('.kcs-input').value);
      if (!id) {
        editing = {
          key: wrap.dataset.key,
          error: 'Linkte maç numarası yok. SofaScore\'da maçı açıp adres çubuğundaki linkin tamamını (#id:… ile biten) yapıştır.',
        };
      } else {
        await saveOverride(wrap.dataset.key, id);
        editing = null;
        if (!sofaConnected() && hasStore) chrome.runtime.sendMessage({ type: 'openSofa' });
      }
    }
    for (const el of queryAll('.kcs-legs')) el.__kcsHtml = null;
    render();
    queryOne('.kcs-edit .kcs-input')?.focus({ preventScroll: true });
  }

  // ---------- başlatma ----------

  let timer = null;
  function scheduleRender() {
    clearTimeout(timer);
    timer = setTimeout(render, 300);
  }

  // Sayfa ve shadow DOM kökleri bir kez gözleme alınır.
  const watched = new WeakSet();
  function watchRoot(root) {
    const node = root === document ? document.body : root;
    if (!observer || watched.has(node)) return;
    watched.add(node);
    observer.observe(node, { childList: true, subtree: true });
  }

  // Son Kuponlar kutusu sekme ve satır değiştikçe boyut değiştirir, en altta sayfa zıplar: küçülmesine izin verilmez.
  let recentBox = null;
  let recentMax = 0;
  function holdRecent() {
    if (!recentBox?.isConnected) {
      const head = queryAll('div, h2, h3').find((e) => e.childElementCount === 0 && e.textContent.trim() === 'Son Kuponlar');
      recentBox = head?.parentElement || null;
      recentMax = 0;
    }
    if (!recentBox) return;
    const h = recentBox.offsetHeight;
    if (h > recentMax) {
      recentMax = h;
      recentBox.style.minHeight = `${h}px`;
    }
  }

  function activate() {
    listenStore();
    document.documentElement.style.overflowAnchor = 'none';
    document.body.style.overflowAnchor = 'none';
    window.addEventListener('message', (ev) => {
      if (ev.source === window && Array.isArray(ev.data?.__kcsLines)) saveLines(ev.data.__kcsLines);
    });
    loadStore().then(() => { seedLines(); window.postMessage({ __kcsLinesReq: true }, location.origin); });
    document.addEventListener('pointerdown', onOutsidePress, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('click', onClick, true);
    // Düğmeye girerken mouseover gelmeyebiliyor (sayfada ölçüldü), pointermove her zaman geliyor.
    window.addEventListener('pointermove', onTipHover, { capture: true, passive: true });
    window.addEventListener('keydown', onStakeKey, true);
    window.addEventListener('input', onStakeInput, true);
    window.addEventListener('input', onPickInput, true);
    window.addEventListener('input', onPzInput, true);
    setInterval(pzTick, 1000);
    window.addEventListener('focusout', onStakeOut, true);
    document.documentElement.addEventListener('mouseleave', hideTip);
    window.addEventListener('scroll', onTipScroll, { capture: true, passive: true });
    observer = new MutationObserver((muts) => {
      if (muts.every((m) => m.target.closest?.(OWN))) return;
      try { quickRestore(); } catch (err) { console.error('[kupon-skor] hızlı geri koyma', err); }
      observer.takeRecords();
      pinRestore();
      scheduleRender();
    });
    window.addEventListener('scroll', onPinScroll, { passive: true });
    watchRoot(document.body);
    loadStore().then(scheduleRender);
    loadAliases();
    loadNotes();
    setInterval(loadNotes, 60000);
    const skPoll = () => { if (hasStore && chrome.runtime?.id) chrome.runtime.sendMessage({ type: 'skPoll', ids: [...trackedSk] }).catch(() => {}); };
    skPoll();
    // Veri servisinin sunucusu canlı veriyi 5-7 sn'de bir tazeliyor (sitenin kendi sayfası 30 sn'de bir soruyor): 8 sn.
    setInterval(skPoll, 8000);
    // Pencere açıkken canlı maç kendiliğinden yenilensin.
    setInterval(() => { if (peekOpen.size) renderPeekModal(); }, 5000);
    // Dakikalar SofaScore'daki devre başlangıcından hesaplanıyor; 30 sn'de bir yeniden çiz.
    setInterval(scheduleRender, 30000);
  }

  // Eklenti her sitede yüklenir (6q'nun ve bahis sağlayıcısının adresi değişebilir) ama sadece bu
  // sitenin Bahislerim ya da Özel Oranlar yapısı görülünce devreye girer. Başka sitelerde iki saniyede
  // bir bu seçiciye bakmaktan başka hiçbir şey yapmaz: sayfayı okumaz, gözlemlemez, depoya erişmez.
  const PAGE = `${BETS_PAGE}, article.special-odd-card .special-odd-pickline, article.sb-custom-bet-card, .sb-bets-view-head, .sb-mb`;
  const probe = setInterval(() => {
    if (!queryOne(PAGE)) return;
    clearInterval(probe);
    activate();
  }, 2000);
})();
