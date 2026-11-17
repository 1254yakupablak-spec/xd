// Sadece güncelleme: GitHub'daki son sürüm numarasına bakar, menüden istenince güncelleme sayfasını açar.
// GitHub'ın dosya sunucusu 5 dk önbellekte tutar: adrese ?t= eklenir, hep son hali gelir.
const UPDATE_BASE = 'https://raw.githubusercontent.com/1254yakupablak-spec/xd/main/eklenti/';

async function checkUpdate(force = false) {
  const { updateInfo = {} } = await chrome.storage.local.get('updateInfo');
  if (!force && Date.now() - (updateInfo.checkedAt || 0) < 10 * 60 * 1000) return updateInfo;
  let latest = updateInfo.latest || null;
  try {
    const res = await fetch(UPDATE_BASE + 'manifest.json?t=' + Date.now(), { cache: 'no-store', credentials: 'omit' });
    if (res.ok) latest = (await res.json())?.version || latest;
  } catch {
    // Bağlantı yok: eski bilgi kalır.
  }
  const info = { latest, checkedAt: Date.now() };
  await chrome.storage.local.set({ updateInfo: info });
  return info;
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'openUpdate') chrome.tabs.create({ url: chrome.runtime.getURL('update.html') });
  if (msg?.type === 'checkUpdate') {
    checkUpdate(!!msg.force).then(reply, () => reply(null));
    return true;
  }
  return false;
});

chrome.runtime.onStartup?.addListener(() => checkUpdate(true));
chrome.runtime.onInstalled.addListener(async () => {
  // Eski sürümlerin kayıtları (canlı skor, oranlar, notlar) artık kullanılmıyor.
  // 1xBet verisi, adresi ve kupon verisi korunur.
  const KEEP = ['updateInfo', 'xbetHost', 'xbetEvents', 'xbetOdds', 'xbetMeta', 'kkData'];
  const keep = await chrome.storage.local.get(KEEP);
  await chrome.storage.local.clear();
  await chrome.storage.local.set(keep);
  checkUpdate(true);
});
