// Service Worker のエントリポイント。
// 30 秒アイドル停止前提でトップレベル初期化は副作用なし。SYNC_SELECTIVE では指定された
// services を Promise.allSettled で並列実行し、merge + upsert は全結果集約後に 1 回だけ
// （IndexedDB トランザクション数を最小化）。

import { upsert, readAll, deleteByServices } from './lib/db.js';
import { mergeRecords } from './lib/merge.js';
import {
  syncChatGpt,
  syncClaude,
  syncGemini,
  syncGoogleAi,
  syncGrok,
  syncXGrok,
  getCurrentChatGptEmail,
  getCurrentClaudeAccountEmails,
  getCurrentGeminiAccountEmail,
  getCurrentGoogleAiAccountEmail,
  getCurrentGrokAccountId,
  getCurrentXGrokScreenName,
} from './lib/sync.js';

console.log('[LLM History Hub] background service worker booted');

// 拡張アイコンクリック時にサイドパネルを開く挙動を有効化する。
// manifest から default_popup を削除し side_panel を定義しているため、本設定により
// action クリック → サイドパネル起動の標準挙動が成立する。
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => {
        console.warn('[LLM History Hub] sidePanel.setPanelBehavior failed', err);
      });
  } else {
    console.warn('[LLM History Hub] chrome.sidePanel API が利用できません (Chrome 114+ 必須)');
  }
});

async function runOneService(name, syncFn) {
  try {
    const records = await syncFn();
    if (!Array.isArray(records)) {
      throw new TypeError(`${name} sync did not return an array`);
    }
    return { name, ok: true, records };
  } catch (err) {
    // 想定内エラー（タブ未開 / ログイン切れ等）が大半のため warn で出す。
    // chrome://extensions/ のエラー欄に蓄積されないため、運用時のノイズを抑える。
    // SW Console には依然黄色で表示されるので開発時の切り分けには支障なし。
    console.warn(`[LLM History Hub] ${name} sync failed`, err && err.message ? err.message : err);
    return { name, ok: false, error: err && err.message ? err.message : String(err) };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null || typeof message.type !== 'string') {
    console.warn('[LLM History Hub] invalid message shape', message);
    return false;
  }

  switch (message.type) {
    case 'PING':
      sendResponse({ ok: true, type: 'PONG', ts: Date.now() });
      return false;

    case 'GET_CURRENT_ACCOUNTS':
      // 行クリック時のアカウント不一致警告判定に使う accountEmail を popup 起動時に取得する。
      // 直列実行だと両 fetch 分が累積するため Promise.allSettled で並列化する。
      // 失敗は swallow して null / [] を返し、popup 側は不一致判定をスキップする。
      (async () => {
        const accounts = { chatgpt: null, claude: [], gemini: null, googleai: null, grok: null, xgrok: null };
        // 順序は ALL_SERVICES (chatgpt / claude / gemini / googleai / grok / xgrok) と一致させる。
        const settled = await Promise.allSettled([
          getCurrentChatGptEmail(),
          getCurrentClaudeAccountEmails(),
          getCurrentGeminiAccountEmail(),
          getCurrentGoogleAiAccountEmail(),
          getCurrentGrokAccountId(),
          getCurrentXGrokScreenName(),
        ]);
        if (settled[0].status === 'fulfilled') {
          accounts.chatgpt = settled[0].value;
        } else {
          const reason = settled[0].reason;
          console.warn('[LLM History Hub] GET_CURRENT_ACCOUNTS chatgpt failed',
            reason && reason.message ? reason.message : reason);
        }
        if (settled[1].status === 'fulfilled') {
          accounts.claude = settled[1].value;
        } else {
          const reason = settled[1].reason;
          console.warn('[LLM History Hub] GET_CURRENT_ACCOUNTS claude failed',
            reason && reason.message ? reason.message : reason);
        }
        if (settled[2].status === 'fulfilled') {
          accounts.gemini = settled[2].value;
        } else {
          const reason = settled[2].reason;
          console.warn('[LLM History Hub] GET_CURRENT_ACCOUNTS gemini failed',
            reason && reason.message ? reason.message : reason);
        }
        if (settled[3].status === 'fulfilled') {
          accounts.googleai = settled[3].value;
        } else {
          const reason = settled[3].reason;
          console.warn('[LLM History Hub] GET_CURRENT_ACCOUNTS googleai failed',
            reason && reason.message ? reason.message : reason);
        }
        if (settled[4].status === 'fulfilled') {
          accounts.grok = settled[4].value;
        } else {
          const reason = settled[4].reason;
          console.warn('[LLM History Hub] GET_CURRENT_ACCOUNTS grok failed',
            reason && reason.message ? reason.message : reason);
        }
        if (settled[5].status === 'fulfilled') {
          accounts.xgrok = settled[5].value;
        } else {
          const reason = settled[5].reason;
          console.warn('[LLM History Hub] GET_CURRENT_ACCOUNTS xgrok failed',
            reason && reason.message ? reason.message : reason);
        }
        sendResponse({ ok: true, accounts });
      })();
      return true;

    case 'SYNC_SELECTIVE': {
      // payload: { services: ('chatgpt'|'claude'|'gemini'|'googleai'|'grok'|'xgrok')[] }
      // 指定された service だけを Promise.allSettled で並列実行する。
      // chrome.runtime.onMessage は async 関数を直接渡しても戻り値の Promise が
      // 無視される。`return true` で非同期応答を有効化し、内部で IIFE を回す。
      const services = Array.isArray(message.services) ? message.services : [];
      if (services.length === 0) {
        sendResponse({ ok: false, error: 'no services specified' });
        return false;
      }
      (async () => {
        const map = {
          chatgpt: syncChatGpt,
          claude: syncClaude,
          gemini: syncGemini,
          googleai: syncGoogleAi,
          grok: syncGrok,
          xgrok: syncXGrok,
        };
        const targets = services.filter(
          (s) => typeof s === 'string'
            && Object.prototype.hasOwnProperty.call(map, s),
        );
        const settled = await Promise.allSettled(
          targets.map((s) => runOneService(s, map[s])),
        );
        const results = {};
        const allRecords = [];
        let anyOk = false;
        for (const s of settled) {
          const r = (s.status === 'fulfilled')
            ? s.value
            : { name: 'unknown', ok: false, error: String(s.reason) };
          if (r.ok) {
            for (const rec of r.records) allRecords.push(rec);
            results[r.name] = { count: r.records.length };
            anyOk = true;
          } else {
            results[r.name] = { error: r.error };
          }
        }
        if (allRecords.length > 0) {
          const existing = await readAll();
          // 同期経路ではお気に入りフラグを既存値で必ず保持する。各サービスから取得した
          // incoming は favorite フィールドを持たないが、念のため source='sync' を明示する。
          const { merged, stats } = mergeRecords(existing, allRecords, { source: 'sync' });
          await upsert(merged);
          results.merge = stats;
        }
        console.log(`[LLM History Hub] SYNC_SELECTIVE services=[${targets.join(',')}] total records=${allRecords.length}`);
        sendResponse({ ok: anyOk, results });
      })();
      return true;
    }

    case 'DELETE_SELECTIVE': {
      // payload: { services: ('chatgpt'|'claude'|'gemini'|'googleai'|'grok'|'xgrok')[] }
      // 指定された service の全レコードを 1 トランザクションで削除する。
      const services = Array.isArray(message.services) ? message.services : [];
      if (services.length === 0) {
        sendResponse({ ok: false, error: 'no services specified' });
        return false;
      }
      (async () => {
        try {
          const { deleted, perService } = await deleteByServices(services);
          console.log(`[LLM History Hub] DELETE_SELECTIVE services=[${services.join(',')}] deleted=${deleted}`);
          sendResponse({ ok: true, deleted, perService });
        } catch (err) {
          console.error('[LLM History Hub] DELETE_SELECTIVE failed', err);
          sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
        }
      })();
      return true;
    }

    default:
      console.warn('[LLM History Hub] unknown message type', message.type);
      return false;
  }
});
