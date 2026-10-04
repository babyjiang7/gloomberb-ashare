import json
import os
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from bridge import server


class QuietHandler(server.Handler):
    def log_message(self, _format, *_args):
        pass


class ServerRouteTests(unittest.TestCase):
    def test_health_describes_only_the_search_and_identity_service(self):
        with patch.object(server, 'get_research_symbols') as search, patch.object(server, 'get_research_identity') as identity:
            data, meta = server.route('/health', {})
        self.assertEqual(data['service'], 'ashare-local')
        self.assertEqual(data['processId'], os.getpid())
        self.assertTrue(data['readOnly'])
        self.assertEqual(data['scope'], 'shanghai-shenzhen-a-shares')
        self.assertEqual(data['operations'], ['research-symbols', 'research-identity'])
        self.assertNotIn('supportedSecurities', data)
        self.assertNotIn('financialMode', data)
        self.assertEqual(meta['mode'], 'health')
        search.assert_not_called()
        identity.assert_not_called()

    def test_search_and_identity_forward_only_valid_scalar_arguments(self):
        result = ({'schemaVersion': 1}, {'mode': 'fixture'})
        with patch.object(server, 'get_research_symbols', return_value=result) as search:
            self.assertEqual(server.route('/v1/research-symbols', {'q': ['GYFL']}), result)
            search.assert_called_once_with('GYFL', 10, False)
        with patch.object(server, 'get_research_identity', return_value=result) as identity:
            self.assertEqual(server.route('/v1/research-identity', {'symbol': ['601138.SH'], 'force': ['1']}), result)
            identity.assert_called_once_with('601138.SH', True)

    def test_retired_routes_never_call_an_upstream_loader(self):
        with patch.object(server, 'get_research_symbols') as search, patch.object(server, 'get_research_identity') as identity:
            for path in ['/v1/symbols', '/v1/quotes', '/v1/history', '/v1/financials', '/v1/announcements', '/v1/cash-flow', '/v1/profit', '/v1/research-company']:
                with self.subTest(path=path), self.assertRaises(LookupError):
                    server.route(path, {})
            search.assert_not_called()
            identity.assert_not_called()

    def test_missing_duplicate_and_invalid_parameters_fail_before_query(self):
        invalid = [{}, {'q': ['GYFL', 'DFCF']}, {'q': ['GYFL'], 'force': ['2']},
                   {'q': ['GYFL'], 'force': ['0', '1']}, {'q': ['GYFL'], 'limit': ['1.5']},
                   {'q': ['GYFL'], 'limit': ['1', '2']}]
        with patch.object(server, 'get_research_symbols') as search:
            for params in invalid:
                with self.subTest(params=params), self.assertRaises(ValueError):
                    server.route('/v1/research-symbols', params)
            search.assert_not_called()


class ServerHttpTests(unittest.TestCase):
    def setUp(self):
        self.server = server.ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': 0.01})
        self.thread.start()
        self.addCleanup(self.close)
        self.base = f'http://127.0.0.1:{self.server.server_port}'

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.assertFalse(self.thread.is_alive())

    def read(self, path, status):
        try:
            response = urlopen(self.base + path, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            self.assertEqual(response.status, status)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(response.headers['Content-Type'], 'application/json; charset=utf-8')
            return json.load(response)

    def test_removed_route_and_invalid_request_have_explicit_error_codes(self):
        self.assertEqual(self.read('/v1/financials?symbol=601138.SH', 404)['error']['code'], 'not_found')
        self.assertEqual(self.read('/v1/research-symbols?q=GYFL&q=DFCF', 400)['error']['code'], 'invalid_request')
        self.assertEqual(self.read('/v1/research-symbols?q=' + 'x' * 4096, 414)['error']['code'], 'invalid_request')

    def test_source_failure_is_not_reported_as_an_empty_success(self):
        with patch.object(server, 'get_research_symbols', side_effect=ConnectionError('CNINFO unavailable')):
            body = self.read('/v1/research-symbols?q=GYFL', 502)
        self.assertFalse(body['ok'])
        self.assertEqual(body['error']['code'], 'source_unavailable')
        self.assertNotIn('data', body)

    def test_get_response_retains_upstream_data_and_receipt(self):
        result = ({'candidates': []}, {'receivedAt': '2026-10-05T02:19:30+08:00', 'mode': 'cninfo_shsz_search'})
        with patch.object(server, 'get_research_symbols', return_value=result):
            body = self.read('/v1/research-symbols?q=GYFL', 200)
        self.assertEqual(body, {'ok': True, 'data': result[0], 'meta': result[1]})

    def test_mutating_http_method_is_not_supported(self):
        with patch.object(server, 'get_research_symbols') as search:
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(self.base + '/v1/research-symbols?q=GYFL', method='POST'), timeout=2)
            self.assertEqual(caught.exception.code, 501)
            caught.exception.close()
            search.assert_not_called()


if __name__ == '__main__':
    unittest.main()
