import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitWindow, WINDOW_MS, windowStart} from '../src/attribution.mjs';

const go = (id, cost, tokens) => ({model: {providerID: 'opencode-go', id}, cost, tokens});
const other = (providerID, id, cost) => ({model: {providerID, id}, cost, tokens: {input: 10}});

test('each Go model gets its share of the reported window total', () => {
  const models = [go('deepseek-v4.1-flash', 0.75, {input: 100}), go('glm-5.3-flash', 0.25, {input: 50})];
  const split = splitWindow(models, 8);
  assert.deepEqual(split.rows.map(r => [r.id, r.sharePercent]), [['deepseek-v4.1-flash', 6], ['glm-5.3-flash', 2]]);
  assert.equal(split.unattributedPercent, 0);
  assert.equal(split.basis, 'cost');
});

test('models from other providers never dilute the Go split', () => {
  const models = [go('deepseek-v4.1-flash', 1), other('google', 'gemini-3.8-flash', 9), other('openai', 'gpt-6-luna', 4)];
  const split = splitWindow(models, 10);
  assert.deepEqual(split.rows.map(r => r.id), ['deepseek-v4.1-flash']);
  assert.equal(split.rows[0].sharePercent, 10, 'the whole reported total belongs to the one Go model');
});

test('free Go models are listed without stealing share from billed ones', () => {
  const models = [go('deepseek-v4.1-flash', 2, {input: 100}), go('space-bunny-free', 0, {input: 900})];
  const split = splitWindow(models, 4);
  const free = split.rows.find(r => r.id === 'space-bunny-free');
  assert.equal(free.sharePercent, 0);
  assert.equal(free.billable, false);
  assert.equal(free.tokens, 900);
  assert.equal(split.rows.find(r => r.id === 'deepseek-v4.1-flash').sharePercent, 4);
});

test('with no way to apportion, no percentage is invented', () => {
  assert.deepEqual(splitWindow([], 5).rows, []);
  assert.equal(splitWindow([], 5).note, 'No OpenCode Go usage recorded in this window');
  const freeOnly = splitWindow([go('space-bunny-free', 0, {input: 5})], 5);
  assert.equal(freeOnly.basis, null);
  assert.ok(freeOnly.rows.every(r => r.sharePercent === null));
  assert.match(freeOnly.note, /no billable usage recorded/i);
  const noTotal = splitWindow([go('gpt-5.6-luna', 1, {input: 5})], null);
  assert.equal(noTotal.rows[0].sharePercent, null);
  assert.match(noTotal.note, /window total unavailable/i);
});

test('a model reported more than once is merged into a single row', () => {
  const models = [go('gpt-5.6-luna', 1, {input: 10}), go('gpt-5.6-luna', 3, {input: 90})];
  const split = splitWindow(models, 8);
  assert.equal(split.rows.length, 1, 'one row per model, not one per reporting entry');
  assert.equal(split.rows[0].cost, 4);
  assert.equal(split.rows[0].tokens, 100);
  assert.equal(split.rows[0].sharePercent, 8);
});

test('a window start is derived from the provider reset time', () => {
  const reset = '2026-09-27T10:45:20.464Z';
  assert.equal(windowStart('fiveHour', reset), Date.parse(reset) - WINDOW_MS.fiveHour);
  assert.equal(windowStart('weekly', reset), Date.parse(reset) - WINDOW_MS.weekly);
  assert.equal(windowStart('monthly', reset), Date.parse(reset) - WINDOW_MS.monthly);
  assert.equal(windowStart('fiveHour', null), null);
  assert.equal(windowStart('fiveHour', 'not a date'), null);
});
