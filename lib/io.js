// エクスポート / インポートの純関数。IndexedDB / chrome.* / document を参照しない。
// CSV 仕様 (BOM / CRLF / RFC 4180 / 列順) は docs/UI_DESIGN.md の SSOT を参照。

import { isValidRecord } from './merge.js';

export const CSV_COLUMNS = Object.freeze([
  'id',
  'service',
  'accountEmail',
  'conversationId',
  'title',
  'url',
  'createdAt',
  'updatedAt',
  'favorite',
]);

export function csvEscape(s) {
  const v = (s === null || s === undefined) ? '' : String(s);
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// favorite だけは boolean を CSV に乗せるため "1" / "" に正規化する。
// 他フィールドは csvEscape の String() フォールバックそのまま。
function csvCellValue(r, key) {
  if (key === 'favorite') {
    return r.favorite === true ? '1' : '';
  }
  return r[key];
}

export function recordsToJson(records) {
  if (!Array.isArray(records)) return '[]';
  // favorite は boolean に正規化して全レコードに残す。インポート側で typeof boolean 判定して
  // 上書き判定するため、true/false どちらも明示的にエクスポートする (undefined は出さない)。
  const valid = records
    .filter(isValidRecord)
    .map((r) => ({ ...r, favorite: r.favorite === true }));
  return JSON.stringify(valid, null, 2);
}

export function recordsToCsv(records) {
  const header = CSV_COLUMNS.join(',');
  if (!Array.isArray(records)) {
    return '﻿' + header + '\r\n';
  }
  const lines = [header];
  for (const r of records) {
    if (!isValidRecord(r)) continue;
    lines.push(CSV_COLUMNS.map((k) => csvEscape(csvCellValue(r, k))).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function parseJsonImport(text) {
  if (typeof text !== 'string') {
    throw new TypeError(JSON.stringify({ code: 'invalid_json' }));
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(JSON.stringify({ code: 'invalid_json' }));
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(JSON.stringify({ code: 'not_an_array' }));
  }
  return parsed;
}
