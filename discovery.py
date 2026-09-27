"""Locate and patch OpenCode's API-client factory inside a minified renderer bundle.

Nothing here is tied to a particular OpenCode release. The bundle is found by scanning
renderer assets for the client factory, and the factory is matched by shape, so a renamed
function, a different bundle hash, or a new patch release all still work. When the shape
changes, discovery fails loudly instead of writing a broken archive.

The scanner understands enough JavaScript to find a function's closing brace in minified
code: strings, template literals (including nested interpolation), comments, and regex
literals.
"""
import re

WRAPPER = '__localTelemetryAttach'
SESSION_OPENER_BRIDGE = '__localTelemetryOpenSession'
# A real minified client factory, kept as a worked example for tests and documentation.
FACTORY_TEXT = (
    'function TI(e){return CI({baseUrl:e.server.url,fetch:e.fetch,'
    'headers:e.server.password?{Authorization:`Basic ${wI({password:e.server.password})}`}:void 0})}'
)
FACTORY_RE = re.compile(
    r'function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)'
    r'(?=\s*\{\s*return\s+[A-Za-z_$][\w$]*\s*\(\s*\{\s*baseUrl\s*:\s*[A-Za-z_$][\w$]*\.server\.url\s*,)'
)
RETURN_RE = re.compile(r'(\s*)return(\s+)')
# A '/' after one of these cannot be division, so it starts a regex literal.
REGEX_PRECEDERS = set('(,=:[!&|?{};+-*%<>~^')
# A '/' after one of these keywords also starts a regex literal, not division.
REGEX_KEYWORDS = {
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'case', 'do', 'else', 'yield', 'await', 'throw',
}


class UnsupportedBuild(ValueError):
    """The bundle does not have the shape this patcher knows how to modify."""


class Factory:
    __slots__ = ('name', 'parameter', 'inner', 'body_open', 'body_close')

    def __init__(self, name, parameter, inner, body_open, body_close):
        self.name = name
        self.parameter = parameter
        self.inner = inner
        self.body_open = body_open
        self.body_close = body_close


def _skip_template(text, index):
    """index is at a backtick. Returns the index just past the closing backtick."""
    index += 1
    length = len(text)
    while index < length:
        char = text[index]
        if char == '\\':
            index += 2
            continue
        if char == '`':
            return index + 1
        if char == '$' and index + 1 < length and text[index + 1] == '{':
            end = find_function_end(text, index + 1)
            if end is None:
                return -1
            index = end + 1
            continue
        index += 1
    return -1


def _skip_quoted(text, index):
    quote = text[index]
    index += 1
    length = len(text)
    while index < length:
        char = text[index]
        if char == '\\':
            index += 2
            continue
        if char == quote:
            return index + 1
        index += 1
    return -1


def _regex_can_start(text, index):
    position = index - 1
    while position >= 0 and text[position] in ' \t\r\n':
        position -= 1
    if position < 0:
        return True
    char = text[position]
    if char in REGEX_PRECEDERS:
        return True
    if char.isalnum() or char in '_$':
        start = position
        while start >= 0 and (text[start].isalnum() or text[start] in '_$'):
            start -= 1
        return text[start + 1:position + 1] in REGEX_KEYWORDS
    return False


def _skip_regex(text, index):
    index += 1
    in_class = False
    length = len(text)
    while index < length:
        char = text[index]
        if char == '\\':
            index += 2
            continue
        if char == '\n':
            return -1
        if char == '[':
            in_class = True
        elif char == ']':
            in_class = False
        elif char == '/' and not in_class:
            return index + 1
        index += 1
    return -1


def find_function_end(text, open_brace):
    """Index of the '}' matching the '{' at open_brace, or None when unbalanced."""
    depth = 0
    index = open_brace
    length = len(text)
    while index < length:
        char = text[index]
        if char == '{':
            depth += 1
            index += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return index
            index += 1
        elif char == '`':
            following = _skip_template(text, index)
            if following < 0:
                return None
            index = following
        elif char in '\'"':
            following = _skip_quoted(text, index)
            if following < 0:
                return None
            index = following
        elif char == '/' and index + 1 < length:
            following = text[index + 1]
            if following == '/':
                newline = text.find('\n', index)
                if newline < 0:
                    return None
                index = newline + 1
            elif following == '*':
                closing = text.find('*/', index + 2)
                if closing < 0:
                    return None
                index = closing + 2
            elif _regex_can_start(text, index):
                following = _skip_regex(text, index)
                if following < 0:
                    return None
                index = following
            else:
                index += 1
        else:
            index += 1
    return None


def locate_factory(text):
    """Find the API-client factory. Raises UnsupportedBuild when it is absent or ambiguous."""
    if WRAPPER in text:
        raise UnsupportedBuild('This bundle is already patched by the telemetry sidebar.')
    matches = list(FACTORY_RE.finditer(text))
    if not matches:
        raise UnsupportedBuild(
            'Could not find the OpenCode API-client factory in this build. '
            'The desktop app version is probably not supported yet.')
    if len(matches) > 1:
        raise UnsupportedBuild(
            f'Found {len(matches)} candidate client factories; refusing to guess which to patch.')
    match = matches[0]
    body_open = text.index('{', match.end())
    body_close = find_function_end(text, body_open)
    if body_close is None:
        raise UnsupportedBuild('The client factory body could not be scanned to its end.')
    body = text[body_open + 1:body_close]
    inner = re.match(r'\s*return\s+([A-Za-z_$][\w$]*)\s*\(', body)
    if not inner:
        raise UnsupportedBuild('The client factory does not return a single call expression.')
    return Factory(match.group(1), match.group(2), inner.group(1), body_open, body_close)


class PatchResult:
    __slots__ = ('text', 'factory')

    def __init__(self, text, factory):
        self.text = text
        self.factory = factory


def patch_client_factory(text):
    """Wrap the factory's returned client so the sidebar can observe it.

    Only the wrapper call is inserted; every other byte is preserved.
    """
    factory = locate_factory(text)
    body = text[factory.body_open + 1:factory.body_close]
    opening = RETURN_RE.match(body)
    if not opening:
        raise UnsupportedBuild('The client factory does not begin with a return statement.')
    expression_and_tail = body[opening.end():]
    expression = expression_and_tail.rstrip()
    tail = expression_and_tail[len(expression):]
    if not expression or not expression.startswith(factory.inner):
        raise UnsupportedBuild('The client factory return value is not the expected client call.')
    patched_body = f'{opening.group(1)}return{opening.group(2)}{WRAPPER}({expression}){tail}'
    return PatchResult(text[:factory.body_open + 1] + patched_body + text[factory.body_close:], factory)


TABS_PROVIDER_RE = re.compile(r'\bsa\(\{name:`Tabs`,gate:!1,init:\(\)=>\{')
TABS_RETURN_RE = re.compile(r'\breturn\s*\{\.\.\.([A-Za-z_$][\w$]*),store\s*:')


def expose_tabs_session_opener(text):
    """Register a session-tab opener when OpenCode initializes its Tabs provider.

    The session.open action belongs to a route-specific provider and may not exist
    while the sidebar is mounted on a session screen. The Tabs provider owns the
    shared add/select operations, so install the bridge there instead.
    """
    if SESSION_OPENER_BRIDGE in text:
        raise UnsupportedBuild('The OpenCode Tabs session bridge is already present.')
    matches = list(TABS_PROVIDER_RE.finditer(text))
    if not matches:
        raise UnsupportedBuild(
            'Could not find OpenCode\'s shared Tabs provider for session navigation.')
    if len(matches) > 1:
        raise UnsupportedBuild(
            f'Found {len(matches)} candidate Tabs providers; refusing to guess which to expose.')
    provider = matches[0]
    body_open = provider.end() - 1
    body_close = find_function_end(text, body_open)
    if body_close is None:
        raise UnsupportedBuild('The OpenCode Tabs provider body could not be scanned to its end.')
    body = text[body_open + 1:body_close]
    returns = list(TABS_RETURN_RE.finditer(body))
    if len(returns) != 1:
        raise UnsupportedBuild(
            f'Expected one Tabs state return object, found {len(returns)}; refusing to guess.')
    tabs = returns[0].group(1)
    if not re.search(r'\baddSessionTab\s*:', body) or not re.search(r'\bselect\s*(?:\(|:)', body):
        raise UnsupportedBuild('The Tabs provider does not expose addSessionTab and select actions.')
    insertion = body_open + 1 + returns[0].start()
    bridge = (
        f'window.{SESSION_OPENER_BRIDGE}=(session,options)=>{{'
        f'if(!session?.id||!options?.server)return false;'
        f'let tab={tabs}.addSessionTab({{server:options.server,sessionId:session.id}});'
        f'if(!tab||tab.type!==`session`)return false;'
        f'{tabs}.select(tab);return true}};'
    )
    return text[:insertion] + bridge + text[insertion:]


class Bundle:
    __slots__ = ('key', 'text', 'factory', 'patched')

    def __init__(self, key, text, factory, patched):
        self.key = key
        self.text = text
        self.factory = factory
        self.patched = patched


def find_main_bundle(archive, namespace='out/renderer/'):
    """Return the single renderer Bundle holding the client factory.

    A bundle that already carries the wrapper is returned with `patched` set, so callers
    can tell "already patched" apart from "unsupported build".
    """
    candidates = []
    for key in archive.entries():
        if not key.startswith(namespace) or not key.endswith('.js'):
            continue
        data = archive.read(key)
        if b'server.url' not in data:
            continue
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            continue
        if WRAPPER in text:
            candidates.append(Bundle(key, text, None, True))
            continue
        try:
            candidates.append(Bundle(key, text, locate_factory(text), False))
        except UnsupportedBuild:
            continue
    if not candidates:
        raise UnsupportedBuild(
            'No renderer bundle in this build contains the OpenCode API-client factory. '
            'The desktop app version is probably not supported yet.')
    if len(candidates) > 1:
        names = ', '.join(candidate.key for candidate in candidates)
        raise UnsupportedBuild(f'Found the client factory in several bundles ({names}); refusing to guess.')
    return candidates[0]
