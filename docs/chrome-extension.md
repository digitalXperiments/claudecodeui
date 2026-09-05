# CloudCLI Fix This Chrome extension

This unpacked Manifest V3 extension captures a page screenshot, selected DOM element, selected text/source, expected behavior, and an optional click/scroll/input reproduction. Input field values are never recorded; only the field selector and value length are retained.

## Setup

1. Run CloudCLI and sign in normally. Copy the bearer token used by the CloudCLI web app (the extension stores it only in `chrome.storage.local`, never in page/content-script context).
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `extensions/chrome-capture`.
3. Open the extension side panel from the toolbar action. Enter the CloudCLI server URL (for example `http://127.0.0.1:3000`) and bearer token, then click **Save & load projects**.
4. Choose a project, enter a title, select an element, optionally click **Screenshot** and record a reproduction, then click **Fix This**.

The server creates a real task on the global Kanban board and retains a generated screenshot asset under the existing CloudCLI assets directory. Use HTTPS for remote servers. No extension publishing or broad host permission is required; `activeTab` access is granted only for the active tab after the user invokes an action.

## Troubleshooting

- `401` means the token is missing, expired, or belongs to another CloudCLI server.
- `Project not found` means the selected project was archived or the server connection changed; reload projects.
- `Screenshot and selected text captured` may fail on restricted Chrome pages (such as `chrome://`); use a normal HTTP(S) page.
- The endpoint rejects non-HTTP(S) source URLs, credential-bearing URLs, malformed events, oversized screenshots, and unknown projects.
