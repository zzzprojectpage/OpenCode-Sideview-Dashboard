// Behavioural tests for the quota plugin and the history-search RPC, run against a
// fake plugin context. Node imports the .ts source directly, so these test the
// shipping file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import plugin, {databasePath, settingsPath} from '../index.ts';
import {buildSearchFixture} from './fixture-db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'index.ts'), 'utf8');

// Hermetic by default: never read the developer's real settings file, which may name a real
// Claude login. The Anthropic tests point this at their own fixture and put it back afterwards.
const NO_SETTINGS = join(tmpdir(), 'telemetry-tests-no-settings', 'local-telemetry.json');
process.env.OPENCODE_TELEMETRY_SETTINGS = NO_SETTINGS;

const GO_PAYLOAD = {
  usage: {
    rolling: {status: 'ok', percent: 25, resetsAt: '2026-09-28T12:00:00Z'},
    weekly: {status: 'ok', percent: 6, resetsAt: '2026-09-29T00:00:00Z'},
    monthly: {status: 'rate-limited', percent: 40, resetsAt: '2026-10-12T07:51:52Z'},
  },
};

function fakeContext({connection = {type: 'credential', id: 'c1', label: 'x', method: 'key'},
                     credential = {type: 'key', key: 'secret-token'},
                     options = {}} = {}) {
  const registered = [];
  return {
    options,
    integration: {
      connection: {
        active: async () => connection,
        resolve: async () => credential,
      },
    },
    rpc: {register: async (contract, handlers) => registered.push({contract, handlers})},
    registered,
  };
}

async function handlerFor(context) {
  await plugin.setup(context);
  return context.registered[0].handlers.snapshot;
}

function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({url, init});
    return responder(url, init);
  };
  return calls;
}

function ok(payload) {
  return {ok: true, json: async () => payload};
}

test('the plugin is dependency-free and shaped as OpenCode expects', () => {
  assert.equal(plugin.id, 'local.telemetry');
  assert.equal(typeof plugin.setup, 'function');
  assert.ok(!/@opencode\//.test(source), 'must not import @opencode/plugin, so it needs no install');
  // Only node builtins and relative files: a bare specifier would need npm install.
  assert.ok(!/\bfrom\s+'(?!node:|\.)/.test(source), 'no third-party package may be imported');
});

test('setup registers the snapshot RPC with a plain-object contract', async () => {
  const context = fakeContext();
  await plugin.setup(context);
  assert.equal(context.registered.length, 1);
  const {contract} = context.registered[0];
  assert.equal(contract.id, 'local.telemetry');
  assert.ok(contract.methods.snapshot.input, 'the input schema is required by the RPC runtime');
  assert.ok(contract.methods.snapshot.output);
  assert.equal(typeof context.registered[0].handlers.snapshot, 'function');
});

test('a normal reading returns both providers, with the provider percentages untouched', async () => {
  stubFetch(() => ok(GO_PAYLOAD));
  const snapshot = await (await handlerFor(fakeContext()))({});
  assert.equal(snapshot.providers.length, 2);
  const go = snapshot.providers.find(p => p.provider === 'opencode-go');
  assert.equal(go.state, 'quota');
  assert.equal(go.windows.fiveHour.used, 25);
  assert.equal(go.windows.fiveHour.remaining, 75);
  assert.equal(go.windows.weekly.used, 6);
  assert.equal(go.windows.monthly.used, 100, 'rate-limited means the window is exhausted');
  assert.equal(go.windows.monthly.remaining, 0);
});

test('no connection or credential reports unauthorized without calling the provider', async () => {
  for (const context of [fakeContext({connection: null}), fakeContext({credential: null})]) {
    const calls = stubFetch(() => ok(GO_PAYLOAD));
    const snapshot = await (await handlerFor(context))({});
    assert.equal(calls.length, 0, 'must not contact the provider without a credential');
    assert.ok(snapshot.providers.every(p => p.state === 'unauthorized'), JSON.stringify(snapshot.providers));
    assert.ok(snapshot.providers.every(p => p.windows.fiveHour === null));
  }
});

test('an OpenAI API key is reported unsupported rather than guessed at', async () => {
  stubFetch(() => ok(GO_PAYLOAD));
  const snapshot = await (await handlerFor(fakeContext({credential: {type: 'key', key: 'sk-test'}})))({});
  const openai = snapshot.providers.find(p => p.provider === 'openai');
  assert.equal(openai.state, 'unsupported');
  assert.match(openai.message, /OAuth/);
});

test('a failed refresh keeps the last good reading, labelled stale', async () => {
  let healthy = true;
  stubFetch(() => (healthy
    ? ok(GO_PAYLOAD)
    : {ok: false, status: 500, text: async () => 'upstream boom'}));
  // cacheMs 0 forces a fresh request each call while still remembering the last good value.
  const handler = await handlerFor(fakeContext({options: {cacheMs: 0}}));
  const first = await handler({});
  assert.equal(first.providers[0].state, 'quota');
  assert.equal(first.providers[0].windows.fiveHour.used, 25);

  healthy = false;
  const second = await handler({});
  const go = second.providers.find(p => p.provider === 'opencode-go');
  assert.equal(go.state, 'stale', 'a failed refresh must be labelled stale');
  assert.equal(go.windows.fiveHour.used, 25, 'the last good reading is preserved');
  assert.match(go.message, /last successful reading/i);
});

test('a stale reading survives a second failure without reverting to its old label', async () => {
  let healthy = true;
  stubFetch(() => (healthy ? ok(GO_PAYLOAD) : {ok: false, status: 429, text: async () => 'rate limited'}));
  const handler = await handlerFor(fakeContext({options: {cacheMs: 0}}));
  await handler({});
  healthy = false;
  const once = await handler({});
  const twice = await handler({});
  assert.equal(once.providers[0].state, 'stale');
  assert.equal(twice.providers[0].state, 'stale');
  assert.equal(twice.providers[0].windows.weekly.used, 6);
});

test('a first failure is reported, never turned into a zero-percent window', async () => {
  stubFetch(() => ({ok: false, status: 503, text: async () => 'nope'}));
  const snapshot = await (await handlerFor(fakeContext({options: {cacheMs: 0}})))({});
  for (const provider of snapshot.providers) {
    assert.notEqual(provider.state, 'quota', 'a failure must not look like real usage');
    assert.equal(provider.windows.fiveHour, null);
    assert.ok(provider.message, 'the reason must be reported');
  }
});

test('provider error bodies are never surfaced to the caller', async () => {
  stubFetch(() => ({ok: false, status: 500, text: async () => 'sk-live-SECRETLEAK / internal stack'}));
  const snapshot = await (await handlerFor(fakeContext({options: {cacheMs: 0}})))({});
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes('SECRETLEAK'), 'provider body must not be forwarded');
  assert.ok(!serialized.includes('stack'));
});

test('the credential is never included in the response', async () => {
  stubFetch(() => ok(GO_PAYLOAD));
  const snapshot = await (await handlerFor(fakeContext({credential: {type: 'key', key: 'sk-live-SECRETLEAK'}})))({});
  assert.ok(!JSON.stringify(snapshot).includes('SECRETLEAK'));
});

test('repeated calls inside the cache window make a single provider request', async () => {
  const calls = stubFetch(() => ok(GO_PAYLOAD));
  const handler = await handlerFor(fakeContext({options: {cacheMs: 60000}}));
  await handler({});
  await handler({});
  assert.equal(calls.length, 1, 'both providers share one refresh, and it is cached');
});

test('the ChatGPT account id is sent when the token carries one', async () => {
  const claims = Buffer.from(JSON.stringify({'https://api.openai.com/auth': {chatgpt_account_id: 'acct_9'}})).toString('base64url');
  const token = `header.${claims}.signature`;
  const calls = stubFetch(() => ok(GO_PAYLOAD));
  await (await handlerFor(fakeContext({credential: {type: 'oauth', access: token}})))({});
  const openaiCall = calls.find(call => call.url.includes('chatgpt.com'));
  assert.equal(openaiCall.init.headers['ChatGPT-Account-Id'], 'acct_9');
});

test('the contract exposes search next to snapshot', async () => {
  const context = fakeContext();
  await plugin.setup(context);
  const {contract, handlers} = context.registered[0];
  assert.equal(contract.id, 'local.telemetry');
  assert.ok(contract.methods.search.input, 'the search input schema is required by the RPC runtime');
  assert.deepEqual(contract.methods.search.input.required, ['query']);
  assert.equal(contract.methods.search.input.additionalProperties, false);
  assert.equal(contract.methods.search.input.properties.page.type, 'number');
  assert.ok(contract.methods.search.output);
  assert.equal(typeof handlers.search, 'function');
});

test('the database path honours OPENCODE_DB and otherwise uses the standard location', () => {
  assert.equal(databasePath({OPENCODE_DB: 'C:/custom/opencode.db'}), 'C:/custom/opencode.db');
  assert.match(databasePath({}), /opencode\.db$/);
});

test('search reads the database named by OPENCODE_DB and reports its engine', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-plugin-search-'));
  const dbPath = join(dir, 'opencode.db');
  buildSearchFixture(dbPath);
  const previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = dbPath;
  try {
    const context = fakeContext();
    await plugin.setup(context);
    const search = context.registered[0].handlers.search;

    const response = await search({query: 'rate limit', roles: ['user', 'assistant'], limit: 10});
    assert.equal(response.engine, 'node:sqlite');
    assert.equal(response.error, undefined);
    assert.ok(response.results.length >= 3, JSON.stringify(response));
    assert.ok(response.results.every(item => item.sessionID && item.messageID && typeof item.snippet === 'string'));
    assert.ok(response.results.some(item => item.role === 'user'));
    assert.ok(response.results.some(item => item.role === 'assistant'));
    assert.equal(response.scanned, 2);
    assert.equal(response.total, 2);

    const missing = await search({query: 'zzz_absent_zzz'});
    assert.equal(missing.error, undefined);
    assert.deepEqual(missing.results, []);
    assert.equal(missing.truncated, false);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previous;
    rmSync(dir, {recursive: true, force: true});
  }
});

// --- Anthropic (Claude) subscription limits ---------------------------------------------
const CLAUDE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_TOKEN = 'tok-claude-fixture-A1';
const CLAUDE_PAYLOAD = {
  five_hour: {utilization: 41, resets_at: '2026-09-29T18:59:59.943648+00:00'},
  seven_day: {utilization: 13, resets_at: '2026-10-03T16:59:59Z'},
  seven_day_opus: {utilization: 7, resets_at: '2026-10-03T17:59:59Z'},
  seven_day_sonnet: null,
};
const inAnHour = () => new Date(Date.now() + 3600000).toISOString();
const anHourAgo = () => new Date(Date.now() - 3600000).toISOString();
const validLogin = () => ({'claude-a.json': {type: 'claude', access_token: CLAUDE_TOKEN, expired: inAnHour()}});
const claudeCalls = calls => calls.filter(call => String(call.url) === CLAUDE_URL);

// Fake fetch that answers the Claude endpoint with `claude` and everything else with the Go payload.
function routedFetch(claude = () => ok(CLAUDE_PAYLOAD)) {
  return stubFetch(url => (String(url) === CLAUDE_URL ? claude() : ok(GO_PAYLOAD)));
}

// Builds a folder of Claude login files plus a settings file pointing at it (or at
// `target({dir, logins})`), runs the test, then restores the hermetic default and cleans up.
async function withClaude(files, run, {target, settingsText} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-claude-'));
  const logins = join(dir, 'auth');
  mkdirSync(logins);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(logins, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  const settings = join(dir, 'settings.json');
  const credentialPath = target ? target({dir, logins}) : logins;
  const text = typeof settingsText === 'function' ? settingsText({dir, logins}) : settingsText;
  writeFileSync(settings, text ?? JSON.stringify({anthropic: {credentialPath}}));
  process.env.OPENCODE_TELEMETRY_SETTINGS = settings;
  try {
    return await run({dir, logins, settings});
  } finally {
    process.env.OPENCODE_TELEMETRY_SETTINGS = NO_SETTINGS;
    rmSync(dir, {recursive: true, force: true});
  }
}

const anthropicOf = snapshot => snapshot.providers.find(provider => provider.provider === 'anthropic');

test('the settings path honours its override and otherwise lives beside OpenCode\'s config', () => {
  assert.equal(settingsPath({OPENCODE_TELEMETRY_SETTINGS: 'C:/custom/settings.json'}), 'C:/custom/settings.json');
  assert.match(settingsPath({}), /local-telemetry\.json$/);
});

test('Anthropic is left out until a Claude login is configured, and nothing is contacted', async () => {
  const calls = routedFetch();
  const snapshot = await (await handlerFor(fakeContext()))({});
  assert.deepEqual(snapshot.providers.map(provider => provider.provider), ['opencode-go', 'openai']);
  assert.equal(claudeCalls(calls).length, 0);
});

test('a configured Claude login is read from its file, never from the OpenCode connection', async () => {
  await withClaude(validLogin(), async () => {
    const calls = routedFetch();
    // OpenCode's own Anthropic connection holds only a local proxy key; it must never reach Anthropic.
    const snapshot = await (await handlerFor(fakeContext({credential: {type: 'key', key: 'local-proxy-key-Z9'}})))({});
    assert.deepEqual(snapshot.providers.map(provider => provider.provider), ['opencode-go', 'openai', 'anthropic']);
    const claude = anthropicOf(snapshot);
    assert.equal(claude.state, 'quota');
    assert.equal(claude.windows.fiveHour.used, 41);
    assert.equal(claude.windows.weekly.used, 13);
    assert.equal(claude.windows.weeklyOpus.used, 7);
    assert.equal(claude.windows.weeklySonnet, null);
    assert.equal(claude.windows.monthly, null);
    assert.equal(claude.refreshMs, 300000, 'the panel needs the refresh cadence to judge staleness');

    assert.equal(claudeCalls(calls).length, 1);
    const {headers, redirect} = claudeCalls(calls)[0].init;
    assert.equal(headers.Authorization, `Bearer ${CLAUDE_TOKEN}`);
    assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(headers['ChatGPT-Account-Id'], undefined);
    assert.equal(redirect, 'error');
    for (const call of calls.filter(call => String(call.url) !== CLAUDE_URL)) {
      assert.ok(!JSON.stringify(call.init).includes(CLAUDE_TOKEN), 'the Claude token must go nowhere but Anthropic');
    }
    assert.ok(!JSON.stringify(claudeCalls(calls)).includes('local-proxy-key-Z9'), 'the proxy key must not be sent to Anthropic');
    assert.ok(!JSON.stringify(snapshot).includes(CLAUDE_TOKEN), 'the token must not appear in the response');
  });
});

test('Anthropic readings are cached for five minutes', async () => {
  await withClaude(validLogin(), async () => {
    const calls = routedFetch();
    const handler = await handlerFor(fakeContext());
    await handler({});
    await handler({});
    assert.equal(claudeCalls(calls).length, 1);
  });
});

test('an expired Claude login makes no request and says why', async () => {
  await withClaude({'claude-a.json': {type: 'claude', access_token: CLAUDE_TOKEN, expired: anHourAgo()}}, async () => {
    const calls = routedFetch();
    const claude = anthropicOf(await (await handlerFor(fakeContext()))({}));
    assert.equal(claude.state, 'unauthorized');
    assert.match(claude.message, /expired/);
    assert.equal(claude.windows.fiveHour, null);
    assert.equal(claudeCalls(calls).length, 0);
    assert.ok(!JSON.stringify(claude).includes(CLAUDE_TOKEN));
  });
});

test('a missing Claude login is reported, not guessed', async () => {
  await withClaude({}, async () => {
    const calls = routedFetch();
    const claude = anthropicOf(await (await handlerFor(fakeContext()))({}));
    assert.equal(claude.state, 'unauthorized');
    assert.match(claude.message, /No Claude login file/);
    assert.equal(claudeCalls(calls).length, 0);
  });
  await withClaude(validLogin(), async () => {
    routedFetch();
    const claude = anthropicOf(await (await handlerFor(fakeContext()))({}));
    assert.match(claude.message, /not found/);
  }, {target: ({dir}) => join(dir, 'nowhere')});
});

test('the newest usable Claude login in the folder wins, and an expired newer one is skipped', async () => {
  const two = () => ({
    'claude-old.json': {type: 'claude', access_token: 'tok-older-A', expired: inAnHour()},
    'claude-new.json': {type: 'claude', access_token: 'tok-newer-B', expired: inAnHour()},
    'notes.json': {type: 'claude', access_token: 'tok-ignored-C', expired: inAnHour()},
  });
  const age = (logins, name, ms) => utimesSync(join(logins, name), new Date(Date.now() - ms), new Date(Date.now() - ms));
  await withClaude(two(), async ({logins}) => {
    age(logins, 'claude-old.json', 120000);
    age(logins, 'claude-new.json', 1000);
    const calls = routedFetch();
    await (await handlerFor(fakeContext()))({});
    assert.equal(claudeCalls(calls)[0].init.headers.Authorization, 'Bearer tok-newer-B');
  });
  await withClaude(two(), async ({logins}) => {
    writeFileSync(join(logins, 'claude-new.json'), JSON.stringify({type: 'claude', access_token: 'tok-newer-B', expired: anHourAgo()}));
    age(logins, 'claude-old.json', 120000);
    age(logins, 'claude-new.json', 1000);
    const calls = routedFetch();
    await (await handlerFor(fakeContext()))({});
    assert.equal(claudeCalls(calls)[0].init.headers.Authorization, 'Bearer tok-older-A');
  });
});

test('a Claude Code credentials file can be named directly', async () => {
  const files = {'credentials.json': {claudeAiOauth: {accessToken: 'tok-code-D', expiresAt: Date.now() + 3600000}}};
  await withClaude(files, async () => {
    const calls = routedFetch();
    const claude = anthropicOf(await (await handlerFor(fakeContext()))({}));
    assert.equal(claude.state, 'quota');
    assert.equal(claudeCalls(calls)[0].init.headers.Authorization, 'Bearer tok-code-D');
  }, {target: ({logins}) => join(logins, 'credentials.json')});
});

test('a rate-limited Anthropic read keeps the last reading and backs off', async () => {
  await withClaude(validLogin(), async () => {
    let limited = false;
    const calls = routedFetch(() => (limited
      ? {ok: false, status: 429, headers: {get: name => (name === 'retry-after' ? '120' : null)}, text: async () => 'slow down'}
      : ok(CLAUDE_PAYLOAD)));
    // anthropicCacheMs 0 makes every call eligible to refresh, so only the back-off can stop one.
    const handler = await handlerFor(fakeContext({options: {anthropicCacheMs: 0}}));
    await handler({});
    limited = true;
    const second = anthropicOf(await handler({}));
    assert.equal(second.state, 'stale');
    assert.equal(second.windows.fiveHour.used, 41, 'the last good reading is preserved');
    const before = claudeCalls(calls).length;
    const third = anthropicOf(await handler({}));
    assert.equal(claudeCalls(calls).length, before, 'no retry inside the back-off window');
    assert.equal(third.state, 'stale');
  });
});

test('Anthropic errors are fixed messages, never the provider body', async () => {
  await withClaude(validLogin(), async () => {
    routedFetch(() => ({ok: false, status: 401, text: async () => `Bearer ${CLAUDE_TOKEN} rejected`}));
    const claude = anthropicOf(await (await handlerFor(fakeContext({options: {anthropicCacheMs: 0}})))({}));
    assert.equal(claude.state, 'unauthorized');
    assert.equal(claude.message, 'Usage request returned HTTP 401');
    assert.ok(!JSON.stringify(claude).includes(CLAUDE_TOKEN));
    assert.equal(claude.windows.fiveHour, null);
  });
});

test('a login file that becomes unreadable keeps the last reading, labelled stale', async () => {
  await withClaude(validLogin(), async ({logins}) => {
    routedFetch();
    const handler = await handlerFor(fakeContext({options: {anthropicCacheMs: 0}}));
    await handler({});
    writeFileSync(join(logins, 'claude-a.json'), '{not json');
    const claude = anthropicOf(await handler({}));
    assert.equal(claude.state, 'stale');
    assert.equal(claude.windows.fiveHour.used, 41);
    assert.match(claude.message, /not usable/);
  });
});

test('a settings file that is not valid JSON is reported, and a BOM does not break a valid one', async () => {
  await withClaude({}, async () => {
    routedFetch();
    const claude = anthropicOf(await (await handlerFor(fakeContext()))({}));
    assert.equal(claude.state, 'unsupported');
    assert.match(claude.message, /Telemetry settings/);
  }, {settingsText: '{oops'});
  await withClaude(validLogin(), async () => {
    routedFetch();
    const claude = anthropicOf(await (await handlerFor(fakeContext()))({}));
    assert.equal(claude.state, 'quota');
  }, {settingsText: ({logins}) => `\uFEFF${JSON.stringify({anthropic: {credentialPath: logins}})}`});
  // A settings file with no anthropic entry leaves the provider out.
  await withClaude({}, async () => {
    routedFetch();
    const snapshot = await (await handlerFor(fakeContext()))({});
    assert.equal(anthropicOf(snapshot), undefined);
  }, {settingsText: '{"other": true}'});
});

test('search reports an honest error for a database that does not exist', async () => {
  const previous = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = join(tmpdir(), 'telemetry-missing-db', 'opencode.db');
  try {
    const context = fakeContext();
    await plugin.setup(context);
    const response = await context.registered[0].handlers.search({query: 'x'});
    assert.deepEqual(response.results, []);
    assert.match(response.error, /not found/);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previous;
  }
});
