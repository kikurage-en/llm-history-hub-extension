export function isValidRecord(rec) {
  return rec !== null
    && typeof rec === 'object'
    && typeof rec.id === 'string' && rec.id.length > 0
    && typeof rec.service === 'string' && rec.service.length > 0
    && typeof rec.url === 'string' && rec.url.length > 0;
}

function normalizeUpdatedAt(rec) {
  const n = Number(rec.updatedAt);
  return Number.isFinite(n) ? n : 0;
}

// favorite フィールドの解決ルール:
// - 新規レコード (prev なし): incoming.favorite が boolean なら採用、それ以外は false
// - 既存あり + source='sync' (既定): 既存値を必ず維持。同期は incoming.favorite を見ない。
// - 既存あり + source='import': incoming.favorite が boolean なら上書き、undefined / 非 boolean なら既存値維持。
//   旧 JSON (favorite フィールド無し) を読み込んでも既存お気に入りが消えない。
function resolveFavorite(prev, rec, source) {
  if (!prev) {
    return (typeof rec.favorite === 'boolean') ? rec.favorite : false;
  }
  const prevFav = (typeof prev.favorite === 'boolean') ? prev.favorite : false;
  if (source === 'import' && typeof rec.favorite === 'boolean') {
    return rec.favorite;
  }
  return prevFav;
}

export function mergeRecords(existing, incoming, options) {
  if (!Array.isArray(existing)) {
    throw new TypeError('mergeRecords: existing must be an array');
  }
  if (!Array.isArray(incoming)) {
    throw new TypeError('mergeRecords: incoming must be an array');
  }

  const opts = (options !== null && typeof options === 'object') ? options : {};
  // source='import' のみ favorite 上書きを許可。それ以外 (省略 / 'sync' / 不明値) は同期経路扱い。
  const source = opts.source === 'import' ? 'import' : 'sync';

  const stats = { created: 0, updated: 0, unchanged: 0, invalid: 0 };
  const map = new Map();

  for (const rec of existing) {
    if (isValidRecord(rec)) {
      map.set(rec.id, { ...rec, updatedAt: normalizeUpdatedAt(rec) });
    }
  }

  for (const rec of incoming) {
    if (!isValidRecord(rec)) {
      stats.invalid += 1;
      continue;
    }
    const normalized = { ...rec, updatedAt: normalizeUpdatedAt(rec) };
    const prev = map.get(rec.id);
    const favorite = resolveFavorite(prev, rec, source);
    if (!prev) {
      map.set(rec.id, { ...normalized, favorite });
      stats.created += 1;
    } else if (normalized.updatedAt > prev.updatedAt) {
      map.set(rec.id, { ...normalized, favorite });
      stats.updated += 1;
    } else if (normalized.updatedAt === prev.updatedAt) {
      map.set(rec.id, { ...normalized, favorite });
      stats.unchanged += 1;
    } else {
      // 既存の方が新しい場合でも、import 経路で incoming.favorite があれば favorite だけは反映する。
      map.set(rec.id, { ...prev, favorite });
      stats.unchanged += 1;
    }
  }

  return { merged: Array.from(map.values()), stats };
}
