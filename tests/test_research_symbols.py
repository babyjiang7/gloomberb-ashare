import hashlib
import json
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

from bridge import research_symbols as research, server


def encoded(value):
    return json.dumps(value, ensure_ascii=False).encode('utf-8')


def directory_row(code='601138', name='工业富联', initials='gyfl', **changes):
    return {'code': code, 'zwjc': name, 'pinyin': initials, 'category': 'A股', 'orgId': 'org' + code, **changes}


def directory(rows=None):
    return encoded({'stockList': rows or [directory_row(), directory_row('300059', '东方财富', 'dfcf'),
                                        directory_row('601963', '重庆银行', 'cqyh'),
                                        directory_row('600036', '招商银行', 'zsyh'),
                                        directory_row('601916', '浙商银行', 'zsyh')]})


def official_row(**changes):
    return {'code': '601138', 'zwjc': '工业富联', 'pinyin': 'gyfl', 'category': 'A股',
            'type': 'shj', 'delisted': 'false', 'orgId': 'org601138', **changes}


def response(raw, url, acquired=None):
    clock = acquired or datetime.now(timezone.utc).isoformat()
    return raw, {'sourceUrl': url, 'requestedAt': clock, 'receivedAt': clock,
                 'httpStatus': 200, 'sha256': hashlib.sha256(raw).hexdigest()}


class ResearchSymbolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.runtime = patch.object(research, 'runtime_dir', return_value=Path(self.temp.name))
        self.runtime.start()
        self.addCleanup(self.runtime.stop)
        self.calls = []
        research.MEMORY.clear()

    def loader(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return response(directory() if url == research.DIRECTORY_URL else encoded([official_row()]), url)

    def get_search(self, query='工业富联', limit=10, force=False, loader=None):
        with patch.object(research, 'fetch', side_effect=loader or self.loader), patch.object(research, 'archive'):
            return research.get_research_symbols(query, limit, force)

    def get_identity(self, symbol='601138.SH', force=False, loader=None):
        with patch.object(research, 'fetch', side_effect=loader or self.loader), patch.object(research, 'archive'):
            return research.get_research_identity(symbol, force)

    def test_query_normalization_bounds_and_raw_name_preserved(self):
        self.assertEqual(research.normalize_query('　ＧＯＮＧ YE　Fu Lian '), 'gongyefulian')
        self.assertEqual(research.normalize_query('*ST华嵘'), '*st华嵘')
        self.assertEqual(research.normalize_query('６０１１３８．ＳＨ'), '601138.sh')
        for query in ('', ' 　', 'x' * 65, 'a\n', '\u200b', None):
            with self.subTest(query=query), patch.object(research, 'fetch') as fetch:
                with self.assertRaises(ValueError):
                    research.get_research_symbols(query)
                fetch.assert_not_called()
        row = research.parse_directory(directory([directory_row(name=' 工业 富联 ')]))[0]
        self.assertEqual(row['name'], ' 工业 富联 ')
        self.assertEqual(research.match_candidate(row, '工业富联')[1], 'name_exact')

    def test_code_canonical_suffix_and_only_shanghai_shenzhen(self):
        self.assertEqual(research.normalize_symbol('６０１１３８.sh'), '601138.SH')
        self.assertEqual(research.normalize_symbol('300059'), '300059.SZ')
        for code in ('920185', '920185.BJ', '601138.SZ', '300059.SH', '60113', '835185', '', None):
            with self.subTest(code=code), patch.object(research, 'fetch') as fetch:
                with self.assertRaises(ValueError):
                    research.get_research_identity(code)
                fetch.assert_not_called()

    def test_directory_excludes_beijing_b_shares_and_cdr(self):
        rows = [directory_row(), directory_row('920185', '贝特瑞', 'btr'),
                directory_row('900901', '云赛B股', 'ysbg', category='B股'),
                directory_row('689009', '九号公司', 'jhgs', category='CDR')]
        projected = research.parse_directory(directory(rows))
        self.assertEqual([row['symbol'] for row in projected], ['601138.SH'])
        self.assertEqual(projected[0]['exchangeBasis'], 'code_prefix_route')
        self.assertEqual(projected[0]['identityBasis'], 'directory_index')

    def test_malformed_or_duplicate_accepted_directory_rows_fail(self):
        cases = [encoded([]), encoded({'stockList': []}), b'{',
                 encoded({'stockList': [None]}), directory([directory_row(), directory_row()])]
        for changes in ({'zwjc': ''}, {'orgId': '../bad'}, {'pinyin': None}, {'pinyin': 'gy fl'}):
            cases.append(directory([directory_row(**changes)]))
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(research.ResearchSymbolsSourceError):
                research.parse_directory(raw)

    def test_code_chinese_full_pinyin_initials_and_polyphonic(self):
        for query, code, kind in [('601138.SH', '601138', 'code_exact'),
                                  ('工业富联', '601138', 'name_exact'),
                                  ('GONG YE FU LIAN', '601138', 'pinyin_exact'),
                                  ('GYFL', '601138', 'initials_exact'),
                                  ('dongfangcaifu', '300059', 'pinyin_exact'),
                                  ('DFCF', '300059', 'initials_exact'),
                                  ('chongqingyinhang', '601963', 'pinyin_exact'),
                                  ('CQYH', '601963', 'initials_exact')]:
            with self.subTest(query=query):
                data, _ = self.get_search(query)
                self.assertEqual(data['candidates'][0]['code'], code)
                self.assertEqual(data['candidates'][0]['matchKind'], kind)
                self.assertEqual(data['totalMatches'], 1)
        data, _ = self.get_search('工业富联')
        self.assertEqual(data['pinyin']['initialsStyle'], 'FIRST_LETTER')
        self.assertEqual(data['pinyin']['umlaut'], 'v')
        self.assertEqual(data['pinyin']['version'], '0.55.0')
        self.assertTrue(data['pinyin']['derived'])
        self.assertEqual(len(self.calls), 1)

    def test_initials_collision_is_not_auto_selected_and_exact_precedes_prefix(self):
        data, _ = self.get_search('ZSYH')
        self.assertEqual([row['symbol'] for row in data['candidates']], ['600036.SH', '601916.SH'])
        self.assertTrue(all(row['matchKind'] == 'initials_exact' for row in data['candidates']))
        self.assertEqual(data['totalMatches'], 2)
        self.assertNotIn('selectedSymbol', data)
        rows = research.parse_directory(directory([directory_row('600036', '招商银行扩展', 'zsyhkz'),
                                                  directory_row('601916', '招商银行', 'zsyh')]))
        candidates, total = research.search_candidates(rows, '招商银行', 10)
        self.assertEqual(candidates[0]['code'], '601916')
        self.assertEqual([row['matchKind'] for row in candidates], ['name_exact', 'name_prefix'])
        self.assertEqual(total, 2)

    def test_limit_does_not_change_total_and_never_exceeds_ten(self):
        data, _ = self.get_search('银行', limit=1)
        self.assertEqual(len(data['candidates']), 1)
        self.assertEqual(data['totalMatches'], 3)
        for limit in (0, 11, True, 1.5, '1'):
            with self.subTest(limit=limit), patch.object(research, 'fetch') as fetch:
                with self.assertRaises(ValueError):
                    research.get_research_symbols('银行', limit)
                fetch.assert_not_called()
        data, _ = self.get_search('notacompany')
        self.assertEqual(data['candidates'], [])
        self.assertEqual(data['totalMatches'], 0)

    def test_st_name_keeps_official_name_and_normal_initials(self):
        rows = research.parse_directory(directory([directory_row(name='*ST华嵘', initials='sthr')]))
        self.assertEqual(rows[0]['name'], '*ST华嵘')
        self.assertEqual(rows[0]['fullPinyin'], 'sthuarong')
        self.assertEqual(research.search_candidates(rows, 'sthr', 10)[0][0]['name'], '*ST华嵘')
        self.assertEqual(research.derived_pinyin('银娃', research.Style.FIRST_LETTER), 'yw')

    def test_official_initials_narrow_library_readings_without_inventing_pronunciation(self):
        rows = research.parse_directory(directory([directory_row('002032', '苏泊尔', 'sbe'),
                                                  directory_row('000966', '长源电力', 'cydl'),
                                                  directory_row('300729', '乐歌股份', 'lggf'),
                                                  directory_row('603605', '珀莱雅', 'bly')]))
        by_code = {row['code']: row for row in rows}
        self.assertEqual(by_code['002032']['fullPinyin'], 'suboer')
        self.assertEqual(by_code['002032']['generatedInitials'], 'spe')
        self.assertEqual(by_code['000966']['fullPinyin'], 'changyuandianli')
        self.assertEqual(by_code['300729']['fullPinyin'], 'legegufen')
        self.assertEqual(by_code['603605']['fullPinyin'], 'polaiya')
        self.assertEqual(research.search_candidates(rows, 'bly', 10)[0][0]['name'], '珀莱雅')
        self.assertEqual(research.search_candidates(rows, 'suboer', 10)[0][0]['name'], '苏泊尔')
        self.assertIsNone(research.derived_pinyin('𠮷祥', research.Style.NORMAL))

    def test_exact_identity_requires_one_current_a_share_and_valid_fields(self):
        symbol = '601138.SH'
        for row in (official_row(category='CDR'), official_row(delisted='true')):
            with self.subTest(row=row), self.assertRaises(LookupError):
                research.parse_identity(encoded([row]), symbol)
        for raw in (encoded([official_row(), official_row()]), encoded([None]),
                    encoded([official_row(type='sz')]), encoded([official_row(orgId='')]),
                    encoded([official_row(zwjc='')]), encoded([official_row()] * 11)):
            with self.subTest(raw=raw), self.assertRaises(research.ResearchSymbolsSourceError):
                research.parse_identity(raw, symbol)
        with self.assertRaises(LookupError):
            research.parse_identity(encoded([official_row(code='600000')]), symbol)

    def test_shj_is_not_exchange_proof_and_lookup_not_directory_name(self):
        candidate, _ = self.get_search('工业富联')
        def renamed(url, **kwargs):
            self.assertEqual(kwargs['body'], b'')
            self.assertIn('keyWord=601138&maxNum=10', url)
            return response(encoded([official_row(zwjc='官方新简称')]), url)
        current, _ = self.get_identity(loader=renamed)
        self.assertEqual(candidate['candidates'][0]['name'], '工业富联')
        self.assertEqual(current['name'], '官方新简称')
        self.assertEqual(current['officialIdentity']['type'], 'shj')
        self.assertEqual(current['exchangeBasis'], 'code_prefix_route')
        self.assertEqual(current['identityBasis'], 'official_exact_current_code')
        shenzhen = research.parse_identity(encoded([official_row(code='300059', zwjc='东方财富')]), '300059.SZ')
        self.assertEqual(shenzhen['exchange'], 'SZSE')
        self.assertEqual(shenzhen['officialIdentity']['type'], 'shj')

    def test_source_clock_sha_and_disk_cache_are_preserved(self):
        first, meta = self.get_search()
        second, cached = self.get_search('GYFL')
        self.assertFalse(meta['fromCache'])
        self.assertTrue(cached['fromCache'])
        self.assertEqual(first['source'], second['source'])
        self.assertEqual(first['source']['receivedAt'], meta['receivedAt'])
        self.assertEqual(meta['receivedAt'], cached['receivedAt'])
        self.assertLessEqual(cached['receivedAt'], cached['returnedAt'])
        research.MEMORY.clear()
        third, disk = self.get_search('gongyefulian')
        self.assertTrue(disk['fromCache'])
        self.assertEqual(first['source'], third['source'])
        self.assertEqual(len(self.calls), 1)

    def test_identity_cache_preserves_source_and_force_refreshes_same_code_name(self):
        first, original = self.get_identity()
        research.MEMORY.clear()
        second, cached = self.get_identity()
        self.assertEqual(first['source'], second['source'])
        self.assertEqual(original['receivedAt'], cached['receivedAt'])
        self.assertTrue(cached['fromCache'])
        self.assertEqual(len(self.calls), 1)
        def rename(url, **kwargs):
            return response(encoded([official_row(zwjc='更名后的官方简称')]), url)
        renamed, fresh = self.get_identity(force=True, loader=rename)
        self.assertEqual(renamed['symbol'], '601138.SH')
        self.assertEqual(renamed['name'], '更名后的官方简称')
        self.assertFalse(fresh['fromCache'])
        with self.assertRaises(URLError):
            self.get_identity(force=True, loader=lambda *_args, **_kwargs: (_ for _ in ()).throw(URLError('Offline')))

    def test_expired_and_force_cache_do_not_return_old_name_on_source_failure(self):
        self.get_search()
        file = Path(self.temp.name) / 'research-symbol-cache/cninfo-shsz-directory.json'
        saved = json.loads(file.read_text())
        old = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        saved['receipt']['requestedAt'] = saved['receipt']['receivedAt'] = old
        file.write_text(json.dumps(saved))
        research.MEMORY.clear()
        with self.assertRaises(URLError):
            self.get_search(loader=lambda *_args, **_kwargs: (_ for _ in ()).throw(URLError('Offline')))
        self.get_search()
        with self.assertRaises(URLError):
            self.get_search(force=True, loader=lambda *_args, **_kwargs: (_ for _ in ()).throw(URLError('Offline')))

    def test_corrupt_cache_refetches_and_bad_live_receipt_never_archives(self):
        self.get_search()
        file = Path(self.temp.name) / 'research-symbol-cache/cninfo-shsz-directory.json'
        saved = json.loads(file.read_text())
        saved['raw'] = saved['raw'].replace('工业富联', '错公司')
        file.write_text(json.dumps(saved))
        research.MEMORY.clear()
        restored, _ = self.get_search()
        self.assertEqual(restored['candidates'][0]['name'], '工业富联')
        self.assertEqual(len(self.calls), 2)
        def corrupt(url, **kwargs):
            raw, receipt = response(directory(), url)
            return raw, {**receipt, 'sha256': '0' * 64}
        with patch.object(research, 'fetch', side_effect=corrupt), patch.object(research, 'archive') as archive:
            with self.assertRaises(research.ResearchSymbolsSourceError):
                research.get_research_symbols('GYFL', force=True)
            archive.assert_not_called()

    def test_simultaneous_searches_share_one_directory_request(self):
        results, errors = [], []
        def run(query):
            try:
                results.append(research.get_research_symbols(query))
            except Exception as error:
                errors.append(error)
        with patch.object(research, 'fetch', side_effect=self.loader), patch.object(research, 'archive'):
            threads = [threading.Thread(target=run, args=(q,)) for q in ('GYFL', 'DFCF', 'CQYH')]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(3)
        self.assertFalse(errors)
        self.assertEqual(len(results), 3)
        self.assertEqual(len(self.calls), 1)

    def test_read_only_routes_reject_duplicates_force_and_bad_limits(self):
        with patch.object(server, 'get_research_symbols', return_value=({}, {})) as search:
            server.route('/v1/research-symbols', {'q': ['GYFL'], 'limit': ['2']})
            search.assert_called_once_with('GYFL', 2, False)
        with patch.object(server, 'get_research_identity', return_value=({}, {})) as identity:
            server.route('/v1/research-identity', {'symbol': ['601138.SH'], 'force': ['1']})
            identity.assert_called_once_with('601138.SH', True)
        for path, params in [('/v1/research-symbols', {'q': ['a', 'b']}),
                             ('/v1/research-symbols', {'q': ['a'], 'limit': ['two']}),
                             ('/v1/research-identity', {'symbol': ['601138.SH'], 'force': ['yes']})]:
            with self.subTest(path=path, params=params), self.assertRaises(ValueError):
                server.route(path, params)


if __name__ == '__main__':
    unittest.main()
