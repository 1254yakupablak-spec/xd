// Öğrenilenler: elle bağlanan maçlar ve bunlardan öğrenilen takım adları. Menüden dışa/içe aktarılır,
// eklenti klasöründeki learned.json da kurulumda/güncellemede bunlara eklenir (paylaşılan paket için).
// Birleştirirken kendi kayıtların her zaman öne geçer; gelen dosya sadece eksikleri doldurur.
const LEARN_KEYS = {
  learnedSides: 'flat', // kupondaki takım yazısı → SofaScore takım adı
  overrides: 'flat',    // kupon yazısı → SofaScore maç no
  arbLearned: 'book',   // { xbet|stake: { kart yazısı parçası → sitedeki takım adı } }
  arbLinks: 'book',     // { xbet|stake: { kart anahtarı → sitedeki maç no } }
};

function mergeLearned(mine, incoming) {
  const out = {};
  for (const [key, kind] of Object.entries(LEARN_KEYS)) {
    const a = mine?.[key] || {};
    const b = incoming?.[key];
    if (!b || typeof b !== 'object') { out[key] = a; continue; }
    if (kind === 'flat') {
      out[key] = { ...b, ...a };
    } else {
      out[key] = { ...a };
      for (const [book, map] of Object.entries(b)) {
        if (map && typeof map === 'object') out[key][book] = { ...map, ...(a[book] || {}) };
      }
    }
  }
  return out;
}

function countLearned(data) {
  let n = 0;
  for (const [key, kind] of Object.entries(LEARN_KEYS)) {
    const v = data?.[key] || {};
    n += kind === 'flat' ? Object.keys(v).length : Object.values(v).reduce((s, m) => s + Object.keys(m || {}).length, 0);
  }
  return n;
}

async function importLearned(incoming) {
  const mine = await chrome.storage.local.get(Object.keys(LEARN_KEYS));
  const merged = mergeLearned(mine, incoming);
  await chrome.storage.local.set(merged);
  return countLearned(merged) - countLearned(mine);
}
