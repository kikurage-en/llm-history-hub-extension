// gemini.google.com に注入する content script。
// SW 直 fetch では取れない値（CSRF token / build ID / session ID / accountEmail）を
// ページコンテキストから抽出し、SW のメッセージ経由で返す。
//
// セキュリティ:
// - at (CSRF token) など機密値は関数ローカル変数のみで保持し、ログ・例外メッセージには含めない。
// - SW へは必要最小限のフィールドだけ返す（生 HTML や全 aria-label 一覧は返さない）。
//
// SPA 対応:
// - メッセージ受信ごとに都度 DOM / HTML を走査する。navigation 後の再注入は
//   Manifest V3 の content_scripts 仕様で同フレーム内では追加注入されないため、
//   キャッシュは持たず毎回最新状態を読む。

console.log('[LLM History Hub] gemini content script booted');

// ページ HTML に埋め込まれた WIZ_global_data から session 関連の値を抽出する。
// API_NOTES.md §Gemini に記載の通り、`SNlM0e` / `cfb2h` / `FdrFJe` は
// `<script>` の生 JSON にしか現れないため、`document.documentElement.outerHTML`
// から正規表現でマッチさせる。
function extractGeminiSession() {
  const html = (typeof document !== 'undefined' && document.documentElement)
    ? document.documentElement.outerHTML
    : '';
  if (typeof html !== 'string' || html.length === 0) {
    return { ok: false, error: 'Gemini: page HTML not available' };
  }

  const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
  const blMatch = html.match(/"cfb2h":"([^"]+)"/);
  const fsidMatch = html.match(/"FdrFJe":"([^"]+)"/);

  if (!atMatch || !blMatch || !fsidMatch) {
    return { ok: false, error: 'Gemini: session tokens not found in page' };
  }

  return {
    ok: true,
    session: {
      at: atMatch[1],
      bl: blMatch[1],
      fsid: fsidMatch[1],
    },
  };
}

// Google アカウントボタンの accessibility name から email を抽出する。
// 実測では `aria-label="Google アカウント: <氏名> (<email>)"` 形式。
// ロケール差や aria-label が aria-labelledby から計算されるケースに備え、
// 候補要素を広く取って email パターンマッチで決め打ちする。
function extractGeminiAccountEmail() {
  if (typeof document === 'undefined') {
    return { ok: false, error: 'Gemini: document not available' };
  }

  const candidates = document.querySelectorAll('a[aria-label], button[aria-label]');
  const emailRe = /[\w.+-]+@[\w.-]+\.\w+/;

  // 優先: aria-label に「Google アカウント」「Google Account」を含むもの。
  for (const el of candidates) {
    const label = el.getAttribute('aria-label') || '';
    if (!/Google\s*(アカウント|Account)/i.test(label)) continue;
    const m = label.match(emailRe);
    if (m) return { ok: true, accountEmail: m[0] };
  }

  // フォールバック: ロケール差で上記でヒットしなかった場合、aria-label に email
  // パターンを含む任意の要素を採用。複数当たった場合は最初のものを使う。
  for (const el of candidates) {
    const label = el.getAttribute('aria-label') || '';
    const m = label.match(emailRe);
    if (m) return { ok: true, accountEmail: m[0] };
  }

  return { ok: false, error: 'Gemini: account email not found' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
    return false;
  }

  switch (message.type) {
    case 'GEMINI_GET_SESSION': {
      const result = extractGeminiSession();
      // ログには session 値そのものを出さない（CSRF token 流出回避）。
      console.log('[LLM History Hub] gemini GEMINI_GET_SESSION', result.ok ? 'ok' : `error: ${result.error}`);
      sendResponse(result);
      return false;
    }
    case 'GEMINI_GET_ACCOUNT_EMAIL': {
      const result = extractGeminiAccountEmail();
      console.log('[LLM History Hub] gemini GEMINI_GET_ACCOUNT_EMAIL', result.ok ? 'ok' : `error: ${result.error}`);
      sendResponse(result);
      return false;
    }
    default:
      return false;
  }
});
