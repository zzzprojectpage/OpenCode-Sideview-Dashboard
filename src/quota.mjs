const percent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
function windowValue(used, reset) {
  if (!percent(used) || !reset || !Number.isFinite(Date.parse(reset))) return null;
  return {used, remaining:100-used, reset:new Date(reset).toISOString()};
}
// Anthropic sends timestamps with microseconds; pad or trim the fraction to milliseconds so
// every JavaScript engine (the desktop server runs on Bun) parses them the same way.
const isoTime = value => typeof value === 'string' ? value.replace(/\.(\d+)/, (_, digits) => `.${digits.slice(0,3).padEnd(3,'0')}`) : value;
// An idle 5-hour or weekly window has a usage figure but no reset yet: the window has not
// started. That is real data, so it is kept without a reset. Per-model buckets are stricter,
// because a null there usually means the plan has no such cap, so they need a reset to count.
function anthropicWindow(bucket, allowIdle) {
  if (!bucket || !percent(bucket.utilization)) return null;
  if (allowIdle && bucket.resets_at == null) return {used:bucket.utilization, remaining:100-bucket.utilization, reset:null};
  return windowValue(bucket.utilization, isoTime(bucket.resets_at));
}
export function normalizeQuota(provider, payload, now = Date.now()) {
  const windows = {fiveHour:null,weekly:null,monthly:null};
  if (provider === 'opencode-go') {
    for (const [key,raw] of [['fiveHour','rolling'],['weekly','weekly'],['monthly','monthly']]) {
      const w = payload?.usage?.[raw];
      if (w && ['ok','rate-limited'].includes(w.status) && percent(w.percent))
        windows[key] = windowValue(w.status === 'rate-limited' ? 100 : w.percent, w.resetsAt);
    }
  }
  if (provider === 'openai') {
    const kinds = {18000:'fiveHour',604800:'weekly',2628000:'monthly',2592000:'monthly'};
    const conflicts = new Set();
    for (const w of [payload?.rate_limit?.primary_window,payload?.rate_limit?.secondary_window]) {
      const key = kinds[w?.limit_window_seconds];
      if (!key || conflicts.has(key)) continue;
      const ms = typeof w.reset_at === 'number' ? w.reset_at*1000 : typeof w.reset_after_seconds === 'number' ? now+w.reset_after_seconds*1000 : NaN;
      const v = windowValue(w.used_percent, Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null);
      if (windows[key] && JSON.stringify(windows[key]) !== JSON.stringify(v)) { windows[key]=null; conflicts.add(key); }
      else windows[key]=v;
    }
  }
  if (provider === 'anthropic') {
    // Claude subscriptions have a 5-hour and a weekly window (no monthly one); some plans add a
    // separate weekly cap per model family. Utilization is already a 0-100 percentage.
    windows.fiveHour = anthropicWindow(payload?.five_hour, true);
    windows.weekly = anthropicWindow(payload?.seven_day, true);
    windows.weeklyOpus = anthropicWindow(payload?.seven_day_opus, false);
    windows.weeklySonnet = anthropicWindow(payload?.seven_day_sonnet, false);
  }
  return {provider,state:Object.values(windows).some(Boolean)?'quota':'unsupported',windows,checked:now};
}

// The bearer token from a Claude sign-in file, if that login is still valid. Two layouts are
// understood: CLIProxyAPI's ({type:'claude', access_token, expired}) and Claude Code's
// ({claudeAiOauth:{accessToken, expiresAt}}). Pure: it never reads or writes a file, and the
// only messages it returns are fixed strings, so a token cannot leak through an error.
export function claudeCredential(file, now = Date.now()) {
  const proxy = file && typeof file === 'object' && file.type === 'claude' ? file : null;
  const code = file && typeof file === 'object' && file.claudeAiOauth && typeof file.claudeAiOauth === 'object' ? file.claudeAiOauth : null;
  const token = proxy ? proxy.access_token : code?.accessToken;
  if (typeof token !== 'string' || !token.trim()) return {state:'unauthorized', message:'Claude login file is not usable'};
  let expires = NaN;
  if (proxy) expires = Date.parse(isoTime(proxy.expired));
  else if (Number.isFinite(code.expiresAt)) expires = code.expiresAt >= 1e11 ? code.expiresAt : code.expiresAt * 1000;
  // A token about to lapse counts as expired: better to say so than to fail the request.
  if (Number.isFinite(expires) && expires <= now + 30000) {
    return {state:'unauthorized', message:'Claude login has expired; it renews the next time Claude uses it'};
  }
  return {token:token.trim()};
}
