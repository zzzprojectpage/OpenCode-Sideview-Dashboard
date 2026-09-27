// End-to-end search against a real SQLite file: the production SQL, the real
// node:sqlite driver, and the fixture's awkward rows (quotes, wildcards,
// duplicates, malformed JSON). The user's own database is never touched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {buildSearchFixture} from './fixture-db.mjs';
import {searchMessages, sqliteAdapter} from '../src/search.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-search-'));
  const path = join(dir, 'opencode.db');
  buildSearchFixture(path);
  return {dir, path};
}

function adapterFor(path) {
  const db = new DatabaseSync(path, {readOnly: true});
  return {db, adapter: sqliteAdapter({all: (sql, params = []) => db.prepare(sql).all(...params)})};
}

test('the real SQL finds both roles, newest first, and skips everything else', async () => {
  const {dir, path} = fixture();
  try {
    const {db, adapter} = adapterFor(path);
    const {results, scanned, total, truncated} = await searchMessages(adapter, {query: 'rate limit', limit: 10});
    assert.equal(total, 2);
    assert.equal(scanned, 2);
    assert.equal(truncated, false);
    const ids = results.map(item => item.messageID);
    assert.deepEqual(ids, ['msg_3', 'msg_2', 'msg_1'], 'newest message first within the newest session');
    assert.ok(!ids.includes('msg_4'), 'synthetic/system rows are never searched');
    assert.ok(!ids.includes('msg_7'), 'identical text dedupes to one hit per role');
    assert.ok(!ids.includes('msg_8'), 'malformed JSON is skipped, not fatal');
    assert.equal(results[0].sessionID, 'ses_new');
    assert.equal(results[0].title, 'Rate limits in the proxy');
    assert.equal(results[0].role, 'assistant');
    assert.ok(results[0].snippet.includes('rate limit'));
    db.close();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('LIKE wildcards in a query are literal, never wildcards', async () => {
  const {dir, path} = fixture();
  try {
    const {db, adapter} = adapterFor(path);
    const underscore = await searchMessages(adapter, {query: 'rate_limit'});
    assert.deepEqual(underscore.results.map(item => item.messageID), ['msg_5'],
      'an underscore must not match the space in other rows');
    const percent = await searchMessages(adapter, {query: '50%'});
    assert.deepEqual(percent.results.map(item => item.messageID).sort(), ['msg_5', 'msg_6']);
    db.close();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('database-backed search pages preserve ordering and indicate the final page', async () => {
  const {dir, path} = fixture();
  try {
    const {db, adapter} = adapterFor(path);
    const first = await searchMessages(adapter, {query: 'rate limit', limit: 2, page: 1});
    const second = await searchMessages(adapter, {query: 'rate limit', limit: 2, page: 2});
    assert.deepEqual(first.results.map(item => item.messageID), ['msg_3', 'msg_2']);
    assert.deepEqual(second.results.map(item => item.messageID), ['msg_1']);
    assert.equal(first.hasMore, true);
    assert.equal(second.hasMore, false);
    db.close();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a query containing quotes still matches through the exact text matcher', async () => {
  const {dir, path} = fixture();
  try {
    const {db, adapter} = adapterFor(path);
    const quoted = await searchMessages(adapter, {query: '"rate limit"'});
    assert.deepEqual(quoted.results.map(item => item.messageID), ['msg_3']);
    db.close();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('role toggles restrict the search; an empty query lists recent messages', async () => {
  const {dir, path} = fixture();
  try {
    const {db, adapter} = adapterFor(path);
    const users = await searchMessages(adapter, {query: 'rate', roles: ['user']});
    assert.ok(users.results.length > 0);
    assert.ok(users.results.every(item => item.role === 'user'));
    assert.ok(users.results.some(item => item.messageID === 'msg_1'));

    const recent = await searchMessages(adapter, {query: '', limit: 2});
    assert.deepEqual(recent.results.map(item => item.messageID), ['msg_3', 'msg_2']);
    db.close();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a read-only connection refuses writes, so search can never change history', () => {
  const {dir, path} = fixture();
  try {
    const db = new DatabaseSync(path, {readOnly: true});
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_v2').get().n, 2);
    assert.throws(() => db.exec("INSERT INTO session_v2 (id) VALUES ('x')"), /readonly|read-only|SQLITE_READONLY/i);
    db.close();
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
