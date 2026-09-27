import {test} from 'node:test';
import assert from 'node:assert/strict';
import {summarize} from '../src/metrics.mjs';
import {formatCost} from '../src/sidebar.mjs';

const enUS2 = new Intl.NumberFormat('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}).format;

test('session cost is reported and never invented', () => {
  assert.equal(summarize([], [], [], {cost: 0.29576529}).sessionCost, 0.29576529);
  assert.equal(summarize([], [], [], {cost: 0}).sessionCost, 0);
  assert.equal(summarize([], [], []).sessionCost, null, 'absent session means no cost claim');
  assert.equal(summarize([], [], [], {cost: null}).sessionCost, null);
  assert.equal(summarize([], [], [], {cost: 'free'}).sessionCost, null);
  assert.equal(summarize([], [], [], {cost: -1}).sessionCost, null);
  assert.equal(summarize([], [], [], {cost: NaN}).sessionCost, null);
});

test('the token metrics keep working alongside the cost', () => {
  const messages = [{id:'a', type:'assistant', model:{providerID:'openai',id:'test'},
    time:{created:1,streamed:2,completed:4}, content:[],
    tokens:{input:100,output:40,reasoning:10,cache:{read:300,write:100}}}];
  const result = summarize(messages, [{providerID:'openai',id:'test',limit:{context:1000}}], [], {cost: 1.5});
  assert.equal(result.cachePercent, 60);
  assert.equal(result.sessionCost, 1.5);
});

test('cost is rendered as dollars without pretending a tiny amount is zero', () => {
  assert.equal(formatCost(0.29576529, enUS2), '$0.30');
  assert.equal(formatCost(0, enUS2), '$0.00');
  assert.equal(formatCost(0.009, enUS2), '<$0.01', 'a real cost must not read as zero');
  assert.equal(formatCost(0.0000001, enUS2), '<$0.01');
  assert.equal(formatCost(0.01, enUS2), '$0.01');
  assert.equal(formatCost(12.5, enUS2), '$12.50');
  for (const value of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(formatCost(value, enUS2), 'Unavailable', String(value));
  }
});

test('money uses a dot separator regardless of the machine locale', () => {
  assert.equal(formatCost(0.3), '$0.30', 'must match the app-owned cost readout');
  assert.equal(formatCost(1234.5), '$1,234.50');
});
