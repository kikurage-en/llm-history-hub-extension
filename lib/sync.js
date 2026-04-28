// 重要制約:
// - トップレベルで `chrome.*` を参照しない（mock-popup から import 可能にするため）。
// - 純関数 (`normalizeChatGptItems` 等) と副作用付き取得 (`syncChatGpt` 等) を分離する。
// - 失敗時は throw（エラー戦略 sync 層）。成功時は `Record[]` を返す。
// - accessToken 等の機密値は関数ローカル変数のみで保持し、戻り値・例外メッセージ・ログに含めない。
// - 例外メッセージはエラーコード化 (`{ code, service, ... }` の JSON 文字列) し、popup 側の
//   `parseErrorInfo` で復号する（i18n 対応のため）。`code` 一覧は `popup.js` の
//   `shortenServiceError` の switch に列挙する。

// エラー JSON 文字列を生成する。code は popup.js の shortenServiceError と 1:1 対応する。
// extras には `status` (HTTP) や `detail` (汎用メッセージ) を含めてよい。
function svcError(code, service, extras) {
  const payload = { code, service };
  if (extras !== null && typeof extras === 'object') {
    Object.assign(payload, extras);
  }
  return new Error(JSON.stringify(payload));
}

// content script からの sendResponse({ ok: false, error: <JSON文字列> }) を透過する。
// 既にコード化済みの error をそのまま rethrow する想定。JSON でない場合は generic にフォールバック。
function rethrowContentError(respError, fallbackCode, service) {
  if (typeof respError === 'string' && respError.length > 0) {
    try {
      const obj = JSON.parse(respError);
      if (obj !== null && typeof obj === 'object' && typeof obj.code === 'string') {
        throw new Error(respError);
      }
    } catch (parseErr) {
      // JSON.parse 失敗または rethrow 後の Error。後者は再 throw する。
      if (parseErr instanceof Error && typeof parseErr.message === 'string'
          && parseErr.message.startsWith('{')) {
        throw parseErr;
      }
    }
  }
  throw svcError(fallbackCode, service);
}

const CHATGPT_PAGE_LIMIT = 100;

// Gemini batchexecute の `_reqid` は同一 epoch 内で衝突すると 400 が返るため、
// 同期呼び出しごとに 100000 ずつ進める（API_NOTES.md §Gemini）。
// SW のアイドル停止で module が再読み込みされると -1 に戻るが、その場合は
// `Date.now() % 1_000_000_000` から再始動するので衝突しない。
let geminiLastReqid = -1;

const GEMINI_PAGE_LIMIT = 200;

// `/backend-api/conversations` の items[] 配列を統一スキーマに正規化する。
// mock-popup から呼び出してテストできるよう副作用なしの純関数として export する。
export function normalizeChatGptItems(items, accountEmail) {
  if (!Array.isArray(items)) return [];
  if (typeof accountEmail !== 'string' || accountEmail.length === 0) return [];

  const out = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    if (item.is_temporary_chat === true) continue;
    if (typeof item.id !== 'string' || item.id.length === 0) continue;

    const title = (typeof item.title === 'string' && item.title.length > 0)
      ? item.title
      : '(無題)';

    const createdAt = Date.parse(item.create_time) || 0;
    const updatedAt = Date.parse(item.update_time) || 0;

    out.push({
      id: `chatgpt_${accountEmail}_${item.id}`,
      service: 'chatgpt',
      accountEmail,
      conversationId: item.id,
      title,
      url: `https://chatgpt.com/c/${item.id}`,
      createdAt,
      updatedAt,
    });
  }
  return out;
}

// `/api/organizations/{uuid}/chat_conversations` の配列を統一スキーマに正規化する。
// mock-popup から呼び出してテストできるよう副作用なしの純関数として export する。
export function normalizeClaudeItems(items, accountEmail) {
  if (!Array.isArray(items)) return [];
  if (typeof accountEmail !== 'string' || accountEmail.length === 0) return [];

  const out = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    if (item.is_temporary === true) continue;
    // MVP は project_uuid !== null の会話を除外（API_NOTES.md §Claude）。
    if (item.project_uuid !== null && item.project_uuid !== undefined) continue;
    if (typeof item.uuid !== 'string' || item.uuid.length === 0) continue;

    const title = (typeof item.name === 'string' && item.name.length > 0)
      ? item.name
      : '(無題)';

    const createdAt = Date.parse(item.created_at) || 0;
    const updatedAt = Date.parse(item.updated_at) || 0;

    out.push({
      id: `claude_${accountEmail}_${item.uuid}`,
      service: 'claude',
      accountEmail,
      conversationId: item.uuid,
      title,
      url: `https://claude.ai/chat/${item.uuid}`,
      createdAt,
      updatedAt,
    });
  }
  return out;
}

// 現プロファイルの ChatGPT email を取得する。
// 不一致警告ダイアログ判定のため popup 起動時に SW 経由で呼び出す。
// 失敗時は throw（メッセージに accessToken / Cookie 値を含めない）。
export async function getCurrentChatGptEmail() {
  let res;
  try {
    res = await fetch('https://chatgpt.com/api/auth/session', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    if (err instanceof TypeError) {
      throw svcError('network_error', 'chatgpt', { detail: 'auth/session' });
    }
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    throw svcError('not_logged_in', 'chatgpt');
  }
  if (!res.ok) {
    throw svcError('http_error', 'chatgpt', { status: res.status, detail: 'auth/session' });
  }
  const session = await res.json();
  const email = session && session.user && typeof session.user.email === 'string'
    ? session.user.email
    : '';
  if (email.length === 0) {
    throw svcError('not_logged_in', 'chatgpt');
  }
  return email;
}

// 現プロファイルの Claude accountEmail 一覧を取得する（chat capability の org 全件、重複は dedupe）。
// 同 email で複数 chat org に所属するケースに備えて Set で dedupe したものを配列化して返す。
// 失敗時は throw（メッセージに org uuid / Cookie 値を含めない）。
export async function getCurrentClaudeAccountEmails() {
  let res;
  try {
    res = await fetch('https://claude.ai/api/organizations', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    if (err instanceof TypeError) {
      throw svcError('network_error', 'claude', { detail: 'organizations' });
    }
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    throw svcError('not_logged_in', 'claude');
  }
  if (!res.ok) {
    throw svcError('http_error', 'claude', { status: res.status, detail: 'organizations' });
  }
  const orgs = await res.json();
  if (!Array.isArray(orgs)) {
    throw svcError('not_logged_in', 'claude');
  }
  const emails = orgs
    .filter((o) => o && Array.isArray(o.capabilities) && o.capabilities.includes('chat'))
    .map(pickClaudeAccountEmail)
    .filter((s) => typeof s === 'string' && s.length > 0);
  return Array.from(new Set(emails));
}

// chatgpt.com から履歴を取得して正規化済み Record[] を返す。
// 失敗時は throw する（メッセージにレスポンスボディ等の機密情報を含めない）。
export async function syncChatGpt() {
  // 1) セッション取得 → accessToken / email を取り出す。
  //    `host_permissions` で chatgpt.com を許可済みのオリジンへの fetch でも、
  //    Cookie の自動付与は `credentials: 'include'` を明示する方が安全。
  let session;
  try {
    const res = await fetch('https://chatgpt.com/api/auth/session', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      throw svcError('not_logged_in', 'chatgpt');
    }
    if (!res.ok) {
      throw svcError('http_error', 'chatgpt', { status: res.status, detail: 'auth/session' });
    }
    session = await res.json();
  } catch (err) {
    if (err instanceof TypeError) {
      throw svcError('network_error', 'chatgpt', { detail: 'auth/session' });
    }
    throw err;
  }

  const accessToken = session && typeof session.accessToken === 'string' ? session.accessToken : '';
  const email = session && session.user && typeof session.user.email === 'string' ? session.user.email : '';
  if (accessToken.length === 0 || email.length === 0) {
    throw svcError('not_logged_in', 'chatgpt');
  }

  // 2) 履歴をページングで全取得。終端は `items.length < limit` で判定（API_NOTES.md）。
  const accumulator = [];
  let offset = 0;
  while (true) {
    const url = `https://chatgpt.com/backend-api/conversations?offset=${offset}&limit=${CHATGPT_PAGE_LIMIT}&order=updated`;
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
      });
    } catch (err) {
      throw svcError('network_error', 'chatgpt', { detail: 'backend-api/conversations' });
    }
    if (res.status === 401 || res.status === 403) {
      throw svcError('not_logged_in', 'chatgpt');
    }
    if (!res.ok) {
      throw svcError('http_error', 'chatgpt', { status: res.status, detail: 'backend-api/conversations' });
    }
    const body = await res.json();
    const items = Array.isArray(body && body.items) ? body.items : [];
    const records = normalizeChatGptItems(items, email);
    for (const rec of records) accumulator.push(rec);

    // 終端: items.length < limit。
    if (items.length < CHATGPT_PAGE_LIMIT) break;
    offset += CHATGPT_PAGE_LIMIT;
  }

  return accumulator;
}

// `/api/organizations` レスポンスの 1 件から accountEmail を決定する。
// 個人 org の場合は `name` に "<email>'s Organization" 形式で email が含まれるため、
// 正規表現マッチで抽出する。会社/チーム org など email を含まないケースは
// `org:${uuid.slice(0, 8)}` にフォールバック（API_NOTES.md §Claude）。
export function pickClaudeAccountEmail(org) {
  if (!org || typeof org.uuid !== 'string' || org.uuid.length === 0) return '';
  const name = (typeof org.name === 'string') ? org.name : '';
  const m = name.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (m) return m[0];
  return `org:${org.uuid.slice(0, 8)}`;
}

// claude.ai から履歴を取得して正規化済み Record[] を返す。
// 失敗時は throw する（メッセージにレスポンスボディ・Cookie 値・org uuid を含めない）。
//
// accountEmail は `/api/organizations` の各エントリの `name` から email を抽出する
// （個人 org は `name` に email が埋め込まれている）。抽出できない org は
// `org:${uuid.slice(0, 8)}` にフォールバック。
export async function syncClaude() {
  // 1) 組織一覧を取得。Claude API は Cookie ベースのため Authorization ヘッダーは付けない。
  let orgs;
  try {
    const res = await fetch('https://claude.ai/api/organizations', {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    if (res.status === 401 || res.status === 403) {
      throw svcError('not_logged_in', 'claude');
    }
    if (!res.ok) {
      throw svcError('http_error', 'claude', { status: res.status, detail: 'organizations' });
    }
    orgs = await res.json();
  } catch (err) {
    if (err instanceof TypeError) {
      throw svcError('network_error', 'claude', { detail: 'organizations' });
    }
    throw err;
  }

  if (!Array.isArray(orgs)) {
    throw svcError('not_logged_in', 'claude');
  }

  // 2) `/chat_conversations` を持つ org だけに絞り込む。
  //    `capabilities` に `chat` を含まない org（例: `["api"]` の API Workspace）は
  //    `/chat_conversations` で 403 を返すため事前除外。
  const chatOrgs = orgs.filter((org) =>
    org && Array.isArray(org.capabilities) && org.capabilities.includes('chat')
  );

  // 3) 各 chat org について `/chat_conversations` を並列取得。
  //    事前除外しているので Promise.all で全成功する想定。個別 org 失敗時は
  //    全体失敗扱いとする。
  const perOrg = await Promise.all(chatOrgs.map(async (org) => {
    if (!org || typeof org.uuid !== 'string' || org.uuid.length === 0) {
      // throw メッセージには org uuid を含めない（ログ流出回避）。
      throw svcError('invalid_org_entry', 'claude');
    }
    const orgUuid = org.uuid;
    const accountEmail = pickClaudeAccountEmail(org);
    const url = `https://claude.ai/api/organizations/${orgUuid}/chat_conversations`;
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
    } catch (err) {
      // console.error には orgUuid を含めて DevTools での切り分けを助ける。
      console.error(`[LLM History Hub] claude /chat_conversations network error org=${orgUuid}`, err);
      throw svcError('network_error', 'claude', { detail: 'chat_conversations' });
    }
    if (res.status === 401 || res.status === 403) {
      throw svcError('not_logged_in', 'claude');
    }
    if (!res.ok) {
      console.error(`[LLM History Hub] claude /chat_conversations failed status=${res.status} org=${orgUuid}`);
      throw svcError('http_error', 'claude', { status: res.status, detail: 'chat_conversations' });
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      console.error(`[LLM History Hub] claude /chat_conversations: response is not an array org=${orgUuid}`);
      throw svcError('unexpected_response_shape', 'claude', { detail: 'chat_conversations' });
    }
    return normalizeClaudeItems(body, accountEmail);
  }));

  const accumulator = [];
  for (const records of perOrg) {
    for (const rec of records) accumulator.push(rec);
  }
  return accumulator;
}

// Gemini の `POST /batchexecute` 生レスポンスから会話配列と次ページカーソルを抽出する。
// レスポンスは `)]}'` prefix + 改行区切りチャンクの Google 独自ストリーミング形式。
// 各チャンクは「バイト長行 + JSON 配列行」だが、JSON 行のみを JSON.parse 試行で拾い、
// `["wrb.fr","MaZiqc",<JSON 文字列>,...]` を見つけて二重 parse する。
//
// 内部 wrapper 構造は実測で `[null, <次ページカーソル token>, <会話配列>, ...]` 形式
// （会話一覧は parsed[2]、カーソルは parsed[1] / 約 1453 文字の不透明 base64 風文字列）。
// Google の RPC レスポンス形式は変動するため位置はハードコードせず、
// - 会話一覧: 「array of array で各要素の `[0]` が `c_` 始まり string」のパターンマッチ
// - カーソル: 「100 文字以上の string 要素」(会話 ID 18 文字 / title 数十文字より十分長い)
// で動的に特定する。想定外形状では throw せず空オブジェクトを返す。
export function parseGeminiBatchExecute(rawText) {
  const empty = { items: [], cursor: null };
  if (typeof rawText !== 'string' || rawText.length === 0) return empty;

  let body = rawText;
  if (body.startsWith(")]}'")) {
    body = body.slice(4);
  }

  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.charAt(0) !== '[') continue;

    let outer;
    try {
      outer = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!Array.isArray(outer)) continue;

    for (const entry of outer) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      if (entry[0] !== 'wrb.fr' || entry[1] !== 'MaZiqc') continue;

      const inner = entry[2];
      if (typeof inner !== 'string' || inner.length === 0) continue;

      let parsed;
      try {
        parsed = JSON.parse(inner);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;

      let items = [];
      let cursor = null;
      for (const candidate of parsed) {
        if (Array.isArray(candidate) && candidate.length > 0
            && Array.isArray(candidate[0])
            && typeof candidate[0][0] === 'string'
            && candidate[0][0].startsWith('c_')) {
          items = candidate;
        } else if (typeof candidate === 'string' && candidate.length >= 100 && cursor === null) {
          cursor = candidate;
        }
      }
      return { items, cursor };
    }
  }
  return empty;
}

// Gemini の MaZiqc レスポンスの会話エントリ配列を統一スキーマに正規化する。
// 各 item は固定インデックス配列で、`[0]` = conversationId（`c_` + 16hex）、
// `[1]` = title (string|null)、`[5]` = `[seconds, nanoseconds]` (Protobuf Timestamp 相当)。
// `createdAt` は本 RPC で取得不可のため `updatedAt` で代用する（API_NOTES.md §Gemini）。
export function normalizeGeminiItems(items, accountEmail) {
  if (!Array.isArray(items)) return [];
  if (typeof accountEmail !== 'string' || accountEmail.length === 0) return [];

  const out = [];
  for (const item of items) {
    if (!Array.isArray(item)) continue;

    const rawId = item[0];
    if (typeof rawId !== 'string' || rawId.length === 0) continue;

    const rawTitle = item[1];
    const title = (typeof rawTitle === 'string' && rawTitle.length > 0) ? rawTitle : '(無題)';

    const ts = item[5];
    if (!Array.isArray(ts) || ts.length < 2) continue;
    const seconds = ts[0];
    const nanoseconds = ts[1];
    if (typeof seconds !== 'number' || typeof nanoseconds !== 'number') continue;

    const updatedAt = seconds * 1000 + Math.floor(nanoseconds / 1_000_000);
    const urlId = rawId.replace(/^c_/, '');

    out.push({
      id: `gemini_${accountEmail}_${rawId}`,
      service: 'gemini',
      accountEmail,
      conversationId: rawId,
      title,
      url: `https://gemini.google.com/app/${urlId}`,
      createdAt: updatedAt,
      updatedAt,
    });
  }
  return out;
}

// gemini.google.com のタブから session 情報と accountEmail を取得して `_reqid` 付きで
// batchexecute を叩き、正規化済み Record[] を返す。
// 失敗時は throw（メッセージに at / bl / fsid を含めない）。
// accountEmail が取れない場合は `gemini-user-unknown` フォールバック（ARCHITECTURE.md §3 「空でなければ可」）。
export async function syncGemini() {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (!Array.isArray(tabs) || tabs.length === 0) {
    throw svcError('tab_unreachable', 'gemini');
  }
  // discarded / loading 中のタブは content script に sendMessage しても届かない。
  // active かつ complete のタブを優先し、なければ最初の complete タブ、最後の手段で tabs[0]。
  const tab = tabs.find((t) => t.active && t.status === 'complete' && !t.discarded)
    || tabs.find((t) => t.status === 'complete' && !t.discarded)
    || tabs[0];
  const tabId = tab.id;
  if (typeof tabId !== 'number') {
    throw svcError('tab_unreachable', 'gemini');
  }

  let sessionResp;
  try {
    sessionResp = await chrome.tabs.sendMessage(tabId, { type: 'GEMINI_GET_SESSION' });
  } catch (err) {
    // 想定内ケース（タブ未注入 / 拡張更新後にタブ未リロード）。chrome://extensions/ の
    // エラー欄に蓄積されないよう warn で出す。
    console.warn('[LLM History Hub] gemini content script unreachable',
      err && err.message ? err.message : err);
    throw svcError('content_unreachable', 'gemini');
  }
  if (!sessionResp || sessionResp.ok !== true || !sessionResp.session
      || typeof sessionResp.session.at !== 'string'
      || typeof sessionResp.session.bl !== 'string'
      || typeof sessionResp.session.fsid !== 'string') {
    rethrowContentError(sessionResp && sessionResp.error, 'session_retrieval_failed', 'gemini');
  }
  const { at, bl, fsid } = sessionResp.session;

  let accountEmail = 'gemini-user-unknown';
  try {
    const emailResp = await chrome.tabs.sendMessage(tabId, { type: 'GEMINI_GET_ACCOUNT_EMAIL' });
    if (emailResp && emailResp.ok === true
        && typeof emailResp.accountEmail === 'string'
        && emailResp.accountEmail.length > 0) {
      accountEmail = emailResp.accountEmail;
    }
  } catch (err) {
    console.warn('[LLM History Hub] gemini accountEmail fetch failed, using fallback');
  }

  // ページングループ: cursor を payload[1] に入れて再 RPC を繰り返す（仮説、Google の他 RPC の一般パターン）。
  // 終端: items=0 / cursor=null / cursor 不変 / MAX_PAGES 到達。
  // 1 ページ目は throw、2 ページ目以降の失敗は部分成功で break（途中までの items を返す）。
  const MAX_PAGES = 50;
  const allItems = [];
  let cursor = null;
  let lastCursor = null;
  let pageCount = 0;

  while (pageCount < MAX_PAGES) {
    pageCount += 1;
    if (geminiLastReqid < 0) {
      geminiLastReqid = Date.now() % 1_000_000_000;
    } else {
      geminiLastReqid += 100000;
    }

    const payload = JSON.stringify([GEMINI_PAGE_LIMIT, cursor, [0, null, 1]]);
    const fReq = JSON.stringify([[['MaZiqc', payload, null, 'generic']]]);
    const formBody = new URLSearchParams();
    formBody.set('f.req', fReq);
    formBody.set('at', at);

    const url = 'https://gemini.google.com/_/BardChatUi/data/batchexecute'
      + `?rpcids=MaZiqc&source-path=%2Fapp&bl=${encodeURIComponent(bl)}`
      + `&f.sid=${encodeURIComponent(fsid)}&hl=ja&_reqid=${geminiLastReqid}&rt=c`;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Accept': '*/*',
        },
        body: formBody.toString(),
      });
    } catch (err) {
      if (pageCount === 1) throw svcError('network_error', 'gemini', { detail: 'batchexecute' });
      console.warn(`[LLM History Hub] gemini page ${pageCount} network error, partial=${allItems.length}`);
      break;
    }
    if (!res.ok) {
      if (pageCount === 1) {
        if (res.status === 401 || res.status === 403) {
          throw svcError('not_logged_in', 'gemini');
        }
        throw svcError('http_error', 'gemini', { status: res.status, detail: 'batchexecute' });
      }
      console.warn(`[LLM History Hub] gemini page ${pageCount} http ${res.status}, partial=${allItems.length}`);
      break;
    }

    const text = await res.text();
    const { items, cursor: nextCursor } = parseGeminiBatchExecute(text);
    const cursorHead = (typeof nextCursor === 'string' && nextCursor.length > 0)
      ? nextCursor.slice(0, 30)
      : 'null';
    console.log(`[LLM History Hub] gemini page ${pageCount}: items=${items.length} nextCursorHead="${cursorHead}"`);

    if (items.length === 0) break;
    for (const item of items) allItems.push(item);

    if (typeof nextCursor !== 'string' || nextCursor.length === 0) break;
    if (nextCursor === lastCursor) {
      console.warn('[LLM History Hub] gemini cursor unchanged, breaking pagination');
      break;
    }
    lastCursor = nextCursor;
    cursor = nextCursor;
  }

  if (pageCount >= MAX_PAGES) {
    console.warn(`[LLM History Hub] gemini reached MAX_PAGES=${MAX_PAGES}, total=${allItems.length}`);
  }

  const records = normalizeGeminiItems(allItems, accountEmail);
  console.log(`[LLM History Hub] gemini sync items=${allItems.length} pages=${pageCount} records=${records.length}`);
  return records;
}

const GROK_PAGE_SIZE = 100;
const GROK_MAX_PAGES = 50;

// `/rest/app-chat/conversations` の conversations[] を統一スキーマに正規化する。
// mock-popup から呼び出してテストできるよう副作用なしの純関数として export する。
export function normalizeGrokItems(items, accountEmail) {
  if (!Array.isArray(items)) return [];
  if (typeof accountEmail !== 'string' || accountEmail.length === 0) return [];

  const out = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    if (item.temporary === true) continue;
    if (typeof item.conversationId !== 'string' || item.conversationId.length === 0) continue;

    const title = (typeof item.title === 'string' && item.title.length > 0)
      ? item.title
      : '(無題)';

    const createdAt = Date.parse(item.createTime) || 0;
    const updatedAt = Date.parse(item.modifyTime) || 0;

    out.push({
      id: `grok_${accountEmail}_${item.conversationId}`,
      service: 'grok',
      accountEmail,
      conversationId: item.conversationId,
      title,
      url: `https://grok.com/c/${item.conversationId}`,
      createdAt,
      updatedAt,
    });
  }
  return out;
}

// 現プロファイルの Grok userId を取得し、`grok-user-{userId}` 形式で返す。
// Grok は X SSO のため email が露出しない。grok.com のページ DOM の
// `<img alt="pfp" src="https://assets.grok.com/users/{userId}/...">` から userId (UUID) を抽出する。
// Next.js SPA で初期 HTML に pfp img が含まれないため (実測 2026-04-27)、SW 直 fetch ではなく
// content/grok.js 経由で実 DOM を読む（API_NOTES.md §Grok）。
// 不一致警告判定でも使うため `grok-user-{userId}` 全体を返す。
// 失敗時は throw（メッセージに userId 全体を含めない）。
export async function getCurrentGrokAccountId() {
  const tabs = await chrome.tabs.query({ url: 'https://grok.com/*' });
  if (!Array.isArray(tabs) || tabs.length === 0) {
    throw svcError('tab_unreachable', 'grok');
  }
  const tab = tabs.find((t) => t.active && t.status === 'complete' && !t.discarded)
    || tabs.find((t) => t.status === 'complete' && !t.discarded)
    || tabs[0];
  const tabId = tab.id;
  if (typeof tabId !== 'number') {
    throw svcError('tab_unreachable', 'grok');
  }

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: 'GROK_GET_ACCOUNT_ID' });
  } catch (err) {
    console.warn('[LLM History Hub] grok content script unreachable',
      err && err.message ? err.message : err);
    throw svcError('content_unreachable', 'grok');
  }
  if (!resp || resp.ok !== true || typeof resp.userId !== 'string' || resp.userId.length === 0) {
    rethrowContentError(resp && resp.error, 'userid_not_found', 'grok');
  }
  return `grok-user-${resp.userId}`;
}

// grok.com から履歴を取得して正規化済み Record[] を返す。
// 失敗時は throw する（メッセージにレスポンスボディ・Cookie 値を含めない）。
//
// 終端判定は `conversations.length < pageSize` を採用する。`nextPageToken` は
// 最終ページにも付与されるため、トークン有無では終端を判定できない（API_NOTES.md §Grok）。
// 1 ページ目は throw、2 ページ目以降の失敗は部分成功で break。
export async function syncGrok() {
  const accountEmail = await getCurrentGrokAccountId();

  const accumulator = [];
  let pageToken = null;
  let pageCount = 0;

  while (pageCount < GROK_MAX_PAGES) {
    pageCount += 1;
    const params = new URLSearchParams();
    params.set('pageSize', String(GROK_PAGE_SIZE));
    if (typeof pageToken === 'string' && pageToken.length > 0) {
      params.set('pageToken', pageToken);
    }
    const url = `https://grok.com/rest/app-chat/conversations?${params.toString()}`;

    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json' },
      });
    } catch (err) {
      if (pageCount === 1) {
        if (err instanceof TypeError) {
          throw svcError('network_error', 'grok', { detail: 'app-chat/conversations' });
        }
        throw err;
      }
      console.warn(`[LLM History Hub] grok page ${pageCount} network error, partial=${accumulator.length}`);
      break;
    }
    if (!res.ok) {
      if (pageCount === 1) {
        if (res.status === 401 || res.status === 403) {
          throw svcError('not_logged_in', 'grok');
        }
        throw svcError('http_error', 'grok', { status: res.status, detail: 'app-chat/conversations' });
      }
      console.warn(`[LLM History Hub] grok page ${pageCount} http ${res.status}, partial=${accumulator.length}`);
      break;
    }

    const body = await res.json();
    const conversations = Array.isArray(body && body.conversations) ? body.conversations : [];
    const records = normalizeGrokItems(conversations, accountEmail);
    for (const rec of records) accumulator.push(rec);

    console.log(`[LLM History Hub] grok page ${pageCount}: items=${conversations.length} records=${records.length}`);

    if (conversations.length < GROK_PAGE_SIZE) break;
    if (typeof body.nextPageToken !== 'string' || body.nextPageToken.length === 0) break;
    pageToken = body.nextPageToken;
  }

  if (pageCount >= GROK_MAX_PAGES) {
    console.warn(`[LLM History Hub] grok reached MAX_PAGES=${GROK_MAX_PAGES}, total=${accumulator.length}`);
  }

  console.log(`[LLM History Hub] grok sync pages=${pageCount} records=${accumulator.length}`);
  return accumulator;
}

// X UI で「直近 7 日以内」の項目に出る曜日名 → DOW (Date#getDay 互換)。
// X は当日項目を「今日」、前日項目を「昨日」、それ以前 6 日を曜日名で表示する。
const XGROK_WEEKDAY_DOW = {
  '月曜日': 1,
  '火曜日': 2,
  '水曜日': 3,
  '木曜日': 4,
  '金曜日': 5,
  '土曜日': 6,
  '日曜日': 0,
};

// X内Grok の日付ラベルを ローカル 00:00 の epoch ms に変換する純関数。
// サポート形式:
//   - "YYYY年M月D日" (1 週間以上前)
//   - 「今日」 (当日) / 「昨日」 (前日)
//   - 月〜日曜日 (過去 7 日以内、当日と異曜日のものに使われる)
//
// 曜日ラベルは「過去 7 日以内で最も近い該当曜日」を返す。今日が同じ曜日なら
// X UI は当日項目を「今日」ラベルで分類するため、先週の同曜日 (= 7 日前) として
// 解釈する。
//
// 時分秒は X 側に存在しないため 00:00 (ローカル) で記録 (`updatedAt` 粒度)。
//
// テスト容易性のため `now` を引数注入可能 (default `Date.now()`)。
export function parseXGrokDateText(text, now = Date.now()) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const m = trimmed.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return new Date(year, month - 1, day, 0, 0, 0).getTime();
  }

  if (trimmed === '今日') {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    return today.getTime();
  }

  if (trimmed === '昨日') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 1);
    return d.getTime();
  }

  if (Object.prototype.hasOwnProperty.call(XGROK_WEEKDAY_DOW, trimmed)) {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const targetDow = XGROK_WEEKDAY_DOW[trimmed];
    const todayDow = today.getDay();
    let diff = todayDow - targetDow;
    if (diff <= 0) diff += 7;
    today.setDate(today.getDate() - diff);
    return today.getTime();
  }

  return null;
}

// content script `XGROK_GET_CONVERSATIONS` の戻り値 (`{ conversationId, title, dateText }[]`) を
// 統一スキーマに正規化する純関数。
//
// 日付ラベルは parseXGrokDateText に委譲。null (空文字 / 未知形式) の場合は前項目の
// 日付を継承する。継承元がない場合は skip (ARCHITECTURE.md の `updatedAt` 不在は不正レコード)。
// conversationId 空 / 重複は skip（content script 側でも除去するが二重防御）。
//
// テスト容易性のため `now` を引数注入可能 (default `Date.now()`)。曜日ラベル解釈に
// 影響する点に注意 (実機呼び出しでは省略 OK)。
export function normalizeXGrokItems(items, accountEmail, now = Date.now()) {
  if (!Array.isArray(items)) return [];
  if (typeof accountEmail !== 'string' || accountEmail.length === 0) return [];

  const out = [];
  const seen = new Set();
  let prevUpdatedAt = null;

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const conversationId = item.conversationId;
    if (typeof conversationId !== 'string' || conversationId.length === 0) continue;
    if (seen.has(conversationId)) continue;

    const dateText = typeof item.dateText === 'string' ? item.dateText : '';
    let updatedAt = parseXGrokDateText(dateText, now);
    if (updatedAt === null) {
      if (prevUpdatedAt === null) continue;
      updatedAt = prevUpdatedAt;
    }
    prevUpdatedAt = updatedAt;
    seen.add(conversationId);

    const title = (typeof item.title === 'string' && item.title.length > 0)
      ? item.title
      : '(無題)';

    out.push({
      id: `xgrok_${accountEmail}_${conversationId}`,
      service: 'xgrok',
      accountEmail,
      conversationId,
      title,
      url: `https://x.com/i/grok?conversation=${conversationId}`,
      createdAt: updatedAt,
      updatedAt,
    });
  }
  return out;
}

// /i/grok 配下のタブから content script 経由で履歴を取得し、正規化済み Record[] を返す。
// 失敗時は throw（screenName 以外の機密値はないが、ログに title は含めない）。
//
// content script に到達できない / 履歴コンテナ未描画は throw。
// screenName 取得失敗は `xgrok-user-unknown` フォールバック（履歴自体は取れているため）。
export async function syncXGrok() {
  const tabs = await chrome.tabs.query({ url: 'https://x.com/i/grok/*' });
  if (!Array.isArray(tabs) || tabs.length === 0) {
    throw svcError('tab_unreachable', 'xgrok');
  }
  const tab = tabs.find((t) => t.active && t.status === 'complete' && !t.discarded)
    || tabs.find((t) => t.status === 'complete' && !t.discarded)
    || tabs[0];
  const tabId = tab.id;
  if (typeof tabId !== 'number') {
    throw svcError('tab_unreachable', 'xgrok');
  }

  let convResp;
  try {
    convResp = await chrome.tabs.sendMessage(tabId, { type: 'XGROK_GET_CONVERSATIONS' });
  } catch (err) {
    console.warn('[LLM History Hub] xgrok content script unreachable',
      err && err.message ? err.message : err);
    throw svcError('content_unreachable', 'xgrok');
  }
  if (!convResp || convResp.ok !== true || !Array.isArray(convResp.items)) {
    rethrowContentError(convResp && convResp.error, 'conversations_retrieval_failed', 'xgrok');
  }

  let accountEmail = 'xgrok-user-unknown';
  try {
    const snResp = await chrome.tabs.sendMessage(tabId, { type: 'XGROK_GET_ACCOUNT_SCREENNAME' });
    if (snResp && snResp.ok === true
        && typeof snResp.screenName === 'string'
        && snResp.screenName.length > 0) {
      accountEmail = `xgrok-user-${snResp.screenName}`;
    }
  } catch (err) {
    console.warn('[LLM History Hub] xgrok screenName fetch failed, using fallback');
  }

  const records = normalizeXGrokItems(convResp.items, accountEmail);
  console.log(`[LLM History Hub] xgrok sync items=${convResp.items.length} records=${records.length}`);
  return records;
}

// 現プロファイルの X内Grok screenName を取得し、`xgrok-user-{screenName}` 形式で返す。
// 不一致警告判定では確実な値が必要なため、fallback (`xgrok-user-unknown`) は採用しない。
// `syncXGrok` の screenName fallback とは扱いを分ける。
export async function getCurrentXGrokScreenName() {
  const tabs = await chrome.tabs.query({ url: 'https://x.com/i/grok/*' });
  if (!Array.isArray(tabs) || tabs.length === 0) {
    throw svcError('tab_unreachable', 'xgrok');
  }
  const tab = tabs.find((t) => t.active && t.status === 'complete' && !t.discarded)
    || tabs.find((t) => t.status === 'complete' && !t.discarded)
    || tabs[0];
  const tabId = tab.id;
  if (typeof tabId !== 'number') {
    throw svcError('tab_unreachable', 'xgrok');
  }
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: 'XGROK_GET_ACCOUNT_SCREENNAME' });
  } catch (err) {
    throw svcError('content_unreachable', 'xgrok');
  }
  if (!resp || resp.ok !== true
      || typeof resp.screenName !== 'string'
      || resp.screenName.length === 0) {
    throw svcError('screenname_not_found', 'xgrok');
  }
  return `xgrok-user-${resp.screenName}`;
}

// ---------------- Google AI モード (Search の udm=50) ----------------
//
// API: GET https://www.google.com/httpservice/web/AimThreadsService/ListThreads
// Cookie 認証のみで動く REST GET (Gemini の batchexecute と異なりシンプル)。
// レスポンスは Gemini と同じ `)]}'\n\n` プレフィックス + JSON 配列。
// 詳細は docs/API_NOTES.md §GoogleAI を参照（実機調査 2026-04-28）。

// AimThreadsService/ListThreads の生レスポンス文字列を items + cursor に分解する純関数。
//
// レスポンス top-level は `[<threadList>, <object>, <number>, <[5]>]` 形式（実測 2026-04-28）だが、
// Google の仕様変更に備えて位置をハードコードせず **「array of array で各要素の `[0]` が
// 2 要素配列 + その両要素が string」** というパターンマッチで thread 配列を動的特定する。
//
// cursor 位置は実機調査時点で未確定 (reqpld 3 番目要素の意味が不明)。Phase 8.B 短期検証で
// 解明予定。現状は cursor=null を返し、syncGoogleAi は単発 fetch のみで打ち切る。
//
// 防御:
// - `)]}'` プレフィックス欠落 / 不正 JSON / HTML レスポンス (Cookie 切れ時のリダイレクト) → 空オブジェクト
// - typeof rawText !== 'string' / 空文字 → 空オブジェクト
export function parseGoogleAiListThreads(rawText) {
  const empty = { items: [], cursor: null };
  if (typeof rawText !== 'string' || rawText.length === 0) return empty;

  let body = rawText;
  if (body.startsWith(")]}'")) {
    body = body.slice(4);
  } else {
    // Cookie 切れ時の HTML リダイレクト等で prefix が無いケースは early return。
    return empty;
  }

  let outer;
  try {
    outer = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!Array.isArray(outer)) return empty;

  // top-level 配列の各要素を走査して thread 配列パターンを動的特定。
  // パターン: 「array of array で各要素の [0] が `[<token>, <id>]` 形式の 2 要素配列」
  for (const candidate of outer) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;
    // 全要素 (or 最低 1 要素) が thread 形式に一致するかチェック。
    // 一部要素が無効でも最初の要素が thread 形式なら採用 (fixture の 4-6 番目は無効データ)。
    const first = candidate[0];
    if (!Array.isArray(first) || first.length < 1) continue;
    const inner = first[0];
    if (!Array.isArray(inner) || inner.length !== 2) continue;
    if (typeof inner[0] !== 'string' || typeof inner[1] !== 'string') continue;
    return { items: candidate, cursor: null };
  }
  return empty;
}

// thread 配列の各要素を統一スキーマに正規化する純関数。
// 各 item は固定インデックス配列で:
//   [0] = `[<securityToken>, <threadId>]`
//   [1] = title (string|null) - null は `(無題)` フォールバック
//   [5] = createdAt `[seconds, nanoseconds]` (Protobuf Timestamp 相当)
//   [6] = updatedAt `[seconds, nanoseconds]`
// 防御: thread[0] / thread[5] / thread[6] の形式が一致しないものは skip。
export function normalizeGoogleAiItems(items, accountEmail) {
  if (!Array.isArray(items)) return [];
  if (typeof accountEmail !== 'string' || accountEmail.length === 0) return [];

  const out = [];
  for (const item of items) {
    if (!Array.isArray(item)) continue;

    const head = item[0];
    if (!Array.isArray(head) || head.length !== 2) continue;
    const threadId = head[1];
    if (typeof threadId !== 'string' || threadId.length === 0) continue;

    const ts5 = item[5];
    const ts6 = item[6];
    if (!Array.isArray(ts5) || ts5.length < 2) continue;
    if (!Array.isArray(ts6) || ts6.length < 2) continue;
    const cs = ts5[0];
    const cn = ts5[1];
    const us = ts6[0];
    const un = ts6[1];
    if (typeof cs !== 'number' || typeof cn !== 'number') continue;
    if (typeof us !== 'number' || typeof un !== 'number') continue;

    const rawTitle = item[1];
    const title = (typeof rawTitle === 'string' && rawTitle.length > 0) ? rawTitle : '(無題)';
    const urlTitle = (typeof rawTitle === 'string' && rawTitle.length > 0) ? rawTitle : '';

    const createdAt = cs * 1000 + Math.floor(cn / 1_000_000);
    const updatedAt = us * 1000 + Math.floor(un / 1_000_000);

    out.push({
      id: `googleai_${accountEmail}_${threadId}`,
      service: 'googleai',
      accountEmail,
      conversationId: threadId,
      title,
      url: `https://www.google.com/search?udm=50&hl=ja&mtid=${encodeURIComponent(threadId)}&q=${encodeURIComponent(urlTitle)}`,
      createdAt,
      updatedAt,
    });
  }
  return out;
}

// 現プロファイルの GoogleAI モード accountEmail を取得する（不一致警告判定用）。
// `https://www.google.com/search*` のタブから content script 経由で aria-label から email を抽出。
// `udm=50` のタブを優先採用、無ければ通常検索タブで補完 (aria-label は udm 値に依存しない)。
// 失敗時は throw。`googleai-user-unknown` フォールバックは syncGoogleAi のみで採用。
export async function getCurrentGoogleAiAccountEmail() {
  const tabs = await chrome.tabs.query({ url: 'https://www.google.com/search*' });
  if (!Array.isArray(tabs) || tabs.length === 0) {
    throw svcError('tab_unreachable', 'googleai');
  }
  // udm=50 タブを優先 → 通常検索タブを補完 → 最後の手段で先頭タブ。
  const isAimTab = (t) => typeof t.url === 'string' && /[?&]udm=50(&|$)/.test(t.url);
  const tab = tabs.find((t) => isAimTab(t) && t.status === 'complete' && !t.discarded)
    || tabs.find((t) => t.status === 'complete' && !t.discarded)
    || tabs[0];
  const tabId = tab.id;
  if (typeof tabId !== 'number') {
    throw svcError('tab_unreachable', 'googleai');
  }
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: 'GOOGLEAI_GET_ACCOUNT_EMAIL' });
  } catch (err) {
    throw svcError('content_unreachable', 'googleai');
  }
  if (!resp || resp.ok !== true
      || typeof resp.accountEmail !== 'string'
      || resp.accountEmail.length === 0) {
    throw svcError('account_email_not_found', 'googleai');
  }
  return resp.accountEmail;
}

// www.google.com の AimThreadsService/ListThreads から履歴を取得して正規化済み Record[] を返す。
// 認証は Cookie のみ (SW 直 fetch)。accountEmail は content script 経由で aria-label から抽出。
// 失敗時は throw（メッセージにレスポンスボディを含めない）。
//
// ページング: Phase 8.B で reqpld の 3 番目要素の意味を解明するまで、現状は単発 fetch。
// reqpld=[null,null,0] で 1 ページ取得。実測 89 件 / page。
//
// accountEmail 取得失敗は `googleai-user-unknown` フォールバック（履歴自体は取れているため）。
export async function syncGoogleAi() {
  // accountEmail は content script 経由で取得するため、まずタブの存在を確認。
  // タブが無い場合は明示的なエラーで誘導する。
  const tabs = await chrome.tabs.query({ url: 'https://www.google.com/search*' });
  if (!Array.isArray(tabs) || tabs.length === 0) {
    throw svcError('tab_unreachable', 'googleai');
  }

  // accountEmail を aria-label から取得。Phase 8.B 実機検証で
  // ListThreads が Cookie 切れでも HTTP 200 + 空 JSON `[]` を返すことが判明したため、
  // accountEmail 取得成否を「ログイン中シグナル」として items=0 と組合せ判定する。
  let accountEmail = 'googleai-user-unknown';
  let accountEmailFromTab = false;
  try {
    accountEmail = await getCurrentGoogleAiAccountEmail();
    accountEmailFromTab = true;
  } catch (err) {
    console.warn('[LLM History Hub] googleai accountEmail fetch failed, using fallback');
  }

  const reqpld = encodeURIComponent(JSON.stringify([null, null, 0]));
  const url = 'https://www.google.com/httpservice/web/AimThreadsService/ListThreads'
    + `?hl=ja&source=hp&udm=50&reqpld=${reqpld}&msc=gwsclient&opi=89978449`;

  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    if (err instanceof TypeError) {
      throw svcError('network_error', 'googleai', { detail: 'ListThreads' });
    }
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    throw svcError('not_logged_in', 'googleai');
  }
  if (!res.ok) {
    throw svcError('http_error', 'googleai', { status: res.status, detail: 'ListThreads' });
  }

  // Cookie 切れ時に HTML リダイレクトが返る可能性に備えた防御 (実測では空 JSON が返る挙動だが念のため)。
  const contentType = res.headers.get('content-type') || '';
  if (!/application\/json/i.test(contentType)) {
    throw svcError('unexpected_response_shape', 'googleai', { detail: 'ListThreads' });
  }

  const text = await res.text();
  const { items } = parseGoogleAiListThreads(text);

  // Cookie 切れ判定: ListThreads は Cookie 切れでも 200 + 空配列を返す。
  // accountEmail が aria-label から取れず + items=0 の組合せをログイン切れと判定する。
  // (ログイン中で履歴 0 件のユーザーは accountEmailFromTab=true なので 0 件成功扱い)
  if (items.length === 0 && !accountEmailFromTab) {
    throw svcError('not_logged_in', 'googleai');
  }

  const records = normalizeGoogleAiItems(items, accountEmail);
  console.log(`[LLM History Hub] googleai sync items=${items.length} records=${records.length}`);
  return records;
}

// 現プロファイルの Gemini accountEmail を取得する（不一致警告判定用）。
// gemini タブが無い / content script 未到達 / email が aria-label から拾えないケースは throw。
// `gemini-user-unknown` フォールバックは `syncGemini` のみで使い、こちらは取得失敗を呼び出し側に伝える。
export async function getCurrentGeminiAccountEmail() {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  if (!Array.isArray(tabs) || tabs.length === 0) {
    throw svcError('tab_unreachable', 'gemini');
  }
  // syncGemini と同じくタブ選択は active+complete を優先する。
  const tab = tabs.find((t) => t.active && t.status === 'complete' && !t.discarded)
    || tabs.find((t) => t.status === 'complete' && !t.discarded)
    || tabs[0];
  const tabId = tab.id;
  if (typeof tabId !== 'number') {
    throw svcError('tab_unreachable', 'gemini');
  }
  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: 'GEMINI_GET_ACCOUNT_EMAIL' });
  } catch (err) {
    throw svcError('content_unreachable', 'gemini');
  }
  if (!resp || resp.ok !== true
      || typeof resp.accountEmail !== 'string'
      || resp.accountEmail.length === 0) {
    throw svcError('account_email_not_found', 'gemini');
  }
  return resp.accountEmail;
}
