// chrome.i18n ヘルパ。トップレベルで chrome を参照しないため mock-popup / Node import でも
// 例外を出さない (関数呼び出し時に chrome の有無を確認してフォールバックする)。
//
// メッセージキーは Chrome i18n 仕様に従い camelCase で命名する (`A-Z, a-z, 0-9, _, @` のみ可、
// `.` は不可)。詳細は docs/UI_DESIGN.md §多言語対応 参照。

// chrome.i18n.getMessage の薄いラッパ。chrome 不在時はキーをそのまま返す (フォールバック)。
export function t(key, args) {
  if (typeof chrome === 'undefined' || !chrome.i18n) {
    return typeof key === 'string' ? key : '';
  }
  const result = chrome.i18n.getMessage(key, args);
  // 未定義キーは getMessage が空文字を返すため、キー名を fallback として使う (デバッグ容易性)。
  return (typeof result === 'string' && result.length > 0) ? result : key;
}

// Chrome UI 言語が ja で始まるかどうかを返す。chrome 不在時は 'en' 扱い。
export function getUILocale() {
  if (typeof chrome === 'undefined' || !chrome.i18n
      || typeof chrome.i18n.getUILanguage !== 'function') {
    return 'en';
  }
  const lang = chrome.i18n.getUILanguage();
  return (typeof lang === 'string' && lang.toLowerCase().startsWith('ja')) ? 'ja' : 'en';
}

// document.documentElement.lang を Chrome UI 言語に応じて書き換える。
// HTML の静的 lang="ja" は popup ロード時の hint として残し、起動時にここで上書きする。
export function setHtmlLang() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  document.documentElement.lang = getUILocale();
}

// data-i18n-attr の構文をパースする。
// 形式: "<attr1>:<key1>;<attr2>:<key2>"
// `:` を含む URL 値は属性キー側には現れないため、最初の `:` を区切りとする。
function parseAttrSpec(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return [];
  const out = [];
  for (const segment of spec.split(';')) {
    const idx = segment.indexOf(':');
    if (idx <= 0) continue;
    const attr = segment.slice(0, idx).trim();
    const key = segment.slice(idx + 1).trim();
    if (attr.length > 0 && key.length > 0) {
      out.push({ attr, key });
    }
  }
  return out;
}

// 単一要素の data-i18n / data-i18n-attr 属性を翻訳済み文字列に置換する。
function applyI18nElement(el) {
  if (!(el instanceof Element)) return;
  const textKey = el.getAttribute('data-i18n');
  if (typeof textKey === 'string' && textKey.length > 0) {
    el.textContent = t(textKey);
  }
  const attrSpec = el.getAttribute('data-i18n-attr');
  if (typeof attrSpec === 'string' && attrSpec.length > 0) {
    for (const { attr, key } of parseAttrSpec(attrSpec)) {
      el.setAttribute(attr, t(key));
    }
  }
}

// rootEl 配下の全 data-i18n / data-i18n-attr 要素を翻訳する。
// init 時の一括置換と、動的に挿入された要素 (例: dialog 内行) への個別置換の両方をサポート。
export function applyI18n(rootEl) {
  const isDoc = (typeof Document !== 'undefined') && (rootEl instanceof Document);
  if (!(rootEl instanceof Element) && !isDoc) return;
  if (rootEl instanceof Element) applyI18nElement(rootEl);
  const targets = rootEl.querySelectorAll('[data-i18n], [data-i18n-attr]');
  for (const el of targets) {
    applyI18nElement(el);
  }
}

// epoch ms を Chrome UI 言語に応じた表記に整形する。
// ja: yyyy-mm-dd (popup.js 既存 ymd() と互換) / en: Apr 24, 2026
export function formatDate(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '';
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '';
  if (getUILocale() === 'ja') {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
