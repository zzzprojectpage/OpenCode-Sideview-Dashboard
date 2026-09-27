// Pure-behaviour tests for the search core: input normalisation, JSON shapes,
// the raw-JSON prefilter decision, snippet shaping and the session walk.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LIMIT, MAX_LIMIT, ROLES,
  normalizeSearchInput, likePattern, messageTexts, snippetFor, contextFor,
  sqliteAdapter, searchMessages,
} from '../src/search.mjs';

test('input normalisation trims, defaults roles and clamps the limit', () => {
  assert.deepEqual(normalizeSearchInput({query: '  rate limit  '}),
    {query: 'rate limit', roles: [...ROLES], limit: DEFAULT_LIMIT, page: 1});
  assert.deepEqual(normalizeSearchInput({query: 'x', roles: ['assistant']}),
    {query: 'x', roles: ['assistant'], limit: DEFAULT_LIMIT, page: 1});
  assert.deepEqual(normalizeSearchInput({query: 'x', roles: ['nope', 'user']}).roles, ['user']);
  assert.deepEqual(normalizeSearchInput({query: 'x', roles: []}).roles, [...ROLES]);
  assert.equal(normalizeSearchInput({query: 'x', limit: 5000}).limit, MAX_LIMIT);
  assert.equal(normalizeSearchInput({query: 'x', limit: 0}).limit, 1);
  assert.equal(normalizeSearchInput({query: 'x', page: 3}).page, 3);
  assert.equal(normalizeSearchInput({query: 'x', page: 0}).page, 1);
  assert.equal(normalizeSearchInput({}).query, '');
  assert.equal(normalizeSearchInput(undefined).query, '');
});

test('the SQL prefilter is skipped where raw JSON could differ from the typed query', () => {
  assert.equal(likePattern(''), null);
  assert.equal(likePattern('rate'), '%rate%');
  assert.equal(likePattern('50%'), '%50\\%%');
  assert.equal(likePattern('rate_limit'), '%rate\\_limit%');
  assert.equal(likePattern('say "hi"'), null, 'JSON escapes quotes');
  assert.equal(likePattern('back\\slash'), null, 'JSON escapes backslashes');
  assert.equal(likePattern('café'), null, 'LIKE lowercases ASCII only');
});

test('message text extraction follows the two production shapes', () => {
  assert.deepEqual(messageTexts('user', JSON.stringify({text: 'hello'})), ['hello']);
  assert.deepEqual(messageTexts('user', JSON.stringify({content: [{type: 'text', text: 'nope'}]})), []);
  assert.deepEqual(messageTexts('assistant', JSON.stringify({content: [
    {type: 'reasoning', text: 'hidden'}, {type: 'text', text: 'shown'},
    {type: 'text', text: ''}, {type: 'tool', name: 'edit'}, null,
  ]})), ['shown']);
  assert.deepEqual(messageTexts('assistant', '{broken'), []);
  assert.deepEqual(messageTexts('assistant', 'null'), []);
});

test('snippets centre on the match and clip long text', () => {
  const long = `${'a'.repeat(150)} needle ${'b'.repeat(150)}`;
  const snippet = snippetFor(long, 'needle');
  assert.ok(snippet.startsWith('…a'));
  assert.ok(snippet.endsWith('b…'));
  assert.equal(snippetFor('short text', 'missing'), 'short text');
  assert.equal(snippetFor('  lots\n of\tspace ', ''), 'lots of space');
  const clipped = snippetFor('x'.repeat(300), '');
  assert.equal(clipped.length, 218, '217 characters plus the ellipsis');
  assert.ok(clipped.endsWith('…'));
  assert.equal(contextFor('a needle b', 'needle'), 'a needle b');
  assert.equal(contextFor('y'.repeat(900), '').length, 598);
});

function hit(id, role, text, time) {
  return {
    id, role, timeCreated: time,
    data: role === 'user'
      ? JSON.stringify({text})
      : JSON.stringify({content: [{type: 'text', text}]}),
  };
}

function fakeAdapter({sessions, rowsFor}) {
  return {
    listSessions: () => sessions,
    candidates: (sessionID, query, roles) => (rowsFor[sessionID] ?? []).filter(row => roles.includes(row.role)),
  };
}

test('search walks sessions newest-first and stops at the limit', async () => {
  const sessions = [
    {id: 'ses_new', title: 'Newer', directory: 'C:/new', timeUpdated: 200},
    {id: 'ses_old', title: 'Older', directory: 'C:/old', timeUpdated: 100},
  ];
  const rowsFor = {
    ses_new: [hit('m1', 'user', 'alpha beta', 10), hit('m2', 'assistant', 'beta gamma', 11)],
    ses_old: [hit('m3', 'user', 'alpha delta', 1)],
  };
  const result = await searchMessages(fakeAdapter({sessions, rowsFor}), {query: 'alpha', limit: 2});
  assert.equal(result.total, 2);
  assert.equal(result.scanned, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.results.map(item => item.messageID), ['m1', 'm3']);
  assert.equal(result.results[0].title, 'Newer');
  assert.ok(result.results[0].snippet.includes('alpha'));
  assert.equal(result.results[0].directory, 'C:/new');
});

test('search returns numbered pages across all matching messages and reports whether another page exists', async () => {
  const sessions = [{id: 's', title: 'All results', directory: 'C:/all', timeUpdated: 1}];
  const rowsFor = {s: Array.from({length: 5}, (_, index) =>
    hit(`m${index + 1}`, 'user', `matching result ${index + 1}`, 5 - index))};
  const adapter = fakeAdapter({sessions, rowsFor});

  const first = await searchMessages(adapter, {query: 'matching', limit: 2, page: 1});
  const second = await searchMessages(adapter, {query: 'matching', limit: 2, page: 2});
  const third = await searchMessages(adapter, {query: 'matching', limit: 2, page: 3});
  assert.deepEqual(first.results.map(item => item.messageID), ['m1', 'm2']);
  assert.deepEqual(second.results.map(item => item.messageID), ['m3', 'm4']);
  assert.deepEqual(third.results.map(item => item.messageID), ['m5']);
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, true);
  assert.equal(third.hasMore, false);
  assert.equal(third.page, 3);
});

test('deduplication is per session, role and opening bytes', async () => {
  const sessions = [{id: 's', title: 't', directory: '', timeUpdated: 1}];
  const rowsFor = {s: [
    hit('a', 'user', 'duplicate text here', 3),
    hit('b', 'user', 'duplicate text here', 2),
    hit('c', 'assistant', 'duplicate text here', 1),
  ]};
  const {results} = await searchMessages(fakeAdapter({sessions, rowsFor}), {query: 'duplicate'});
  assert.deepEqual(results.map(item => item.messageID), ['a', 'c']);
});

test('roles reach the adapter and matching is case-insensitive', async () => {
  const sessions = [{id: 's', title: 't', directory: '', timeUpdated: 1}];
  const rowsFor = {s: [hit('u', 'user', 'Mixed CASE word', 2), hit('a', 'assistant', 'mixed case word', 1)]};
  const {results} = await searchMessages(fakeAdapter({sessions, rowsFor}), {query: 'mixed case', roles: ['assistant']});
  assert.deepEqual(results.map(item => item.messageID), ['a']);
});

test('the scan yields between sessions and stops on the time budget', async () => {
  const sessions = [1, 2].map(id => ({id: `s${id}`, title: `t${id}`, directory: '', timeUpdated: id}));
  const rowsFor = {s1: [hit('m1', 'user', 'one', 1)], s2: [hit('m2', 'user', 'two', 1)]};
  let pauses = 0;
  const full = await searchMessages(fakeAdapter({sessions, rowsFor}), {query: ''}, {pause: async () => { pauses += 1; }});
  assert.equal(pauses, 2, 'a completed walk yields once per session');
  assert.equal(full.results.length, 2);

  const clock = [0, 0, 9000];
  const now = () => (clock.length ? clock.shift() : 9000);
  const bounded = await searchMessages(fakeAdapter({sessions, rowsFor}), {query: ''}, {budgetMs: 8000, now});
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.scanned, 1);
  assert.equal(bounded.results.length, 1);
});

test('an aborted signal returns what was found so far, flagged truncated', async () => {
  const sessions = [{id: 's', title: 't', directory: '', timeUpdated: 1}];
  const {results, truncated, scanned} = await searchMessages(
    fakeAdapter({sessions, rowsFor: {s: []}}), {query: ''}, {signal: AbortSignal.abort()});
  assert.deepEqual(results, []);
  assert.equal(truncated, true);
  assert.equal(scanned, 0);
});

test('no sessions is an empty, untruncated result', async () => {
  const result = await searchMessages(fakeAdapter({sessions: [], rowsFor: {}}), {query: 'x'});
  assert.deepEqual(result.results, []);
  assert.equal(result.total, 0);
  assert.equal(result.truncated, false);
});

test('the sqlite adapter filters by session, roles and a LIKE-escaped prefilter', () => {
  const calls = [];
  const adapter = sqliteAdapter({all: (sql, params) => { calls.push({sql, params}); return []; }});
  adapter.listSessions();
  assert.match(calls[0].sql, /FROM session_v2/);
  assert.match(calls[0].sql, /ORDER BY time_updated DESC/);
  adapter.candidates('ses_1', 'rate limit', ['user', 'assistant']);
  const query = calls[1];
  assert.match(query.sql, /sm\.session_id = \? AND sm\.type IN \(\?, \?\)/);
  assert.match(query.sql, /LIKE \? ESCAPE '\\'/);
  assert.match(query.sql, /ORDER BY sm\.time_created DESC, sm\.seq DESC/);
  assert.deepEqual(query.params, ['ses_1', 'user', 'assistant', '%rate limit%']);
  adapter.candidates('ses_1', '', ['user']);
  assert.doesNotMatch(calls[2].sql, /LIKE/);
  assert.deepEqual(calls[2].params, ['ses_1', 'user']);
});
