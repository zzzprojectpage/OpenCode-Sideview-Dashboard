import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeQuota, claudeCredential} from '../src/quota.mjs';
test('Go windows preserve authoritative percentages and reject missing/invalid values', () => {
  const result = normalizeQuota('opencode-go', {usage:{rolling:{status:'ok',percent:25,resetsAt:'2026-09-28T12:00:00Z'},weekly:{status:'ok',percent:NaN},monthly:{status:'ok',percent:null}}});
  assert.equal(result.windows.fiveHour.used,25);
  assert.equal(result.windows.fiveHour.remaining,75);
  assert.equal(result.windows.weekly,null);
  assert.equal(result.windows.monthly,null);
});
test('OpenAI labels windows by their duration, not position, without inventing a monthly cap', () => {
  const result = normalizeQuota('openai',{rate_limit:{
    primary_window:{used_percent:12,limit_window_seconds:604800,reset_at:1790596800},
    secondary_window:{used_percent:8,limit_window_seconds:18000,reset_at:1790596800},
  }});
  assert.equal(result.windows.fiveHour.used,8);
  assert.equal(result.windows.weekly.used,12);
  assert.equal(result.windows.monthly,null);
  assert.equal(normalizeQuota('openai',{}).state,'unsupported');
});

// Response shape of Anthropic's usage endpoint, as documented by the tools that read it.
const CLAUDE_USAGE = {
  five_hour:{utilization:41,resets_at:'2026-09-29T18:59:59.943648+00:00'},
  seven_day:{utilization:13.5,resets_at:'2026-10-03T16:59:59Z'},
  seven_day_opus:{utilization:7,resets_at:'2026-10-03T17:59:59Z'},
  seven_day_sonnet:null,
  extra_usage:{is_enabled:false,monthly_limit:null,used_credits:null,utilization:null},
};
test('Anthropic windows keep the reported percentages and never invent a monthly cap', () => {
  const result = normalizeQuota('anthropic', CLAUDE_USAGE, 1);
  assert.equal(result.state,'quota');
  assert.equal(result.windows.fiveHour.used,41);
  assert.equal(result.windows.fiveHour.remaining,59);
  assert.equal(result.windows.weekly.used,13.5);
  assert.equal(result.windows.weekly.remaining,86.5);
  assert.equal(result.windows.weeklyOpus.used,7);
  assert.equal(result.windows.weeklySonnet,null,'a bucket the plan does not have stays absent');
  assert.equal(result.windows.monthly,null);
  assert.equal(result.checked,1);
});
test('Anthropic timestamps with microseconds parse to the same instant on any engine', () => {
  const result = normalizeQuota('anthropic', CLAUDE_USAGE);
  assert.equal(result.windows.fiveHour.reset,'2026-09-29T18:59:59.943Z');
  assert.equal(result.windows.weekly.reset,'2026-10-03T16:59:59.000Z');
});
test('an idle Anthropic window is real 0% usage, not missing data', () => {
  const result = normalizeQuota('anthropic', {five_hour:{utilization:0,resets_at:null},seven_day:{utilization:22,resets_at:'2026-10-03T16:59:59Z'}});
  assert.deepEqual(result.windows.fiveHour,{used:0,remaining:100,reset:null});
  assert.equal(result.windows.weekly.used,22);
});
test('a per-model Anthropic bucket without a reset is treated as absent, not as 0% used', () => {
  const result = normalizeQuota('anthropic', {five_hour:{utilization:5,resets_at:'2026-09-29T18:00:00Z'},seven_day_opus:{utilization:0,resets_at:null}});
  assert.equal(result.windows.weeklyOpus,null);
});
test('invalid Anthropic values are rejected rather than clamped', () => {
  for (const utilization of [NaN, -1, 100.5, '40', null, undefined, Infinity]) {
    const result = normalizeQuota('anthropic', {five_hour:{utilization,resets_at:'2026-09-29T18:00:00Z'}});
    assert.equal(result.windows.fiveHour,null,String(utilization));
  }
  assert.equal(normalizeQuota('anthropic', {five_hour:{utilization:5,resets_at:'not a date'}}).windows.fiveHour,null);
  assert.equal(normalizeQuota('anthropic', {}).state,'unsupported');
  assert.equal(normalizeQuota('anthropic', null).state,'unsupported');
  assert.equal(normalizeQuota('anthropic', {five_hour:{utilization:100,resets_at:'2026-09-29T18:00:00Z'}}).windows.fiveHour.remaining,0);
});

const NOW = Date.parse('2026-09-29T12:00:00Z');
test('a CLIProxyAPI Claude login yields its bearer token while it is still valid', () => {
  const login = {type:'claude',access_token:' tok-proxy-1 ',refresh_token:'never-read',expired:'2026-09-29T20:03:44+03:00'};
  assert.deepEqual(claudeCredential(login, NOW), {token:'tok-proxy-1'});
});
test('a Claude Code login is understood in milliseconds or seconds', () => {
  const later = NOW + 3600000;
  assert.deepEqual(claudeCredential({claudeAiOauth:{accessToken:'tok-code-1',expiresAt:later}}, NOW), {token:'tok-code-1'});
  assert.deepEqual(claudeCredential({claudeAiOauth:{accessToken:'tok-code-2',expiresAt:Math.floor(later/1000)}}, NOW), {token:'tok-code-2'});
});
test('an expired or nearly expired Claude login is reported, not used', () => {
  for (const login of [
    {type:'claude',access_token:'tok-old',expired:'2026-09-29T11:00:00Z'},
    {type:'claude',access_token:'tok-old',expired:new Date(NOW + 10000).toISOString()},
    {claudeAiOauth:{accessToken:'tok-old',expiresAt:NOW - 1}},
  ]) {
    const result = claudeCredential(login, NOW);
    assert.equal(result.token,undefined);
    assert.equal(result.state,'unauthorized');
    assert.match(result.message,/expired/);
    assert.ok(!JSON.stringify(result).includes('tok-old'),'the token must not appear in the result');
  }
});
test('a file that is not a Claude login is unusable, and says so without echoing it', () => {
  for (const login of [null, undefined, 'text', [], {}, {type:'codex',access_token:'tok-other'}, {type:'claude'}, {type:'claude',access_token:'   '}, {claudeAiOauth:{}}, {claudeAiOauth:{accessToken:42}}]) {
    const result = claudeCredential(login, NOW);
    assert.equal(result.token,undefined);
    assert.equal(result.message,'Claude login file is not usable');
  }
});
