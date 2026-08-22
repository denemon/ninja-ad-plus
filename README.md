# Ninja Ad (Stealth Switch)

*English | [日本語](README.ja.md)*

Chrome Manifest V3 ad-blocking extension. Instead of hard-blocking ad requests (which triggers anti-adblock detection), it redirects ad resources to content-type-appropriate empty responses, returning silent HTTP 200 OK.

## How It Works

Standard ad blockers return `ERR_BLOCKED_BY_CLIENT`, which anti-adblock scripts detect by catching failed loads. This extension redirects blocked resources to local noop files matching the expected content type:

| Resource Type | Redirect Target | Description |
|---|---|---|
| Script, XHR/fetch, ping, object, other | `noop.js` | Valid empty JavaScript (`;`) |
| Image | `noop.gif` | 1x1 transparent GIF (44 bytes) |
| Sub-frame | `noop.html` | Minimal empty HTML document |
| Stylesheet | `noop.css` | Empty CSS file |
| Font, media, WebSocket | *(not blocked)* | Nothing can answer these convincingly |

Chrome derives the response `Content-Type` from the noop file's extension, so a
redirect only stays invisible when the target suits the type that was requested.
HTTP 200 is not enough on its own: a stylesheet served as `text/javascript` is
refused in standards mode, an image fails to decode, a font rejects the
`document.fonts` promise, and a video fires `error` on the element — the very
event this extension exists to avoid.

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
as it normally would, and the page sees exactly what it would see without the
extension installed — less blocking, nothing to detect.

Exception (`@@`) rules resolve against the **full** set of blockable types, not
the narrower set above. A block rule costs one rule per group, which is why that
set is kept tight; an exception is never split, so breadth costs nothing there.
An exception narrower than the block it opposes silently fails to except —
`@@||x/ad.css^` would leave `||x/ad.css^$stylesheet` redirecting the very file
the exception exists to permit, because a priority-2 `allow` cannot override a
type it does not claim.

All blocking runs in Chrome's native C++ `declarativeNetRequest` engine. No JavaScript executes per network request.

On YouTube, `youtube.js` automatically clicks ad skip buttons, advances active
video ads to their end, and removes page ad slots.

Every component honours the single ON/OFF switch, but by two different
mechanisms. `youtube.js` runs in the isolated world and watches
`chrome.storage` directly. `spoofing.js` runs in the page's MAIN world, where
`chrome.*` APIs do not exist, so it cannot read the state itself — the service
worker registers and unregisters it through `chrome.scripting` instead. Turning
the extension off therefore stops the page-context patching too, from the next
page load onward.

### Keeping OFF Meaning OFF

One toggle drives four things — two rulesets, the injected script and the badge
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

Failure tolerance is deliberately asymmetric. Losing the extended ruleset to
quota **while enabling** is survivable and only costs blocking coverage. A
failure **while disabling** is fatal and rolls back: disabling never competes
for quota, so a rejection there means the rules are still live, and reporting
success would leave ~144,000 rules running against a stored OFF.

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

The extension uses [EasyList](https://easylist.to/) as its filter source. To update:

1. Download the latest `easylist.txt` from [https://easylist.to/easylist/easylist.txt](https://easylist.to/easylist/easylist.txt).
2. Place it in `filters/`.
3. Run the converter, which writes both generated rulesets into `src/`:

```bash
node convert.js
npm test
```

4. Reload the extension in `chrome://extensions/`.

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

- **A runtime guard rule** — the single highest-priority (`3`) `allow` rule at
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
page instead, which is a different condition and does not protect anything here.

To modify the whitelist, edit the `WHITELIST_DOMAINS` array in `convert.js` and
rerun the converter.

### Rule Priorities

| Priority | Rule Type | Action |
|---|---|---|
| 1 | Block rule | Redirect to noop file |
| 2 | Exception (`@@`) rule | Allow (bypasses block) |
| 3 | Whitelist guard (one rule) | Allow (bypasses everything) |

### Two Rulesets and Chrome's Static Rule Budget

Chrome guarantees only **30,000** static rules per extension. EasyList currently
yields ~174,000 rules (about 58,000 filters, most emitted once per noop group),
and the surplus is drawn from a pool shared with every other installed
extension.

Critically, `updateEnabledRulesets()` is **atomic**: if enabling a ruleset would
push the count past what that shared pool can spare, the call is rejected and
*no* change is made. Chrome does not load the rules that fit and drop the rest.
A single 174,000-rule ruleset would be all-or-nothing — one unlucky quota check
and the extension blocks nothing at all.

The converter splits the output accordingly:

| Ruleset | Rules | Enabled | Failure impact |
|---|---|---|---|
| `rules-core.json` | 30,000: the guard rule, **every** exception rule, then one `noop.js` rule per filter | `false` in the manifest; `background.js` enables it from the stored state | Cannot be rejected for quota — it fits inside the guarantee |
| `rules-extended.json` | the remainder (~144,000) | `false`; `background.js` enables it best-effort | Reduced blocking coverage, logged as a warning |

**Rules are emitted noop group by noop group, not filter by filter.** Both orders
produce identical rules; only the core/extended boundary moves. Filter-major
ordering would spend the guaranteed 30,000 on every variant of the first ~7,500
filters. Group-major ordering spends it on the `noop.js` variant of ~29,400
filters instead and leaves the image, sub-frame and stylesheet variants to the
extended ruleset. That is the better failure mode in both directions: blocking an
ad's script usually prevents its image request from ever being made, and if the
extended ruleset cannot be enabled the type-specific rules simply do not match,
so those requests proceed untouched rather than being answered with the wrong
content type.

All exception (`allow`) rules go in the core ruleset. An exception stranded in
the droppable half would let core block rules fire with nothing to override
them, which is how sites break. `convert.js` fails the build if the exceptions
alone ever exceed the guarantee, and the split is asserted in
`test/static-rules.test.js`.

Rule matching and priorities apply across all enabled rulesets, so a priority-2
`allow` in the core ruleset still overrides a priority-1 `redirect` in the
extended one.

### Neither Ruleset Is Enabled From the Manifest

Both `rule_resources` entries declare `"enabled": false`, and `background.js`
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

`main_frame` (document) and `popup` resource types are excluded from all rules.
This prevents the extension from forcibly navigating browser tabs. `font`,
`media` and `websocket` are excluded for the separate reason given above: no
response this extension can produce would be mistaken for a real one.

## File Structure

`src/` is the extension exactly as it ships. Everything outside it is a build
input or a test, so nothing but `src/` is ever loaded into Chrome.

```
ninja-ad-plus/
├── src/                        # ← Load unpacked target: the packaged extension
│   ├── manifest.json           # MV3 config (permissions, ruleset, service worker)
│   ├── background.js           # Service worker: ruleset + spoofing toggle, badge, storage sync
│   ├── spoofing.js             # MAIN-world ad/anti-adblock stubs (registered by background.js)
│   ├── youtube.js              # YouTube video-ad skipper and page ad cleanup
│   ├── popup.html              # Popup UI: toggle switch with status indicator
│   ├── popup.js                # Popup controller: reads/writes state, sends toggle messages
│   ├── rules-core.json         # Generated: 30k rules incl. all exceptions, enabled from stored state
│   ├── rules-extended.json     # Generated: overflow rules, enabled best-effort
│   ├── noop.js                 # Empty JS (script, XHR, ping, object, other)
│   ├── noop.gif                # 1x1 transparent GIF (image ads)
│   ├── noop.css                # Empty CSS (explicit $stylesheet filters only)
│   ├── noop.html               # Empty HTML (sub-frame ad slots)
│   ├── icon48.png              # Toolbar icon
│   └── icon128.png             # Extension management page icon
├── filters/                    # Build inputs, never shipped
│   ├── easylist.txt            # EasyList filter source
│   └── antiadblockfilters.txt  # Anti-adblock filter source
├── test/                       # node --test suites
├── convert.js                  # Build step: filters/*.txt -> src/rules-{core,extended}.json
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
- **Page-context spoofing is switchable**: `spoofing.js` is injected at `document_start` in the page's MAIN world to stub common ad/anti-adblock globals. It is bundled locally, loads no remote code, and is unregistered entirely when the extension is switched off — so a site it breaks can always be recovered by toggling off and reloading.
- **Bait protection is name-exact**: `spoofing.js` force-shows hidden elements whose class or id looks like ad bait, to defeat dimension probing. Each class token must equal a bait word or be a bait word followed by `-`/`_`, so `address`, `admin-dialog` and `adaptive-layout` are left alone. An open-ended prefix match would force ordinary hidden UI visible with `!important` on every site.
- **No main_frame redirection**: Document-level rules are explicitly excluded to prevent forced navigation.
- **Minimal permissions**: Only the four permissions below. `scripting` buys the kill switch for the MAIN-world script and is not used for remote or arbitrary code injection — the only script it ever registers is the bundled `spoofing.js`.
- **Domain whitelist**: Critical services (Google, YouTube) are protected from accidental blocking at the build step.
- **web_accessible_resources**: Noop files are exposed to all URLs (required for redirects). These files contain no executable logic or sensitive data.

## Permissions

| Permission | Purpose |
|---|---|
| `declarativeNetRequest` | Register and toggle DNR rulesets |
| `declarativeNetRequestWithHostAccess` | Apply redirect rules to all URLs |
| `scripting` | Register/unregister the MAIN-world `spoofing.js` so the ON/OFF switch reaches it |
| `storage` | Persist ON/OFF state across browser restarts |
| `host_permissions: <all_urls>` | Required for redirect rules to match any URL |
