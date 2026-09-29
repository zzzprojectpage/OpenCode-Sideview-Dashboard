// OpenCode telemetry source for the sidebar: OpenCode Go / OpenAI subscription
// quotas, optionally Anthropic (Claude) subscription limits, plus read-only search over
// the local session history.
//
// Deliberately dependency-free: `Plugin.define` is an identity function and `Rpc.define`
// only validates reserved error names, so the plain object shapes below are equivalent.
// That means this plugin loads without `npm install` anywhere, which matters for anyone
// who drops it into ~/.config/opencode/plugins/.
//
// Secrets stay in this process. Credentials are read through the plugin context, sent
// only to the provider's own usage endpoint, and never returned over the RPC; the sidebar
// receives percentages and reset times only.
//
// Anthropic is opt-in. OpenCode holds only an API key (or a local proxy's key) for it, and
// neither can read subscription limits, so the Claude login is read from a local file that
// the user names in ~/.config/opencode/local-telemetry.json. That file is only ever read,
// never written or refreshed; its token goes to Anthropic's usage endpoint and nowhere else,
// and is never returned over the RPC. Without that settings entry Anthropic is left out.
//
// Search reads the OpenCode SQLite database directly, read-only (WAL-safe), using the
// SQLite driver the host runtime ships — bun:sqlite in the desktop app's Bun-compiled
// server, node:sqlite on Node. Only matched message text and location fields leave this
// process; the database file is never written to.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeCredential, normalizeQuota } from './src/quota.mjs';
import { searchMessages, sqliteAdapter } from './src/search.mjs';

const RPC_ID = 'local.telemetry';
const PROVIDERS = ['opencode-go', 'openai'];
const CACHE_MS = 60000;
const TIMEOUT_MS = 10000;
const DB_ENV = 'OPENCODE_DB';
const SETTINGS_ENV = 'OPENCODE_TELEMETRY_SETTINGS';
// Anthropic's usage endpoint is undocumented and rate-limits hard (a handful of reads per
// token), so it is read far less often than the others, and a 429 backs off for minutes.
const ANTHROPIC_CACHE_MS = 300000;
const ANTHROPIC_BACKOFF_MS = 600000;
const ANTHROPIC_BACKOFF_MAX_MS = 1800000;

const USAGE_URLS = {
  'opencode-go': 'https://opencode.ai/zen/go/v1/usage',
  'openai': 'https://chatgpt.com/backend-api/wham/usage',
  'anthropic': 'https://api.anthropic.com/api/oauth/usage',
};

// Plain object contract: the same shape Rpc.define would return unchanged.
const contract = {
  id: RPC_ID,
  methods: {
    snapshot: {
      input: { type: 'object', additionalProperties: false },
      output: { type: 'object', additionalProperties: true },
    },
    search: {
      input: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          roles: { type: 'array', items: { type: 'string', enum: ['user', 'assistant'] } },
          limit: { type: 'number' },
          page: { type: 'number' },
        },
        required: ['query'],
      },
      output: { type: 'object', additionalProperties: true },
    },
  },
  events: {},
};

function unavailable(provider, state, message) {
  return { provider, state, message, checked: Date.now(), windows: { fiveHour: null, weekly: null, monthly: null } };
}

// The ChatGPT account id lives in the OAuth token; only this process ever sees it.
function accountIdFrom(token) {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const id = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined; // Not a JWT, or an unexpected shape: the provider decides.
  }
}

export function settingsPath(env = process.env) {
  return env[SETTINGS_ENV] || join(homedir(), '.config', 'opencode', 'local-telemetry.json');
}

// Tolerates the byte-order mark some Windows editors put at the start of a JSON file.
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));

// Where the Claude login lives, per the user's settings file. No settings file, or no
// anthropic entry in it, means the feature is off and Anthropic is left out of the snapshot.
// A settings file that exists but cannot be read is reported rather than silently ignored.
async function claudeSource() {
  let settings;
  try {
    settings = await readJson(settingsPath());
  } catch (error) {
    return error?.code === 'ENOENT' ? null : { error: 'Telemetry settings file cannot be read as JSON' };
  }
  const value = settings?.anthropic?.credentialPath;
  if (typeof value !== 'string' || !value.trim()) return null;
  return { path: value.trim().replace(/^~(?=$|[\\/])/, homedir()) };
}

// The newest usable Claude login at `path`: a single file, or a folder of claude-*.json files
// (one per signed-in account). Only reads. Every failure is a fixed message; no file content,
// path or error text is ever passed on.
async function readClaudeLogin(path, now = Date.now()) {
  let files;
  try {
    if ((await stat(path)).isDirectory()) {
      const found = [];
      for (const name of await readdir(path)) {
        if (!/^claude-.+\.json$/i.test(name)) continue;
        const file = join(path, name);
        try { found.push({ file, at: (await stat(file)).mtimeMs }); } catch { /* vanished while listing */ }
      }
      files = found.sort((a, b) => b.at - a.at).map(entry => entry.file);
    } else {
      files = [path];
    }
  } catch {
    return { state: 'unauthorized', message: 'Claude login not found at the configured path' };
  }
  if (files.length === 0) return { state: 'unauthorized', message: 'No Claude login file at the configured path' };
  let failure;
  for (const file of files) {
    try {
      const result = claudeCredential(await readJson(file), now);
      if (result.token) return result;
      failure ??= result;
    } catch {
      failure ??= { state: 'unauthorized', message: 'Claude login file is not usable' };
    }
  }
  return failure;
}

function requestHeaders(provider, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (provider === 'openai') {
    const accountId = accountIdFrom(token);
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  }
  if (provider === 'anthropic') {
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    headers['User-Agent'] = 'opencode-telemetry-sidebar';
  }
  return headers;
}

// Anthropic sends no dependable Retry-After. Honour it when it comes, otherwise wait ten minutes.
function retryAfterMs(response) {
  const seconds = Number(response.headers?.get?.('retry-after'));
  const asked = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : ANTHROPIC_BACKOFF_MS;
  return Math.min(asked, ANTHROPIC_BACKOFF_MAX_MS);
}

export function databasePath(env = process.env) {
  return env[DB_ENV] || join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

// Prefer the runtime's own driver, then the other one, then fail loudly-but-honestly.
// Literal specifiers keep the imports resolvable in the compiled desktop server.
let driverPromise;
export function loadSqliteDriver() {
  if (!driverPromise) {
    driverPromise = (async () => {
      const bun = typeof process.versions?.bun === 'string';
      if (bun) {
        try { return { id: 'bun:sqlite', sqlite: await import('bun:sqlite') }; } catch { /* fall through */ }
        try { return { id: 'node:sqlite', sqlite: await import('node:sqlite') }; } catch { /* unavailable */ }
      } else {
        try { return { id: 'node:sqlite', sqlite: await import('node:sqlite') }; } catch { /* fall through */ }
        try { return { id: 'bun:sqlite', sqlite: await import('bun:sqlite') }; } catch { /* unavailable */ }
      }
      return null;
    })();
  }
  return driverPromise;
}

const message = error => (error instanceof Error ? error.message : String(error));

// One read-only connection per call: the database file can be replaced by a migration
// between searches, and opening is cheap. Errors are reported, never guessed around.
async function runSearch(input, { signal } = {}) {
  const driver = await loadSqliteDriver();
  if (!driver) return { error: 'No SQLite driver is available in this runtime.' };
  const path = databasePath();
  if (!existsSync(path)) return { engine: driver.id, error: `OpenCode database not found at ${path}` };
  let db;
  try {
    db = driver.id === 'bun:sqlite'
      ? new driver.sqlite.Database(path, { readonly: true })
      : new driver.sqlite.DatabaseSync(path, { readOnly: true });
  } catch (error) {
    return { engine: driver.id, error: `Cannot open the OpenCode database read-only: ${message(error)}` };
  }
  try {
    const all = (sql, params = []) => (
      driver.id === 'bun:sqlite'
        ? db.query(sql).all(...params)
        : db.prepare(sql).all(...params)
    );
    const value = await searchMessages(sqliteAdapter({ all }), input, {
      signal,
      // Let the server keep serving between sessions: a scan of older history
      // yields after every session instead of blocking the event loop.
      pause: () => new Promise(resolve => setTimeout(resolve, 0)),
    });
    return { engine: driver.id, value };
  } catch (error) {
    return { engine: driver.id, error: `Search failed: ${message(error)}` };
  } finally {
    try { db.close(); } catch { /* best-effort cleanup; the call's work is done */ }
  }
}

export default {
  id: RPC_ID,
  async setup(ctx) {
    // Options are optional; defaults suit normal use. Tests set cacheMs to force refreshes.
    const cacheMs = Number.isFinite(ctx?.options?.cacheMs) ? ctx.options.cacheMs : CACHE_MS;
    const timeoutMs = Number.isFinite(ctx?.options?.timeoutMs) ? ctx.options.timeoutMs : TIMEOUT_MS;
    // Anthropic follows an explicit cacheMs (so tests can force refreshes), else its own, slower default.
    const anthropicCacheMs = Number.isFinite(ctx?.options?.anthropicCacheMs) ? ctx.options.anthropicCacheMs
      : Number.isFinite(ctx?.options?.cacheMs) ? ctx.options.cacheMs : ANTHROPIC_CACHE_MS;
    const ttlFor = provider => (provider === 'anthropic' ? anthropicCacheMs : cacheMs);
    const cache = new Map();
    const inFlight = new Map();
    const lastGood = new Map();

    // One cached, single-flight usage request per credential. It never rejects: every failure
    // becomes a fixed-message state, and a prior reading survives it.
    function refresh(provider, token) {
      // Cache is scoped to the exact credential, so switching accounts never reuses a reading.
      const key = `${provider}:${createHash('sha256').update(token).digest('hex')}`;
      const ttl = ttlFor(provider);
      const previous = cache.get(key);
      if (previous && Date.now() - previous.at < (previous.ttl ?? ttl)) return previous.value;
      if (inFlight.has(key)) return inFlight.get(key);

      const job = (async () => {
        try {
          const response = await fetch(USAGE_URLS[provider], {
            headers: requestHeaders(provider, token), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) {
            const state = [401, 403].includes(response.status) ? 'unauthorized' : 'status-only';
            throw {
              state,
              message: `Usage request returned HTTP ${response.status}`,
              backoffMs: provider === 'anthropic' && response.status === 429 ? retryAfterMs(response) : 0,
            };
          }
          const value = { ...normalizeQuota(provider, await response.json()), refreshMs: ttl };
          cache.set(key, { at: Date.now(), value, ttl });
          if (value.state === 'quota') lastGood.set(provider, value);
          return value;
        } catch (error) {
          // Only our own fixed messages are returned; never a provider body or a raw error.
          // A prior reading stays visible through repeated failures, so a temporary outage
          // never erases the last known numbers.
          const previousValue = previous?.value;
          const hasReading = previousValue
            && (previousValue.state === 'quota' || previousValue.state === 'stale');
          const value = hasReading
            ? { ...previousValue, state: 'stale', message: 'Refresh failed; last successful reading' }
            : unavailable(provider, error?.state || 'status-only',
                          error?.state ? error.message : 'Usage service unavailable');
          cache.set(key, { at: Date.now(), value, ttl: Math.max(ttl, error?.backoffMs || 0) });
          return value;
        } finally {
          inFlight.delete(key);
        }
      })();
      inFlight.set(key, job);
      return job;
    }

    async function quota(provider) {
      try {
        const connection = await ctx.integration.connection.active(provider);
        if (!connection) return unavailable(provider, 'unauthorized', 'No active connection');
        const credential = await ctx.integration.connection.resolve(connection);
        if (!credential) return unavailable(provider, 'unauthorized', 'No available credential');
        if (provider === 'openai' && credential.type !== 'oauth') {
          return unavailable(provider, 'unsupported', 'Subscription quota requires OpenAI OAuth');
        }
        const token = credential.type === 'key' ? credential.key : credential.access;
        if (!token) return unavailable(provider, 'unauthorized', 'Sign in through OpenCode');
        return await refresh(provider, token);
      } catch {
        return unavailable(provider, 'unauthorized', 'Cannot resolve active connection');
      }
    }

    // A login that cannot be read right now (being rewritten, or expired) must not erase the
    // last known numbers: they stay, labelled stale, with the reason.
    function keepLastReading(state, message) {
      const previous = lastGood.get('anthropic');
      return previous ? { ...previous, state: 'stale', message } : unavailable('anthropic', state, message);
    }

    // Anthropic never goes through OpenCode's connection: that holds only an API key or a proxy
    // key, which must not be sent to Anthropic. The token comes from the configured login file.
    async function anthropicQuota(source) {
      if (source.error) return unavailable('anthropic', 'unsupported', source.error);
      try {
        const login = await readClaudeLogin(source.path);
        if (!login.token) return keepLastReading(login.state, login.message);
        return await refresh('anthropic', login.token);
      } catch {
        return keepLastReading('unauthorized', 'Cannot read the Claude login');
      }
    }

    await ctx.rpc.register(contract, {
      snapshot: async () => {
        const providers = await Promise.all(PROVIDERS.map(quota));
        // Anthropic appears only once the user has pointed the sidebar at a Claude login.
        const source = await claudeSource();
        if (source) providers.push(await anthropicQuota(source));
        return { providers };
      },
      search: async (input, context) => {
        const started = Date.now();
        const { engine, value, error } = await runSearch(input ?? {}, { signal: context?.signal });
        if (error || !value) {
          return { results: [], engine: engine ?? null, error: error ?? 'Search unavailable', elapsedMs: Date.now() - started };
        }
        return { ...value, engine, elapsedMs: Date.now() - started };
      },
    });
  },
};
