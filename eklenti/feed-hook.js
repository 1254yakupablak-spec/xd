// Bahis sitesi sekmelerinde (1xBet, Stake) sayfanın kendi içinde (MAIN world) çalışır. Sayfanın
// Fetch/XHR ile aldığı JSON yanıtlarının bir kopyasını eklentinin okuyucusuna (xbet.js / stake.js)
// iletir. Sayfanın isteklerini değiştirmez. Diğer sitelerde sadece xbet.js'in "bu seçilen 1xBet
// adresi" mesajını bekler, başka bir şey yapmaz.
//
// 1xBet'te ayrıca sayfanın kendi "arama" ve "maç" isteklerinin kalıbını öğrenir (adres + başlıklar).
// xbet.js isteyince (Özel Oranlar'daki maçları aramak için) bu kalıpla, sayfanın yapacağı isteğin
// aynısını atar; yanıtı da diğerleri gibi kopyalanıp xbet.js'e gider.

// 6q'da sadece sitenin kendi özel oran yanıtının kopyasına bakar (yeni istek atmaz, yanıtı değiştirmez): çok maçlı
// kuponların "TOPLAM GOL 8.5 ALT" çizgisi Bahislerim'de yazmadığı için content.js'e buradan iletilir.
(() => {
  if (!/(^|\.)6q[\w-]*\./i.test(location.hostname) || window.__kcsLineHook) return;
  window.__kcsLineHook = true;
  const LINE = /(\d{1,2}[.,]5)\s*(?:GOL\s*)?(ALT|ÜST|UST)(?![A-ZÇĞİÖŞÜa-zçğıöşü])/i;
  const URL_RE = /\/custom-bets(\/|\?|$)/;
  const found = [];
  const clean = (t) => t.replace(/\s*(\S+\s+MAÇ\s+)?(TOPLAM\s+)?(GOL\s+)?\d{1,2}[.,]5.*$/is, '').replace(/\s*(\S+\s+MAÇ\s+)?TOPLAM\s+GOL.*$/is, '').trim();
  const isMatches = (t) => (t.match(/\S-\S/g) || []).length >= 2;

  function walk(v, depth) {
    if (!v || typeof v !== 'object' || depth > 8) return;
    const strs = Object.values(v).filter((x) => typeof x === 'string');
    const title = strs.map(clean).find(isMatches);
    // Çizgi kuponun herhangi bir alanında olabilir (açıklama, seçenekler, ayaklar).
    const all = title ? JSON.stringify(v) : '';
    const m = title && !/KORNER|CORNER|KART/i.test(all) ? LINE.exec(all) : null;
    if (m) found.push({ title, line: m[1], side: m[2] });
    for (const x of Object.values(v)) walk(x, depth + 1);
  }
  const post = () => window.postMessage({ __kcsLines: found }, location.origin);
  function take(text) {
    try { walk(JSON.parse(text), 0); post(); } catch { /* JSON değil */ }
  }

  const realFetch = window.fetch;
  window.fetch = function (...args) {
    const p = realFetch.apply(this, args);
    const url = String(args[0]?.url || args[0]);
    if (URL_RE.test(url)) p.then((res) => res.clone().text()).then(take).catch(() => {});
    return p;
  };
  const realOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (URL_RE.test(String(url))) this.addEventListener('load', () => take(this.responseText));
    return realOpen.call(this, method, url, ...rest);
  };
  // content.js sayfa yüklendikten sonra başlar; kaçırdığını ister.
  window.addEventListener('message', (ev) => {
    if (ev.source === window && ev.data?.__kcsLinesReq && found.length) post();
  });
})();

(() => {
  if (window.__kcsFeedHook) return;
  // Bilinen adresler hemen; menüden seçilen 1xBet adresinde xbet.js haber verince (ve sonraki
  // açılışlarda, o sitede bıraktığı işaretle hemen) devreye girer.
  let flagged = false;
  try { flagged = localStorage.getItem('kcsFeedHook') === '1'; } catch { /* erişim yok */ }
  if (flagged || /(^|\.)(1xbet|stake)[\w-]*\./i.test(location.hostname)) {
    install();
  } else {
    window.addEventListener('message', (ev) => {
      if (ev.source === window && ev.data?.__kcsHookOn) install();
    });
  }

  function install() {
    if (window.__kcsFeedHook) return;
    window.__kcsFeedHook = true;

    // Maçla ilgisiz dosyalar (sözlük, analitik, ikon, stil, betik).
    const SKIP = /genfiles|dictionary|analytics|fatman|sys-icons|licenses|\.svg|\.png|\.css|\.js(\?|$)/i;
    const MAX_CHARS = 3_000_000;
    const isXbet = !/(^|\.)stake[\w-]*\./i.test(location.hostname);

    function forward(url, op, data) {
      try {
        window.postMessage({ __kcsFeed: true, url: String(url), op, data }, location.origin);
      } catch {
        // İletilemeyen (klonlanamayan) veri: yok say.
      }
    }

    function forwardText(url, op, text) {
      if (!text || text.length > MAX_CHARS || !/^\s*[{[]/.test(text)) return;
      try { forward(url, op, JSON.parse(text)); } catch { /* JSON değil */ }
    }

    // GraphQL isteklerinde (Stake) adres hep aynı; hangi sorgu olduğunu gövdeden al.
    function opName(body) {
      if (typeof body !== 'string') return '';
      return body.match(/"operationName"\s*:\s*"([^"]+)"/)?.[1] || body.match(/query\s+(\w+)/)?.[1] || '';
    }

    // ---------- 1xBet: arama / maç isteği kalıbı ----------
    // search: adresinde "search" geçen, metin parametreli GET (ör. ...?text=galatasaray).
    // game: adresinde "game" geçen, maç numarası parametreli GET (ör. GetGameZip?id=236548963).
    // Sayfanın yenilenmesinden sonra da kullanılsın diye bu sitenin localStorage'ında tutulur.
    const TPL_KEY = 'kcsTpl';
    let tpl = {};
    try { tpl = JSON.parse(localStorage.getItem(TPL_KEY) || '{}') || {}; } catch { tpl = {}; }
    // Canlı maç isteği maç öncesi maçlarda boş döner: ikisi ayrı tutulur (eski kayıt da ayrılır).
    // gameInfo maçın künyesi, oran vermez: maç isteği olarak öğrenilmez.
    const NOT_ODDS = /info|stat|h2h|preview/i;
    if (NOT_ODDS.test(tpl.game?.path || '')) delete tpl.game;
    if (NOT_ODDS.test(tpl.gameLive?.path || '')) delete tpl.gameLive;
    if (/live/i.test(tpl.game?.path || '')) { tpl.gameLive = tpl.game; delete tpl.game; }
    const swapFeed = (url, live) => (live
      ? url.replace(/main-line-feed/, 'main-live-feed').replace(/LineFeed/, 'LiveFeed')
      : url.replace(/main-live-feed/, 'main-line-feed').replace(/LiveFeed/, 'LineFeed'));

    function headersOf(h) {
      const out = {};
      if (!h) return out;
      if (h instanceof Headers) h.forEach((v, k) => { out[k] = v; });
      else if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
      else if (typeof h === 'object') Object.assign(out, h);
      return out;
    }

    function tellTpl() {
      window.postMessage({ __kcsTpl: { search: !!tpl.search, game: !!(tpl.game || tpl.gameLive), searchPath: tpl.search?.path || '', gamePath: [tpl.game?.path, tpl.gameLive?.path].filter(Boolean).join(' + ') } }, location.origin);
    }

    function learnTpl(url, method, headers) {
      if (!isXbet || String(method || 'GET').toUpperCase() !== 'GET') return;
      let u;
      try { u = new URL(url, location.href); } catch { return; }
      if (u.origin !== location.origin) return;
      const params = [...u.searchParams];
      let kind = null;
      let param = null;
      if (/search/i.test(u.pathname)) {
        param = params.find(([k, v]) => /^(text|q|query|term|searchtext|search|str|name)$/i.test(k) && v.trim().length >= 2)?.[0];
        kind = param ? 'search' : null;
      } else if (/game/i.test(u.pathname) && !NOT_ODDS.test(u.pathname)) {
        param = params.find(([k, v]) => /^(id|gameid|eventid|game|i)$/i.test(k) && /^\d{6,}$/.test(v))?.[0];
        kind = param ? 'game' : null;
      }
      if (!kind) return;
      const slot = kind === 'game' && /live/i.test(u.pathname) ? 'gameLive' : kind;
      tpl[slot] = { url: u.href, param, path: u.pathname, headers, at: Date.now() };
      try { localStorage.setItem(TPL_KEY, JSON.stringify(tpl)); } catch { /* yer yok */ }
      tellTpl();
    }

    // xbet.js'ten: { __kcsRun: { kind: 'search' | 'game', value } } → kalıpla aynı isteği at.
    if (isXbet) {
      window.addEventListener('message', (ev) => {
        const run = ev.source === window && ev.data?.__kcsRun;
        if (run === true) { tellTpl(); return; }
        if (!run) return;
        // Maçın durumuna uyan kalıp; yoksa diğerinin adresi canlı/maç öncesi akışa çevrilir.
        const own = run.kind === 'game' ? tpl[run.live ? 'gameLive' : 'game'] : tpl[run.kind];
        const other = run.kind === 'game' ? tpl[run.live ? 'game' : 'gameLive'] : null;
        const t = own || other;
        if (!t) return;
        const u = new URL(own ? t.url : swapFeed(t.url, run.live));
        u.searchParams.set(t.param, String(run.value));
        window.fetch(u.href, { credentials: 'include', headers: t.headers || {} }).catch(() => {});
      });
      setTimeout(tellTpl, 1000);
    }

    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const a = args[0];
        const url = typeof a === 'string' ? a : (a?.url || String(a));
        const op = opName(args[1]?.body);
        if (res.ok && !SKIP.test(url)) {
          res.clone().text().then((t) => forwardText(url, op, t), () => {});
          learnTpl(url, args[1]?.method || a?.method, headersOf(args[1]?.headers || a?.headers));
        }
      } catch {
        // Yakalama hatası sayfayı etkilemesin.
      }
      return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__kcsUrl = String(url);
      this.__kcsMethod = method;
      this.__kcsHeaders = {};
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (this.__kcsHeaders) this.__kcsHeaders[k] = v;
      return origSetHeader.call(this, k, v);
    };
    XMLHttpRequest.prototype.send = function (body) {
      const url = this.__kcsUrl;
      if (url && !SKIP.test(url)) {
        const op = opName(body);
        this.addEventListener('load', () => {
          if (this.status < 200 || this.status >= 300) return;
          if (this.responseType === 'json') forward(url, op, this.response);
          else if (this.responseType === '' || this.responseType === 'text') forwardText(url, op, this.responseText);
          learnTpl(url, this.__kcsMethod, this.__kcsHeaders);
        });
      }
      return origSend.call(this, body);
    };
  }
})();
