// Behavioural tests for the quota plugin, run against a fake plugin context.
// Node imports the .ts source directly, so these test the shipping file.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import plugin from '../index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'index.ts'), 'utf8');

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
