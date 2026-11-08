// Güncelleme sayfası: son sürümün dosyalarını GitHub'dan alıp eklentinin klasörüne yazar.
// Klasörden yüklenen eklenti kendi klasörüne yazamaz; kullanıcı klasörü bir kez seçer (File System Access),
// izni tarayıcı hatırlar. Dosyalar yazılınca kullanıcı Uzantılar sayfasından eklentiyi yeniler.
const UPDATE_BASE = 'https://raw.githubusercontent.com/1254yakupablak-spec/xd/main/eklenti/';
const $ = (id) => document.getElementById(id);
const current = chrome.runtime.getManifest().version;
let folder = null;
let latest = null;

const newer = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

function setStatus(text, bad = false) {
  $('status').textContent = text;
  $('status').classList.toggle('is-bad', bad);
}

// Seçilen klasör IndexedDB'de saklanır (tarayıcı klasör tutamacını orada saklamaya izin veriyor).
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('kcs-update', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kv(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
    const req = value === undefined ? tx.objectStore('kv').get(key) : tx.objectStore('kv').put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readManifest(dir) {
  try {
    const f = await (await dir.getFileHandle('manifest.json')).getFile();
    return JSON.parse(await f.text());
  } catch {
    return null;
  }
}

function showFolder() {
  $('folder-text').textContent = folder
    ? `Seçili klasör: ${folder.name}. Başka bir klasör seçmek için düğmeye bas.`
    : 'Güncelleme dosyaları doğrudan eklentinin klasörüne yazılır. İlk seferde eklentiyi yüklediğin klasörü bir kez seç (içinde manifest.json olan klasör).';
  $('pick').textContent = folder ? 'Başka klasör seç' : 'Klasörü seç';
  $('update').disabled = !folder || !latest;
  $('update').textContent = latest && !newer(latest, current) ? 'Yeniden indir' : 'Güncelle';
}

async function pickFolder() {
  try {
    const dir = await window.showDirectoryPicker({ id: 'kokleyici', mode: 'readwrite' });
    const m = await readManifest(dir);
    if (!m || m.name !== 'KOKLEYİCİ SPORTS') {
      setStatus('Bu klasörde KOKLEYİCİ SPORTS eklentisinin manifest.json dosyası yok. Eklentiyi yüklediğin klasörü seç.', true);
      return;
    }
    if (m.version !== current) setStatus(`Uyarı: klasördeki sürüm ${m.version}, yüklü olan ${current}. Doğru klasör olduğundan emin ol.`, true);
    else setStatus('');
    folder = dir;
    await kv('folder', dir);
    showFolder();
  } catch (err) {
    if (err?.name !== 'AbortError') setStatus(`Klasör seçilemedi: ${err?.message || err}`, true);
  }
}

async function writeFile(root, path, data) {
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function runUpdate() {
  if (!folder) return;
  $('update').disabled = true;
  try {
    if ((await folder.queryPermission({ mode: 'readwrite' })) !== 'granted'
      && (await folder.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      setStatus('Klasöre yazma izni verilmedi.', true);
      return;
    }
    const m = await readManifest(folder);
    if (!m || m.name !== 'KOKLEYİCİ SPORTS') { setStatus('Seçili klasörde eklenti yok. Klasörü yeniden seç.', true); return; }
    setStatus('Dosya listesi alınıyor…');
    const list = await (await fetch(`${UPDATE_BASE}files.json`, { cache: 'no-store' })).json();
    const files = (list.files || []).filter((p) => typeof p === 'string' && /^[\w./-]+$/.test(p) && !p.includes('..'));
    if (!files.includes('manifest.json')) throw new Error('dosya listesi eksik');
    // Önce hepsi indirilir; biri bile inmezse klasöre hiçbir şey yazılmaz.
    const got = [];
    $('progress').hidden = false;
    for (const [i, p] of files.entries()) {
      setStatus(`İndiriliyor: ${p}`);
      const res = await fetch(`${UPDATE_BASE}${p}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${p} indirilemedi (${res.status})`);
      got.push([p, await res.arrayBuffer()]);
      $('progress').firstElementChild.style.width = `${Math.round(((i + 1) / files.length) * 50)}%`;
    }
    // manifest.json en son yazılır: yarıda kalırsa eklenti eski sürüm numarasıyla kalır.
    got.sort((a, b) => (a[0] === 'manifest.json') - (b[0] === 'manifest.json'));
    for (const [i, [p, data]] of got.entries()) {
      setStatus(`Yazılıyor: ${p}`);
      await writeFile(folder, p, data);
      $('progress').firstElementChild.style.width = `${50 + Math.round(((i + 1) / got.length) * 50)}%`;
    }
    setStatus(`${got.length} dosya yazıldı. Sürüm ${list.version || latest}.`);
    $('done').hidden = false;
  } catch (err) {
    setStatus(`Güncelleme yapılamadı: ${err?.message || err}`, true);
  } finally {
    $('update').disabled = !folder;
  }
}

async function init() {
  $('current').textContent = current;
  try {
    folder = (await kv('folder')) || null;
  } catch { folder = null; }
  try {
    const m = await (await fetch(`${UPDATE_BASE}manifest.json`, { cache: 'no-store' })).json();
    latest = m.version;
    $('latest').textContent = latest;
    $('latest').classList.toggle('is-new', newer(latest, current));
    setStatus(newer(latest, current) ? 'Yeni sürüm var.' : 'Eklenti güncel.');
    chrome.storage.local.set({ updateInfo: { latest, checkedAt: Date.now() } });
  } catch {
    $('latest').textContent = '—';
    setStatus('Son sürüm bilgisi alınamadı. İnternet bağlantısını kontrol et.', true);
  }
  showFolder();
}

$('pick').addEventListener('click', pickFolder);
$('update').addEventListener('click', runUpdate);
$('open-ext').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/' }));
init();
