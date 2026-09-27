// Session-history search core for the telemetry sidebar's Search panel.
//
// This runs inside the OpenCode server process (see index.ts). The SQLite
// connection is injected so the plugin can use whichever driver the host runtime
// ships — bun:sqlite in the desktop app's Bun-compiled server, node:sqlite on a
// Node-run server — while this module owns the query shape, the text extraction
// and the result shaping. Everything here is either pure or written against a
// tiny adapter ({all(sql, params)}), so it can be unit-tested without OpenCode,
// a running server, or the real database.
//
// What is searched: the current V2 store. New sessions exist only in
// session_v2/session_message; a user message carries its text in data.text, an
// assistant message carries text items in data.content[]. The migrated legacy
// sessions live in the same tables, so one query path covers all history.
// Reasoning and tool calls are never searched, matching the panel's promise.

export const ROLES = ['user', 'assistant'];
export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;
export const DEFAULT_PAGE = 1;
export const MAX_PAGE = 1000000;
export const DEFAULT_BUDGET_MS = 8000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function normalizeSearchInput(input) {
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  const requested = Array.isArray(input?.roles) ? input.roles : [];
  const roles = ROLES.filter(role => requested.includes(role));
  const limit = Number.isFinite(input?.limit) ? clamp(Math.trunc(input.limit), 1, MAX_LIMIT) : DEFAULT_LIMIT;
  const page = Number.isFinite(input?.page) ? clamp(Math.trunc(input.page), DEFAULT_PAGE, MAX_PAGE) : DEFAULT_PAGE;
  return { query, roles: roles.length > 0 ? roles : [...ROLES], limit, page };
}

// A SQL prefilter on the raw JSON keeps the scan fast for ordinary words. It is
// skipped whenever the JSON-encoded text could differ from the typed query
// (quotes, backslashes, control characters) or SQLite's ASCII-only LIKE lowering
// could disagree with JavaScript's (non-ASCII). The exact matcher decides either
// way, so skipping the prefilter is slower but never wrong.
export function likePattern(query) {
  if (!query) return null;
  if (/[\\"\u0000-\u001f\u007f-\uffff]/.test(query)) return null;
  return `%${query.replace(/[%_]/g, character => `\\${character}`)}%`;
}

export function matches(text, query) {
  return String(text).toLowerCase().includes(String(query).toLowerCase());
}

// Text items of one message row. User messages keep their text directly;
// assistant messages keep it inside content[] items. Malformed JSON never
// throws: the row is simply not searchable.
export function messageTexts(role, data) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  if (role === 'user') return typeof parsed.text === 'string' && parsed.text ? [parsed.text] : [];
  if (!Array.isArray(parsed.content)) return [];
  return parsed.content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string' && part.text)
    .map(part => part.text);
}

const normalizeWhitespace = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 3)}…` : text);

// Center the snippet on the match when there is one, else show the opening text.
export function snippetFor(text, query) {
  const normalized = normalizeWhitespace(text);
  if (!query) return clip(normalized, 220);
  const at = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return clip(normalized, 220);
  const start = Math.max(0, at - 100);
  const end = Math.min(normalized.length, at + query.length + 100);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}

// Wider window used for the hover tooltip on a result.
export function contextFor(text, query) {
  const normalized = normalizeWhitespace(text);
  if (!query) return clip(normalized, 600);
  const at = normalized.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return clip(normalized, 600);
  const start = Math.max(0, at - 300);
  const end = Math.min(normalized.length, at + query.length + 300);
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`;
}

const SESSIONS_SQL = `SELECT id, title, directory, time_updated AS timeUpdated
FROM session_v2
ORDER BY time_updated DESC`;

// Adapter over a minimal {all(sql, params)} database handle. Sessions are read
// newest-first; each session's candidate messages are filtered by the raw-JSON
// prefilter when it is safe, and always ordered newest-first.
export function sqliteAdapter(db) {
  return {
    listSessions() {
      return db.all(SESSIONS_SQL, []);
    },
    candidates(sessionID, query, roles) {
      const marks = roles.map(() => '?').join(', ');
      let sql = `SELECT sm.id AS id, sm.type AS role, sm.time_created AS timeCreated, sm.data AS data
FROM session_message sm
WHERE sm.session_id = ? AND sm.type IN (${marks})`;
      const params = [sessionID, ...roles];
      const pattern = likePattern(query);
      if (pattern) {
        sql += ` AND sm.data LIKE ? ESCAPE '\\'`;
        params.push(pattern);
      }
      sql += ' ORDER BY sm.time_created DESC, sm.seq DESC';
      return db.all(sql, params);
    },
  };
}

function hitFor(session, row, text, query) {
  return {
    sessionID: session.id,
    messageID: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    title: session.title || '(untitled)',
    directory: session.directory || '',
    time: Number.isFinite(session.timeUpdated) ? session.timeUpdated : row.timeCreated,
    snippet: snippetFor(text, query),
    context: contextFor(text, query),
  };
}

// Walk sessions newest-first until the requested page and one lookahead hit have
// been found. The lookahead enables pagination without scanning the entire database
// on every keystroke. `pause` yields between sessions; `signal` aborts and the time
// budget bounds pathological scans. Both report themselves honestly (`truncated`).
export async function searchMessages(adapter, input, options = {}) {
  const { query, roles, limit, page } = normalizeSearchInput(input);
  const offset = (page - 1) * limit;
  const pageEnd = offset + limit;
  const now = options.now ?? Date.now;
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : DEFAULT_BUDGET_MS;
  const pause = options.pause ?? (async () => {});
  const signal = options.signal;
  const started = now();
  const sessions = adapter.listSessions();
  const results = [];
  const seen = new Set();
  let scanned = 0;
  let truncated = false;
  let matched = 0;
  let hasMore = false;
  let pageReady = false;
  for (const session of sessions) {
    if (signal?.aborted || now() - started > budgetMs) {
      truncated = true;
      break;
    }
    scanned += 1;
    const rows = adapter.candidates(session.id, query, roles);
    for (const row of rows) {
      for (const text of messageTexts(row.role, row.data)) {
        if (query && !matches(text, query)) continue;
        const key = `${session.id}\n${row.role}\n${text.slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (matched >= offset && results.length < limit) results.push(hitFor(session, row, text, query));
        matched += 1;
        if (matched > pageEnd) {
          hasMore = true;
          pageReady = true;
          break;
        }
      }
      if (pageReady) break;
    }
    if (pageReady) break;
    await pause();
  }
  return {
    query, roles, limit, page, results, hasMore: hasMore || truncated,
    scanned, total: sessions.length, truncated,
  };
}
