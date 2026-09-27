import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeQuota} from '../src/quota.mjs';
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
