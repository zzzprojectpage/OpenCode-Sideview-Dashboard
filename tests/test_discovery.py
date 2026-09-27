import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import discovery

REAL_FACTORY = (
    'function TI(e){return CI({baseUrl:e.server.url,fetch:e.fetch,'
    'headers:e.server.password?{Authorization:`Basic ${wI({password:e.server.password})}`}:void 0})}'
)


class FindFunctionEndTests(unittest.TestCase):
    def test_simple_body(self):
        text = 'function a(){return b({x:1})}'
        open_brace = text.index('{')
        self.assertEqual(discovery.find_function_end(text, open_brace), len(text) - 1)

    def test_regex_literal_after_a_keyword_is_not_division(self):
        for text in ['function a(){return /}/.test(x)}tail',
                     'function a(){return typeof /{/.source}tail',
                     'function a(){x = y ? /}/ : 1}tail']:
            with self.subTest(text=text):
                self.assertEqual(discovery.find_function_end(text, text.index('{')), text.index('}tail'))

    def test_nested_objects_and_calls(self):
        text = 'function a(){return b({c:{d:1}},e(2))}tail'
        self.assertEqual(discovery.find_function_end(text, text.index('{')),
                         text.index('}tail'))

    def test_brace_inside_single_quoted_string(self):
        text = "function a(){return '}}}'}tail"
        self.assertEqual(discovery.find_function_end(text, text.index('{')), text.index('}tail'))

    def test_brace_inside_double_quoted_string_with_escape(self):
        text = 'function a(){return "a\\"}}}b"}tail'
        self.assertEqual(discovery.find_function_end(text, text.index('{')), text.index('}tail'))

    def test_template_literal_with_interpolation_containing_braces(self):
        text = 'function a(){return `x${ {y:1} }z`}tail'
        self.assertEqual(discovery.find_function_end(text, text.index('{')), text.index('}tail'))

    def test_nested_template_literal_inside_interpolation(self):
        text = 'function a(){return `${`${ {q:1} }`}`}tail'
        self.assertEqual(discovery.find_function_end(text, text.index('{')), text.index('}tail'))

    def test_line_comment_containing_braces(self):
        text = 'function a(){// }}}\nreturn 1}tail'
        self.assertEqual(discovery.find_function_end(text, text.index('{')), text.index('}tail'))

    def test_block_comment_containing_braces(self):
        text = 'function a(){/* }}} */return 1}tail'
        self.assertEqual(discovery.find_function_end(text, text.index('{')), text.index('}tail'))

    def test_regex_literal_containing_brace(self):
        text = 'function a(){return /}/.test(x)}tail'
        self.assertEqual(discovery.find_function_end(text, text.index('{')), text.index('}tail'))

    def test_division_is_not_treated_as_a_regex(self):
        text = 'function a(){return (x/total)+y}tail'
        self.assertEqual(discovery.find_function_end(text, text.index('{')), text.index('}tail'))

    def test_unbalanced_input_returns_none(self):
        self.assertIsNone(discovery.find_function_end('function a(){return 1', 11))


class LocateFactoryTests(unittest.TestCase):
    def test_locates_the_real_factory_shape(self):
        found = discovery.locate_factory(REAL_FACTORY)
        self.assertEqual(found.name, 'TI')
        self.assertEqual(found.inner, 'CI')
        self.assertEqual(found.parameter, 'e')

    def test_locates_a_differently_named_factory(self):
        renamed = REAL_FACTORY.replace('TI', 'zz').replace('(e)', '(q)').replace('e.server', 'q.server').replace('e.fetch', 'q.fetch')
        found = discovery.locate_factory('var pad=1;' + renamed + ';var after=2;')
        self.assertEqual(found.name, 'zz')
        self.assertEqual(found.parameter, 'q')

    def test_rejects_an_already_patched_bundle(self):
        with self.assertRaises(discovery.UnsupportedBuild):
            discovery.locate_factory(discovery.patch_client_factory(REAL_FACTORY).text)

    def test_rejects_when_no_factory_is_present(self):
        with self.assertRaises(discovery.UnsupportedBuild):
            discovery.locate_factory('function other(){return 1}')

    def test_rejects_an_ambiguous_bundle(self):
        with self.assertRaisesRegex(discovery.UnsupportedBuild, '2'):
            discovery.locate_factory(REAL_FACTORY + REAL_FACTORY)


class PatchFactoryTests(unittest.TestCase):
    def test_wraps_the_returned_client_and_keeps_the_rest_byte_identical(self):
        result = discovery.patch_client_factory(REAL_FACTORY)
        self.assertIn('return __localTelemetryAttach(CI({baseUrl:e.server.url', result.text)
        self.assertTrue(result.text.endswith('}))}'), result.text[-20:])
        self.assertEqual(result.text.count('__localTelemetryAttach'), 1)
        # Removing the wrapper must reproduce the original byte for byte.
        # The wrapper's own closing paren sits just before the factory's final '}'.
        stripped = result.text.replace('return __localTelemetryAttach(', 'return ', 1)
        self.assertTrue(stripped.endswith('}))}'), stripped[-10:])
        stripped = stripped[:-2] + '}'
        self.assertEqual(stripped, REAL_FACTORY)

    def test_patched_factory_stays_brace_and_paren_balanced(self):
        result = discovery.patch_client_factory(REAL_FACTORY)
        for open_char, close_char in [('{', '}'), ('(', ')'), ('[', ']')]:
            self.assertEqual(result.text.count(open_char), result.text.count(close_char),
                             f'{open_char}{close_char} must balance')

    def test_surrounding_bundle_text_is_preserved(self):
        bundle = 'var head=1;' + REAL_FACTORY + ';var tail=2;'
        result = discovery.patch_client_factory(bundle)
        self.assertTrue(result.text.startswith('var head=1;function TI(e){return __localTelemetryAttach('))
        self.assertTrue(result.text.endswith(';var tail=2;'))


if __name__ == '__main__':
    unittest.main()
