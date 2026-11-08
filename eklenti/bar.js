// Veri sitelerinin (SofaScore, 1xBet) sayfasının üstünde çıkan "bu maç mı?" çubuğu. sofa.js ve
// xbet.js kullanır. Sadece fonksiyon tanımlar; kendi başına hiçbir şey yapmaz.
(() => {
  if (window.__kcsBar) return;
  let bar = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function text(html) {
    const s = document.createElement('span');
    s.innerHTML = html;
    s.style.minWidth = '0';
    return s;
  }

  function button(label, primary, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    Object.assign(b.style, {
      flex: 'none', padding: '6px 12px', border: '0', borderRadius: '8px', cursor: 'pointer', font: 'inherit', fontWeight: '700',
      background: primary ? '#16a34a' : 'rgba(255,255,255,.1)', color: '#fff',
    });
    b.addEventListener('click', onClick);
    return b;
  }

  function select(options) {
    const e = document.createElement('select');
    Object.assign(e.style, {
      flex: '0 1 280px', minWidth: '0', padding: '6px 8px', border: '1px solid rgba(255,255,255,.2)', borderRadius: '8px',
      background: '#1e202f', color: '#fff', font: 'inherit',
    });
    for (const [value, label] of options) e.add(new Option(label, value));
    return e;
  }

  function close() {
    bar?.remove();
    bar = null;
  }

  function show(parts) {
    close();
    bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: '2147483000',
      display: 'flex', alignItems: 'center', gap: '10px', maxWidth: 'calc(100vw - 32px)', padding: '10px 14px',
      borderRadius: '12px', background: '#0f172a', color: '#e8eef8', boxShadow: '0 12px 32px rgba(0,0,0,.45)',
      font: '13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    });
    const mark = document.createElement('span');
    mark.title = 'KOKLEYİCİ SPORTS eklentisi';
    mark.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" style="display:block"><defs><linearGradient id=\"kcsg\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#d9ff73\"/><stop offset=\"1\" stop-color=\"#8fd61f\"/></linearGradient><clipPath id=\"kcsb\"><circle cx=\"13.6\" cy=\"12\" r=\"6.3\"/></clipPath></defs><rect x=\"1\" y=\"1\" width=\"22\" height=\"22\" rx=\"6\" fill=\"url(#kcsg)\"/><g stroke=\"#0b0f14\" stroke-width=\"1.7\" stroke-linecap=\"round\"><path d=\"M3.4 9h2.4M2.6 12h3.2M3.4 15h2.4\"/></g><circle cx=\"13.6\" cy=\"12\" r=\"6.3\" fill=\"#fff\"/><g clip-path=\"url(#kcsb)\" fill=\"#0b0f14\"><path d=\"M13.6 9.6 15.88 11.26 15.01 13.94 12.19 13.94 11.32 11.26Z\"/><path d=\"M13.6 5.2 15.2 6.4 13.6 7.4 12 6.4Z\"/><path d=\"M20.4 10.2 19.6 12.3 18.4 10.6 19.3 8.9Z\"/><path d=\"M18.3 18.2 16.2 18.4 16.9 16.5 18.9 16.1Z\"/><path d=\"M8.9 18.2 11 18.4 10.3 16.5 8.3 16.1Z\"/><path d=\"M6.8 10.2 7.6 12.3 8.8 10.6 7.9 8.9Z\"/></g><g stroke=\"#0b0f14\" stroke-width=\"0.9\" stroke-linecap=\"round\" clip-path=\"url(#kcsb)\"><path d=\"M13.6 9.6V7.2M15.88 11.26 18.5 10.4M15.01 13.94 16.6 16.3M12.19 13.94 10.6 16.3M11.32 11.26 8.7 10.4\"/></g><circle cx=\"13.6\" cy=\"12\" r=\"6.3\" fill=\"none\" stroke=\"#0b0f14\" stroke-width=\"1.3\"/></svg>';
    mark.style.flex = 'none';
    bar.append(mark);
    for (const p of parts) bar.append(p);
    document.documentElement.append(bar);
  }

  const slugify = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i').replace(/ø/g, 'o').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Listede olmayan maç: adlar sayfa başlığından ("Ev - Deplasman ..."), adresteki adlarla tutuyorsa; olmazsa adresin tamamı.
  function guessEvent(id, slug) {
    const words = slug.replace(/^\d+-/, '');
    const t = document.title.match(/^\s*(.+?)\s+(?:[-–—]|vs\.?)\s+(.+?)(?:\s+[|:,(]|\s+[-–—]\s|$)/i);
    // Başlıkta adın ardından gelen kelimeler ("Almere City Betting") atılır: adreste geçen son kelimeye kadar alınır.
    const trim = (x) => {
      const parts = x.trim().split(/\s+/);
      let last = -1;
      parts.forEach((p, i) => { const w = slugify(p); if (w.length >= 2 && words.includes(w)) last = i; });
      return parts.slice(0, last + 1).join(' ');
    };
    const home = t ? trim(t[1]) : '';
    const away = t ? trim(t[2]) : '';
    const named = home && away;
    return {
      id, home: named ? home : words.replace(/-/g, ' '), away: named ? away : '—',
      start: null, league: '', homeEng: '', awayEng: '', seenAt: Date.now(), guess: true,
    };
  }

  const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

  // Özel oranlardan "siteye git": sayfa bekleyen bir istek (bookPick) bırakır. İstek yoksa, açılan maç hiçbir karta
  // bağlı değilse bulunamayan kartlardan seçtirilir (kullanıcı maçı sitede kendisi bulduysa). Kullanıcı sitede bir maçın sayfasını
  // açınca üstte "Özel oranlardaki X bu maç mı?" çubuğu çıkar. "Bağla" maçı o karta bağlar ve takım adları öğrenilir;
  // maç sayfasının yüklediği oranlar karta gelir.
  // pageEvent(): { onMatch, e }, oddsOf(id): maçın oranları, flush(): okuyucunun verisini hemen kaydeder.
  function watchPick({ book, name, pageEvent, oddsOf, flush }) {
    const PICK_TTL_MS = 30 * 60 * 1000;
    let pickFor = '';
    let linked = null; // { id, pick, until } — bağlandıktan sonra oran gelene kadar çubukta göster
    const dismissed = new Set(); // kapatılan maçlar için bir daha sorma

    function counterText(id, pick) {
      if (pick.kind === 'btts') {
        const other = pick.side === 'yes' ? 'no' : 'yes';
        const o = oddsOf(id)?.btts?.[other];
        const label = `KG ${other === 'yes' ? 'Var' : 'Yok'}`;
        return o ? `${label}: <b>${o}</b>` : `${label} oranı henüz gelmedi`;
      }
      const other = pick.side === 'under' ? 'over' : 'under';
      const rec = oddsOf(id);
      const table = pick.team === 'home' || pick.team === 'away' ? rec?.[pick.team] : (pick.team ? null : rec?.lines);
      const o = table?.[String(pick.line)]?.[other];
      const label = `${other === 'over' ? 'Üst' : 'Alt'} ${pick.line}`;
      return o ? `${label}: <b>${o}</b>` : `${label} oranı henüz gelmedi (sayfada Toplam pazarı yüklenince gelir)`;
    }

    function showLinked(e) {
      const tabId = linked?.pick.tabId;
      show([
        text(`✓ Bağlandı: ${esc(e.home)} - ${esc(e.away)} · ${counterText(linked.id, linked.pick)}`),
        ...(tabId == null ? [] : [button('Özel oranlara dön', true, () => chrome.runtime.sendMessage({ type: 'backToCoupon', tabId }))]),
        button('Kapat', false, () => { linked = null; close(); }),
      ]);
    }

    // Kartla açık maçın adlarında kaç ortak kelime var (benzeyen kart önce gelsin diye).
    const wordsOf = (x) => new Set(String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
    const overlap = (a, set) => [...wordsOf(a)].filter((w) => set.has(w)).length;

    // Yönlendirme olmadan açılan maç sayfası: maç henüz bir karta bağlı değilse bulunamayan kartlardan seçtirir.
    async function offerCards(e) {
      if (dismissed.has(e.id)) return;
      const key = `${book}Want`;
      const { [key]: want = [] } = await chrome.storage.local.get(key);
      const sig = `liste|${e.id}|${want.filter((w) => w.pick).map((w) => w.key).join(',')}`;
      if (sig === pickFor) return;
      if (want.some((w) => w.id != null && String(w.id) === String(e.id))) { if (pickFor) close(); pickFor = ''; return; }
      const names = wordsOf(`${e.home} ${e.away}`);
      const cards = want.filter((w) => w.pick).sort((a, b) => overlap(b.pick.match, names) - overlap(a.pick.match, names));
      if (!cards.length) { if (pickFor) close(); pickFor = ''; return; }
      pickFor = sig;
      const box = select(cards.map((w) => [w.key, w.pick.match]));
      show([
        text(`Bu maç hangi özel oran? <span style="color:#8b9ab3">${esc(e.home)} - ${esc(e.away)}</span>`),
        box,
        button('Bağla', true, () => link(e, cards.find((w) => w.key === box.value).pick)),
        button('Kapat', false, () => { dismissed.add(e.id); pickFor = ''; close(); }),
      ]);
    }

    async function link(e, pick) {
      await flush();
      const { arbLinks = {} } = await chrome.storage.local.get('arbLinks');
      await chrome.storage.local.set({
        arbLinks: { ...arbLinks, [book]: { ...(arbLinks[book] || {}), [pick.cardKey]: e.id } },
        // Özel oranlar sayfası bu maçtan takım adlarını öğrenir.
        arbLearnReq: { book, cardKey: pick.cardKey, id: e.id, at: Date.now() },
      });
      await chrome.storage.local.remove('bookPick');
      linked = { id: e.id, pick, until: Date.now() + 2 * 60 * 1000, e, path: location.pathname };
      showLinked(e);
    }

    async function check() {
      if (linked) {
        // Başka maça geçildiyse "bağlandı" yazısı beklemez: o maç için tekrar sorulur.
        const moved = location.pathname !== linked.path;
        if (Date.now() > linked.until || moved) {
          linked = null;
          pickFor = '';
          close();
          if (!moved) return;
        } else {
          showLinked(linked.e);
          return;
        }
      }
      const { bookPick: pick } = await chrome.storage.local.get('bookPick');
      const { onMatch, e } = pageEvent();
      if (!pick || pick.book !== book || Date.now() - pick.at > PICK_TTL_MS) {
        if (onMatch && e) { await offerCards(e); return; }
        if (pickFor) close();
        pickFor = '';
        return;
      }
      const sig = `${pick.cardKey}|${location.pathname}|${e?.id ?? ''}`;
      if (sig === pickFor) return;
      pickFor = sig;
      const card = `<b>${esc(pick.match)}</b>${pick.time ? ` (${esc(pick.time)})` : ''}`;
      const cancel = async () => { await chrome.storage.local.remove('bookPick'); pickFor = ''; close(); };
      if (!onMatch) {
        show([text(`${card} için ${esc(name)}'te maçın sayfasını aç.`), button('Vazgeç', false, cancel)]);
        return;
      }
      if (!e) {
        // Maç sayfası açıldı ama maçın verisi daha gelmedi; sonraki yoklamada tekrar bakılır.
        pickFor = '';
        show([text(`${card} · bu maçın bilgisi yükleniyor…`), button('Vazgeç', false, cancel)]);
        return;
      }
      const info = [when(e.start), e.league].filter(Boolean).map(esc).join(' · ');
      show([
        text(`${card} bu maç mı? <span style="color:#8b9ab3">${esc(e.home)} - ${esc(e.away)}${info ? ` · ${info}` : ''}</span>`),
        button('Bağla', true, () => link(e, pick)),
        button('Vazgeç', false, cancel),
      ]);
    }

    // Siteler tek sayfa: adres değişince ve iki saniyede bir bak (maç verisi sonradan gelir).
    setInterval(() => { if (chrome.runtime?.id) check().catch(() => {}); }, 2000);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.bookPick) { pickFor = ''; check().catch(() => {}); }
    });
  }

  window.__kcsBar = { esc, text, button, show, close, when, watchPick, slugify, guessEvent };
})();
