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
