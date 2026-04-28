# LLM History Hub

> 日本語: [README.md](./README.md)

A Chrome extension (Manifest V3) for unified management of chat history across ChatGPT / Claude / Gemini / GoogleAI / Grok / Grok on X. It fetches conversation IDs, titles, and update timestamps from each service's history API or DOM, and offers list / search / filter capabilities in a side panel.

## Features

- **6 services supported**: ChatGPT / Claude / Gemini / GoogleAI / Grok / Grok on X
- **Side panel UI**: persistent, resizable
- **Search and filter**: by date range, service, account, and favorites
- **Export / Import**: JSON / CSV formats
- **Localized**: automatically switches between English and Japanese based on Chrome's UI language

## Requirements

- Google Chrome 114 or later (Side Panel API required)

## Installation

### Load as an unpacked extension

1. Clone this repository, or download a zip archive from GitHub Releases and extract it
2. Open `chrome://extensions/` in Chrome
3. Toggle "Developer mode" on (top right)
4. Click "Load unpacked" and select the repository's root directory (or the extracted folder)
5. Click the extension's toolbar icon to open the side panel

## Getting Started

### 1. Open the side panel

Click the extension's toolbar icon to open the side panel on the right side of the browser. The side panel is resizable — drag its left edge to adjust the width.

### 2. Sync your history

You must be **logged in** to each LLM service (ChatGPT / Claude / Gemini / GoogleAI / Grok / Grok on X) beforehand.

1. Click the **Sync** button in the header
2. Choose services in the dialog (Select All or individual checkboxes)
3. Click **Sync** to run

If a service's tab is not open at sync time, the error row shows "Open it in a tab and re-sync" with an inline link that opens the service in a new tab.

### 3. Browse the list

Conversations are grouped by date and color-coded by service (ChatGPT green / Claude orange / Gemini blue / GoogleAI purple / Grok black / Grok on X black). Each row shows the **title**, **service**, **account identifier**, and **last updated time**.

- **Click a row**: open the original conversation in a new tab
- **Copy URL** button: copy the conversation URL to clipboard
- **♥ button**: toggle favorite
- **`⚠ Different account` badge** (yellow background): the row was synced under a different account than the one currently logged in

### 4. Search & filter

- **Search box**: substring match against titles
- **Date range filter**: presets "All time / Past 7 days / Past 30 days", or specify `from / to` dates
- **Service chips**: `All` / `♥` / per-service (single-select)
- **Account select**: filter when you use multiple accounts within the same service
- **Sort toggle** (Updated ▼/▲): switch between descending and ascending order

Filters are combined with AND. Count badges next to each chip / account option reflect the current filter state.

### 5. Favorites

Toggle the **♥** button on each row. Use the `♥` chip to view favorites only. Favorite state is preserved across syncs (existing ♥s are never overwritten by sync) and is included in JSON exports, so you can migrate them across environments via export → import.

### 6. Export / Import

From the **⋯ menu** in the upper right of the side panel:

- **Export JSON** / **Export CSV**: exports all records (filters do not apply)
- **Import JSON**: select a file → records sharing the same `service` / `accountEmail` / `conversationId` are merged with the newer `updatedAt` winning

### 7. Delete history

Click the **Delete** button in the header → choose services in the dialog → click **Delete**. Selecting "All" deletes the entire database. **This cannot be undone.**

## Permissions

| Permission | Purpose |
|---|---|
| `tabs` | Detect target tabs at sync time (read-only access) |
| `sidePanel` | Provide the side panel UI |
| `https://chatgpt.com/*` | Access ChatGPT history API |
| `https://claude.ai/*` | Access Claude history API |
| `https://gemini.google.com/*` | Access Gemini history API |
| `https://www.google.com/*` | Extract GoogleAI history from search results |
| `https://grok.com/*` | Access Grok history API |
| `https://x.com/*` | Read Grok-on-X history from the DOM |

All history data is stored locally in IndexedDB only and is never transmitted externally.

## Disclaimer

- Automated access to each LLM service may fall into a grey area under the respective Terms of Service. **This extension is intended for personal use** and is provided on a best-effort, use-at-your-own-risk basis.
- Commercial use and large-scale distribution are not supported.
- Each service's API / DOM may change without notice. If the extension stops working, please open an issue.

## License

MIT License. See [LICENSE](./LICENSE).
