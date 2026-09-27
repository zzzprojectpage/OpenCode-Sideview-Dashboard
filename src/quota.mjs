const percent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
function windowValue(used, reset) {
  if (!percent(used) || !reset || !Number.isFinite(Date.parse(reset))) return null;
  return {used, remaining:100-used, reset:new Date(reset).toISOString()};
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
  return {provider,state:Object.values(windows).some(Boolean)?'quota':'unsupported',windows,checked:now};
}
