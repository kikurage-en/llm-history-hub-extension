// www.google.com/search* に注入する content script。
// AI モード (udm=50) のページから accountEmail を抽出して SW に返す。
// 履歴 API は SW 直 fetch で完結するため、本 content script は accountEmail 抽出専用。
//
// 通常の Google 検索ページ (udm パラメータなし、または他の値) には注入されるが
// 早期 return で何もしない（不要なメッセージリスナーは登録するが、走査コストは 0）。

console.log('[LLM History Hub] googleai content script booted');

// 現在の URL が AI モード (udm=50) かを判定する。
// matches で絞れない URL クエリの値は content script 側で確認するしかない。
function isAimModePage() {
  if (typeof location === 'undefined' || typeof location.search !== 'string') return false;
  try {
    const params = new URLSearchParams(location.search);
    return params.get('udm') === '50';
  } catch {
    return false;
  }
}

// Google アカウントボタンの aria-label から email を抽出する。
// 実測形式: `aria-label="Google アカウント: <氏名> (<email>)"` (Gemini と完全同一)。
// content/gemini.js の extractGeminiAccountEmail と同じロジック。
function extractGoogleAiAccountEmail() {
  if (typeof document === 'undefined') {
    return { ok: false, error: 'GoogleAI: document not available' };
  }

  const candidates = document.querySelectorAll('a[aria-label], button[aria-label]');
  const emailRe = /[\w.+-]+@[\w.-]+\.\w+/;

  for (const el of candidates) {
    const label = el.getAttribute('aria-label') || '';
    if (!/Google\s*(アカウント|Account)/i.test(label)) continue;
    const m = label.match(emailRe);
    if (m) return { ok: true, accountEmail: m[0] };
  }

  for (const el of candidates) {
    const label = el.getAttribute('aria-label') || '';
    const m = label.match(emailRe);
    if (m) return { ok: true, accountEmail: m[0] };
  }

  return { ok: false, error: 'GoogleAI: account email not found' };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
    return false;
  }

  if (message.type !== 'GOOGLEAI_GET_ACCOUNT_EMAIL') {
    return false;
  }

  // udm=50 のページでなくても aria-label からは email が拾える (Google アカウントは
  // どの Google ページでも同じヘッダーを持つ)。早期 return せず常に走査する。
  // ただし通常ページでヒットしないケースに備えて isAimModePage は ログにのみ反映。
  const result = extractGoogleAiAccountEmail();
  console.log('[LLM History Hub] googleai GOOGLEAI_GET_ACCOUNT_EMAIL',
    result.ok ? `ok (aim=${isAimModePage()})` : `error: ${result.error}`);
  sendResponse(result);
  return false;
});
