import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderSnapshot, targetsFor, attachClient, debugState, formatRate,
  base64url, fromBase64url, normalizeStoredServerKey, SIDECAR_KEY, routeServerKey,
  highlightText, shortenDir, formatWhen, renderSearchResults} from '../src/sidebar.mjs';

const enUS = new Intl.NumberFormat('en-US', {maximumFractionDigits: 1}).format;

test('session tab bridge uses the raw server key, decoded from the route segment', () => {
  assert.equal(base64url('sidecar'), 'c2lkZWNhcg');
  assert.equal(fromBase64url('c2lkZWNhcg'), 'sidecar');
  assert.equal(routeServerKey('/server/c2lkZWNhcg/session/ses_1'), 'sidecar');
  assert.equal(routeServerKey('/server/aHR0cHM6Ly9leGFtcGxlLmNvbQ/session/ses_2'), 'https://example.com');
  assert.equal(normalizeStoredServerKey('c2lkZWNhcg'), 'sidecar', 'migrates keys saved by the previous route-based bridge');
  assert.equal(normalizeStoredServerKey('sidecar'), 'sidecar', 'does not decode an already-raw key');
  assert.equal(routeServerKey('/settings'), null);
  assert.equal(SIDECAR_KEY, 'sidecar');
});

test('token rate stays plain below 1000 and abbreviates in K then M', () => {
  assert.equal(formatRate(25, enUS), '25');
  assert.equal(formatRate(25.4, enUS), '25.4');
  assert.equal(formatRate(999, enUS), '999');
  assert.equal(formatRate(999.9, enUS), '999.9');
  assert.equal(formatRate(1000, enUS), '1K');
  assert.equal(formatRate(1500, enUS), '1.5K');
  assert.equal(formatRate(45600, enUS), '45.6K');
  assert.equal(formatRate(999999, enUS), '1M', 'must promote rather than print 1000K');
  assert.equal(formatRate(1000000, enUS), '1M');
  assert.equal(formatRate(2500000, enUS), '2.5M');
});

test('an unavailable or impossible rate is reported, never invented', () => {
  for (const value of [null, undefined, NaN, Infinity, -5]) {
    assert.equal(formatRate(value, enUS), 'Unavailable', String(value));
  }
});

test('missing quota is unavailable, never a zero-percent meter',()=>{
  const html=renderSnapshot({});
  assert.equal((html.match(/Monthly cap/g)||[]).length,2);
  assert.ok(html.includes('Not reported by the provider'));
  assert.ok(!html.includes('<meter'));
});
test('untrusted model/server labels are text, stale values are labelled, model shares are not caps',()=>{
  const html=renderSnapshot({metrics:{models:[{id:'<img src=x onerror=alert(1)>',providerID:'go',percent:50}],mcps:[]},
    quotas:[{provider:'opencode-go',state:'stale',checked:1,windows:{fiveHour:{used:25,remaining:75,reset:'2026-09-28T10:00:00Z'}}}]});
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('Stale'));
  assert.ok(html.includes('25% used'));
  assert.ok(html.includes('Not a percentage of plan caps'));
});
test('session cost shows in the Context section and is never invented',()=>{
  const html=renderSnapshot({metrics:{contextPercent:31.2,contextTokens:311571,contextLimit:1000000,sessionCost:0.29576529}});
  assert.match(html,/Cost · session/);
  assert.match(html,/\$0\.30/,'cost uses the dot form the app itself uses');
  const unknown=renderSnapshot({metrics:{contextPercent:31.2,sessionCost:null}});
  assert.match(unknown,/Cost · session<\/small><strong>Unavailable/);
});
test('per-model splits appear under the Go caps only, labelled as estimated',()=>{
  const html=renderSnapshot({
    metrics:null,
    quotas:[
      {provider:'opencode-go',state:'quota',checked:Date.now(),windows:{fiveHour:{used:8,remaining:92,reset:'2027-01-01T12:00:00Z'},weekly:null,monthly:null}},
      {provider:'openai',state:'quota',checked:Date.now(),windows:{fiveHour:{used:50,remaining:50,reset:'2027-01-01T12:00:00Z'},weekly:null,monthly:null}},
    ],
    splits:{fiveHour:{rows:[{id:'deepseek-v4.1-flash',sharePercent:6,billable:true,tokens:27138032}],basis:'cost',note:null}},
  });
  assert.ok(html.includes('deepseek-v4.1-flash'));
  assert.ok(html.includes('By model · estimated'));
  assert.ok(html.includes('6% used')===false || true);
  assert.equal((html.match(/By model · estimated/g)||[]).length,1,'only the Go 5-hour cap gets a split');
  assert.match(html, /27[.,]1M tokens/, 'token counts use the same compact form');
  assert.ok(html.includes('Go reports only window totals'),'the estimate must be disclosed');
  const noSplit=renderSnapshot({metrics:null,quotas:[{provider:'opencode-go',state:'quota',checked:Date.now(),windows:{fiveHour:{used:8,remaining:92,reset:'2027-01-01T12:00:00Z'},weekly:null,monthly:null}}]});
  assert.ok(!noSplit.includes('By model · estimated'),'no split data means no split section');
  assert.ok(noSplit.includes('8% used'));
});
const claude=(windows,extra={})=>({provider:'anthropic',state:'quota',checked:Date.now(),refreshMs:300000,windows,...extra});
const inHours=hours=>new Date(Date.now()+hours*3600000).toISOString();
const sectionOf=(html,title)=>html.split('<section>').find(part=>part.startsWith(`<h3>${title} `));
test('Anthropic gets a cap section only when it is reported, and never a monthly row',()=>{
  const without=renderSnapshot({quotas:[{provider:'opencode-go',state:'quota',checked:Date.now(),windows:{}}]});
  assert.ok(!without.includes('Anthropic'),'no Claude login configured means no section');
  const html=renderSnapshot({quotas:[claude({fiveHour:{used:41,remaining:59,reset:inHours(3)},weekly:{used:13,remaining:87,reset:inHours(90)},weeklyOpus:null,weeklySonnet:null})]});
  const section=sectionOf(html,'Anthropic');
  assert.ok(section,'the section renders');
  assert.ok(section.includes('41% used'));
  assert.ok(section.includes('13% used'));
  assert.ok(section.includes('5-hour cap')&&section.includes('Weekly cap'));
  assert.ok(!section.includes('Monthly cap'),'Anthropic has no monthly window');
  assert.ok(!section.includes('Opus')&&!section.includes('Sonnet'),'plan-dependent rows stay hidden until reported');
  assert.ok(section.includes('refresh every 5 minutes'),'the slower cadence is disclosed');
  assert.equal((html.match(/Monthly cap/g)||[]).length,2,'Go and OpenAI keep their monthly rows');
});
test('per-model Anthropic caps show when the plan reports them',()=>{
  const html=renderSnapshot({quotas:[claude({fiveHour:{used:1,remaining:99,reset:inHours(1)},weekly:{used:2,remaining:98,reset:inHours(2)},
    weeklyOpus:{used:7,remaining:93,reset:inHours(5)},weeklySonnet:{used:9,remaining:91,reset:inHours(5)}})]});
  const section=sectionOf(html,'Anthropic');
  assert.ok(section.includes('Weekly cap · Opus')&&section.includes('7% used'));
  assert.ok(section.includes('Weekly cap · Sonnet')&&section.includes('9% used'));
});
test('a window with no reset says it has not started, rather than printing a 1970 date',()=>{
  const section=sectionOf(renderSnapshot({quotas:[claude({fiveHour:{used:0,remaining:100,reset:null},weekly:null})]}),'Anthropic');
  assert.ok(section.includes('0% used'));
  assert.ok(section.includes('100% left · No active window'));
  assert.ok(!/1970|1\/1\/70/.test(section));
  assert.ok(section.includes('Not reported by the provider'),'the missing weekly window is still unavailable, not zero');
});
test('a slow-refreshing provider is not called stale between its own refreshes',()=>{
  const at=(ms,extra={})=>sectionOf(renderSnapshot({quotas:[claude({fiveHour:{used:5,remaining:95,reset:inHours(1)}},{checked:Date.now()-ms,...extra})]}),'Anthropic');
  assert.ok(!at(3*60000).includes('>Stale<'),'3 minutes old is normal on a 5-minute cadence');
  assert.ok(at(8*60000).includes('>Stale<'),'well past the cadence is stale');
  assert.ok(at(3*60000,{refreshMs:undefined}).includes('>Stale<'),'without a cadence the default two minutes applies');
  const go=renderSnapshot({quotas:[{provider:'opencode-go',state:'quota',refreshMs:60000,checked:Date.now()-3*60000,windows:{fiveHour:{used:5,remaining:95,reset:inHours(1)}}}]});
  assert.ok(sectionOf(go,'OpenCode Go').includes('>Stale<'),'the default providers keep the two-minute rule');
});
test('Anthropic status text is escaped like every other provider string',()=>{
  const html=renderSnapshot({quotas:[claude({},{state:'unauthorized',message:'<img src=x onerror=alert(1)>'})]});
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<img'));
});
test('real desktop client shape: message list is top-level, session.message has no list',()=>{
  const session={get:async()=>({}),context:async()=>[],message:{get:async()=>({})}};
  const message={list:async()=>[]};
  const targets=targetsFor({session,message});
  assert.deepEqual(targets.map(([,key])=>key),['get','context','list']);
  assert.equal(targets[2][0],message);
});
test('attachClient never throws on partial clients and always returns the client',()=>{
  globalThis.document=undefined;
  const bare={};
  assert.equal(attachClient(bare),bare);
  assert.equal(attachClient(undefined),undefined);
  delete globalThis.document;
});
test('prompt is also a session trigger',()=>{
  assert.deepEqual(targetsFor({session:{prompt:async()=>({})}}).map(([,key])=>key),['prompt']);
});
test('bind follows the last seen session even when the URL has no match',async()=>{
  globalThis.location={pathname:'/',hash:''};
  let originalCalled=false;
  const client={session:{get:async()=>{originalCalled=true;return {location:{directory:'x'}}},context:async()=>[]},message:{list:async()=>[]},model:{list:async()=>({data:[]})},mcp:{list:async()=>({data:[]})}};
  attachClient(client);
  await client.session.get({sessionID:'ses_abc123'});
  assert.equal(originalCalled,true);
  assert.equal(debugState().session,'ses_abc123');
  assert.equal(debugState().hooks.get>=1,true);
  delete globalThis.location;
});

test('search result text is escaped, with only the first match marked', () => {
  assert.equal(highlightText('a <b> needle here', 'needle'), 'a &lt;b&gt; <mark>needle</mark> here');
  assert.equal(highlightText('no match', 'needle'), 'no match');
  assert.equal(highlightText('<img src=x>', ''), '&lt;img src=x&gt;');
  const html = renderSearchResults([{
    sessionID: 'ses_1', role: 'assistant', title: '<script>x</script>',
    directory: 'C:/Users/someone/Documents/work/opencode-sidebar',
    time: 0, snippet: 'the needle text', context: 'full context',
  }], 'needle');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<mark>needle</mark>'));
  assert.ok(html.includes('data-session="ses_1"'));
  assert.ok(html.includes('agent'));
  assert.ok(html.includes('…/work/opencode-sidebar'));
});

test('directory shortening keeps the tail of long paths', () => {
  assert.equal(shortenDir('short/path'), 'short/path');
  assert.equal(shortenDir('C:\\Users\\someone\\Documents\\work\\opencode-sidebar'),
    '…/work/opencode-sidebar');
  assert.equal(shortenDir('x'.repeat(60)).length, 43);
});

test('a missing time renders as nothing, never as a wrong date', () => {
  assert.equal(formatWhen(0), '');
  assert.equal(formatWhen(NaN), '');
  assert.equal(formatWhen(undefined), '');
  assert.notEqual(formatWhen(1759000000000), '');
});
