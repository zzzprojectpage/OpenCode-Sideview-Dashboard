// OpenCode Go / OpenAI subscription-quota source for the telemetry sidebar.
//
// Deliberately dependency-free: `Plugin.define` is an identity function and `Rpc.define`
// only validates reserved error names, so the plain object shapes below are equivalent.
// That means this plugin loads without `npm install` anywhere, which matters for anyone
// who drops it into ~/.config/opencode/plugins/.
//
// Secrets stay in this process. Credentials are read through the plugin context, sent
// only to the provider's own usage endpoint, and never returned over the RPC; the sidebar
// receives percentages and reset times only.
import { createHash } from 'node:crypto';
import { normalizeQuota } from './src/quota.mjs';

const RPC_ID = 'local.telemetry';
const PROVIDERS = ['opencode-go', 'openai'];
const CACHE_MS = 60000;
const TIMEOUT_MS = 10000;

const USAGE_URLS = {
  'opencode-go': 'https://opencode.ai/zen/go/v1/usage',
  'openai': 'https://chatgpt.com/backend-api/wham/usage',
};

// Plain object contract: the same shape Rpc.define would return unchanged.
const contract = {
  id: RPC_ID,
  methods: {
    snapshot: {
      input: { type: 'object', additionalProperties: false },
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

export default {
  id: RPC_ID,
  async setup(ctx) {
    // Options are optional; defaults suit normal use. Tests set cacheMs to force refreshes.
    const cacheMs = Number.isFinite(ctx?.options?.cacheMs) ? ctx.options.cacheMs : CACHE_MS;
    const timeoutMs = Number.isFinite(ctx?.options?.timeoutMs) ? ctx.options.timeoutMs : TIMEOUT_MS;
    const cache = new Map();
    const inFlight = new Map();

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

        // Cache is scoped to the exact credential, so switching accounts never reuses a reading.
        const key = `${provider}:${createHash('sha256').update(token).digest('hex')}`;
        const previous = cache.get(key);
        if (previous && Date.now() - previous.at < cacheMs) return previous.value;
        if (inFlight.has(key)) return inFlight.get(key);

        const job = (async () => {
          try {
            const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
            if (provider === 'openai') {
              const accountId = accountIdFrom(token);
              if (accountId) headers['ChatGPT-Account-Id'] = accountId;
            }
            const response = await fetch(USAGE_URLS[provider], {
              headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) {
              const state = [401, 403].includes(response.status) ? 'unauthorized' : 'status-only';
              throw { state, message: `Usage request returned HTTP ${response.status}` };
            }
            const value = normalizeQuota(provider, await response.json());
            cache.set(key, { at: Date.now(), value });
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
            cache.set(key, { at: Date.now(), value });
            return value;
          } finally {
            inFlight.delete(key);
          }
        })();
        inFlight.set(key, job);
        return job;
      } catch {
        return unavailable(provider, 'unauthorized', 'Cannot resolve active connection');
      }
    }

    await ctx.rpc.register(contract, {
      snapshot: async () => ({ providers: await Promise.all(PROVIDERS.map(quota)) }),
    });
  },
};
