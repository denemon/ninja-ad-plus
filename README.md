# Ninja Ad (Stealth Switch)

Chrome Manifest V3 ad-blocking extension. Instead of hard-blocking ad requests (which triggers anti-adblock detection), it redirects ad resources to content-type-appropriate empty responses, returning silent HTTP 200 OK.

## How It Works

Standard ad blockers return `ERR_BLOCKED_BY_CLIENT`, which anti-adblock scripts detect by catching failed loads. This extension redirects blocked resources to local noop files matching the expected content type:

| Resource Type | Redirect Target | Description |
|---|---|---|
| Script | `noop.js` | Valid empty JavaScript (`;`) |
| Image | `noop.gif` | 1x1 transparent GIF (44 bytes) |
| Stylesheet | `noop.css` | Empty CSS file |
| Sub-frame | `noop.html` | Minimal empty HTML document |
| Other | `noop.txt` | Empty text file |

All blocking runs in Chrome's native C++ `declarativeNetRequest` engine. No JavaScript executes per network request.

## Installation

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode** (top right toggle).
3. Click **Load unpacked** and select this project directory.
4. The extension icon appears in the toolbar with an **ON** badge.

## Updating Filter Rules

The extension uses [EasyList](https://easylist.to/) as its filter source. To update:

1. Download the latest `easylist.txt` from [https://easylist.to/easylist/easylist.txt](https://easylist.to/easylist/easylist.txt).
2. Place it in the project root directory.
3. Run the converter:

```bash
node convert.js
```

4. Reload the extension in `chrome://extensions/`.

### Converter Output

The converter parses EasyList filter syntax and generates Chrome DNR rules. It:

- Converts URL patterns and `$options` into `declarativeNetRequest` conditions.
- Maps `@@` exception rules to `allow` actions with higher priority.
- Selects the appropriate noop redirect target by resource type and URL extension.
- Skips cosmetic (CSS hiding) rules, `$document`/`$popup` rules, and rules targeting whitelisted domains.

## Configuration

### Whitelisted Domains

The following domains are excluded from blocking at build time (in `convert.js`):

- `google.com`, `google.co.jp`
- `gstatic.com`, `googleapis.com`
- `youtube.com`, `ggpht.com`
- `accounts.google.com`
- `gemini.google.com`, `bard.google.com`

To modify the whitelist, edit the `WHITELIST_DOMAINS` array in `convert.js` and regenerate `rules.json`.

### Rule Priorities

| Priority | Rule Type | Action |
|---|---|---|
| 1 | Block rule | Redirect to noop file |
| 2 | Exception (`@@`) rule | Allow (bypasses block) |

### Resource Type Safety

`main_frame` (document) and `popup` resource types are excluded from all rules. This prevents the extension from forcibly navigating browser tabs.

## File Structure

```
ninja-ad-plus/
├── manifest.json    # MV3 extension config (permissions, ruleset, service worker)
├── background.js    # Service worker: ruleset toggle, badge state, storage sync
├── popup.html       # Popup UI: toggle switch with status indicator
├── popup.js         # Popup controller: reads/writes state, sends toggle messages
├── convert.js       # Dev tool (Node.js): EasyList -> rules.json converter
├── easylist.txt     # EasyList filter source (input for convert.js)
├── rules.json       # Generated DNR ruleset (loaded by Chrome at runtime)
├── noop.js          # Empty JS response (redirect target for script ads)
├── noop.gif         # 1x1 transparent GIF (redirect target for image ads)
├── noop.css         # Empty CSS (redirect target for stylesheet ads)
├── noop.html        # Empty HTML (redirect target for sub-frame ads)
├── noop.txt         # Empty text (redirect target for other ad types)
├── icon.png         # Extension icon (48x48)
├── .gitignore       # Excludes _metadata/, .DS_Store, node_modules/
└── README.md
```

## Security Considerations

- **No remote code execution**: All rules are pre-compiled and bundled. No network fetches at runtime.
- **Page-context spoofing**: `spoofing.js` is injected at `document_start` in the page's MAIN world to stub common ad/anti-adblock globals. It is bundled locally and performs no remote code loading.
- **No main_frame redirection**: Document-level rules are explicitly excluded to prevent forced navigation.
- **Minimal permissions**: Only `declarativeNetRequest`, `declarativeNetRequestWithHostAccess`, and `storage` are requested.
- **Domain whitelist**: Critical services (Google, YouTube) are protected from accidental blocking at the build step.
- **web_accessible_resources**: Noop files are exposed to all URLs (required for redirects). These files contain no executable logic or sensitive data.

## Permissions

| Permission | Purpose |
|---|---|
| `declarativeNetRequest` | Register and toggle DNR rulesets |
| `declarativeNetRequestWithHostAccess` | Apply redirect rules to all URLs |
| `storage` | Persist ON/OFF state across browser restarts |
| `host_permissions: <all_urls>` | Required for redirect rules to match any URL |
