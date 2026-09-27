import {summarize} from './metrics.mjs';
import {splitWindow, windowStart} from './attribution.mjs';

const rpcDefinition = {id:'local.telemetry',methods:{snapshot:{}},events:{}};
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
  const quotasHTML = ['opencode-go','openai'].map(id => {
    const q = quotas?.find(q=>q.provider===id);
    const stale = q?.state==='stale' || (q?.checked && Date.now()-q.checked>120000);
    return `<section><h3>${id==='openai'?'OpenAI':'OpenCode Go'} <span class="status">${stale?'Stale':escape(q?.state || 'Loading')}</span></h3>
      ${q?.message?`<small>${escape(q.message)}</small>`:''}
      ${[['fiveHour','5-hour cap'],['weekly','Weekly cap'],['monthly','Monthly cap']].map(([key,label])=>{
        const w=q?.windows?.[key];
        const expired=w?.reset && Date.parse(w.reset)<=Date.now();
        return `<div class="quota"><div class="row"><span>${label}</span><strong>${w?`${pct(w.used)} used`:'Unavailable'}</strong></div>${bar(w?.used,`${label} used`)}
          <small>${w?`${pct(w.remaining)} left · ${stale||expired?'Last reported reset':'Resets'} ${escape(new Date(w.reset).toLocaleString())}`:'Not reported by the provider'}</small>
          ${w && id==='opencode-go' ? splitHTML(splits?.[key]) : ''}</div>`;
      }).join('')}
      ${q?.checked?`<small>Checked ${escape(new Date(q.checked).toLocaleTimeString())}</small>`:''}
      ${id==='opencode-go' && q?.state==='quota' ? '<small class="sub">Model shares are estimated from locally recorded OpenCode Go cost in the same window. Go reports only window totals, and usage from other machines or clients is not counted.</small>' : ''}
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
    snapshot={metrics:null,quotas:[],updated:null,error:null};
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

function mount() {
  try {
  if(mounted)return;
  if(typeof document==='undefined'||!document.body){if(typeof document!=='undefined')document.addEventListener('DOMContentLoaded',mount,{once:true});return;}
  mounted=true;
  const reserve=document.createElement('style');
  reserve.textContent='@media(min-width:1050px){html[data-oc-telemetry-open] #root{width:calc(100% - 300px)!important}}';
  document.head.append(reserve);
  host=document.createElement('div');host.id='oc-telemetry';document.body.append(host);
  const shadow=host.attachShadow({mode:'open'});
  shadow.innerHTML=`<style>
    :host{font:12px/1.5 var(--font-family-sans,system-ui);color:var(--text-base,#ededed)}
    *{box-sizing:border-box}button{font:inherit;cursor:pointer;color:inherit;background:transparent;border:1px solid var(--border-base,#555);border-radius:6px;padding:5px 9px;min-height:30px;-webkit-app-region:no-drag}button:focus-visible{outline:2px solid #66b7ff;outline-offset:2px}button:disabled{opacity:.5;cursor:wait}
    .toggle{position:fixed;right:12px;bottom:12px;z-index:1000;background:var(--background-base,#151515);box-shadow:0 1px 4px #0005}
    aside{position:fixed;top:48px;bottom:0;right:0;width:300px;background:var(--background-base,#151515);border-left:1px solid var(--border-base,#444);z-index:100;display:flex;flex-direction:column}
    aside[hidden]{display:none}header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border-base,#444)}header strong{font-size:13px}.body{overflow:auto;padding:0 16px 48px;overscroll-behavior:contain}
    section{padding:16px 0;border-bottom:1px solid var(--border-base,#444)}h3{font-size:12px;font-weight:600;margin:0 0 10px;display:flex;justify-content:space-between;gap:8px}.status,small,footer{color:var(--text-weak,#a9a9a9);font-size:11px;font-weight:400}small{display:block}.context-value{font:600 26px/1.2 var(--font-family-mono,monospace);margin:6px 0}.headrow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px}.cost{text-align:right;flex-shrink:0}.cost strong{font:600 18px/1.2 var(--font-family-mono,monospace);white-space:nowrap}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}.metric>span{display:block;font-size:11px}.metric strong{display:block;font-size:17px;margin:3px 0}.metric small{font-size:10px}.row{display:flex;justify-content:space-between;gap:12px;align-items:center}.row>span{overflow-wrap:anywhere;min-width:0}.row strong{flex-shrink:0;font-size:11px;font-variant-numeric:tabular-nums}.mcp{margin:10px 0}.quota{margin-top:13px}meter{display:block;width:100%;height:7px;margin:8px 0;accent-color:#73b3df}meter::-webkit-meter-bar{background:var(--surface-base,#383838);border:0;border-radius:4px}meter::-webkit-meter-optimum-value{background:#73b3df;border-radius:4px}.notice{color:var(--text-base,#ededed);border:1px solid #9c7b34;padding:10px;border-radius:6px}footer{padding-top:16px}
    @media(max-width:1049px){aside{box-shadow:-8px 0 25px #0005;width:min(300px,95vw)}}
    .diag{color:var(--text-weak,#a9a9a9);font-size:10px;padding:10px 0;overflow-wrap:anywhere}
    .bysplit{margin-top:10px;padding-left:9px;border-left:2px solid var(--border-base,#444)}
    .bysplit .label{font-size:10px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px}
    .bysplit .row{margin-top:6px}.bysplit .sub{padding-left:0}
  </style><button class="toggle" aria-expanded="true" aria-controls="panel">Telemetry</button>
  <aside id="panel" aria-label="Session telemetry"><header><strong>Session telemetry</strong><button class="refresh" aria-label="Refresh telemetry">Refresh</button></header><div class="body"></div></aside>`;
  panel=shadow.querySelector('aside');content=shadow.querySelector('.body');refreshButton=shadow.querySelector('.refresh');
  const toggle=shadow.querySelector('.toggle');
  let open=true;try{open=localStorage.getItem('local.telemetry.open')!=='false';}catch{}
  const apply=()=>{panel.hidden=!open;document.documentElement.toggleAttribute('data-oc-telemetry-open',open);toggle.setAttribute('aria-expanded',String(open));};
  apply();toggle.onclick=()=>{open=!open;apply();try{localStorage.setItem('local.telemetry.open',String(open));}catch{}};
  refreshButton.onclick=()=>void refresh();
  shadow.addEventListener('keydown',e=>{if(e.key==='Escape'){open=false;apply();toggle.focus();}});
  draw();setInterval(()=>{try{if(open)void refresh();}catch{}},3000);
  } catch {}
}
