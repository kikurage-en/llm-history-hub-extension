// grok.com に注入する content script。
// Grok は Next.js ベースの SPA で初期 HTML に pfp img が含まれないため (実測 2026-04-27)、
// SW 直 fetch + HTML 正規表現抽出は不可能。実 DOM の `<img alt="pfp">` を読んで
// src から userId を抽出する (API_NOTES.md §Grok)。
//
// SPA 対応:
// - メッセージ受信時にポーリング待ち (最大 5 秒、500ms 間隔)
// - 各メッセージ受信時に都度 DOM 走査 (キャッシュしない)
//
// セキュリティ:
// - userId は UUID で機密性は低いが、ログには先頭 8 文字のみ出力する

console.log('[LLM History Hub] grok content script booted');

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 5000;
const PFP_SELECTOR = 'img[alt="pfp"]';

async function waitForSelector(selector) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    if (document.querySelector(selector)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

// `img[alt="pfp"]` の src `https://assets.grok.com/users/{userId}/...` から userId を抽出する。
function extractGrokAccountId() {
  const img = document.querySelector(PFP_SELECTOR);
  if (!(img instanceof HTMLImageElement)) return '';
  const src = img.getAttribute('src') || '';
  if (typeof src !== 'string' || src.length === 0) return '';
  const m = src.match(/\/users\/([a-f0-9-]+)\//);
  if (!m) return '';
  return m[1];
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
    return false;
  }

  switch (message.type) {
    case 'GROK_GET_ACCOUNT_ID': {
      (async () => {
        const ready = await waitForSelector(PFP_SELECTOR);
        if (!ready) {
          console.log('[LLM History Hub] grok GROK_GET_ACCOUNT_ID: poll timeout');
          sendResponse({ ok: false, error: JSON.stringify({ code: 'pfp_not_found', service: 'grok' }) });
          return;
        }
        const userId = extractGrokAccountId();
        if (typeof userId !== 'string' || userId.length === 0) {
          sendResponse({ ok: false, error: JSON.stringify({ code: 'userid_not_found', service: 'grok' }) });
          return;
        }
        console.log(`[LLM History Hub] grok GROK_GET_ACCOUNT_ID: ok userId=${userId.slice(0, 8)}...`);
        sendResponse({ ok: true, userId });
      })();
      return true;
    }
    default:
      return false;
  }
});
