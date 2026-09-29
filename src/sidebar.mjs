import {summarize} from './metrics.mjs';
import {splitWindow, windowStart} from './attribution.mjs';

const rpcDefinition = {id:'local.telemetry',methods:{snapshot:{},search:{}},events:{}};
const nf = new Intl.NumberFormat(undefined,{maximumFractionDigits:1});
// Money mirrors OpenCode's own cost readout, which always uses a dot decimal
// separator, so the two cost numbers on screen never look divergent.
const nfMoney = new Intl.NumberFormat('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const pct = value => value == null ? 'Unavailable' : `${nf.format(value)}%`;
const count = value => value == null ? 'Unavailable' : new Intl.NumberFormat().format(value);
const escape = text => String(text ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bar = (value,label) => value == null ? '' : `<meter min="0" max="100" value="${Math.max(0,Math.min(100,value))}" aria-label="${escape(label)}"></meter>`;
// Rates stay readable as they grow: 999 tok/s, 1.2K tok/s, 2.5M tok/s.
// A value that would round to 1000K is promoted to M so "1000K" can never appear.
export function formatRate(value, format = nf.format) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value >= 999950) return `${format(value/1000000)}M`;
  if (value >= 1000) return `${format(value/1000)}K`;
  return format(value);
}
// Session cost in dollars. A cost that exists but rounds to zero is shown as
// "<$0.01" rather than "$0.00", so a real charge is never reported as nothing.
export function formatCost(value, format = nfMoney.format) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Unavailable';
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${format(value)}`;
}

// --- session search ----------------------------------------------------------------
// The Search panel is fed by the local.telemetry search RPC (server plugin, read-only
// SQLite). The desktop bundle registers the opener from its shared Tabs provider;
// it adds a closed session to the tab store and selects it. Route changes alone only
// work for tabs that are already open.
export function base64url(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromBase64url(text) {
  const value = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(value + '='.repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
export function normalizeStoredServerKey(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const decoded = fromBase64url(value);
    if (base64url(decoded) === value) return decoded;
  } catch {}
  return value;
}
// Tab records store Q.key(server) (e.g. "sidecar"); the route segment is its
// base64url encoding (e.g. "c2lkZWNhcg").
export const SIDECAR_KEY = 'sidecar';
export function routeServerKey(pathname) {
  const match = /^\/server\/([^/]+)\//.exec(String(pathname ?? ''));
  if (!match) return null;
  try { return fromBase64url(match[1]); } catch { return null; }
}
let learnedServerKey = null;
function currentServerKey() {
  return routeServerKey(typeof location !== 'undefined' ? location.pathname : null)
    ?? learnedServerKey ?? SIDECAR_KEY;
}
export function highlightText(text, query) {
  const value = String(text ?? '');
  const safe = escape(value);
  if (!query) return safe;
  const at = value.toLowerCase().indexOf(String(query).toLowerCase());
  if (at === -1) return safe;
  return `${escape(value.slice(0, at))}<mark>${escape(value.slice(at, at + query.length))}</mark>${escape(value.slice(at + query.length))}`;
}
export function shortenDir(value, max = 42) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  const parts = text.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) return `…/${parts.slice(-2).join('/')}`;
  return `…${text.slice(-max)}`;
}
export function formatWhen(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  try {
    return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
  }
}
export function renderSearchResults(items, query) {
  return items.map(item => {
    const role = item.role === 'assistant' ? 'agent' : 'user';
    return `<button type="button" class="hit" data-session="${escape(item.sessionID)}" title="${escape(item.context || item.snippet || '')}">
      <span class="hit-top"><span class="role ${role}">${role}</span><span class="when">${escape(formatWhen(item.time))}</span></span>
      <span class="hit-title">${escape(item.title)}</span>
      <span class="hit-dir">${escape(shortenDir(item.directory))}</span>
      <span class="hit-snip">${highlightText(item.snippet, query)}</span>
    </button>`;
  }).join('');
}

// The cap sections, in display order. Anthropic has no monthly cap, and its per-model weekly
// caps depend on the plan, so those rows (marked optional) show only when they are reported.
const CAP_ROWS = [['fiveHour','5-hour cap'],['weekly','Weekly cap'],['monthly','Monthly cap']];
const CLAUDE_ROWS = [['fiveHour','5-hour cap'],['weekly','Weekly cap'],['weeklyOpus','Weekly cap · Opus',true],['weeklySonnet','Weekly cap · Sonnet',true]];
const CAP_SECTIONS = [
  {id:'opencode-go',title:'OpenCode Go',rows:CAP_ROWS,always:true},
  {id:'openai',title:'OpenAI',rows:CAP_ROWS,always:true},
  {id:'anthropic',title:'Anthropic',rows:CLAUDE_ROWS,always:false},
];

const readStored = (key, fallback = null) => {
  try { const value = localStorage.getItem(key); return value === null ? fallback : value; } catch { return fallback; }
};
const writeStored = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage can be unavailable */ } };
let lastClient = null;
let searchDirectory = null;
const openingSessions = new Set();

export function renderSnapshot({metrics, quotas, splits, error, updated, scope='Active context since last compaction'}) {
  const m = metrics || {};
  const metric = (name,value,note) => `<div class="metric"><span>${name}</span><strong>${value}</strong><small>${note}</small></div>`;
  // Estimated per-model split of a Go cap window, shown only where a split was computed.
  const splitHTML = split => {
    if (!split) return '';
    const rows = split.rows.length
      ? split.rows.map(r => `<div class="row split"><span>${escape(r.id)}</span><strong>${r.sharePercent == null ? '—' : pct(r.sharePercent)}</strong></div>
          <small class="sub">${formatRate(r.tokens)} tokens${r.billable ? '' : ' · no billable cost'}</small>`).join('')
      : '';
    return `<div class="bysplit"><small class="label">By model · estimated</small>${rows}${split.note ? `<small class="sub">${escape(split.note)}</small>` : ''}</div>`;
  };
  const quotasHTML = CAP_SECTIONS.map(({id,title,rows,always}) => {
    const q = quotas?.find(q=>q.provider===id);
    // Go and OpenAI always have a section; Anthropic has one only once the plugin reports it.
    if (!always && !q) return '';
    // A reading is stale once it is older than a refresh plus the panel's own poll. Providers that
    // refresh more slowly than the default minute (Anthropic) say so in refreshMs.
    const staleAfter = q?.refreshMs > 60000 ? q.refreshMs + 120000 : 120000;
    const stale = q?.state==='stale' || (q?.checked && Date.now()-q.checked>staleAfter);
    return `<section><h3>${title} <span class="status">${stale?'Stale':escape(q?.state || 'Loading')}</span></h3>
      ${q?.message?`<small>${escape(q.message)}</small>`:''}
      ${rows.map(([key,label,optional])=>{
        const w=q?.windows?.[key];
        if (optional && !w) return '';
        const expired=w?.reset && Date.parse(w.reset)<=Date.now();
        // A window with no reset has not started yet (for example an idle 5-hour session).
        const when=w?.reset?`${stale||expired?'Last reported reset':'Resets'} ${escape(new Date(w.reset).toLocaleString())}`:'No active window';
        return `<div class="quota"><div class="row"><span>${label}</span><strong>${w?`${pct(w.used)} used`:'Unavailable'}</strong></div>${bar(w?.used,`${label} used`)}
          <small>${w?`${pct(w.remaining)} left · ${when}`:'Not reported by the provider'}</small>
          ${w && id==='opencode-go' ? splitHTML(splits?.[key]) : ''}</div>`;
      }).join('')}
      ${q?.checked?`<small>Checked ${escape(new Date(q.checked).toLocaleTimeString())}</small>`:''}
      ${id==='opencode-go' && q?.state==='quota' ? '<small class="sub">Model shares are estimated from locally recorded OpenCode Go cost in the same window. Go reports only window totals, and usage from other machines or clients is not counted.</small>' : ''}
      ${id==='anthropic' && (q?.state==='quota' || q?.state==='stale') ? '<small class="sub">Claude subscription limits, read with the Claude login configured for this sidebar. Anthropic allows only occasional reads, so they refresh every 5 minutes.</small>' : ''}
    </section>`;
  }).join('');
  return `${error?`<p class="notice" role="status">${escape(error)}</p>`:''}
    <section><h3>Context <span class="status">${metrics?'Measured':'Waiting'}</span></h3>
      <div class="headrow"><div class="context-value">${pct(m.contextPercent)}</div>
        <div class="cost"><small>Cost · session</small><strong>${formatCost(m.sessionCost)}</strong></div></div>
      ${bar(m.contextPercent,'Context window used')}
      <small>${count(m.contextTokens)} / ${count(m.contextLimit)} tokens · latest measured request</small>
      <div class="metrics">${metric('Speed',m.tokensPerSecond==null?'Unavailable':`${formatRate(m.tokensPerSecond)} tok/s`,'Last completed generation · includes reasoning')}
      ${metric('Cache hit ratio',pct(m.cachePercent),'Cached reads / all input tokens')}</div>
    </section>
    <section><h3>MCPs <span class="status">${m.mcps?.length || 0} configured</span></h3>
      ${m.mcps?.length?m.mcps.map(s=>`<div class="row mcp"><span>${escape(s.name)}<small>${escape(s.status)}</small></span><strong>${s.calls} ${s.calls===1?'call':'calls'}</strong></div>`).join(''):'<small>No MCP data yet</small>'}
      <small>Observed calls in active context, including recorded Code Mode calls. Includes failed attempts.</small>
    </section>${quotasHTML}
    <section><h3>Model token share</h3><small>${escape(scope)}. Not a percentage of plan caps; providers do not return model-level cap attribution.</small>
      ${m.models?.length?m.models.map(g=>`<div class="quota"><div class="row"><span>${escape(g.id)}<small>${escape(g.providerID)}</small></span><strong>${pct(g.percent)}</strong></div>${bar(g.percent,'Model token share')}</div>`).join(''):'<small>No measured model usage yet</small>'}
    </section><footer>${updated?`Session updated ${escape(new Date(updated).toLocaleTimeString())}`:'Select a session to see metrics'}<br>Local telemetry · quota refresh at most once/minute</footer>`;
}

let current, host, panel, content, refreshButton, status, busy=false, generation=0;
let searchPanel, searchInput, searchBody, searchPagination, searchButton, searchStatus, searchUserBox, searchAgentBox, searchLimitSel, searchTimer, searchToken=0, searchAbort=null;
let searchPage=1, maxSearchPage=1;
let snapshot = {metrics:null,quotas:[],splits:null,updated:null,error:null};
let lastQuota=0, mounted=false;
const attached = new WeakSet();
const debug = {hooks:{}, session:null};
export function debugState() { return {session:debug.session, hooks:{...debug.hooks}}; }
const looksLikeSession = id => typeof id === 'string' && /^ses_[A-Za-z0-9]+$/.test(id);

// Read-only method hooks, resolved against the real client shape. The desktop
// client exposes the message list as top-level `message.list` while
// `session.message` only has `get`. Missing methods are skipped so a client
// shape change can never break app startup.
export function targetsFor(client) {
  const targets = [];
  const session = client?.session;
  if (session) {
    if (typeof session.get === 'function') targets.push([session,'get']);
    if (typeof session.context === 'function') targets.push([session,'context']);
    if (typeof session.prompt === 'function') targets.push([session,'prompt']);
    if (session.message && typeof session.message.list === 'function') targets.push([session.message,'list']);
  }
  if (client?.message && typeof client.message.list === 'function') targets.push([client.message,'list']);
  return targets;
}

function bind(client, sessionID) {
  try {
    // Follow the last session seen on real API calls. No URL check: the
    // desktop router does not always expose the session id in the location.
    if (!looksLikeSession(sessionID)) return;
    debug.session=sessionID;
    if (current?.client === client && current.sessionID === sessionID) return;
    current={client,sessionID};generation++;lastQuota=0;
    // Quotas belong to the account, not the session, so they survive a session switch. That keeps
    // the Anthropic section (which exists only once reported) from vanishing until the next refresh.
    snapshot={metrics:null,quotas:snapshot.quotas||[],splits:snapshot.splits??null,updated:null,error:null};
    mount();draw();void refresh().catch(()=>{});
  } catch {}
}

// Decorate only read methods; no token interception, credential access or prompt mutation.
// Never throws: sidebar failures must stay inside the sidebar.
export function attachClient(client) {
  try {
    if (!client || (typeof client !== 'object' && typeof client !== 'function')) return client;
    if (attached.has(client)) return client;
    attached.add(client);
    lastClient=client;
    for (const [object,key] of targetsFor(client)) {
      try {
        const original=object[key].bind(object);
        object[key]=(...args)=>{try{debug.hooks[key]=(debug.hooks[key]||0)+1;bind(client,args[0]?.sessionID);}catch{}return original(...args);};
      } catch {}
    }
    mount();
  } catch {}
  return client;
}

function draw() {
  if (!content) return;
  // Keep keyboard focus and scroll position: only non-interactive data is replaced.
  const d=debugState();
  const diag=`<div class="diag">Session ${escape(d.session||'none')} · hooks ${escape(Object.entries(d.hooks).map(([k,v])=>`${k}:${v}`).join(' ')||'none yet')}</div>`;
  content.innerHTML=renderSnapshot(snapshot)+diag;
}
// Per-model split of each Go window: the provider's total distributed by local cost share.
async function loadSplits(client, quotas, now) {
  const go = quotas?.find(q => q.provider === 'opencode-go');
  if (go?.state !== 'quota') return null;
  const splits = {};
  await Promise.all(['fiveHour','weekly','monthly'].map(async key => {
    const window = go.windows?.[key];
    const from = windowStart(key, window?.reset);
    if (from == null || from >= now) return;
    try {
      const stats = await client.session.stats({from, to: now}, {signal: AbortSignal.timeout(12000)});
      splits[key] = splitWindow(stats?.models, window.used);
    } catch {
      splits[key] = {rows: [], basis: null, note: 'Could not read local usage for this window'};
    }
  }));
  return splits;
}
async function refresh() {
  try {
  if (busy || !current) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  busy=true;const stamp=generation;const {client,sessionID}=current;
  if(refreshButton) refreshButton.disabled=true;
  try {
    const options={signal:AbortSignal.timeout(12000)};
    const session=await client.session.get({sessionID},options);
    // Remembered so the Search panel can find its location before any result exists.
    if(session.location?.directory){current.directory=session.location.directory;searchDirectory=session.location.directory;writeStored('local.telemetry.search.dir',searchDirectory);}
    const locationRef={directory:session.location.directory};
    const [messages,models,servers]=await Promise.all([
      client.session.context({sessionID},options),
      client.model.list({location:locationRef},options),
      client.mcp.list({location:locationRef},options),
    ]);
    if(stamp!==generation)return;
    snapshot.metrics=summarize(messages,models.data,servers.data,session);
    snapshot.updated=Date.now();snapshot.error=null;draw();
    if (Date.now()-lastQuota>=60000) {
      lastQuota=Date.now();
      try {
        const data=await client.rpc(rpcDefinition).snapshot({},{location:locationRef,signal:AbortSignal.timeout(15000)});
        if(stamp!==generation)return;
        snapshot.quotas=data.providers;
        snapshot.splits=await loadSplits(client,snapshot.quotas,Date.now());
        if(stamp!==generation)return;
      } catch {
        if(stamp===generation) {
          snapshot.error='Quota plugin unavailable. Session metrics are still live.';
          snapshot.quotas=snapshot.quotas.map(q=>({...q,state:'stale'}));
        }
      }
    }
  } catch {
    if(stamp===generation) snapshot.error='Cannot refresh session metrics. Values shown are stale; retry shortly.';
  } finally {
    busy=false;if(refreshButton)refreshButton.disabled=false;draw();
  }
  } catch {}
}

function setSearchStatus(text) {
  if (searchStatus) searchStatus.textContent = text || '';
}
function searchFilters() {
  const roles = [];
  if (searchUserBox.checked) roles.push('user');
  if (searchAgentBox.checked) roles.push('assistant');
  return { roles: roles.length ? roles : ['user', 'assistant'], limit: Number(searchLimitSel.value) || 30 };
}
// The RPC is location-routed; any known working directory will do because the
// server-side search reads the whole database. The last bound session is the
// best hint; the first session in the list is the fallback.
async function findSearchDirectory(client) {
  if (current?.directory) return current.directory;
  if (searchDirectory) return searchDirectory;
  try {
    const listed = await client.session.list({ limit: 1 });
    const rows = listed?.data ?? listed;
    const directory = Array.isArray(rows) ? rows[0]?.location?.directory : undefined;
    if (directory) {
      searchDirectory = directory;
      writeStored('local.telemetry.search.dir', directory);
      return directory;
    }
  } catch {}
  return undefined;
}
function renderSearchPagination(page, lastPage, hasMore) {
  if (page === 1 && lastPage === 1 && !hasMore) return '';
  const pages = new Set([1, lastPage]);
  for (let value = Math.max(2, page - 2); value <= Math.min(lastPage, page + 2); value += 1) pages.add(value);
  const ordered = [...pages].sort((a, b) => a - b);
  const items = [];
  let previous = 0;
  for (const value of ordered) {
    if (value - previous > 1) items.push('<span class="page-gap" aria-hidden="true">…</span>');
    items.push(`<button type="button" class="page${value === page ? ' active' : ''}" data-page="${value}"${value === page ? ' aria-current="page"' : ''}>${value}</button>`);
    previous = value;
  }
  return `<nav class="search-pagination" aria-label="Search result pages">
    <button type="button" class="page-arrow" data-navigate="previous" aria-label="Previous page"${page <= 1 ? ' disabled' : ''}>‹</button>
    ${items.join('')}
    <button type="button" class="page-arrow" data-navigate="next" aria-label="Next page"${hasMore ? '' : ' disabled'}>›</button>
  </nav>`;
}
function resetSearchPagination() {
  searchPage = 1;
  maxSearchPage = 1;
  searchAbort?.abort();
  searchAbort = null;
  searchToken += 1;
  if (searchPagination) searchPagination.innerHTML = '';
}
async function runSearch(page = 1) {
  if (!searchInput) return;
  const client = current?.client ?? lastClient;
  const token = ++searchToken;
  if (!client) { setSearchStatus('No connection yet — open a session once, then search.'); return; }
  const query = searchInput.value.trim();
  const { roles, limit } = searchFilters();
  // A new search supersedes the previous one: abort it server-side so a rare-term
  // full scan does not keep burning cycles while the user keeps typing.
  searchAbort?.abort();
  const controller = new AbortController();
  searchAbort = controller;
  const signal = typeof AbortSignal.any === 'function'
    ? AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
    : AbortSignal.timeout(20000);
  setSearchStatus(query ? `searching “${query}”…` : 'loading recent…');
  searchBody.setAttribute('aria-busy', 'true');
  try {
    const directory = await findSearchDirectory(client);
    const response = await client.rpc(rpcDefinition).search({ query, roles, limit, page }, {
      ...(directory ? { location: { directory } } : {}),
      signal,
    });
    if (token !== searchToken) return;
    if (response?.error) { setSearchStatus(String(response.error)); return; }
    searchPage = page;
    const hasMore = Boolean(response?.hasMore);
    maxSearchPage = Math.max(maxSearchPage, page + (hasMore ? 1 : 0));
    const results = Array.isArray(response?.results) ? response.results : [];
    searchBody.innerHTML = results.length
      ? renderSearchResults(results, query)
      : `<p class="empty">${query ? 'No matching messages.' : 'No recent messages.'}</p>`;
    if (results[0]?.directory) {
      searchDirectory = results[0].directory;
      writeStored('local.telemetry.search.dir', searchDirectory);
    }
    searchPagination.innerHTML = renderSearchPagination(searchPage, maxSearchPage, hasMore);
    setSearchStatus(`Page ${searchPage} · ${results.length} ${results.length === 1 ? 'result' : 'results'}${hasMore ? ' · more results' : ''}${response?.truncated ? ' · older history not fully scanned' : ''}`);
  } catch (error) {
    if (token === searchToken) setSearchStatus(`Search failed. ${error?.message ?? error}`);
  } finally {
    if (token === searchToken) searchBody.removeAttribute('aria-busy');
  }
}
function scheduleSearch() {
  clearTimeout(searchTimer);
  resetSearchPagination();
  searchTimer = setTimeout(() => { void runSearch(1); }, 260);
}

function mount() {
  try {
  if(mounted)return;
  if(typeof document==='undefined'||!document.body){if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',mount,{once:true});return;}
  mounted=true;
  const reserve=document.createElement('style');
  reserve.textContent='@media(min-width:1050px){html[data-oc-telemetry-open] #root{width:calc(100% - 300px)!important}html[data-oc-telemetry-search-open] #root{width:calc(100% - min(640px,45vw))!important}}';
  document.head.append(reserve);
  host=document.createElement('div');host.id='oc-telemetry';document.body.append(host);
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML=`<style>
    :host{font:12px/1.5 var(--font-family-sans,system-ui);color:var(--text-base,#ededed)}
    *{box-sizing:border-box}button{font:inherit;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--border-base,#555);border-radius:6px;padding:5px 9px;min-height:30px;-webkit-app-region:no-drag}button:focus-visible{outline:2px solid #66b7ff;outline-offset:2px}button:disabled{opacity:.5;cursor:wait}
    .dock{position:fixed;right:12px;bottom:12px;z-index:1000;display:flex;gap:8px}
    .toggle{background:var(--background-base,#151515);box-shadow:0 1px 4px #0005}
    aside{position:fixed;top:48px;bottom:0;right:0;width:300px;background:var(--background-base,#151515);border-left:1px solid var(--border-base,#444);z-index:100;display:flex;flex-direction:column}
    #search-panel{width:min(640px,45vw)}
    aside[hidden]{display:none}header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border-base,#444)}header strong{font-size:13px}.body{overflow:auto;padding:0 16px 48px;overscroll-behavior:contain}
    section{padding:16px 0;border-bottom:1px solid var(--border-base,#444)}h3{font-size:12px;font-weight:600;margin:0 0 10px;display:flex;justify-content:space-between;gap:8px}.status,small,footer{color:var(--text-weak,#a9a9a9);font-size:11px;font-weight:400}small{display:block}.context-value{font:600 26px/1.2 var(--font-family-mono,monospace);margin:6px 0}.headrow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px}.cost{text-align:right;flex-shrink:0}.cost strong{font:600 18px/1.2 var(--font-family-mono,monospace);white-space:nowrap}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}.metric>span{display:block;font-size:11px}.metric strong{display:block;font-size:17px;margin:3px 0}.metric small{font-size:10px}.row{display:flex;justify-content:space-between;gap:12px;align-items:center}.row>span{overflow-wrap:anywhere;min-width:0}.row strong{flex-shrink:0;font-size:11px;font-variant-numeric:tabular-nums}.mcp{margin:10px 0}.quota{margin-top:13px}meter{display:block;width:100%;height:7px;margin:8px 0;accent-color:#73b3df}meter::-webkit-meter-bar{background:var(--surface-base,#383838);border:0;border-radius:4px}meter::-webkit-meter-optimum-value{background:#73b3df;border-radius:4px}.notice{color:var(--text-base,#ededed);border:1px solid #9c7b34;padding:10px;border-radius:6px}footer{padding-top:16px}
    @media(max-width:1049px){aside{box-shadow:-8px 0 25px #0005;width:min(300px,95vw)}#search-panel{width:min(640px,95vw)}}
    .diag{color:var(--text-weak,#a9a9a9);font-size:10px;padding:10px 0;overflow-wrap:anywhere}
    .bysplit{margin-top:10px;padding-left:9px;border-left:2px solid var(--border-base,#444)}
    .bysplit .label{font-size:10px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px}
    .bysplit .row{margin-top:6px}.bysplit .sub{padding-left:0}
    .search-status{text-align:right;min-width:0;overflow-wrap:anywhere}
    .search-controls{display:flex;gap:8px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border-base,#444);flex-wrap:wrap}
    .search-controls .query{flex:1 1 100%;min-height:30px;background:transparent;color:inherit;border:1px solid var(--border-base,#555);border-radius:6px;padding:5px 8px;font:inherit}
    .search-controls select{background:transparent;color:inherit;border:1px solid var(--border-base,#555);border-radius:6px;padding:4px;font:inherit}
    .search-controls .check{display:inline-flex;gap:4px;align-items:center;color:var(--text-weak,#a9a9a9);font-size:11px}
    .search-body{display:flex;flex:1 1 auto;flex-direction:column;gap:8px;min-height:0;padding:12px 16px 12px;overflow:auto;overscroll-behavior:contain}
    .hit{display:block;width:100%;flex-shrink:0;text-align:left;border:1px solid var(--border-base,#444);border-radius:6px;padding:8px 10px}
    .hit:hover,.hit:focus-visible{background:var(--surface-base,#2a2a2a)}
    .hit-top{display:flex;justify-content:space-between;gap:8px;align-items:center}
    .role{font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-weak,#a9a9a9)}
    .role.agent{color:#8ab4f8}
    .hit-title{display:block;font-weight:600;margin:4px 0;overflow-wrap:anywhere}
    .hit-dir,.hit-snip{display:block;color:var(--text-weak,#a9a9a9);font-size:11px;overflow-wrap:anywhere}
    .hit-snip{margin-top:4px}
    mark{background:#3b5a75;color:inherit;border-radius:2px}
    .empty{color:var(--text-weak,#a9a9a9);font-size:11px}
    .search-pagination{display:flex;justify-content:center;align-items:center;gap:5px;padding:8px 12px;border-top:1px solid var(--border-base,#444)}
    .search-pagination .page,.search-pagination .page-arrow{min-width:30px;padding:4px 8px}
    .search-pagination .active{background:var(--surface-base,#383838);border-color:var(--border-weak,#777)}
    .search-pagination .page-gap{color:var(--text-weak,#a9a9a9);padding:0 2px}
  </style><div class="dock">
    <button class="toggle" aria-expanded="true" aria-controls="panel">Telemetry</button>
    <button class="toggle search" aria-expanded="false" aria-controls="search-panel">Search</button>
  </div>
  <aside id="panel" aria-label="Session telemetry"><header><strong>Session telemetry</strong><button class="refresh" aria-label="Refresh telemetry">Refresh</button></header><div class="body"></div></aside>
  <aside id="search-panel" aria-label="Search sessions" hidden><header><strong>Search</strong><span class="status search-status" role="status" aria-live="polite"></span></header>
    <div class="search-controls">
      <input type="search" class="query" placeholder="Search all sessions…" aria-label="Search query" autocomplete="off">
      <label class="check"><input type="checkbox" class="role-user" checked> User</label>
      <label class="check"><input type="checkbox" class="role-agent" checked> Agent</label>
      <select class="limit" aria-label="Maximum results"><option value="20">20</option><option value="30" selected>30</option><option value="50">50</option><option value="100">100</option></select>
    </div>
    <div class="body search-body"></div><div class="search-pagination"></div></aside>`;
  panel=shadow.querySelector('#panel');content=shadow.querySelector('#panel .body');refreshButton=shadow.querySelector('.refresh');
  searchPanel=shadow.querySelector('#search-panel');searchButton=shadow.querySelector('.toggle.search');
  searchInput=shadow.querySelector('.search-controls .query');searchUserBox=shadow.querySelector('.role-user');searchAgentBox=shadow.querySelector('.role-agent');searchLimitSel=shadow.querySelector('.limit');searchBody=shadow.querySelector('.search-body');searchPagination=shadow.querySelector('.search-pagination');searchStatus=shadow.querySelector('.search-status');
  searchDirectory=readStored('local.telemetry.search.dir');learnedServerKey=normalizeStoredServerKey(readStored('local.telemetry.search.server'));
  if(learnedServerKey)writeStored('local.telemetry.search.server',learnedServerKey);
  const seenKey=routeServerKey(location.pathname);if(seenKey){learnedServerKey=seenKey;writeStored('local.telemetry.search.server',seenKey);}
  const toggle=shadow.querySelector('.toggle:not(.search)');
  let open=true;try{open=localStorage.getItem('local.telemetry.open')!=='false';}catch{}
  let searchVisible=readStored('local.telemetry.search.open')==='true';if(searchVisible)open=false;
  const apply=()=>{panel.hidden=!open;searchPanel.hidden=!searchVisible;document.documentElement.toggleAttribute('data-oc-telemetry-open',open||searchVisible);document.documentElement.toggleAttribute('data-oc-telemetry-search-open',searchVisible);toggle.setAttribute('aria-expanded',String(open));searchButton.setAttribute('aria-expanded',String(searchVisible));};
  apply();
  toggle.onclick=()=>{open=!open;if(open)searchVisible=false;apply();writeStored('local.telemetry.open',String(open));writeStored('local.telemetry.search.open',String(searchVisible));};
  searchButton.onclick=()=>{searchVisible=!searchVisible;if(searchVisible)open=false;apply();writeStored('local.telemetry.search.open',String(searchVisible));writeStored('local.telemetry.open',String(open));if(searchVisible){searchInput.focus();if(!searchBody.innerHTML)void runSearch(1);}};
  refreshButton.onclick=()=>void refresh();
  searchInput.addEventListener('input',scheduleSearch);
  searchInput.addEventListener('keydown',event=>{if(event.key==='Enter'){clearTimeout(searchTimer);void runSearch(1);}});
  searchUserBox.addEventListener('change',()=>{resetSearchPagination();void runSearch(1);});
  searchAgentBox.addEventListener('change',()=>{resetSearchPagination();void runSearch(1);});
  searchLimitSel.addEventListener('change',()=>{resetSearchPagination();void runSearch(1);});
  searchPagination.addEventListener('click',event=>{
    const button=event.target?.closest?.('button');
    if(!button||button.disabled)return;
    const page=button.dataset.page?Number(button.dataset.page):searchPage+(button.dataset.navigate==='next'?1:-1);
    if(page>=1&&page<=maxSearchPage)void runSearch(page);
  });
  searchBody.addEventListener('click',async event=>{
    const hit=event.target&&event.target.closest?event.target.closest('.hit'):null;
    if(!hit||!hit.dataset.session)return;
    const sessionID=hit.dataset.session;
    if(openingSessions.has(sessionID))return;
    const client=current?.client??lastClient;
    const openSession=typeof window!=='undefined'?window.__localTelemetryOpenSession:null;
    if(!client){setSearchStatus('No connection available to open this session.');return;}
    if(typeof openSession!=='function'){setSearchStatus('Session tab integration is missing. Reinstall the sidebar and restart OpenCode.');return;}
    openingSessions.add(sessionID);
    try{
      const session=await client.session.get({sessionID},{signal:AbortSignal.timeout(12000)});
      if(!session?.id){setSearchStatus('OpenCode could not load that session.');return;}
      if(openSession(session,{server:currentServerKey()})===false){setSearchStatus('OpenCode could not add that session tab.');return;}
      searchVisible=false;apply();writeStored('local.telemetry.search.open','false');
    }catch(error){setSearchStatus(`Could not open session. ${error?.message??error}`);}
    finally{openingSessions.delete(sessionID);}
  });
  shadow.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(searchVisible){searchVisible=false;apply();writeStored('local.telemetry.search.open','false');searchButton.focus();return;}open=false;apply();writeStored('local.telemetry.open','false');toggle.focus();});
  draw();setInterval(()=>{try{if(open)void refresh();}catch{}},3000);
  } catch {}
}
