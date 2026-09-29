# AI Assistance

You are reading the maintainer's notes for **opencode-telemetry-sidebar**. This file exists
so an AI agent can diagnose a failed install or a missing sidebar without rediscovering the
architecture. Work the diagnostic ladder in order and stop at the first branch that matches.

Read `README.md` for user-facing behaviour and honest limits. This file covers mechanics.

## Mental model

Two independent halves must both work. Test them separately, because they fail differently.

| Half | Lives in | Delivers | Fails as |
|---|---|---|---|
| Renderer patch | inside the app's `app.asar` | the sidebar panel itself | no panel at all |
| Server plugin | `~/.config/opencode/plugins/local-telemetry/` | Go/OpenAI (and optional Anthropic) cap numbers | panel renders, caps say Unavailable |

The session metrics (context, cost, speed, cache, MCPs, model share) come from the renderer
half alone. Only the cap sections need the plugin. That split tells you which half broke.

The **Search** panel (1.1.0) spans both halves: the renderer owns the button, panel and
navigation; the server plugin owns the database read. It fails in its own way: an old
renderer has no button at all, and an old (or not restarted) plugin makes searches answer
`Search failed.`

The **Anthropic** section (1.2.0) is opt-in and lives in the server plugin plus one settings
file. Anthropic is absent from the snapshot until `~/.config/opencode/local-telemetry.json` names
a Claude login, so "no Anthropic section" is the normal state, not a fault.

## Invariants

1. **Never delete.** Unwanted files move aside to a uniquely named folder. `_stash()` guarantees this.
2. **`stage` is read-only** against the installation. It writes only into the state directory's `build/`.
3. **Every preserved archive entry is verified byte-for-byte** during staging.
4. **Credentials stay in the server process.** The RPC returns percentages and reset times only,
   never tokens, never account ids, never provider error bodies.
5. **No number is invented.** Missing data renders as `Unavailable`, never `0`.
6. **The plugin stays dependency-free.** It must not import `@opencode/plugin`; that package is
   not installed for a fresh user.
7. **Never touch `build/`, `backups/` or `__pycache__/`** while packaging or cleaning up: they hold
   install state, not release content. `build_release.py` enforces this with a `PROTECTED` set.
8. **Search never writes.** The database is opened read-only, a test proves the connection refuses
   writes, and reasoning/tool content is never searched or returned.
9. **The Claude login file is read-only and its token goes to one place.** The plugin never writes,
   refreshes or copies it, and sends its token only to `https://api.anthropic.com/api/oauth/usage`.
   OpenCode's own Anthropic connection (an API key or a proxy key) is never sent to Anthropic. Every
   error about the login is a fixed message: no path, file content or token is ever echoed.

## Where state lives

The staged archive, the install record and the pristine backup live in a **per-user state
directory**, not in the project folder:

```
%LOCALAPPDATA%\opencode-telemetry-sidebar\
    build\app.asar            staged, patched archive (regenerated on every install)
    build\installed.json      the record rollback needs
    backups\<sha256>\app.asar the pristine original, the safety net
```

Override it with the `OPENCODE_TELEMETRY_STATE` environment variable. State is kept out of the
project folder on purpose: that folder is what the user shares, and ~236 MB of archives in it
both bloats an upload and invites a cleanup that strands a patched install. An install made by
an older version that kept state in the folder is moved out automatically by `migrate_state()`
on the next run; `py patch_desktop.py migrate` does it on demand.

## Where configuration lives

The only user configuration is the optional `~/.config/opencode/local-telemetry.json` (override
with `OPENCODE_TELEMETRY_SETTINGS`). It holds no secret, only the path of a Claude login:

```
{ "anthropic": { "credentialPath": "C:/path/to/claude/login" } }
```

`credentialPath` is a file, or a folder of `claude-*.json` files (newest usable one wins). It is
re-read on every snapshot, so editing it needs no reinstall. It is not part of the install:
`Rollback-Sidebar.cmd` leaves it alone.

## The install pipeline

`Install-Sidebar.cmd` runs `py patch_desktop.py install`. That does, in order:

1. `require_closed()` — refuses if `OpenCode.exe` is running. Nothing is written.
2. `stage()` — pick the source archive: the pristine backup if the installed app is already
   patched, otherwise the installed app itself. Find the renderer bundle and the client
   factory, wrap the factory, bundle three ES modules, write `build/app.asar`, then verify
   every entry.
3. Back up the original to `backups/<sha256-of-original>/app.asar`.
4. `install_plugin()` — copy the files in `PLUGIN_FILES` (`index.ts`, `package.json`,
   `src/quota.mjs`, `src/search.mjs`) into the plugin folder. Files a previous install recorded
   in `installed.json` (or the 1.0.0 release, recognised by its digests) are upgraded in place;
   any other file with one of those names is refused, never overwritten.
5. Atomically replace `app.asar`.
6. Write `build/installed.json`, the record `rollback` needs.

## Diagnostic ladder

Run `py patch_desktop.py verify` first. It changes nothing and reports the build, the bundle
it found, and whether the wrapper inserts cleanly. Quote its output when asking for help.

### 1. The installer exits with a traceback

| Message contains | Meaning | Fix |
|---|---|---|
| `No such file or directory: ...build\app.asar` | Running an old copy that did not stage first | Update to this version; `install` now stages automatically |
| `OpenCode is still running` | The app holds the archive open | Quit OpenCode fully, including the tray icon |
| `Could not find the OpenCode API-client factory` | OpenCode changed its client code | The patcher needs updating; `discovery.py` is the file to change |
| `OpenCode desktop 2.x is required` | Wrong product or a 1.x install | Only the 2.x desktop app is supported |
| `already patched` | Archive patched but the pristine backup is gone | `Rollback-Sidebar.cmd`, or restore `app.asar` from the state directory above |
| `has files we did not write` | A different plugin already occupies the folder | Move that folder aside; nothing was overwritten |

### 2. Install succeeds but there is no sidebar

The renderer half failed. Check, in order:

1. **Is the patch actually inside the archive?** Run `py patch_desktop.py verify`. It should say
   *already patched by this project*. If it says *Compatible. Run Install-Sidebar.cmd*, the
   install did not take effect — usually because OpenCode was relaunched from a different
   install location.
2. **Did the renderer throw?** Open the app; a startup error shows a *Something went wrong*
   screen. The most likely cause is a sidebar module that threw while the app was building its
   client. `attachClient` and `mount` are wrapped in `try/catch` for exactly this reason; if you
   are looking at a build that predates those guards, the panel code is at fault.
3. **Check the console.** The renderer must not raise during startup. A thrown error inside the
   injected wrapper surfaces as an Electron error screen, not a quiet failure.

### 3. Sidebar renders, but everything says Unavailable

The renderer loaded but has no session bound yet.

- The panel binds to the **last session id seen on a real API call** (`session.get`,
  `session.context`, `session.prompt`, or a message list). Open or send a message in a session.
- Read the small diagnostics line at the bottom of the panel: `Session ses_… · hooks get:N …`.
  - `Session none` and all counters `0` → no hooked call has run. The client the app uses is not
    the one being decorated, which means the wrapper is on a different code path.
  - Counters non-zero but values still `Unavailable` → the API calls are failing. Check the log.

### 4. Session metrics work, caps say Unavailable

The server plugin half failed.

1. **Is the plugin there?** `~/.config/opencode/plugins/local-telemetry/` must contain `index.ts`,
   `package.json`, `src/quota.mjs`.
2. **Did it load?** Search the log at `~/.local/share/opencode/log/opencode.log` for
   `local.telemetry`. A resolve error mentioning `@opencode/plugin` means an old build that
   imported that package; the current plugin imports only Node builtins (`node:*`) and its own
   `./src/*.mjs` files.
3. **Duplicate id?** Two copies of the plugin cannot coexist; OpenCode reports
   `Duplicate plugin ID: local.telemetry`. Remove the extra copy.
4. **Signed in?** `py patch_desktop.py` cannot check this. Run `opencode auth list`: a provider
   with no stored credential reports `unauthorized`.
5. **OpenAI needs OAuth.** An OpenAI *API key* cannot read subscription usage; that reports
   `unsupported` by design.
6. **A `Stale` label is normal after a failed refresh.** The last good reading stays on screen.
   It clears on the next successful refresh (at most once a minute).

### 5. Search says "Search failed." or returns nothing

The search half is the renderer button plus the plugin's `search` method.

1. **Old plugin.** The panel message names it: the running server has no `search` method yet.
   Restart OpenCode after installing; the plugin loads once per server start.
2. **Sanity-check the database itself**, bypassing the app and the plugin:
   `node verification/search_live.mjs telemetry` reads the real database read-only with the
   shipping core and prints results and timings.
3. **Wrong database.** The plugin uses `$OPENCODE_DB` when set, else
   `~/.local/share/opencode/opencode.db`. A search that returns nothing for known text usually
   means the app is writing a different file.
4. **Old rows only.** Searches read `session_v2`/`session_message`, the current V2 store. A
   session that exists only in the legacy `message`/`part` tables (pre-migration) is invisible
   until the app migrates it.
5. **Clicking a hit says the session-tab integration is missing.** Re-run `Install-Sidebar.cmd`
   from this project, then fully quit and restart OpenCode. The desktop patch registers the
   opener with OpenCode's shared Tabs provider; it must add and select the tab, not only change
   the URL. If the message remains, run `Verify-Compatibility.cmd` and report its output and
   the OpenCode version.
6. **A session tab opens but stays blank.** The route encodes server keys, while the Tabs store
   expects OpenCode's raw server key. Decode the route segment before adding the tab; otherwise
   the session view cannot resolve its server context. Reinstall after updating the project.
7. **Slow searches are bounded.** A term that matches nothing scans every session and stops at
   the 8-second budget; the panel then says *older history not fully scanned*. Typing aborts the
   previous search first.

### 6. A provider is missing its cap section

Caps are a fixed list, not a discovery mechanism. `index.ts` defines `PROVIDERS`, and
`USAGE_URLS` maps each to its endpoint; `src/quota.mjs` normalises each response shape. Adding
a provider means editing all three. Most API-key providers are pay-per-token and expose no cap
at all — do not fabricate one. Balance or spend is the honest substitute where the provider
offers it.

### 7. The Anthropic section is missing, or unhealthy

The section exists only when `local-telemetry.json` names a Claude login, so first work out which
of these you have:

| Symptom | Cause | Fix |
|---|---|---|
| No Anthropic section at all | No settings file, no `anthropic.credentialPath`, or a plugin older than 1.2.0 | Create the file (see `README.md`); re-run `Install-Sidebar.cmd` if the plugin is old |
| `Telemetry settings file cannot be read as JSON` | The settings file exists but is not valid JSON | Fix the JSON (a byte-order mark is tolerated) |
| `Claude login not found at the configured path` | The path does not exist | Correct `credentialPath`; forward slashes are fine on Windows |
| `No Claude login file at the configured path` | The folder has no `claude-*.json` | Point at the file, or at the folder that holds them |
| `Claude login file is not usable` | Not JSON, no token, or neither the CLIProxyAPI nor the Claude Code layout | Check `type` is `claude` and `access_token` exists. Never paste the token anywhere |
| `Claude login has expired; …` | The token lapsed and its owner has not renewed it yet | Use Claude once through the app that owns the login; the last reading shows as `Stale` meanwhile |
| `Usage request returned HTTP 401` or `403` | Token rejected, missing the `user:profile` scope, or not a subscription login | Sign in again; API keys cannot read subscription limits |
| `Usage request returned HTTP 429` | Anthropic rate-limits this endpoint | Wait: the plugin backs off ten minutes and keeps the last reading |

To check the reading outside the app, call the shipping plugin with no connections. It reads only
the login file, makes one request, and prints the state and percentages, never the token:

```
node -e "import('./index.ts').then(async m=>{const r=[];await m.default.setup({options:{},integration:{connection:{active:async()=>null,resolve:async()=>null}},rpc:{register:async(c,h)=>r.push(h)}});console.log(JSON.stringify((await r[0].snapshot({})).providers.find(p=>p.provider==='anthropic'),null,1))})"
```

### 8. The per-model split is missing

It only appears for OpenCode Go, and only when all of these hold:

- the Go provider returned `state: 'quota'`;
- the window has a reset timestamp (the window start is derived as `reset − duration`);
- that derived start is in the past;
- local session stats contain at least one `opencode-go/**` model with non-zero cost.

If every Go model has zero cost, the split cannot be apportioned and the panel says so instead
of showing percentages.

### 9. The sidebar vanished after an OpenCode update

Expected. An update replaces `app.asar`. Run `Install-Sidebar.cmd` again; it upgrades in place
from the pristine backup.

### 10. Tests fail

```
node --test tests/*.test.mjs
py -m unittest discover -s tests -p "test_*.py"
```

Both must pass with no network and no credentials; if a test needs either, that is the bug.
Platform notes that have bitten this project before:

- **Locale.** The machine formats decimals with a comma. Tests assert locale-independently
  (integer values, or a regex) except where a formatter is injected. Money is deliberately
  pinned to `en-US` so it matches OpenCode's own cost readout.
- **Windows file locks.** Explorer holding the release folder open blocks rewrites; the packager
  reports which files it could not update instead of failing.
- **`mkdir`/`move` collisions.** Always use unique destinations; a plain move onto an existing
  folder raises on Windows.
- **Settings isolation.** `plugin.test.mjs` pins `OPENCODE_TELEMETRY_SETTINGS` to a missing file, so
  the tests never read the developer's real settings (which may name a real Claude login) and never
  contact Anthropic. Keep any new plugin test behind that pin.

## Verifying a change

Run all four before claiming a fix:

1. `node --test tests/*.test.mjs` and `py -m unittest discover -s tests -p "test_*.py"`.
2. `py tests/verify_ui.py` — drives the real sidebar module in a headless browser against
   synthetic data (serve the folder on 8768 first).
3. `node verification/search_live.mjs` — runs the shipping search core against the real database,
   read-only; checks the schema assumptions end to end.
4. `py verification/simulate_fresh_download.py` — proves a clean checkout installs and rolls back
   with no manual staging, against a pristine archive. This is the gate that matters most: it
   reproduces what a GitHub downloader experiences.

A change to the patch mechanics is not verified until the fresh-download simulation passes,
because a working install on a development machine hides staging assumptions.

## Where the evidence lives

| Question | Look at |
|---|---|
| Can this build be patched? | `py patch_desktop.py verify` |
| Did the plugin load? | `~/.local/share/opencode/log/opencode.log`, search `local.telemetry` |
| Which plugins are active? | `opencode api get "/api/plugin?location%5Bdirectory%5D=<dir>"` |
| Is a session bound? | the panel's bottom diagnostics line |
| Is the archive patched? | `py patch_desktop.py verify`, or grep the bundle for `__localTelemetryAttach` |
| Does search work outside the app? | `node verification/search_live.mjs <term>` |
| What was upgraded? | `build/installed.json` (`pluginDigests`) and the printed stage summary |
| Is the Anthropic section switched on? | `~/.config/opencode/local-telemetry.json` (`anthropic.credentialPath`) |

## Files

```
patch_desktop.py     install / stage / rollback / verify; owns the ASAR read-write
discovery.py         finds the bundle and client factory by shape; owns the JS scanner
index.ts             server plugin: credentials -> provider usage -> percentages over RPC;
                     optional Claude login file -> Anthropic usage (read-only, opt-in);
                     search -> read-only SQLite query over session history
src/sidebar.mjs      panel UI, client hook, rendering, refresh loop, search panel + navigation
src/search.mjs       search core: query shape, text extraction, snippets, session walk
src/metrics.mjs      session metrics from messages
src/attribution.mjs  per-model split of a Go cap window
src/quota.mjs        normalises each provider's usage response; picks the token out of a Claude login
tests/               unit, patch-integrity, and browser tests
verification/        fresh-download and live-service probes (not shipped to users)
```

The JS scanner in `discovery.py` understands strings, template literals with interpolation,
comments, and regex literals, because minified bundles contain all four. Keep it that way:
finding a function's closing brace by counting braces alone will mis-parse `return /}/`.
