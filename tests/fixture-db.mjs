// A throwaway copy of the two production tables the search core reads
// (session_v2 + session_message), so search tests run the real SQL against a real
// SQLite file without touching the user's database.
import { DatabaseSync } from 'node:sqlite';

export function buildSearchFixture(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER);
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `);
  const session = db.prepare('INSERT INTO session_v2 (id, title, directory, time_updated) VALUES (?,?,?,?)');
  const message = db.prepare('INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)');
  session.run('ses_new', 'Rate limits in the proxy', 'C:/work/proxy', 5000);
  session.run('ses_old', 'Chart colours', 'C:/work/charts', 1000);
  message.run('msg_1', 'ses_new', 'user', 1, 4000, 4000,
    JSON.stringify({ time: { created: 4000 }, text: 'Please add rate limit handling to the proxy' }));
  message.run('msg_2', 'ses_new', 'assistant', 2, 4100, 4100,
    JSON.stringify({ time: { created: 4100 }, content: [
      { type: 'reasoning', text: 'consider rate limits carefully' },
      { type: 'text', text: 'Added a rate limiter. It also handles bursty traffic.' },
      { type: 'tool', name: 'edit' },
    ] }));
  // Quotes and a backslash: the JSON encoding differs from the typed text, so this row
  // can only be found by the exact matcher (the SQL prefilter is skipped for such queries).
  message.run('msg_3', 'ses_new', 'assistant', 3, 4200, 4200,
    JSON.stringify({ content: [{ type: 'text', text: 'He said "rate limit" with quotes and a \\ backslash' }] }));
  message.run('msg_4', 'ses_new', 'synthetic', 4, 4300, 4300,
    JSON.stringify({ text: 'rate limit system message that must never match' }));
  message.run('msg_5', 'ses_old', 'user', 1, 900, 900,
    JSON.stringify({ text: '50% rate_limit notes' }));
  message.run('msg_6', 'ses_old', 'assistant', 2, 950, 950,
    JSON.stringify({ content: [{ type: 'text', text: 'The chart uses 50% shading.' }] }));
  message.run('msg_7', 'ses_new', 'user', 5, 3950, 3950,
    JSON.stringify({ text: 'Please add rate limit handling to the proxy' })); // duplicate of msg_1
  message.run('msg_8', 'ses_new', 'assistant', 6, 4400, 4400, '{not valid json');
  db.close();
  return path;
}
