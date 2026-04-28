import { openDB, readAll, upsert } from '../lib/db.js';
import { isValidRecord, mergeRecords } from '../lib/merge.js';
import { recordsToJson, recordsToCsv, parseJsonImport } from '../lib/io.js';
import { t, applyI18n, setHtmlLang } from '../lib/i18n.js';

console.log('[LLM History Hub] popup booted');

// 同期 / 削除ダイアログで扱うサービス識別子の固定列。chip / アカウント select の集計とも揃える。
// background.js の SYNC_SELECTIVE / DELETE_SELECTIVE への payload にそのまま渡す。
// 順序: Google プロダクト同士 (Gemini と GoogleAI) を隣接配置で UI グルーピングを示す。
export const ALL_SERVICES = ['chatgpt', 'claude', 'gemini', 'googleai', 'grok', 'xgrok'];

// ---------------- popup module-scope 状態 ----------------

let cachedRecords = [];

// null / [] のまま (取得失敗 or 未ログイン) なら不一致判定をスキップ。
let currentAccounts = { chatgpt: null, claude: [], gemini: null, googleai: null, grok: null, xgrok: null };

// dateFrom / dateTo は epoch ms (number) または null（未指定 = フィルタ無効）。
// sortDir は 'desc' (新→古、既定) | 'asc' (古→新)。
// datePresetKey はプリセット chip ハイライト用 ('7d' | '30d' | 'all' | 'custom')。
// 起動時は 'all'（dateFrom/dateTo 共に null）で「全期間」chip をハイライトする。
let filterState = {
  service: 'all',
  account: 'all',
  query: '',
  dateFrom: null,
  dateTo: null,
  sortDir: 'desc',
  datePresetKey: 'all',
  // ♥ chip 選択時に true。他サービス chip と排他で、true のとき r.favorite===true のみ通す。
  favoriteOnly: false,
};

// 連続同期で前回をキャンセルするための setTimeout ハンドル。
let statusTimerId = null;

// ---------------- 純関数 ----------------

function ymd(epochMs) {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '0000-00-00';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// sortDir: 'desc' (既定) | 'asc'。不正値は 'desc' フォールバック。
// 同日内 updatedAt 同値時は id 文字列で 2 次キーソート（X-Grok は時分秒なしで揃うため）。
export function groupByYMD(records, sortDir) {
  const dir = (sortDir === 'asc') ? 'asc' : 'desc';
  const groups = new Map();
  for (const rec of records) {
    const updatedAt = Number(rec.updatedAt) || 0;
    const key = ymd(updatedAt);
    let group = groups.get(key);
    if (!group) {
      group = { key, maxUpdatedAt: updatedAt, records: [] };
      groups.set(key, group);
    } else if (updatedAt > group.maxUpdatedAt) {
      group.maxUpdatedAt = updatedAt;
    }
    group.records.push(rec);
  }

  const sorted = Array.from(groups.values()).sort((a, b) => (
    dir === 'asc'
      ? a.maxUpdatedAt - b.maxUpdatedAt
      : b.maxUpdatedAt - a.maxUpdatedAt
  ));

  for (const group of sorted) {
    group.records.sort((a, b) => {
      const av = Number(a.updatedAt) || 0;
      const bv = Number(b.updatedAt) || 0;
      if (av !== bv) {
        return dir === 'asc' ? av - bv : bv - av;
      }
      const aid = typeof a.id === 'string' ? a.id : '';
      const bid = typeof b.id === 'string' ? b.id : '';
      if (aid === bid) return 0;
      return dir === 'asc'
        ? (aid < bid ? -1 : 1)
        : (aid < bid ? 1 : -1);
    });
  }

  const ordered = new Map();
  for (const group of sorted) {
    ordered.set(group.key, group);
  }
  return ordered;
}

// 日付プリセット keyword から { dateFrom, dateTo } (epoch ms) を計算する純関数。
// preset='7d' | '30d': 今日含む N 日間（ローカル today 00:00 〜 today 23:59:59.999）。
// preset='all': 両方 null（全期間）。
// 不明値は 'all' と同等で両方 null を返す。nowMs はテスト用に渡せる（既定 Date.now()）。
export function computeDatePreset(preset, nowMs) {
  const now = (typeof nowMs === 'number' && Number.isFinite(nowMs)) ? nowMs : Date.now();
  if (preset !== '7d' && preset !== '30d') {
    return { dateFrom: null, dateTo: null };
  }
  const days = preset === '7d' ? 7 : 30;
  const d = new Date(now);
  const todayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  const fromDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1), 0, 0, 0, 0).getTime();
  return { dateFrom: fromDay, dateTo: todayEnd };
}

// `<input type="date">` の value (yyyy-mm-dd) を epoch ms に変換する純関数。
// isEnd=true で当日 23:59:59.999、false で当日 00:00 のローカル時刻 epoch ms を返す。
// 不正値（空文字 / 範囲外 / 形式不一致）は null。
export function parseDateInputValue(value, isEnd) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  const ms = isEnd === true
    ? new Date(y, mo - 1, d, 23, 59, 59, 999).getTime()
    : new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// groups (Map<ymd, { records }>) を一次元配列に flatten する純関数。
// 仮想スクロール側で各アイテムの cumulative position を測るために使う。
// `kind: 'heading'` は常時 DOM 残留、`kind: 'row'` は可視範囲 + バッファのみ DOM に存在。
export function flattenGroups(groups) {
  const out = [];
  if (!(groups instanceof Map)) return out;
  for (const [ymd, group] of groups) {
    out.push({ kind: 'heading', ymd });
    if (group && Array.isArray(group.records)) {
      for (const rec of group.records) {
        out.push({ kind: 'row', rec });
      }
    }
  }
  return out;
}

// service / account / query / 日付範囲 の AND 結合フィルタ。
// state.account は `${service}:${email}` 形式（'all' は無視）。
// state.query は小文字部分一致。
// state.dateFrom / state.dateTo は epoch ms (number) または null（未指定）。
// NaN / 文字列など不正値は null 扱い（日付フィルタを掛けない）。
// updatedAt が NaN のレコードは日付フィルタ指定時のみ除外（誤通過防止）。
export function applyFilters(records, state) {
  if (!Array.isArray(records)) return [];
  const s = (state !== null && typeof state === 'object') ? state : {};
  const svc = (typeof s.service === 'string') ? s.service : 'all';
  const acc = (typeof s.account === 'string') ? s.account : 'all';
  const q = (typeof s.query === 'string') ? s.query.toLowerCase() : '';
  const dateFrom = (typeof s.dateFrom === 'number' && Number.isFinite(s.dateFrom))
    ? s.dateFrom : null;
  const dateTo = (typeof s.dateTo === 'number' && Number.isFinite(s.dateTo))
    ? s.dateTo : null;
  // favoriteOnly は厳密 ===true 判定。undefined / 文字列等は false 扱い (旧呼び出し互換)。
  const favoriteOnly = s.favoriteOnly === true;
  return records.filter((r) => {
    if (!isValidRecord(r)) return false;
    if (svc !== 'all' && r.service !== svc) return false;
    if (acc !== 'all' && `${r.service}:${r.accountEmail}` !== acc) return false;
    if (favoriteOnly && r.favorite !== true) return false;
    if (q.length > 0) {
      const title = typeof r.title === 'string' ? r.title.toLowerCase() : '';
      if (!title.includes(q)) return false;
    }
    if (dateFrom !== null || dateTo !== null) {
      const ts = Number(r.updatedAt);
      if (!Number.isFinite(ts)) return false;
      if (dateFrom !== null && ts < dateFrom) return false;
      if (dateTo !== null && ts > dateTo) return false;
    }
    return true;
  });
}

// account select の選択肢を生成する純関数。
// `${service}:${email}` の unique セットを sort 済みで返す。
export function buildAccountOptions(records) {
  if (!Array.isArray(records)) return [];
  const set = new Set();
  for (const r of records) {
    if (!isValidRecord(r)) continue;
    if (typeof r.accountEmail !== 'string' || r.accountEmail.length === 0) continue;
    set.add(`${r.service}:${r.accountEmail}`);
  }
  return Array.from(set).sort();
}

export function countByService(records) {
  // favorite は service ではないが、♥ chip 件数表示のため counts に同居させる。
  const counts = { all: 0, chatgpt: 0, claude: 0, gemini: 0, googleai: 0, grok: 0, xgrok: 0, favorite: 0 };
  if (!Array.isArray(records)) return counts;
  for (const r of records) {
    if (!isValidRecord(r)) continue;
    counts.all += 1;
    if (Object.prototype.hasOwnProperty.call(counts, r.service) && r.service !== 'all' && r.service !== 'favorite') {
      counts[r.service] += 1;
    }
    if (r.favorite === true) {
      counts.favorite += 1;
    }
  }
  return counts;
}

export function countByAccount(records) {
  const counts = new Map();
  if (!Array.isArray(records)) return counts;
  for (const r of records) {
    if (!isValidRecord(r)) continue;
    if (typeof r.accountEmail !== 'string' || r.accountEmail.length === 0) continue;
    const key = `${r.service}:${r.accountEmail}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// chip 表示ラベル (「All」英字 + xgrok→「X」短縮の理由は docs/UI_DESIGN.md §件数バッジ)。
// favorite はハート記号 ♥ を擬似サービスとして扱う。
const CHIP_LABELS = {
  all: 'All',
  favorite: '♥',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  googleai: 'GoogleAI',
  grok: 'Grok',
  xgrok: 'X',
};

// lib/sync.js / lib/io.js / content/*.js は throw メッセージを `JSON.stringify({ code, service, ... })`
// 形式に統一している。ここで JSON.parse して errorInfo オブジェクト ({ code, service?, status?, detail? })
// に復号する。失敗時は code='unknown' で返す。
export function parseErrorInfo(errMsg) {
  if (typeof errMsg !== 'string' || errMsg.length === 0) {
    return { code: 'unknown', service: null, raw: '' };
  }
  try {
    const obj = JSON.parse(errMsg);
    if (obj !== null && typeof obj === 'object' && typeof obj.code === 'string') {
      return { ...obj, raw: errMsg };
    }
  } catch {
    // legacy / 非 JSON 文字列はそのまま raw として返す
  }
  return { code: 'unknown', service: null, raw: errMsg };
}

// errInfo.code から短縮表示を生成する。`code` 一覧は lib/sync.js / lib/io.js / content/*.js の
// throw 側と 1:1 対応。フォーマット `<svc>: ✕ <label>` は ja/en 共通 (`✕` は中立記号)、
// label 文言のみ messages.json で翻訳する。
export function shortenServiceError(svcName, errInfo) {
  const code = (errInfo !== null && typeof errInfo === 'object' && typeof errInfo.code === 'string')
    ? errInfo.code
    : 'unknown';
  if (code === 'http_error') {
    const status = (errInfo && typeof errInfo.status === 'number') ? errInfo.status : '?';
    return `${svcName}: ✕ HTTP ${status}`;
  }
  let labelKey;
  switch (code) {
    case 'not_logged_in': labelKey = 'statusLoginRequired'; break;
    case 'network_error': labelKey = 'statusNetworkError'; break;
    case 'tab_unreachable': labelKey = 'statusTabUnreachable'; break;
    case 'content_unreachable': labelKey = 'statusContentUnreachable'; break;
    case 'account_email_not_found':
    case 'screenname_not_found': labelKey = 'statusAccountUnknown'; break;
    case 'pfp_not_found':
    case 'userid_not_found':
    case 'history_container_not_found':
    case 'profile_link_not_found': labelKey = 'statusDomChanged'; break;
    case 'invalid_org_entry': labelKey = 'statusInvalidOrg'; break;
    case 'unexpected_response_shape': labelKey = 'statusInvalidShape'; break;
    case 'session_retrieval_failed': labelKey = 'statusSessionFailed'; break;
    case 'conversations_retrieval_failed': labelKey = 'statusConvFetchFailed'; break;
    default: labelKey = 'statusGenericError';
  }
  return `${svcName}: ✕ ${t(labelKey)}`;
}

export function isMismatch(rec, current) {
  if (!rec || typeof rec.service !== 'string') return false;
  if (current === null || typeof current !== 'object') return false;
  switch (rec.service) {
    case 'chatgpt':
      return typeof current.chatgpt === 'string'
        && current.chatgpt.length > 0
        && current.chatgpt !== rec.accountEmail;
    case 'claude':
      return Array.isArray(current.claude)
        && current.claude.length > 0
        && !current.claude.includes(rec.accountEmail);
    case 'gemini':
      return typeof current.gemini === 'string'
        && current.gemini.length > 0
        && current.gemini !== rec.accountEmail;
    case 'googleai':
      return typeof current.googleai === 'string'
        && current.googleai.length > 0
        && current.googleai !== rec.accountEmail;
    case 'grok':
      return typeof current.grok === 'string'
        && current.grok.length > 0
        && current.grok !== rec.accountEmail;
    case 'xgrok':
      return typeof current.xgrok === 'string'
        && current.xgrok.length > 0
        && current.xgrok !== rec.accountEmail;
    default:
      return false;
  }
}

// 同期 / 削除ダイアログの「全て」チェックボックス状態を計算する純関数。
// checkedSet: Set<service identifier> 個別の選択状態を表す。
// allServices: 並びの基準（通常 ALL_SERVICES）。
// 戻り値: { allChecked, allIndeterminate }
//   - allChecked: 全 5 個 ON → true
//   - allIndeterminate: 1〜4 個 ON → true（半チェック視覚化、HTMLInputElement.indeterminate に渡す）
//   - 0 個 ON: 両方 false
export function computeAllCheckedState(checkedSet, allServices) {
  if (!Array.isArray(allServices) || allServices.length === 0) {
    return { allChecked: false, allIndeterminate: false };
  }
  if (!(checkedSet instanceof Set)) {
    return { allChecked: false, allIndeterminate: false };
  }
  let count = 0;
  for (const s of allServices) {
    if (checkedSet.has(s)) count += 1;
  }
  const total = allServices.length;
  return {
    allChecked: count === total,
    allIndeterminate: count > 0 && count < total,
  };
}

// service 識別子 → ステータスバー / 警告で使う表示用ラベル。
function serviceLabel(name) {
  switch (name) {
    case 'chatgpt': return 'ChatGPT';
    case 'claude': return 'Claude';
    case 'gemini': return 'Gemini';
    case 'googleai': return 'GoogleAI';
    case 'grok': return 'Grok';
    case 'xgrok': return t('serviceXgrok');
    default: return typeof name === 'string' ? name : 'unknown';
  }
}

// ---------------- 描画 ----------------

// お気に入りボタンの中身となる SVG ハート要素を生成する。
// Material Design の "favorite" filled path をそのまま使い、CSS で fill/stroke を切替えて
// OFF=輪郭のみ / ON=塗り を表現する。aria-hidden で SR に通さず、ボタンの aria-label に委ねる。
function createHeartIcon() {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z');
  svg.appendChild(path);
  return svg;
}

function renderRow(rec, current) {
  if (!isValidRecord(rec)) {
    return null;
  }
  const li = document.createElement('li');
  li.className = `hub-row hub-row--${rec.service}`;
  li.dataset.id = rec.id;
  // 行クリック遷移と不一致警告ダイアログで参照するため dataset に保持。
  li.dataset.url = rec.url;
  li.dataset.accountEmail = (typeof rec.accountEmail === 'string') ? rec.accountEmail : '';

  const mismatch = isMismatch(rec, current);
  if (mismatch) {
    li.classList.add('hub-row--mismatch');
  }

  const title = document.createElement('div');
  title.className = 'hub-row-title';
  title.textContent = (typeof rec.title === 'string' && rec.title.length > 0)
    ? rec.title
    : t('commonUntitled');
  li.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'hub-row-meta';

  const service = document.createElement('span');
  service.className = 'hub-row-service';
  service.textContent = rec.service;
  meta.appendChild(service);

  if (typeof rec.accountEmail === 'string' && rec.accountEmail.length > 0) {
    const email = document.createElement('span');
    email.className = 'hub-row-account';
    email.textContent = rec.accountEmail;
    meta.appendChild(email);
  }

  if (mismatch) {
    const badge = document.createElement('span');
    badge.className = 'hub-row-badge';
    // 色のみに依存しない情報設計のため ⚠ を冒頭に置く（背景色での識別が困難な場合の補助）。
    badge.textContent = t('badgeMismatch');
    meta.appendChild(badge);
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'hub-row-copy';
  copyBtn.title = t('actionCopyUrl');
  copyBtn.setAttribute('aria-label', t('actionCopyUrl'));
  copyBtn.textContent = '⧉';
  meta.appendChild(copyBtn);

  // お気に入りボタンはコピーボタンの右隣。aria-pressed で状態を読み上げ、
  // SVG path で記号を描画する (Unicode ♡/♥ はフォント依存で字形が揺れるため)。
  // 塗り/輪郭は CSS の [aria-pressed] セレクタで自動切替 (currentColor 参照)。
  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.className = 'hub-row-fav';
  favBtn.title = t('actionFavorite');
  favBtn.setAttribute('aria-label', t('actionFavorite'));
  const isFav = rec.favorite === true;
  favBtn.setAttribute('aria-pressed', isFav ? 'true' : 'false');
  favBtn.appendChild(createHeartIcon());
  meta.appendChild(favBtn);

  li.appendChild(meta);
  return li;
}

// ---------------- 仮想スクロール ----------------
//
// 1000 件オーダーで `<ul#hub-list>` に全 row を append すると popup 開閉 / フィルタ切替が
// 体感重い。windowed virtualization で `<li.hub-row>` の DOM 数を上限 ~200 に保つ。
//
// 設計:
// - heading は常時 DOM 残留 (`position: sticky` 動作維持のため)
// - row のみ仮想化対象
// - 各 group ごとに [heading, spacer-top, ...visible rows, spacer-bottom] の構造
// - scroll listener は requestAnimationFrame で batching、各 group ごとに表示範囲を再計算
// - 行高さは固定前提 (popup.css の `.hub-row` は white-space: nowrap で 1 行高さ固定)。
//   定数で持つが、CSS 変更時に破綻しないよう `tests/.tmp/playwright.test.mjs` で
//   `.hub-row` の bounding rect を計測して整合性を確認する。

const VIRTUAL_ROW_HEIGHT = 50;
const VIRTUAL_HEADING_HEIGHT = 28;
// DoD 1: hub-row DOM ≤ 200。可視範囲 ~10 行 + 上下バッファ 80 = 約 170。
const VIRTUAL_BUFFER_ROWS = 80;

let virtualState = null;
let virtualRafScheduled = false;

function updateVirtualWindows() {
  if (!virtualState) return;
  const list = document.getElementById('hub-list');
  if (!(list instanceof HTMLElement)) return;

  const { flatGroups, rowHeight, bufferRows, current } = virtualState;
  const scrollTop = list.scrollTop;
  const clientHeight = list.clientHeight;
  const viewStart = scrollTop;
  const viewEnd = scrollTop + clientHeight;
  const bufferPx = bufferRows * rowHeight;

  for (const fg of flatGroups) {
    let firstIdx;
    let lastIdx;
    if (fg.rowsEnd < viewStart - bufferPx || fg.rowsStart > viewEnd + bufferPx) {
      // group 全体が viewport 外 → 全 row unmount
      firstIdx = 0;
      lastIdx = -1;
    } else {
      firstIdx = Math.max(0, Math.floor((viewStart - fg.rowsStart) / rowHeight) - bufferRows);
      lastIdx = Math.min(
        fg.group.records.length - 1,
        Math.ceil((viewEnd - fg.rowsStart) / rowHeight) + bufferRows,
      );
    }

    if (firstIdx === fg.currentFirstIdx && lastIdx === fg.currentLastIdx) continue;

    for (const r of fg.renderedRows) r.remove();
    fg.renderedRows = [];

    if (lastIdx >= firstIdx) {
      const frag = document.createDocumentFragment();
      for (let i = firstIdx; i <= lastIdx; i += 1) {
        const rec = fg.group.records[i];
        const row = renderRow(rec, current);
        if (row instanceof Node) {
          frag.appendChild(row);
          fg.renderedRows.push(row);
        }
      }
      fg.spacerBottom.before(frag);
    }

    fg.spacerTop.style.height = `${firstIdx * rowHeight}px`;
    const remainingRows = lastIdx >= firstIdx
      ? (fg.group.records.length - lastIdx - 1)
      : fg.group.records.length;
    fg.spacerBottom.style.height = `${remainingRows * rowHeight}px`;

    fg.currentFirstIdx = firstIdx;
    fg.currentLastIdx = lastIdx;
  }
}

function scheduleVirtualUpdate() {
  if (virtualRafScheduled) return;
  virtualRafScheduled = true;
  requestAnimationFrame(() => {
    virtualRafScheduled = false;
    updateVirtualWindows();
  });
}

function bindVirtualScroll() {
  const list = document.getElementById('hub-list');
  if (!(list instanceof HTMLElement)) return;
  list.addEventListener('scroll', scheduleVirtualUpdate, { passive: true });
}

// リスト先頭へ戻る FAB。scrollTop が閾値を超えたとき is-visible を付与し、クリックで滑らかに先頭へ。
// scroll は requestAnimationFrame で間引き、virtual scroll の rAF と重複しても処理は軽量。
function bindScrollTopButton() {
  const list = document.getElementById('hub-list');
  const btn = document.getElementById('hub-scroll-top');
  if (!(list instanceof HTMLElement) || !(btn instanceof HTMLElement)) return;

  const SHOW_THRESHOLD_PX = 200;
  let rafScheduled = false;

  const updateVisibility = () => {
    rafScheduled = false;
    if (list.scrollTop > SHOW_THRESHOLD_PX) {
      btn.classList.add('is-visible');
    } else {
      btn.classList.remove('is-visible');
    }
  };

  list.addEventListener('scroll', () => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(updateVisibility);
  }, { passive: true });

  btn.addEventListener('click', () => {
    list.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

export function render(records, current, sortDir) {
  const list = document.getElementById('hub-list');
  const empty = document.getElementById('hub-empty');
  if (!list || !empty) {
    console.error('[LLM History Hub] render: required DOM nodes not found');
    return;
  }

  try {
    list.replaceChildren();
    virtualState = null;

    if (!Array.isArray(records) || records.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }

    const validRecords = records.filter(isValidRecord);
    if (validRecords.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }

    const groups = groupByYMD(validRecords, sortDir);
    const flatGroups = [];
    let cumY = 0;
    for (const [key, group] of groups) {
      if (!Array.isArray(group.records) || group.records.length === 0) continue;

      const heading = document.createElement('li');
      heading.className = 'hub-date-heading';
      heading.textContent = key;
      list.appendChild(heading);

      const spacerTop = document.createElement('li');
      spacerTop.className = 'hub-list-spacer';
      spacerTop.dataset.role = 'spacer-top';
      spacerTop.dataset.ymd = key;
      list.appendChild(spacerTop);

      const spacerBottom = document.createElement('li');
      spacerBottom.className = 'hub-list-spacer';
      spacerBottom.dataset.role = 'spacer-bottom';
      spacerBottom.dataset.ymd = key;
      list.appendChild(spacerBottom);

      flatGroups.push({
        ymd: key,
        group,
        heading,
        spacerTop,
        spacerBottom,
        rowsStart: cumY + VIRTUAL_HEADING_HEIGHT,
        rowsEnd: cumY + VIRTUAL_HEADING_HEIGHT + group.records.length * VIRTUAL_ROW_HEIGHT,
        currentFirstIdx: 0,
        // 「未初期化」を表すマーカー: 初回 update で必ず差分が発生する値 (-2)。
        currentLastIdx: -2,
        renderedRows: [],
      });
      cumY += VIRTUAL_HEADING_HEIGHT + group.records.length * VIRTUAL_ROW_HEIGHT;
    }

    if (flatGroups.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }

    list.hidden = false;
    empty.hidden = true;

    virtualState = {
      flatGroups,
      rowHeight: VIRTUAL_ROW_HEIGHT,
      headingHeight: VIRTUAL_HEADING_HEIGHT,
      bufferRows: VIRTUAL_BUFFER_ROWS,
      current,
    };

    updateVirtualWindows();
  } catch (err) {
    console.error('[LLM History Hub] render failed, falling back to empty state', err);
    list.replaceChildren();
    virtualState = null;
    list.hidden = true;
    empty.hidden = false;
  }
}

// account select を populate する。アカウント候補一覧（option の存在）は cachedRecords 全体から
// 安定的に出すが、件数バッジ `(N)` は **chip フィルタ + 日付フィルタを反映した records** から集計する。
// 例: chip "Claude" 選択中なら「全アカウント」は Claude の件数、ChatGPT 系アカウントは `(0)` と表示
// （次の絞り込み操作で何件残るかの予告として機能）。
// 日付フィルタ変更時にも呼び直すことで件数バッジを連動させる。
function populateAccountSelect(allRecords) {
  const select = document.getElementById('hub-account-select');
  if (!(select instanceof HTMLSelectElement)) return;
  if (!Array.isArray(allRecords)) return;

  // 現在の選択値を保持し、再 populate 後に復元する（消えていれば 'all' に戻す）。
  const prev = select.value;

  // option 一覧は cachedRecords 全体から（chip 切替で消えると select が短くなるのを防ぐ）。
  const options = buildAccountOptions(allRecords);

  // 件数集計は chip フィルタ + 日付フィルタ + ♥ フィルタ後の records から。
  const svc = (typeof filterState.service === 'string') ? filterState.service : 'all';
  const filteredByChipAndDate = applyFilters(allRecords, {
    service: svc,
    account: 'all',
    query: '',
    dateFrom: filterState.dateFrom,
    dateTo: filterState.dateTo,
    favoriteOnly: filterState.favoriteOnly === true,
  });
  const accountCounts = countByAccount(filteredByChipAndDate);
  const totalAfterChip = countByService(filteredByChipAndDate).all;

  select.replaceChildren();
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = t('accountAllWithCount', [String(totalAfterChip)]);
  select.appendChild(allOpt);
  // chip フィルタ後の件数が 0 のアカウントは option に出さない（候補が冗長になるのを抑制）。
  // 「全アカウント」option は常に残す（フィルタ解除の入口として必要）。
  // 選択中アカウントが消えた場合は下の prev チェックで 'all' に auto-revert する。
  for (const key of options) {
    const n = accountCounts.get(key) || 0;
    if (n === 0) continue;
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${key}(${n})`;
    select.appendChild(opt);
  }

  if (prev && Array.from(select.options).some((o) => o.value === prev)) {
    select.value = prev;
  } else {
    select.value = 'all';
    filterState.account = 'all';
  }
}

// chip の textContent を `LLM名(件数)` に書き換える。
// 件数は cachedRecords 全体に対して **日付フィルタのみ反映** した結果から集計する。
// chip 自体の絞り込みは反映しない（自己言及で常に同値表示になるのを防ぐ）。
// data-service 属性を使って HTML 側の chip と紐付ける。
function updateChipCounts(allRecords) {
  const dateFiltered = applyFilters(allRecords, {
    service: 'all',
    account: 'all',
    query: '',
    dateFrom: filterState.dateFrom,
    dateTo: filterState.dateTo,
  });
  const counts = countByService(dateFiltered);
  const chips = document.querySelectorAll('#hub-chips .hub-chip');
  for (const chip of chips) {
    if (!(chip instanceof HTMLElement)) continue;
    const svc = chip.dataset.service;
    if (typeof svc !== 'string' || svc.length === 0) continue;
    const label = Object.prototype.hasOwnProperty.call(CHIP_LABELS, svc) ? CHIP_LABELS[svc] : svc;
    const n = Object.prototype.hasOwnProperty.call(counts, svc) ? counts[svc] : 0;
    // 件数バッジ語順は ja/en で異なる (`All(15)` vs `All (15)`)。messages.json の chipWithCount で
    // 完成形を保持し、テンプレ全体を 1 キーで管理する (UI_DESIGN.md §多言語対応 §表記仕様)。
    chip.textContent = t('chipWithCount', [label, String(n)]);
  }
}

// 空状態文言切替 + フィルタ + render 呼出を集約。
function renderFiltered() {
  const empty = document.getElementById('hub-empty');
  const emptyTitle = empty && empty.querySelector('.hub-empty-title');
  const emptyHint = empty && empty.querySelector('.hub-empty-hint');

  const filtered = applyFilters(cachedRecords, filterState);

  // 空状態の文言切替: データ 0 件と「フィルタ結果 0 件」を区別する。
  if (emptyTitle instanceof HTMLElement) {
    if (cachedRecords.length === 0) {
      emptyTitle.textContent = t('emptyNoHistoryTitle');
      if (emptyHint instanceof HTMLElement) {
        emptyHint.textContent = t('emptyNoHistoryHint');
      }
    } else if (filtered.length === 0) {
      emptyTitle.textContent = t('emptyFilteredTitle');
      if (emptyHint instanceof HTMLElement) {
        emptyHint.textContent = t('emptyFilteredHint');
      }
    }
  }

  render(filtered, currentAccounts, filterState.sortDir);
}

// ステータスバーの表示と消滅タイマー。
// 連続呼出で前回タイマーをキャンセル。`is-error` の残留を冒頭で必ず除去。
// actions が指定された場合はインラインボタンを末尾に追加し、自動消滅まで 12 秒（押す猶予）。
// rows が配列で渡された場合は行モードで描画し、サービスごとに 1 行表示する。
// 各 row: { label: string, isError?: boolean, action?: { label, onClick } }
function renderStatusBar(message, isError, actions, rows) {
  const bar = document.getElementById('hub-status');
  if (!(bar instanceof HTMLElement)) return;

  bar.classList.remove('is-error');
  if (isError === true) {
    bar.classList.add('is-error');
  }

  bar.replaceChildren();

  const useRowMode = Array.isArray(rows) && rows.length > 0;
  let hasActions = false;

  if (useRowMode) {
    for (const row of rows) {
      if (!row || typeof row.label !== 'string') continue;
      const rowEl = document.createElement('div');
      rowEl.className = 'hub-status-row';
      if (row.isError === true) rowEl.classList.add('is-error');

      const textEl = document.createElement('span');
      textEl.className = 'hub-status-row-text';
      textEl.textContent = row.label;
      rowEl.appendChild(textEl);

      if (row.action
          && typeof row.action.label === 'string'
          && typeof row.action.onClick === 'function') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hub-status-action';
        btn.textContent = row.action.label;
        btn.addEventListener('click', row.action.onClick);
        rowEl.appendChild(btn);
        hasActions = true;
      }

      bar.appendChild(rowEl);
    }
  } else {
    // 3層目: 型不正は warn + 空文字でフォールバック。
    let text = '';
    if (typeof message === 'string') {
      text = message;
    } else {
      console.warn('[LLM History Hub] renderStatusBar: invalid message type', typeof message);
    }

    const span = document.createElement('span');
    span.textContent = text;
    bar.appendChild(span);

    if (Array.isArray(actions)) {
      for (const action of actions) {
        if (!action || typeof action.label !== 'string' || typeof action.onClick !== 'function') continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hub-status-action';
        btn.textContent = action.label;
        btn.addEventListener('click', action.onClick);
        bar.appendChild(btn);
        hasActions = true;
      }
    }
  }

  bar.hidden = false;

  if (statusTimerId !== null) {
    clearTimeout(statusTimerId);
    statusTimerId = null;
  }
  statusTimerId = setTimeout(() => {
    bar.hidden = true;
    bar.classList.remove('is-error');
    statusTimerId = null;
  }, hasActions ? 12000 : 6000);
}

// ---------------- イベントハンドラ ----------------

async function handleCopyClick(btn, url) {
  if (!(btn instanceof HTMLElement)) return;
  if (typeof url !== 'string' || url.length === 0) return;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = '✓';
  } catch (err) {
    console.error('[LLM History Hub] copy failed', err);
    btn.textContent = '✗';
  }
  setTimeout(() => { btn.textContent = '⧉'; }, 1000);
}

// 行内 ♥ ボタンクリック: 楽観的 UI で即反転 → cachedRecords を更新 → upsert。
// updatedAt は変えない（同期マージは updatedAt 新しい方優先なので、お気に入り操作で
// 並び順や同期挙動が乱れるのを避ける）。失敗時は楽観的更新を巻き戻す。
async function handleFavoriteClick(btn, row) {
  if (!(btn instanceof HTMLElement) || !(row instanceof HTMLElement)) return;
  const id = row.dataset.id;
  if (typeof id !== 'string' || id.length === 0) return;

  const idx = cachedRecords.findIndex((r) => isValidRecord(r) && r.id === id);
  if (idx === -1) return;
  const prev = cachedRecords[idx];
  const next = !(prev.favorite === true);

  // 楽観的 UI: ボタン状態を即反転 (aria-pressed のみ更新、塗り/輪郭は CSS が切替える)。
  btn.setAttribute('aria-pressed', next ? 'true' : 'false');
  cachedRecords[idx] = { ...prev, favorite: next };

  try {
    await upsert([cachedRecords[idx]]);
  } catch (err) {
    console.error('[LLM History Hub] favorite toggle failed', err);
    // 巻き戻し: cachedRecords / ボタン両方を戻す。
    cachedRecords[idx] = prev;
    btn.setAttribute('aria-pressed', prev.favorite === true ? 'true' : 'false');
    renderStatusBar(t('toastFavoriteFailed'), true);
    return;
  }

  // ♥ chip の件数を更新する。リスト自体は再描画しない (favoriteOnly 表示中に行が消えると
  // 操作感が悪い。次のフィルタ切替で自然に反映される)。
  updateChipCounts(cachedRecords);
}

// 行クリック: 一致なら通常遷移、不一致なら dialog を表示する。
function handleRowClick(row) {
  if (!(row instanceof HTMLElement)) return;
  const url = row.dataset.url || '';
  const accountEmail = row.dataset.accountEmail || '';
  if (typeof url !== 'string' || url.length === 0) return;

  // dataset から service を取り出して isMismatch 再判定する。
  const m = row.className.match(/hub-row--(chatgpt|claude|gemini|googleai|grok|xgrok)/);
  const service = m ? m[1] : '';
  const fakeRec = { service, accountEmail };
  if (isMismatch(fakeRec, currentAccounts)) {
    showMismatchDialog(url, accountEmail);
    return;
  }
  chrome.tabs.create({ url });
}

function showMismatchDialog(url, accountEmail) {
  const dialog = document.getElementById('hub-mismatch-dialog');
  if (!(dialog instanceof HTMLDialogElement)) {
    // dialog 要素がない場合は通常遷移にフォールバック（mock-popup の互換用）。
    console.warn('[LLM History Hub] mismatch dialog element not found, opening directly');
    chrome.tabs.create({ url });
    return;
  }
  // showModal 直前に毎回再設定: 連続クリックで前の値が残らないように。
  dialog.dataset.url = url;
  dialog.dataset.accountEmail = accountEmail;
  const account = document.getElementById('hub-mismatch-account');
  if (account instanceof HTMLElement) {
    account.textContent = accountEmail;
  }
  dialog.showModal();
}

function bindRowClick() {
  const list = document.getElementById('hub-list');
  if (!list) return;
  // イベント委譲。fav → copy → row の順で分岐する。
  // ♥ ボタンは copy / row より先に判定しないと、内側の closest('.hub-row') 経路に流れて
  // チャットを開いてしまう。
  list.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    // お気に入りボタン経路。
    const favBtn = target.closest('.hub-row-fav');
    if (favBtn instanceof HTMLElement) {
      const row = favBtn.closest('.hub-row');
      if (!(row instanceof HTMLElement)) return;
      handleFavoriteClick(favBtn, row);
      return;
    }

    // コピーボタンが先に当たる経路。
    const copyBtn = target.closest('.hub-row-copy');
    if (copyBtn instanceof HTMLElement) {
      const row = copyBtn.closest('.hub-row');
      if (!(row instanceof HTMLElement)) return;
      const url = row.dataset.url || '';
      handleCopyClick(copyBtn, url);
      return;
    }

    const row = target.closest('.hub-row');
    if (!(row instanceof HTMLElement)) return;
    handleRowClick(row);
  });
}

function bindFilters() {
  const chips = document.getElementById('hub-chips');
  const search = document.getElementById('hub-search');
  const select = document.getElementById('hub-account-select');

  if (chips instanceof HTMLElement) {
    chips.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const chip = target.closest('.hub-chip');
      if (!(chip instanceof HTMLElement)) return;
      if (chip.disabled) return;
      const svc = chip.dataset.service;
      if (typeof svc !== 'string' || svc.length === 0) return;
      // 排他切替: クリックされた chip だけ is-active に。
      const all = chips.querySelectorAll('.hub-chip');
      for (const c of all) {
        c.classList.toggle('is-active', c === chip);
      }
      // ♥ chip は擬似サービス。service フィルタは 'all' に戻し、favoriteOnly フラグで絞り込む。
      // 他 chip クリック時は favoriteOnly を必ず解除して排他を担保する。
      if (svc === 'favorite') {
        filterState.service = 'all';
        filterState.favoriteOnly = true;
      } else {
        filterState.service = svc;
        filterState.favoriteOnly = false;
      }
      // chip 切替は select の件数バッジに連動させる（次の絞り込み操作の予告として）。
      // chip 件数自体は cachedRecords + 日付フィルタで集計するため chip 切替では変わらない。
      populateAccountSelect(cachedRecords);
      renderFiltered();
    });
  }

  if (search instanceof HTMLInputElement) {
    search.addEventListener('input', () => {
      filterState.query = typeof search.value === 'string' ? search.value : '';
      renderFiltered();
    });
  }

  if (select instanceof HTMLSelectElement) {
    select.addEventListener('change', () => {
      filterState.account = typeof select.value === 'string' ? select.value : 'all';
      renderFiltered();
    });
  }

  // 日付フィルタ: from/to の手動編集と「7日 / 30日 / 全」プリセット chip。
  // input 手動編集は datePresetKey='custom' で全プリセットの data-active を解除する。
  const dateFromEl = document.getElementById('hub-date-from');
  const dateToEl = document.getElementById('hub-date-to');
  const datePresetEls = document.querySelectorAll('.hub-date-preset');
  const sortToggleEl = document.getElementById('hub-sort-toggle');

  function applyDateInputsToState() {
    filterState.dateFrom = (dateFromEl instanceof HTMLInputElement)
      ? parseDateInputValue(dateFromEl.value, false) : null;
    filterState.dateTo = (dateToEl instanceof HTMLInputElement)
      ? parseDateInputValue(dateToEl.value, true) : null;
  }

  // value の有無で data-empty 属性を切替。CSS で placeholder 表示時のみ
  // year-field を圧縮し、値入力時は通常幅に戻すため。
  function syncDateInputEmptyState() {
    for (const el of [dateFromEl, dateToEl]) {
      if (el instanceof HTMLInputElement) {
        el.dataset.empty = el.value === '' ? 'true' : 'false';
      }
    }
  }

  function setPresetActive(key) {
    filterState.datePresetKey = key;
    for (const p of datePresetEls) {
      if (!(p instanceof HTMLElement)) continue;
      if (p.dataset.preset === key) {
        p.dataset.active = 'true';
      } else {
        delete p.dataset.active;
      }
    }
  }

  function onDateInputChange() {
    applyDateInputsToState();
    syncDateInputEmptyState();
    setPresetActive('custom');
    // 日付フィルタ変更で chip 件数 / account select 件数も再集計する。
    updateChipCounts(cachedRecords);
    populateAccountSelect(cachedRecords);
    renderFiltered();
  }

  if (dateFromEl instanceof HTMLInputElement) {
    dateFromEl.addEventListener('change', onDateInputChange);
  }
  if (dateToEl instanceof HTMLInputElement) {
    dateToEl.addEventListener('change', onDateInputChange);
  }

  for (const preset of datePresetEls) {
    if (!(preset instanceof HTMLButtonElement)) continue;
    preset.addEventListener('click', () => {
      if (preset.disabled) return;
      const key = preset.dataset.preset;
      if (typeof key !== 'string') return;
      const { dateFrom: f, dateTo: t } = computeDatePreset(key);
      filterState.dateFrom = f;
      filterState.dateTo = t;
      if (dateFromEl instanceof HTMLInputElement) {
        dateFromEl.value = (f === null) ? '' : ymd(f);
      }
      if (dateToEl instanceof HTMLInputElement) {
        dateToEl.value = (t === null) ? '' : ymd(t);
      }
      syncDateInputEmptyState();
      setPresetActive(key);
      // 日付フィルタ変更で chip 件数 / account select 件数も再集計する。
      updateChipCounts(cachedRecords);
      populateAccountSelect(cachedRecords);
      renderFiltered();
    });
  }

  if (sortToggleEl instanceof HTMLButtonElement) {
    sortToggleEl.addEventListener('click', () => {
      if (sortToggleEl.disabled) return;
      const isAsc = filterState.sortDir === 'asc';
      filterState.sortDir = isAsc ? 'desc' : 'asc';
      sortToggleEl.setAttribute('aria-pressed', String(!isAsc));
      sortToggleEl.textContent = isAsc ? t('filterSortDesc') : t('filterSortAsc');
      renderFiltered();
      // 並び替え方向切替時はリスト先頭にスクロール（位置維持より直感的）。
      requestAnimationFrame(() => {
        const list = document.getElementById('hub-list');
        if (list instanceof HTMLElement) list.scrollTop = 0;
      });
    });
  }
}

function bindMismatchDialog() {
  const dialog = document.getElementById('hub-mismatch-dialog');
  if (!(dialog instanceof HTMLDialogElement)) return;
  dialog.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest('button[data-action]');
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.dataset.action;
    // 3層目: ホワイトリスト判定。それ以外は何もしない。
    if (action === 'cancel') {
      dialog.close();
      return;
    }
    if (action === 'copy') {
      const url = dialog.dataset.url || '';
      if (typeof url === 'string' && url.length > 0) {
        navigator.clipboard.writeText(url).catch((err) => {
          console.error('[LLM History Hub] dialog copy failed', err);
        });
      }
      dialog.close();
      return;
    }
    if (action === 'open') {
      const url = dialog.dataset.url || '';
      if (typeof url === 'string' && url.length > 0) {
        chrome.tabs.create({ url });
      }
      dialog.close();
      return;
    }
  });
}

// ---------------- io 抽象 ----------------

// ファイル系副作用を 1 オブジェクトに集約し、mock-popup から差し替え可能にする。
// pickJsonFile() は Chrome 113+ の <input>.cancel を listen してキャンセル時に null を resolve する。
export const io = {
  triggerDownload(filename, text, mime) {
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new TypeError('triggerDownload: filename must be a non-empty string');
    }
    if (typeof text !== 'string') {
      throw new TypeError('triggerDownload: text must be a string');
    }
    if (typeof mime !== 'string' || mime.length === 0) {
      throw new TypeError('triggerDownload: mime must be a non-empty string');
    }
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  async pickJsonFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.style.display = 'none';
      let settled = false;
      const cleanup = () => {
        if (!input.isConnected) return;
        input.remove();
      };
      input.addEventListener('change', async () => {
        if (settled) return;
        settled = true;
        const file = input.files && input.files[0];
        cleanup();
        if (!(file instanceof Blob)) {
          resolve(null);
          return;
        }
        try {
          const text = await file.text();
          resolve(typeof text === 'string' ? text : null);
        } catch (err) {
          console.error('[LLM History Hub] pickJsonFile: file.text failed', err);
          resolve(null);
        }
      });
      input.addEventListener('cancel', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
      });
      document.body.appendChild(input);
      input.click();
    });
  },
};

// `toISOString().slice(0,10)` は UTC 基準で JST 早朝が前日扱いになるため使わない。
function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function handleExportJson() {
  try {
    const text = recordsToJson(cachedRecords);
    const filename = `llm-history-hub-${todayYmd()}.json`;
    io.triggerDownload(filename, text, 'application/json');
    const valid = Array.isArray(cachedRecords) ? cachedRecords.filter(isValidRecord).length : 0;
    renderStatusBar(t('toastExportJsonOk', [String(valid)]), false);
  } catch (err) {
    console.error('[LLM History Hub] export json failed', err);
    renderStatusBar(t('toastExportFailed'), true);
  }
}

async function handleExportCsv() {
  try {
    const text = recordsToCsv(cachedRecords);
    const filename = `llm-history-hub-${todayYmd()}.csv`;
    io.triggerDownload(filename, text, 'text/csv;charset=utf-8');
    const valid = Array.isArray(cachedRecords) ? cachedRecords.filter(isValidRecord).length : 0;
    renderStatusBar(t('toastExportCsvOk', [String(valid)]), false);
  } catch (err) {
    console.error('[LLM History Hub] export csv failed', err);
    renderStatusBar(t('toastExportFailed'), true);
  }
}

async function handleImportJson() {
  let text;
  try {
    text = await io.pickJsonFile();
  } catch (err) {
    console.error('[LLM History Hub] import: pickJsonFile failed', err);
    renderStatusBar(t('toastImportFilePickFailed'), true);
    return;
  }
  if (text === null) {
    renderStatusBar(t('toastImportCanceled'), false);
    return;
  }

  let parsed;
  try {
    parsed = parseJsonImport(text);
  } catch (err) {
    console.error('[LLM History Hub] import: parse failed', err);
    const errInfo = parseErrorInfo(err && err.message);
    if (errInfo.code === 'invalid_json') {
      renderStatusBar(t('toastImportInvalidJson'), true);
    } else if (errInfo.code === 'not_an_array') {
      renderStatusBar(t('toastImportNotArray'), true);
    } else {
      const detail = (typeof err.message === 'string' && err.message.length > 0)
        ? err.message
        : t('statusGenericError');
      renderStatusBar(t('toastImportGenericFailed', [detail]), true);
    }
    return;
  }

  let existing;
  try {
    existing = await readAll();
  } catch (err) {
    console.error('[LLM History Hub] import: readAll failed', err);
    renderStatusBar(t('toastImportDbReadFailed'), true);
    return;
  }

  let mergedResult;
  try {
    // インポート経路ではお気に入りフラグを incoming で上書きする (favorite フィールドが
    // 含まれる場合のみ)。同期経路 (background.js) と区別するため source='import' を渡す。
    mergedResult = mergeRecords(existing, parsed, { source: 'import' });
  } catch (err) {
    console.error('[LLM History Hub] import: merge failed', err);
    renderStatusBar(t('toastImportMergeFailed'), true);
    return;
  }
  const { merged, stats } = mergedResult;

  // confirm 本文は messages.json 側で 1 キー (importConfirmBody) に格納し、改行を含めた
  // 完成形を ja/en で個別に保持する。$1〜$4 に新規 / 更新 / 変更なし / 無効件数を流し込む。
  const message = t('importConfirmBody', [
    String(stats.created),
    String(stats.updated),
    String(stats.unchanged),
    String(stats.invalid),
  ]);
  if (!window.confirm(message)) {
    renderStatusBar(t('toastImportCanceled'), false);
    return;
  }

  try {
    await upsert(merged);
    cachedRecords = await readAll();
  } catch (err) {
    console.error('[LLM History Hub] import: upsert failed', err);
    renderStatusBar(t('toastImportDbWriteFailed'), true);
    return;
  }
  populateAccountSelect(cachedRecords);
  updateChipCounts(cachedRecords);
  renderFiltered();
  renderStatusBar(
    t('toastImportOk', [String(stats.created), String(stats.updated)]),
    false,
  );
}

// メニュー 3 項目（エクスポート JSON / CSV / インポート JSON）に click + keydown(Enter/Space)
// を結線。各項目クリック後は menu.open=false で閉じる。
// 全データ削除はメニューから撤去（ヘッダー「削除」ボタン → ダイアログ「全て」が代替）。
function bindMenuItems() {
  const menu = document.getElementById('hub-menu');
  const items = [
    { id: 'hub-menu-export-json', handler: handleExportJson },
    { id: 'hub-menu-export-csv', handler: handleExportCsv },
    { id: 'hub-menu-import-json', handler: handleImportJson },
  ];
  for (const { id, handler } of items) {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLElement)) {
      console.warn(`[LLM History Hub] bindMenuItems: ${id} not found`);
      continue;
    }
    const fire = async () => {
      // メニューを先に閉じてから処理を走らせる。confirm() のモーダル中でも
      // パネルが開きっぱなしにならないように同期で閉じる。
      if (menu instanceof HTMLDetailsElement) {
        menu.open = false;
      }
      try {
        await handler();
      } catch (err) {
        console.error(`[LLM History Hub] menu handler ${id} threw`, err);
      }
    };
    el.addEventListener('click', fire);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fire();
      }
    });
  }
}

// ---------------- 同期クリック ----------------

// 同期 / 削除中の UI 一括 disabled。例外時も確実に解除するため finally で syncEndUI を呼ぶ
// 前提でプレーン関数として抽出（export しない）。
// btn: 同期ボタン (HTMLButtonElement) または null。
//   - HTMLButtonElement → 同期フロー: スピナー + 「同期中…」を btn に表示
//   - null → 削除フロー: 同期ボタンの textContent は触らない
// 同期 / 削除どちらのフローでも、両方のボタンを disabled に倒して操作衝突を防ぐ。
function syncStartUI(btn) {
  if (btn instanceof HTMLButtonElement) {
    const spinner = document.createElement('span');
    spinner.className = 'hub-sync-spinner';
    // 装飾的な spinner は読み上げ対象から除外（textContent 「同期中…」のみで十分）。
    spinner.setAttribute('aria-hidden', 'true');
    btn.replaceChildren(spinner, document.createTextNode(t('syncing')));
  }
  // 同期 / 削除フローのいずれでも両ボタンを disabled。
  const syncBtn = document.getElementById('hub-sync');
  const deleteBtn = document.getElementById('hub-delete');
  if (syncBtn instanceof HTMLButtonElement) syncBtn.disabled = true;
  if (deleteBtn instanceof HTMLButtonElement) deleteBtn.disabled = true;
  const chips = document.querySelectorAll('#hub-chips .hub-chip');
  for (const c of chips) {
    if (c instanceof HTMLButtonElement) c.disabled = true;
  }
  const select = document.getElementById('hub-account-select');
  if (select instanceof HTMLSelectElement) select.disabled = true;
  const search = document.getElementById('hub-search');
  if (search instanceof HTMLInputElement) search.disabled = true;
  const dateFromEl = document.getElementById('hub-date-from');
  if (dateFromEl instanceof HTMLInputElement) dateFromEl.disabled = true;
  const dateToEl = document.getElementById('hub-date-to');
  if (dateToEl instanceof HTMLInputElement) dateToEl.disabled = true;
  const datePresetEls = document.querySelectorAll('.hub-date-preset');
  for (const p of datePresetEls) {
    if (p instanceof HTMLButtonElement) p.disabled = true;
  }
  const sortToggleEl = document.getElementById('hub-sort-toggle');
  if (sortToggleEl instanceof HTMLButtonElement) sortToggleEl.disabled = true;
  const menu = document.getElementById('hub-menu');
  if (menu instanceof HTMLDetailsElement) menu.open = false;
  // <li role=menuitem> や details 自体には disabled 属性が効かないので、
  // summary に aria-disabled を付与して CSS 側で pointer-events: none に倒す。
  const summary = menu instanceof HTMLElement ? menu.querySelector(':scope > summary') : null;
  if (summary instanceof HTMLElement) summary.setAttribute('aria-disabled', 'true');
}

function syncEndUI(btn, finalText) {
  if (btn instanceof HTMLButtonElement) {
    const text = typeof finalText === 'string' ? finalText : t('actionSync');
    btn.replaceChildren(document.createTextNode(text));
  }
  const syncBtn = document.getElementById('hub-sync');
  const deleteBtn = document.getElementById('hub-delete');
  if (syncBtn instanceof HTMLButtonElement) syncBtn.disabled = false;
  if (deleteBtn instanceof HTMLButtonElement) deleteBtn.disabled = false;
  const chips = document.querySelectorAll('#hub-chips .hub-chip');
  for (const c of chips) {
    if (c instanceof HTMLButtonElement) c.disabled = false;
  }
  const select = document.getElementById('hub-account-select');
  if (select instanceof HTMLSelectElement) select.disabled = false;
  const search = document.getElementById('hub-search');
  if (search instanceof HTMLInputElement) search.disabled = false;
  const dateFromEl = document.getElementById('hub-date-from');
  if (dateFromEl instanceof HTMLInputElement) dateFromEl.disabled = false;
  const dateToEl = document.getElementById('hub-date-to');
  if (dateToEl instanceof HTMLInputElement) dateToEl.disabled = false;
  const datePresetEls = document.querySelectorAll('.hub-date-preset');
  for (const p of datePresetEls) {
    if (p instanceof HTMLButtonElement) p.disabled = false;
  }
  const sortToggleEl = document.getElementById('hub-sort-toggle');
  if (sortToggleEl instanceof HTMLButtonElement) sortToggleEl.disabled = false;
  const menu = document.getElementById('hub-menu');
  const summary = menu instanceof HTMLElement ? menu.querySelector(':scope > summary') : null;
  if (summary instanceof HTMLElement) summary.removeAttribute('aria-disabled');
}

// 選択同期: alert 廃止、ステータスバー一本化。
// ボタン文字「同期 (合計 N件)」「同期 (1サービス N件)」/「同期 (失敗)」は維持（6 秒過ぎた後の視認性確保）。
// services は ALL_SERVICES の部分集合（必ず 1 個以上、bindServiceSelectionDialog で保証）。
async function handleSyncSelective(services) {
  if (!Array.isArray(services) || services.length === 0) return;
  const btn = document.getElementById('hub-sync');
  if (!(btn instanceof HTMLButtonElement)) return;
  syncStartUI(btn);
  let finalText = t('actionSync');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SYNC_SELECTIVE', services });
    const rows = [];
    let total = 0;
    const successSvcCounts = []; // [{ svc, count }] - 成功サービスのみ、ボタン表示用
    let okFlag = false;
    let geminiTabActionAdded = false;
    let googleaiTabActionAdded = false;
    let grokTabActionAdded = false;
    let xgrokTabActionAdded = false;
    if (result !== null && typeof result === 'object'
        && result.results !== null && typeof result.results === 'object') {
      okFlag = result.ok === true;
      // ALL_SERVICES の固定順で集計し、対象 service だけ表示する。
      for (const svc of ALL_SERVICES) {
        if (!services.includes(svc)) continue;
        const r = result.results[svc];
        if (!r || typeof r !== 'object') continue;
        if (typeof r.count === 'number') {
          rows.push({ svc, label: t('statusSyncRowOk', [serviceLabel(svc), String(r.count)]), isError: false });
          total += r.count;
          successSvcCounts.push({ svc, count: r.count });
        } else if (typeof r.error === 'string' && r.error.length > 0) {
          const errInfo = parseErrorInfo(r.error);
          let action = null;
          // Gemini: タブ未開 / content script 未注入のみ「Gemini を開く」誘導。
          // not_logged_in は誤誘導になるため除外する (タブを開いてもログイン切れは解決しない)。
          if (svc === 'gemini' && !geminiTabActionAdded
              && (errInfo.code === 'tab_unreachable' || errInfo.code === 'content_unreachable')) {
            action = {
              label: t('syncActionGemini'),
              onClick: () => {
                chrome.tabs.create({ url: 'https://gemini.google.com/app' });
              },
            };
            geminiTabActionAdded = true;
          }
          // GoogleAI: タブ未開 / content script 未注入 / Cookie 切れ / aria-label から email 不取得の
          // 4 系統で udm=50 のページを開けば解決する。q= 単独だと top にリダイレクトされるため
          // 最小ダミー値 q=test を付ける。
          if (svc === 'googleai' && !googleaiTabActionAdded
              && ['tab_unreachable', 'content_unreachable', 'not_logged_in', 'account_email_not_found'].includes(errInfo.code)) {
            action = {
              label: t('syncActionGoogleai'),
              onClick: () => {
                chrome.tabs.create({ url: 'https://www.google.com/search?udm=50&hl=ja&q=test' });
              },
            };
            googleaiTabActionAdded = true;
          }
          // Grok: タブ未開 / content script 未注入 / Cookie 切れの 3 系統で grok.com を開けば解決する。
          // `/c` は個別会話 prefix なので id なしでは無効、安全策で `/` を開く。
          if (svc === 'grok' && !grokTabActionAdded
              && ['tab_unreachable', 'content_unreachable', 'not_logged_in'].includes(errInfo.code)) {
            action = {
              label: t('syncActionGrok'),
              onClick: () => {
                chrome.tabs.create({ url: 'https://grok.com/' });
              },
            };
            grokTabActionAdded = true;
          }
          // X内Grok の履歴ページ (https://x.com/i/grok/history) は PC 版 UI から
          // 遷移できない隠しパスのため、エラー文言に関わらず常に誘導リンクを出す。
          if (svc === 'xgrok' && !xgrokTabActionAdded) {
            action = {
              label: t('syncActionXgrok'),
              onClick: () => {
                chrome.tabs.create({ url: 'https://x.com/i/grok/history' });
              },
            };
            xgrokTabActionAdded = true;
          }
          const row = {
            svc,
            label: shortenServiceError(serviceLabel(svc), errInfo),
            isError: true,
          };
          if (action !== null) row.action = action;
          rows.push(row);
        }
      }
    }

    if (okFlag) {
      cachedRecords = await readAll();
      populateAccountSelect(cachedRecords);
      updateChipCounts(cachedRecords);
      renderFiltered();
      // 1 サービスのみ成功時は内訳を出す（例: 「同期 (ChatGPT 153件)」）。
      // 複数成功時は合計表示（例: 「同期 (合計 275件)」）。0 件成功時は「同期」のみ。
      if (successSvcCounts.length === 1) {
        const { svc, count } = successSvcCounts[0];
        finalText = t('syncBtnSingleCount', [serviceLabel(svc), String(count)]);
      } else if (successSvcCounts.length > 1) {
        finalText = t('syncBtnTotalCount', [String(total)]);
      }
      // 行モード: サービスごと 1 行ずつ。エラー行は赤テキスト + 行内末尾に誘導ボタン。
      renderStatusBar('', false, undefined, rows);
    } else {
      finalText = t('syncBtnFailed');
      // 全失敗: 濃赤背景 + 「同期失敗: 詳細はコンソール」（従来モード）。
      // 誘導ボタンは flat 列で末尾に並べる。
      const flatActions = rows.filter(r => r.action).map(r => r.action);
      renderStatusBar(t('statusSyncFailed'), true, flatActions);
    }
  } catch (err) {
    console.error('[LLM History Hub] sync selective failed', err);
    finalText = t('syncBtnFailed');
    renderStatusBar(t('statusSyncFailed'), true);
  } finally {
    syncEndUI(btn, finalText);
  }
}

// 選択削除: 指定 service の全レコードを SW 経由で削除し、popup を再描画する。
// services は ALL_SERVICES の部分集合（必ず 1 個以上、bindServiceSelectionDialog で保証）。
// 二重 confirm は省略（ダイアログのチェックリスト + 赤い「削除」ボタンの二段階で十分）。
async function handleDeleteSelective(services) {
  if (!Array.isArray(services) || services.length === 0) return;
  syncStartUI(null);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'DELETE_SELECTIVE', services });
    if (r && r.ok === true) {
      cachedRecords = await readAll();
      populateAccountSelect(cachedRecords);
      updateChipCounts(cachedRecords);
      renderFiltered();
      // 削除完了時のステータスバー文言: ALL_SERVICES 順に対象だけ並べて内訳明示。
      // 例: 「削除しました: ChatGPT (5件), Grok (3件) 合計 8件」
      const perService = (r.perService !== null && typeof r.perService === 'object')
        ? r.perService
        : {};
      const parts = [];
      for (const svc of ALL_SERVICES) {
        if (!services.includes(svc)) continue;
        const n = typeof perService[svc] === 'number' ? perService[svc] : 0;
        parts.push(t('deleteSvcCount', [serviceLabel(svc), String(n)]));
      }
      const total = typeof r.deleted === 'number' ? r.deleted : 0;
      const breakdown = parts.length > 0 ? parts.join(', ') : t('statusDeleteEmpty');
      renderStatusBar(t('statusDeleteOk', [breakdown, String(total)]), false);
    } else {
      const errMsg = r && typeof r.error === 'string' ? r.error : t('statusErrorUnknown');
      renderStatusBar(t('statusDeleteFailed', [errMsg]), true);
    }
  } catch (err) {
    console.error('[LLM History Hub] delete selective failed', err);
    renderStatusBar(t('statusDeleteFailedConsole'), true);
  } finally {
    syncEndUI(null, t('actionSync'));
  }
}

// 同期 / 削除ダイアログ共通の結線関数。
// kind = 'sync' | 'delete' で対象 dialog 要素を切り替える。
// 戻り値: { open() } - ヘッダーボタンクリックで呼び出すための object。
// open() は毎回「全て ON」で初期化する（前回選択は記憶しない、シンプル優先）。
function bindServiceSelectionDialog(kind, onConfirm) {
  if (kind !== 'sync' && kind !== 'delete') return null;
  const dialog = document.getElementById(`hub-${kind}-dialog`);
  if (!(dialog instanceof HTMLDialogElement)) return null;
  const checklist = dialog.querySelector('.hub-dialog-checklist');
  if (!(checklist instanceof HTMLElement)) return null;
  const allCheckbox = checklist.querySelector('input[data-svc="all"]');
  const itemCheckboxes = Array.from(
    checklist.querySelectorAll('input[data-svc]:not([data-svc="all"])'),
  ).filter((c) => c instanceof HTMLInputElement);
  const confirmBtn = dialog.querySelector('button[data-action="confirm"]');

  function updateConfirmEnabled() {
    if (!(confirmBtn instanceof HTMLButtonElement)) return;
    const anyChecked = itemCheckboxes.some((c) => c.checked);
    confirmBtn.disabled = !anyChecked;
  }

  function syncAllFromItems() {
    const checkedSet = new Set(
      itemCheckboxes.filter((c) => c.checked).map((c) => c.dataset.svc),
    );
    const { allChecked, allIndeterminate } = computeAllCheckedState(checkedSet, ALL_SERVICES);
    if (allCheckbox instanceof HTMLInputElement) {
      allCheckbox.checked = allChecked;
      allCheckbox.indeterminate = allIndeterminate;
    }
    updateConfirmEnabled();
  }

  // 「全て」変更時 → 個別を一斉切替。
  if (allCheckbox instanceof HTMLInputElement) {
    allCheckbox.addEventListener('change', () => {
      const checked = allCheckbox.checked;
      for (const c of itemCheckboxes) c.checked = checked;
      allCheckbox.indeterminate = false;
      updateConfirmEnabled();
    });
  }
  // 個別変更時 → 「全て」を再計算。
  for (const c of itemCheckboxes) {
    c.addEventListener('change', syncAllFromItems);
  }

  // ダイアログ内のボタンクリックを委譲で拾う。
  dialog.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const btn = target.closest('button[data-action]');
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.dataset.action;
    if (action === 'cancel') {
      dialog.close();
      return;
    }
    if (action === 'confirm') {
      const services = itemCheckboxes
        .filter((c) => c.checked)
        .map((c) => c.dataset.svc)
        .filter((s) => typeof s === 'string' && s.length > 0);
      dialog.close();
      // close() を先に呼んでから onConfirm。SW 通信は async なので、
      // ダイアログを閉じない状態で実行が始まると視覚的に古い UI が残る。
      onConfirm(services);
    }
  });

  return {
    open() {
      // 他ダイアログ open 中の二重 showModal は例外スローするので、保険で先に閉じる。
      const mismatch = document.getElementById('hub-mismatch-dialog');
      if (mismatch instanceof HTMLDialogElement && mismatch.open) mismatch.close();
      const otherKind = kind === 'sync' ? 'delete' : 'sync';
      const other = document.getElementById(`hub-${otherKind}-dialog`);
      if (other instanceof HTMLDialogElement && other.open) other.close();

      // 開くたびに「全て ON」で初期化（前回選択は記憶しない）。
      for (const c of itemCheckboxes) c.checked = true;
      if (allCheckbox instanceof HTMLInputElement) {
        allCheckbox.checked = true;
        allCheckbox.indeterminate = false;
      }
      updateConfirmEnabled();
      dialog.showModal();
    },
  };
}

// ヘッダー「同期」「削除」ボタンに click を結線。
// クリック時はダイアログを開き、ダイアログの「実行」「削除」確定で onConfirm が走る。
function bindActionButtons() {
  const syncDialog = bindServiceSelectionDialog('sync', handleSyncSelective);
  const deleteDialog = bindServiceSelectionDialog('delete', handleDeleteSelective);
  const syncBtn = document.getElementById('hub-sync');
  if (syncBtn instanceof HTMLButtonElement && syncDialog) {
    syncBtn.addEventListener('click', () => syncDialog.open());
  }
  const deleteBtn = document.getElementById('hub-delete');
  if (deleteBtn instanceof HTMLButtonElement && deleteDialog) {
    deleteBtn.addEventListener('click', () => deleteDialog.open());
  }
}

// 外部から popup 状態を再構築する。mock-popup の機械検証で
// 「fixture を流し込んだ後の cachedRecords / currentAccounts / 描画を最新化」する用途。
// 拡張ポップアップでも同期成功時 / 起動時に内部的に呼ぶことができる。
export async function refresh() {
  try {
    cachedRecords = await readAll();
  } catch (err) {
    console.error('[LLM History Hub] refresh: readAll failed', err);
    cachedRecords = [];
  }
  // 現プロファイルの accountEmail を SW 経由で取得する。
  // 失敗時は null / [] のまま（不一致判定をスキップ）。
  try {
    const r = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_ACCOUNTS' });
    if (r && r.ok === true && r.accounts !== null && typeof r.accounts === 'object') {
      currentAccounts = {
        chatgpt: typeof r.accounts.chatgpt === 'string' ? r.accounts.chatgpt : null,
        claude: Array.isArray(r.accounts.claude) ? r.accounts.claude : [],
        gemini: typeof r.accounts.gemini === 'string' ? r.accounts.gemini : null,
        googleai: typeof r.accounts.googleai === 'string' ? r.accounts.googleai : null,
        grok: typeof r.accounts.grok === 'string' ? r.accounts.grok : null,
        xgrok: typeof r.accounts.xgrok === 'string' ? r.accounts.xgrok : null,
      };
    }
  } catch (err) {
    console.warn('[LLM History Hub] refresh: currentAccounts fetch failed', err);
  }
  populateAccountSelect(cachedRecords);
  updateChipCounts(cachedRecords);
  renderFiltered();
}

async function init() {
  // i18n を最優先で適用する。HTML は静的に日本語を埋めているため、ja UI ではそのまま表示、
  // 他言語では applyI18n が DOM の textContent / 属性を上書きする。<body hidden> を解除するのは
  // applyI18n の後にして、初期描画の言語混在 (FOUC) を防ぐ。
  setHtmlLang();
  if (typeof document !== 'undefined' && document.body) {
    applyI18n(document.body);
    document.body.hidden = false;
  }

  try {
    await openDB();
  } catch (err) {
    console.error('[LLM History Hub] popup init: openDB failed', err);
  }
  await refresh();

  bindRowClick();
  bindActionButtons();
  bindFilters();
  bindMismatchDialog();
  bindMenuItems();
  bindVirtualScroll();
  bindScrollTopButton();
}

// mock-popup.html / 拡張ポップアップの両方で document の準備が済んだ状態で呼ばれる。
// 純関数 (applyFilters / buildAccountOptions / shortenServiceError / isMismatch) を
// Node から import して単体テストする場合は document が undefined なので init は走らせない。
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
