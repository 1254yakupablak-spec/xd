// Eklenti menüsü: sürüm, güncelleme sayfası, 1xBet durumu ve ayna adresi.
const $ = (id) => document.getElementById(id);
const current = chrome.runtime.getManifest().version;
$('version').textContent = current;
$('cur').textContent = current;
$('open-update').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openUpdate' }));
chrome.runtime.sendMessage({ type: 'checkUpdate', force: true }, (info) => {
  $('latest').textContent = info?.latest || '—';
});

(async () => {
  const s = await chrome.storage.local.get(['xbetMeta', 'xbetEvents', 'xbetOdds', 'xbetHost']);
  const m = s.xbetMeta || {};
  const open = Date.now() - (m.updatedAt || 0) < 2 * 60 * 1000;
  $('xb-state').textContent = open ? 'bağlı' : 'sekme kapalı';
  $('xb-state').style.color = open ? '#7ed321' : '#f87171';
  $('xb-events').textContent = `${(s.xbetEvents || []).length} maç · ${Object.keys(s.xbetOdds || {}).length} oranlı`;
  $('xb-auto').textContent = m.auto?.search ? (m.auto?.game ? 'açık' : 'arama açık, bir maç sayfası aç') : 'bir kez arama yap';
  $('xbet-host').value = s.xbetHost || '';
  $('xbet-host-save').addEventListener('click', async () => {
    const host = $('xbet-host').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (host) await chrome.storage.local.set({ xbetHost: host });
    else await chrome.storage.local.remove('xbetHost');
    $('xbet-host-note').textContent = host ? `Kaydedildi: ${host}. O sekmeyi yenile.` : 'Silindi.';
  });
})();
