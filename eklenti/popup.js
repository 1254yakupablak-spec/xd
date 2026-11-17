// Eklenti menüsü: sürüm ve güncelleme sayfası.
const $ = (id) => document.getElementById(id);
const current = chrome.runtime.getManifest().version;
$('version').textContent = current;
$('cur').textContent = current;
$('open-update').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openUpdate' }));
chrome.runtime.sendMessage({ type: 'checkUpdate', force: true }, (info) => {
  $('latest').textContent = info?.latest || '—';
});

