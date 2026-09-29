"""Run against a loopback static server rooted at opencode-telemetry."""
from pathlib import Path
from playwright.sync_api import sync_playwright

out=Path(__file__).resolve().parents[1]/'build'
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    page=browser.new_page(viewport={'width':1440,'height':1000})
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto('http://127.0.0.1:8768/tests/ui_harness.html')
    page.wait_for_load_state('networkidle')
    page.get_by_text('25 tok/s',exact=True).wait_for()
    assert page.get_by_text('60%',exact=True).is_visible()
    # Session cost, taken from the session itself and shown in the Context section.
    assert page.get_by_text('Cost · session',exact=True).is_visible()
    assert page.locator('#oc-telemetry').evaluate(
        "e=>/\\$0\\.30/.test(e.shadowRoot.textContent)") is True, 'session cost must render as $0.30'
    assert page.get_by_text('25% used',exact=True).is_visible()
    assert page.get_by_text('1 call',exact=True).is_visible()
    # Per-model split of the Go cap window, estimated from local cost share.
    assert page.get_by_text('deepseek-v4.1-flash',exact=True).is_visible()
    assert page.get_by_text('By model · estimated',exact=True).is_visible()
    assert page.get_by_text('space-bunny-free',exact=True).is_visible()
    assert page.get_by_text('gemini-3.8-flash',exact=True).count()==0,'non-Go models must not appear in the split'
    # Anthropic gets its own section once the plugin reports it: 5-hour, weekly and the plan's
    # Opus cap; the unreported Sonnet cap stays hidden and there is never a monthly row.
    assert page.get_by_text('41% used',exact=True).is_visible()
    assert page.get_by_text('13% used',exact=True).is_visible()
    assert page.get_by_text('Weekly cap · Opus',exact=True).is_visible()
    assert page.get_by_text('Weekly cap · Sonnet',exact=True).count()==0,'unreported per-model caps stay hidden'
    claude=page.locator('#oc-telemetry').evaluate("""e=>{
      const section=[...e.shadowRoot.querySelectorAll('section')].find(s=>s.querySelector('h3')?.textContent.startsWith('Anthropic'));
      return section?{text:section.textContent,meters:section.querySelectorAll('meter').length}:null;
    }""")
    assert claude,'the Anthropic section must render once it is reported'
    assert 'Monthly cap' not in claude['text'],'Anthropic has no monthly window'
    assert 'refresh every 5 minutes' in claude['text'],'the slower cadence must be disclosed'
    assert 'Stale' not in claude['text'],'a fresh reading must not be labelled stale'
    assert claude['meters']==3,claude
    assert page.locator('#root').bounding_box()['width']==1140
    page.screenshot(path=str(out/'sidebar-dark.png'))
    page.get_by_role('button',name='Telemetry',exact=True).click()
    assert not page.get_by_role('complementary',name='Session telemetry').is_visible()
    assert page.locator('#root').bounding_box()['width']==1440
    page.get_by_role('button',name='Telemetry',exact=True).click()
    page.get_by_role('button',name='Refresh telemetry').click()
    assert page.evaluate('window.rpcCalls')==1,'Quota refresh must be throttled'
    page.evaluate('window.fail=true')
    page.get_by_role('button',name='Refresh telemetry').click()
    page.get_by_text('Cannot refresh session metrics.',exact=False).wait_for()
    page.evaluate('window.fail=false')
    page.get_by_role('button',name='Refresh telemetry').click()
    page.wait_for_function("!document.querySelector('#oc-telemetry').shadowRoot.textContent.includes('Cannot refresh session metrics.')")
    page.evaluate("document.documentElement.style.cssText='--background-base:#fafafa;--text-base:#171717;--text-weak:#595959;--border-base:#aaa'")
    page.screenshot(path=str(out/'sidebar-light.png'))
    page.set_viewport_size({'width':800,'height':700})
    assert page.get_by_role('complementary',name='Session telemetry').bounding_box()['width']==300
    assert page.locator('#root').bounding_box()['width']==800
    page.get_by_role('button',name='Refresh telemetry').focus()
    page.keyboard.press('Escape')
    assert page.get_by_role('button',name='Telemetry',exact=True).evaluate('(e)=>e===e.getRootNode().activeElement')
    assert not errors,errors

    # Search panel: query the fake RPC, render hits, open a session tab, close on Escape.
    page.set_viewport_size({'width':1440,'height':1000})
    page.get_by_role('button',name='Search',exact=True).click()
    search=page.get_by_role('complementary',name='Search sessions')
    assert search.is_visible()
    assert not page.get_by_role('complementary',name='Session telemetry').is_visible()
    page.get_by_role('searchbox',name='Search query').fill('rate limit')
    page.wait_for_function("() => window.searchCalls.length && window.searchCalls.at(-1).query === 'rate limit'")
    page.get_by_text('Notes on rate limits',exact=True).wait_for()
    call=page.evaluate('window.searchCalls.at(-1)')
    assert call['roles']==['user','assistant'] and call['limit']==30 and call['page']==1,call
    assert page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelectorAll('.hit').length")==1
    # An empty query loads the recent list (both fake hits), escaped, never live markup.
    page.get_by_role('searchbox',name='Search query').fill('')
    page.wait_for_function("() => window.searchCalls.at(-1).query === ''")
    assert page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelectorAll('.hit').length")==2
    assert page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelectorAll('.hit-snip')[1].innerHTML.includes('&lt;b&gt;')")
    assert page.locator('#oc-telemetry').evaluate("e=>!e.shadowRoot.querySelectorAll('.hit-snip')[1].innerHTML.includes('<b>')")
    # Clicking a hit opens that session as a tab through the app's own route and closes the panel.
    page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelectorAll('.hit')[1].click()")
    assert page.evaluate('location.pathname')=='/server/c2lkZWNhcg/session/ses_hit2'
    assert page.evaluate('window.popstateRoutes.at(-1)')=='/server/c2lkZWNhcg/session/ses_hit2','opening a result must notify the app router'
    assert page.evaluate("window.openedServerKeys.at(-1)")=='sidecar','tab records must use the raw server key, not its route encoding'
    assert page.evaluate("window.openTabs.has('ses_hit2')"),'opening a closed session must create/select its app tab'
    assert not search.is_visible()
    # A slow session lookup makes the two clicks in a double-click overlap. Only one
    # native tab open should be in flight for the same session.
    page.get_by_role('button',name='Search',exact=True).click()
    page.get_by_role('searchbox',name='Search query').fill('rate limit')
    page.get_by_text('Notes on rate limits',exact=True).wait_for()
    page.evaluate("window.openDelay=80;window.openedSessions=[]")
    # Dispatch two clicks synchronously, as a double-click does, before the delayed lookup resolves.
    page.locator('#oc-telemetry').evaluate("e=>{const h=e.shadowRoot.querySelector('.hit');h.click();h.click()}")
    page.wait_for_function("window.openedSessions.length >= 1")
    assert page.evaluate("window.openedSessions.filter(id=>id==='ses_hit1').length")==1,'double-click must not race duplicate tab opens'
    page.evaluate('window.openDelay=0')
    # Escape closes the search panel and returns focus to its button.
    page.get_by_role('button',name='Search',exact=True).click()
    assert search.is_visible()
    page.keyboard.press('Escape')
    assert not search.is_visible()
    assert page.get_by_role('button',name='Search',exact=True).evaluate('(e)=>e===e.getRootNode().activeElement')
    # The production screenshot has a full page of results. Search should get the
    # highlighted-width workspace, reserve that width from the app, and keep every
    # result card tall enough for its text rather than compressing/overlapping hits.
    page.get_by_role('button',name='Search',exact=True).click()
    page.get_by_role('searchbox',name='Search query').fill('__many__')
    page.wait_for_function("() => window.searchCalls.at(-1)?.query === '__many__'")
    page.wait_for_function("() => document.querySelector('#oc-telemetry').shadowRoot.querySelectorAll('.hit').length === 30")
    geometry=page.locator('#oc-telemetry').evaluate("""e=>{
      const panel=e.shadowRoot.querySelector('#search-panel');
      const hits=[...e.shadowRoot.querySelectorAll('.hit')];
      const boxes=hits.map(hit=>hit.getBoundingClientRect());
      return {panelWidth:panel.getBoundingClientRect().width,rootWidth:document.querySelector('#root').getBoundingClientRect().width,
        count:hits.length,compressed:hits.some(hit=>hit.getBoundingClientRect().height+1<hit.scrollHeight),
        overlapping:boxes.some((box,index)=>index>0&&box.top<boxes[index-1].bottom-1)};
    }""")
    print(f'  30-hit search geometry: {geometry}')
    page.screenshot(path=str(out/'search-results.png'))
    assert geometry['panelWidth']==640,geometry
    assert geometry['rootWidth']==800,geometry
    assert not geometry['compressed'] and not geometry['overlapping'],geometry
    assert page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelectorAll('.search-pagination [data-page]').length")==2
    page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelector('.search-pagination [data-page=\"2\"]').click()")
    page.wait_for_function("() => window.searchCalls.at(-1)?.page === 2")
    page.get_by_text('Session result 31',exact=True).wait_for()
    assert page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelectorAll('.hit').length")==30
    assert page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelectorAll('.search-pagination [data-page]').length")==3
    page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelector('.search-pagination [data-page=\"3\"]').click()")
    page.wait_for_function("() => window.searchCalls.at(-1)?.page === 3")
    page.get_by_text('Session result 67',exact=True).wait_for()
    assert page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelectorAll('.hit').length")==7
    assert page.locator('#oc-telemetry').evaluate("e=>e.shadowRoot.querySelectorAll('.search-pagination [data-page]').length")==3
    assert not page.evaluate("window.openTabs.has('ses_many_64')"),'the selected historical session starts closed'
    page.get_by_text('Session result 65',exact=True).click()
    assert page.evaluate('location.pathname')=='/server/c2lkZWNhcg/session/ses_many_64','the clicked result must open its own session'
    assert page.evaluate('window.popstateRoutes.at(-1)')=='/server/c2lkZWNhcg/session/ses_many_64','the app router must receive the selected session route'
    assert page.evaluate("window.openTabs.has('ses_many_64')"),'a closed result must be added to the app tab list'
    assert not search.is_visible()
    assert page.locator('#root').bounding_box()['width']==1440,'closing Search must restore the app workspace width'
    # Telemetry opens its own panel (and closes Search); leave it open for the reload checks below.
    page.get_by_role('button',name='Telemetry',exact=True).click()
    assert page.get_by_role('complementary',name='Session telemetry').is_visible()
    assert not search.is_visible()
    assert not errors,errors

    # Speed abbreviation must reach the rendered panel, not just the pure function.
    # Integer results avoid the locale-specific decimal separator, so these hold everywhere.
    # Decimal and millions cases are covered by the pure-function tests.
    for ms, expected in [(2000,'25 tok/s'),(50,'1K tok/s'),(10,'5K tok/s')]:
        page.set_viewport_size({'width':1440,'height':1000})
        page.goto(f'http://127.0.0.1:8768/tests/ui_harness.html?ms={ms}')
        page.wait_for_load_state('networkidle')
        page.get_by_text(expected,exact=True).wait_for()
        print(f'  generation {ms}ms -> {expected}')
    assert not errors,errors
    browser.close()
    print('UI PASS: metrics, quota, per-model split, MCP, desktop space, collapse, refresh throttle, stale/recovery, search panel, themes, narrow layout, keyboard, speed abbreviations, no page errors')
