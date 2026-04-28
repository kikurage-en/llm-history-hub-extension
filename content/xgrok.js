// x.com/i/grok 配下に注入する content script。
// X 内部 API が CSRF + Bearer + GraphQL ハッシュ化で複雑なため、DOM スクレイピング前提
// (API_NOTES.md §X内Grok)。
//
// SPA 対応:
// - manifest matches で /i/grok/* に絞っているため、注入時点でパス判定は不要
// - SPA navigation 直後は DOM 未確定のため、メッセージ受信時に対象セレクタごとに
//   ポーリング待ち (最大 5 秒、500ms 間隔)。履歴一覧と screenName は別 DOM 要素
//   (履歴は中央パネル、screenName は左サイドバー) のため別々に待つ
// - 各メッセージ受信時に都度 DOM 走査 (キャッシュしない、SPA navigation 後の最新状態を読む)
//
// セキュリティ:
// - 機密値はないが、ログには screenName と件数のみ出力。title は個人特定可能なため出さない

console.log('[LLM History Hub] xgrok content script booted');

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 5000;

// 日本語ロケールが想定だが、英語ロケール (`Chat history`) も拾うため OR 結合。
// X 仕様変更でこれが壊れた場合、KNOWN_ISSUES.md §X内Grok DOM セレクタの脆弱性を参照。
const HISTORY_LINK_SELECTOR =
  'div[aria-label="チャット履歴"] a[href^="/i/grok?conversation="], '
  + 'div[aria-label="Chat history"] a[href^="/i/grok?conversation="]';
const PROFILE_LINK_SELECTOR = 'a[data-testid="AppTabBar_Profile_Link"]';

async function waitForSelector(selector) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    if (document.querySelector(selector)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

// 同じ conversationId が複数 a タグで現れる UI 仕様 (API_NOTES.md §X内Grok) のため
// content script 側で Set による重複除去を行う。
function extractXGrokConversations() {
  const links = document.querySelectorAll(HISTORY_LINK_SELECTOR);
  const seen = new Set();
  const items = [];
  for (const a of links) {
    const href = a.getAttribute('href') || '';
    const m = href.match(/conversation=(\d+)/);
    if (!m) continue;
    const conversationId = m[1];
    if (seen.has(conversationId)) continue;
    seen.add(conversationId);

    const title = (typeof a.innerText === 'string' && a.innerText.length > 0)
      ? a.innerText.trim()
      : '';

    // 親要素の最初の子要素 = 日付ラベル ("2026年3月19日" or "水曜日" 等) (API_NOTES.md §X内Grok)
    let dateText = '';
    const parent = a.parentElement;
    if (parent && parent.firstElementChild) {
      const t = parent.firstElementChild.innerText;
      if (typeof t === 'string') dateText = t.trim();
    }

    items.push({ conversationId, title, dateText });
  }
  return items;
}

// `a[data-testid="AppTabBar_Profile_Link"]` の href から screenName を抽出する。
// href = `/{screenName}` 形式 (API_NOTES.md §X内Grok)。
function extractXGrokScreenName() {
  const a = document.querySelector(PROFILE_LINK_SELECTOR);
  if (!(a instanceof HTMLAnchorElement)) return '';
  const href = a.getAttribute('href') || '';
  if (typeof href !== 'string' || href.length === 0) return '';
  if (!href.startsWith('/')) return '';
  return href.slice(1);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
    return false;
  }

  switch (message.type) {
    case 'XGROK_GET_CONVERSATIONS': {
      (async () => {
        const ready = await waitForSelector(HISTORY_LINK_SELECTOR);
        if (!ready) {
          console.log('[LLM History Hub] xgrok XGROK_GET_CONVERSATIONS: poll timeout');
          sendResponse({ ok: false, error: JSON.stringify({ code: 'history_container_not_found', service: 'xgrok' }) });
          return;
        }
        const items = extractXGrokConversations();
        console.log(`[LLM History Hub] xgrok XGROK_GET_CONVERSATIONS: items=${items.length}`);
        sendResponse({ ok: true, items });
      })();
      return true;
    }
    case 'XGROK_GET_ACCOUNT_SCREENNAME': {
      (async () => {
        const ready = await waitForSelector(PROFILE_LINK_SELECTOR);
        if (!ready) {
          sendResponse({ ok: false, error: JSON.stringify({ code: 'profile_link_not_found', service: 'xgrok' }) });
          return;
        }
        const screenName = extractXGrokScreenName();
        if (typeof screenName !== 'string' || screenName.length === 0) {
          sendResponse({ ok: false, error: JSON.stringify({ code: 'screenname_not_found', service: 'xgrok' }) });
          return;
        }
        console.log(`[LLM History Hub] xgrok XGROK_GET_ACCOUNT_SCREENNAME: ok screenName=${screenName}`);
        sendResponse({ ok: true, screenName });
      })();
      return true;
    }
    default:
      return false;
  }
});
