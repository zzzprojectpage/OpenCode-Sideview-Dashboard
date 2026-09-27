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
    print('UI PASS: metrics, quota, per-model split, MCP, desktop space, collapse, refresh throttle, stale/recovery, themes, narrow layout, keyboard, speed abbreviations, no page errors')
