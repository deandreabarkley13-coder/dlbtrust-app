---
name: testing-dlbtrust-ui
description: Test the DLB Trust wealth management platform UI end-to-end. Use when verifying frontend changes, modal behavior, scrolling fixes, or CSS updates.
---

# Testing DLB Trust UI

## Quick Start

```bash
cd /home/ubuntu/repos/dlbtrust-app
npm install
node app.js &
# App runs on http://localhost:3001
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/  # Should return 200
```

## No Auth Required

The app has no login/authentication. All views are accessible directly via the sidebar navigation.

## Devin Secrets Needed

None for UI testing. The app runs fully locally with SQLite.

## Navigation Structure

The sidebar has these nav links (use `data-view` attribute):
- Dashboard
- Accounts
- Transfers
- Contacts
- Payments
- Trust Accounting
- Fixed Income
- Crypto Rails
- Compliance
- Activity

Click a nav link to switch views. Each view loads data via API calls to `/api/*`.

## Key Modals to Test

| View | Button | Modal |
|------|--------|-------|
| Fixed Income | "+ Record Private Placement Bond" | PP Bond form (4 fieldsets, very tall — good scrolling test) |
| Accounts | "+ New Account" | Open New Account (short form) |
| Crypto Rails | "+ New Wallet" | Create wallet |
| Crypto Rails | "Send USDC" | Send USDC transfer |
| Crypto Rails | "Swap POL → USDC" | DEX swap modal |
| Transfers | "+ New Transfer" | Internal transfer |
| Contacts | "+ New Contact" | Contact form |
| Payments | "+ New Payment" | Payment form |

## Modal Scrolling

Modals use `.modal-content` with `max-height: 90vh; overflow-y: auto`. Tall modals (like PP Bond form) should scroll internally. Short modals should NOT have unnecessary scrollbars.

The PP Bond modal has an inline `style="max-width:800px"` override since it's wider than the default 500px.

## CSS Architecture

- `body` uses `height: 100vh; overflow: hidden` to constrain the flex layout
- `.sidebar` is `position: fixed` with `height: 100vh`
- `.content` (main area) uses `margin-left: var(--sidebar-width)` and `overflow-y: auto`
- `.table-container` uses `overflow-x: auto` for horizontal scrolling on wide tables
- `.view-header` uses `flex-wrap: wrap; gap: 12px` for narrow viewport button wrapping

## Common Issues

- **Port 3001 already in use**: Run `fuser -k 3001/tcp` before starting the server
- **Server exits silently**: Check if port is in use or if there's a missing dependency (`npm install`)
- **CI `insert` job fails**: This is a preexisting Docker/SSH external job failure unrelated to app code. The `validate` job is the one that matters.
- **Devin Review comments on full diff**: When PR branches include many commits, Devin Review may flag pre-existing bugs in files not modified by the latest commit. Check if the flagged file was actually changed in the relevant commit before investigating.

## Testing Tips

1. Always maximize the browser before recording (`wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz`)
2. The app uses vanilla JS (no React/Vue) — DOM updates happen via `innerHTML` assignments in `frontend/app.js`
3. Modal show/hide is controlled by adding/removing the `hidden` class
4. The `devin-scrollable="true"` attribute in the DOM confirms an element has active scrolling
5. For CSS changes, focus on the specific properties changed rather than testing every modal — verify the fix works on the reported issue + one regression check on a short modal
