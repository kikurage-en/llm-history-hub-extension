# LLM History Hub

> English: [README.en.md](./README.en.md)

ChatGPT / Claude / Gemini / GoogleAI / Grok / X内Grok のチャット履歴を横断管理する Chrome 拡張（Manifest V3）。各サービスの履歴 API / DOM から会話 ID・タイトル・更新時刻を取得し、サイドパネルで一覧・検索・フィルタを提供します。

## 機能

- **6 サービス対応**: ChatGPT / Claude / Gemini / GoogleAI / Grok / X内Grok
- **サイドパネル UI**: ブラウザに常駐表示、可変幅
- **検索・フィルタ**: 期間・サービス・アカウント・お気に入りで絞り込み
- **エクスポート / インポート**: JSON / CSV 形式
- **多言語対応**: Chrome の UI 言語に応じて日本語 / 英語を自動切替

## 動作要件

- Google Chrome 114 以上（Side Panel API が必須）

## インストール

### 開発者モードで読み込み（unpacked）

1. このリポジトリをクローン、または GitHub Releases から zip をダウンロードして解凍
2. Chrome で `chrome://extensions/` を開く
3. 右上の「デベロッパーモード」を ON
4. 「パッケージ化されていない拡張機能を読み込む」をクリックし、本リポジトリのルートディレクトリ（または解凍したフォルダ）を選択
5. ツールバーの拡張機能アイコンをクリック → サイドパネルが開きます

## 必要権限

| 権限 | 用途 |
|---|---|
| `tabs` | 同期対象タブの判定（履歴取得時のみ参照） |
| `sidePanel` | サイドパネル UI の提供 |
| `https://chatgpt.com/*` | ChatGPT 履歴 API へのアクセス |
| `https://claude.ai/*` | Claude 履歴 API へのアクセス |
| `https://gemini.google.com/*` | Gemini 履歴 API へのアクセス |
| `https://www.google.com/*` | GoogleAI 検索結果からの履歴取得 |
| `https://grok.com/*` | Grok 履歴 API へのアクセス |
| `https://x.com/*` | X 内 Grok 履歴の DOM 取得 |

すべての履歴データはローカルの IndexedDB にのみ保存され、外部に送信されません。

## 利用上の注意

- 各 LLM サービスへの自動化アクセスは、各社の利用規約上グレーゾーンを含みます。**個人利用を前提**とし、自己責任でご利用ください。
- 商用利用や大規模配布は想定していません。
- 各サービスの API / DOM 仕様は予告なく変更されることがあります。動作しなくなった場合は Issue でお知らせください。

## ライセンス

MIT License。詳細は [LICENSE](./LICENSE) を参照。
