# Ninja Ad (Stealth Switch)

*English | [日本語](README.ja.md)*

Chrome Manifest V3 ad-blocking extension. On general sites, it redirects matching
ad resources to local noop files instead of hard-blocking them. Successful loads
do not guarantee that blocking is undetectable. YouTube filters player-ad data
before player initialization, with native auto-skip as a fallback.

## How It Works

Standard ad blockers return `ERR_BLOCKED_BY_CLIENT`, which anti-adblock scripts detect by catching failed loads. This extension redirects blocked resources to local noop files matching the expected content type:

| Resource Type | Redirect Target | Description |
|---|---|---|
| Script, XHR/fetch, ping, object, other | `noop.js` | Valid empty JavaScript (`;`) |
| Image | `noop.gif` | 1x1 transparent GIF (44 bytes) |
| Sub-frame | `noop.html` | Minimal empty HTML document |
| Stylesheet | `noop.css` | Empty CSS file |
| Font, media, WebSocket | *(not blocked)* | Nothing can answer these convincingly |

Chrome derives the response `Content-Type` from the noop file's extension, so
matching the requested type helps avoid load errors but does not make a redirect invisible.
HTTP 200 is not enough on its own: a stylesheet served as `text/javascript` is
refused in standards mode, an image fails to decode, a font rejects the
`document.fonts` promise, and a video fires `error` on the element — the very
event this extension tries to avoid. XHR/fetch consumers can also reject the
response body: `noop.js` is JavaScript, not valid JSON or a real API response.

A DNR rule carries exactly one action, so the target cannot depend on the
resource type at request time. Types are grouped by the noop that can honestly
answer them, and a filter spanning several groups becomes one rule per group.
Three consequences worth stating plainly:

- **Fonts and media are not blocked at all.** Redirecting them is detectable and
  so is blocking them, so the request is left to proceed untouched instead. A
  filter that names only `$font` or `$media` is dropped; `$media,script` narrows
  to `script`.
- **WebSockets are not blocked either.** *"Redirects are not supported for
  WebSocket requests"* — Chrome drops the redirect, and it could not work in any
  case: a WebSocket needs an HTTP 101 upgrade handshake and a static file answers
  200. The outcome would be either the original request proceeding anyway or a
  failed connection firing `error` on the `WebSocket`, which is a detection
  signal rather than a defence against one.
- **Ad CSS is only blocked when a filter says `$stylesheet`.** EasyList marks 17
  filters out of ~58,000 that way, which is not worth an extra rule on every
  filter that carries no `$type` option at all. Those explicit filters still get
  `noop.css`; generic filters simply do not claim the type.

An unmatched type is not a silent failure. No rule matches, the request goes out
as it normally would. That particular request is not modified by this extension.

Exception (`@@`) rules resolve against the **full** set of blockable types, not
the narrower set above. A block rule costs one rule per group, which is why that
set is kept tight; an exception is never split, so breadth costs nothing there.
An exception narrower than the block it opposes silently fails to except —
`@@||x/ad.css^` would leave `||x/ad.css^$stylesheet` redirecting the very file
the exception exists to permit, because a priority-2 `allow` cannot override a
type it does not claim.

General-site redirects run in Chrome's native `declarativeNetRequest` engine.
The YouTube player-response filter below runs separately in page JavaScript.

### YouTube Player-Ad Filtering

When ON, `youtube-player.js` runs in MAIN at `document_start`, before the initial
player consumes `ytInitialPlayerResponse`. It removes `adPlacements` and `adSlots`
from that object synchronously, including later assignments. It also filters
these keys in known player API fetch/XHR responses. Fetch filtering replaces the
response body, so `json()`, `text()`, `arrayBuffer()`, and stream consumers see the
filtered data. Valid JSON text retains its serialization and optional anti-XSSI
prefix; ad keys are renamed to the unused `no_ads` key. Playback tracking,
heartbeat data, media URLs, and networking configuration are preserved.

Only known player endpoints on YouTube and `youtubei.googleapis.com` are targeted.
Fetch responses are buffered through a clone; malformed, non-JSON, ad-free, and
failed responses pass through. This does not remove ads already inserted into
the media stream or handle every alternate networking path/response format.

For ads that still reach the player, `youtube.js` clicks visible, enabled native
skip buttons. **Fallback ads play until skipping becomes available, and page ad
slots remain.** There is no forced seeking or speed change. The same behavior
applies to YouTube embeds, including `youtube-nocookie.com`.

Two guards bypass this extension's network filtering for YouTube:
priority-4 `allowAllRequests` protects YouTube frame trees (including third-party frames),
and a priority-3 `initiatorDomains` allow rule covers requests initiated by YouTube even
outside a frame, such as service-worker requests. The frame guard outranks plain
allow rules so an embedded player reliably establishes a frame-tree exception.
These guards do not override other extensions' filtering. `spoofing.js` is excluded from YouTube, with a
hostname guard inside the script as well. Persisted registrations are refreshed
on installation, updates, startup, and enabling the extension.

**After updating, reload the extension in `chrome://extensions/`, then close and
reopen YouTube tabs (and pages containing embeds). Also reopen pages after changing
ON/OFF to apply or remove the MAIN-world filter.** Existing pages retain injected
hooks until reloaded. Actual pre-roll suppression and anti-adblock warnings must
be checked on the affected account; local tests do not guarantee undetectability.
If a warning persists, turn OFF and reopen the page to compare.

Every component honours the single ON/OFF switch, but by two different
mechanisms. `youtube.js` runs in the isolated world and watches
`chrome.storage` directly. `spoofing.js` and `youtube-player.js` run in MAIN, where
`chrome.*` APIs do not exist, so they cannot read the state themselves — the service
worker registers and unregisters them through `chrome.scripting` instead. Turning
the extension off therefore stops the page-context patching too, from the next
page load onward.

### Keeping OFF Meaning OFF

One toggle drives the ruleset, page spoofing, YouTube player filtering, native skipping, and the badge
— so `background.js` treats the stored value as the single source of truth and
protects it three ways:

- **Serialised updates.** `onStartup`, `onInstalled` and toggle messages all go
  through one promise queue. Run concurrently their awaits interleave, and a
  sync that began earlier can finish *last* and re-apply the state the user just
  switched off. The queue guarantees the update requested last is the one that
  lands.
- **Apply before persist.** The new state is applied first and stored only on
  success, so a stored value never describes something no component is honouring.
- **Rollback on failure.** Any failure re-derives every component from the value
  still in storage (`syncStateFromStorage`) and reports an error, rather than
  claiming a switch that did not happen.

Every ruleset failure is fatal and rolls back. That is affordable because the
whole ruleset fits inside Chrome's per-extension guarantee, so enabling it
cannot be rejected for quota; a rejection means something genuinely went wrong,
and reporting success would leave rules running against a stored OFF.

## Installation

Requires **Chrome 102 or later**, pinned via `minimum_chrome_version` in the
manifest. `RegisteredContentScript.world` (Chrome 102+) is what lets the switch
reach `spoofing.js`, and DNR `initiatorDomains` needs Chrome 101+. Without the
pin, older Chrome would install the extension happily and then fail only at
dynamic registration — leaving a switch that cannot turn the page-context
patching off.

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode** (top right toggle).
3. Click **Load unpacked** and select the **`src/`** directory (not the project root — the root holds build inputs that must not ship).
4. The extension icon appears in the toolbar with an **ON** badge.

## Updating Filter Rules

Every `.txt` in `filters/` is a source; the converter reads them all. EasyList is
international and carries almost no Japanese ad networks, which is why the
AdGuard Japanese filter is bundled alongside it — hosts like `caprofitx.com` and
`flux-cdn.com` appear in neither EasyList nor the anti-adblock list, and a
Japanese news page can be served almost entirely by SSPs EasyList never names.
Add a regional list per language you care about.

| File | Source |
|---|---|
| `easylist.txt` | [easylist.to/easylist/easylist.txt](https://easylist.to/easylist/easylist.txt) |
| `antiadblockfilters.txt` | [easylist.to/easylist/antiadblockfilters.txt](https://easylist.to/easylist/antiadblockfilters.txt) |
| `adguard-japanese.txt` | [filters.adtidy.org/extension/ublock/filters/7.txt](https://filters.adtidy.org/extension/ublock/filters/7.txt) |

Download the current versions into `filters/`, then:

```bash
node convert.js
npm test
```

The converter writes `src/rules-core.json` and **fails** if the result exceeds
Chrome's 30,000-rule guarantee, rather than shipping a ruleset that competes for
the shared global pool. Then reload the extension in `chrome://extensions/`.

Use the uBlock Origin variant of any AdGuard list (`/extension/ublock/`). Its
scriptlet syntax is `##+js(...)`, which the converter classifies as cosmetic and
skips; the native AdGuard `#%#` form would not be recognised.

### Converter Output

The converter parses EasyList filter syntax and generates Chrome DNR rules. It:

- Converts URL patterns and `$options` into `declarativeNetRequest` conditions.
- Maps `@@` exception rules to `allow` actions with higher priority.
- Emits one rule per noop group a filter spans, so every request is answered with a content type it can load.
- Skips cosmetic (CSS hiding) rules, `$document`/`$popup` rules, and rules targeting whitelisted domains.
- Skips any rule carrying an option with no DNR equivalent (see below), and any filter left with no serveable resource type.

#### Unsupported Options Are Dropped, Never Ignored

An option that is silently ignored does not produce a weaker rule — it produces
a *different* one. `$generichide` controls cosmetic filtering only, so ignoring
it turns `@@||example.com^$generichide` into a network `allow` across all
resource types, which switches blocking off for that entire domain. `$csp` and
`$rewrite` degrade the same way, into redirects covering every resource type.

The converter therefore treats an unrecognised option as a hard failure for that
line and reports the count as `unsupported=` in the build summary. Dropping the
rule loses a little coverage; mistranslating it silently disables protection.

## Configuration

### Whitelisted Domains

The following domains are excluded from blocking at build time (in `convert.js`):

- `google.com`, `google.co.jp`
- `gstatic.com`, `googleapis.com`
- `youtube.com`, `ggpht.com`
- `accounts.google.com`
- `gemini.google.com`, `bard.google.com`

Two mechanisms use this list, and only one of them is a guarantee:

- **A runtime guard rule** — a high-priority (`3`) `allow` rule at
  the head of the core ruleset, matching on `requestDomains`. This is what
  actually protects those hosts, because it matches the host being requested
  regardless of how the filter was written.
- **A build-time scan** (optimisation only) that drops filters naming a
  whitelisted domain outright, so no rule is generated that the guard would
  always override anyway. Matching is host-boundary aware: an entry matches the
  domain and its subdomains and nothing else, because a substring test would
  swallow the unrelated ad host `gggpht.com` (a real EasyList entry) and would
  read `google.com.evil.net` as Google.

The scan alone is not sufficient, which is why the guard exists: a generic
filter like `/pagead/conversion.js` never mentions Google, yet matches
`https://www.google.com/pagead/conversion.js`. Note that `requestDomains`
constrains the *requested* host; `initiatorDomains` would constrain the calling
page instead. The separate YouTube compatibility guards use that distinction to
also allow traffic to third-party ad hosts while on YouTube.

To modify the whitelist, edit the `WHITELIST_DOMAINS` array in `convert.js` and
rerun the converter.

### Rule Priorities

| Priority | Rule Type | Action |
|---|---|---|
| 1 | Block rule | Redirect to noop file |
| 2 | Exception (`@@`) rule | Allow (bypasses block) |
| 3 | Target-host whitelist guard | Allow |
| 3 | YouTube initiator guard | Allow YouTube-initiated requests |
| 4 | YouTube frame guard | Allow the entire YouTube frame tree |

### Domain Merging and Chrome's Static Rule Budget

Chrome guarantees only **30,000** static rules per extension. Anything past that
is drawn from a pool shared with every other installed extension, and
`updateEnabledRulesets()` is **atomic**: if enabling a ruleset would push the
count past what that pool can spare, the call is rejected and *no* change is
made. Chrome does not load the rules that fit and drop the rest. An oversized
ruleset is all-or-nothing — one unlucky quota check and the extension blocks
nothing at all, for a reason that depends on what else the user has installed.

The bundled lists are ~93% filters of the form `||host^`: a whole host blocked
outright, with no path and no options. That is precisely what a DNR
`requestDomains` condition expresses, and **one rule can carry a whole list of
hosts**. Merging them collapses ~166,000 domain blocks into **30 rules**:

| | Rules |
|---|---|
| One rule per filter per noop target | ~178,000 |
| With `||host^` filters merged | **~12,300** |

The entire ruleset now fits inside the guarantee with room to spare, so there is
a single `rules-core.json` and enabling it can never be rejected for quota.
`convert.js` fails the build if the output ever exceeds 30,000 rather than
silently shipping a truncated ruleset, and `test/static-rules.test.js` asserts
the same bound.

Merging is deliberately conservative. A filter only qualifies if it is a bare
lowercase host with a trailing `^` and no `$domain=`:

- **No trailing `^`** — `||ad.example` also matches `ad.example.evil.net`, which
  `requestDomains` would not. Merging it would silently narrow the filter.
- **Ports, wildcards, paths** — `requestDomains` takes a bare domain and cannot
  express any of them.
- **`$domain=`** — `initiatorDomains` constrains the *calling page*, so sharing a
  rule would apply one filter's page restriction to every other host in it.

Buckets also key on the noop target, the first/third-party constraint and the
resource types, since a merged rule cannot vary those per host. Everything that
fails to qualify keeps its own `urlFilter` rule.

Rules are ordered by how much each covers, so if the ruleset ever does overflow,
the cheapest thing to lose is last: the whitelist guard, then **every** exception
(`allow`) rule, then the merged whole-network blocks, then the per-filter rules.
An exception stranded past a truncation would let block rules fire with nothing
to override them, which is how sites break.

### The Ruleset Is Not Enabled From the Manifest

The `rule_resources` entry declares `"enabled": false`, and `background.js`
switches them on from the stored ON/OFF state. This is required, not stylistic.
Chrome persists the enabled ruleset set across sessions **but not across
extension updates** — *"the `rule_resources` manifest key will determine the set
of enabled static rulesets on each extension update."* A ruleset marked enabled
there comes back on after every update regardless of what the user chose, and
keeps blocking until the service worker gets around to disabling it again.

Starting from off inverts the failure: an update can only ever under-block for
the moment before the worker runs, never block behind a stored OFF. Failing open
costs a few ads; failing closed breaks the OFF guarantee, which is the one thing
this extension is for.

### Resource Type Safety

`main_frame` (document) and `popup` resource types are excluded from redirects.
The YouTube `allowAllRequests` guard matches frame navigation only to allow it,
never to redirect it. This prevents forced navigation by the extension. `font`,
`media` and `websocket` are excluded for the separate reason given above: no
response this extension can produce would be mistaken for a real one.

## File Structure

`src/` is the extension exactly as it ships. Everything outside it is a build
input or a test, so nothing but `src/` is ever loaded into Chrome.

```
ninja-ad-plus/
├── src/                        # ← Load unpacked target: the packaged extension
│   ├── manifest.json           # MV3 config (permissions, ruleset, service worker)
│   ├── background.js           # Service worker: ruleset + MAIN script toggles, badge, storage sync
│   ├── spoofing.js             # MAIN-world ad/anti-adblock stubs (registered by background.js)
│   ├── youtube-player.js       # MAIN-world initial/API player-ad filtering (registered dynamically)
│   ├── youtube.js              # Fallback: click available native YouTube skip buttons
│   ├── popup.html              # Popup UI: toggle switch with status indicator
│   ├── popup.js                # Popup controller: reads/writes state, sends toggle messages
│   ├── rules-core.json         # Generated: ~12k rules incl. all exceptions, enabled from stored state
│   ├── noop.js                 # Empty JS (script, XHR, ping, object, other)
│   ├── noop.gif                # 1x1 transparent GIF (image ads)
│   ├── noop.css                # Empty CSS (explicit $stylesheet filters only)
│   ├── noop.html               # Empty HTML (sub-frame ad slots)
│   ├── icon48.png              # Toolbar icon
│   └── icon128.png             # Extension management page icon
├── filters/                    # Build inputs, never shipped
│   ├── easylist.txt            # EasyList filter source (international)
│   ├── antiadblockfilters.txt  # Anti-adblock filter source
│   └── adguard-japanese.txt    # AdGuard Japanese filter: JP ad networks EasyList omits
├── test/                       # node --test suites
├── convert.js                  # Build step: filters/*.txt -> src/rules-core.json
├── icon-source.png             # Full-resolution icon artwork (icon48/128 are generated from it)
├── package.json                # `npm test`
├── .gitignore
├── README.md
└── README.ja.md                # Japanese translation, kept in step with README.md
```

Regenerate the icons after editing the artwork:

```bash
sips -s format png -z 128 128 icon-source.png --out src/icon128.png
sips -s format png -z 48  48  icon-source.png --out src/icon48.png
```

`test/static-rules.test.js` fails if an unreferenced file appears in `src/`, so
build inputs cannot drift back into the shipped directory unnoticed.

## Security Considerations

- **No remote code execution**: All rules are pre-compiled and bundled. No network fetches at runtime.
- **Page-context spoofing is switchable**: Outside YouTube, `spoofing.js` is injected at `document_start` in the page's MAIN world to stub common ad/anti-adblock globals. It is bundled locally, loads no remote code, and is unregistered entirely when the extension is switched off — so a site it breaks can be recovered by toggling off and reloading.
- **Bait protection is name-exact**: `spoofing.js` force-shows hidden elements whose class or id looks like ad bait, to defeat dimension probing. Each class token must equal a bait word or be a bait word followed by `-`/`_`, so `address`, `admin-dialog` and `adaptive-layout` are left alone. An open-ended prefix match would force ordinary hidden UI visible with `!important` on every site.
- **No main_frame redirection**: Document-level rules are explicitly excluded to prevent forced navigation.
- **Minimal permissions**: Only the four permissions below. `scripting` controls the bundled MAIN-world scripts, `spoofing.js` and `youtube-player.js`. No remote scripts are loaded.
- **Domain whitelist**: Critical services (Google, YouTube) are protected from accidental blocking at the build step.
- **web_accessible_resources**: Noop files are exposed to all URLs (required for redirects). These files contain no executable logic or sensitive data.

## Permissions

| Permission | Purpose |
|---|---|
| `declarativeNetRequest` | Register and toggle DNR rulesets |
| `declarativeNetRequestWithHostAccess` | Apply redirect rules to all URLs |
| `scripting` | Register/unregister bundled MAIN-world scripts under the ON/OFF switch |
| `storage` | Persist ON/OFF state across browser restarts |
| `host_permissions: <all_urls>` | Required for redirect rules to match any URL |
