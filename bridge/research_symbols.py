"""CNINFO issuer candidates and separately verified current Shanghai/Shenzhen names.

Directory pinyin is official initials. Full pinyin is a derived search aid, never
identity evidence. CNINFO's `shj` page type does not identify an exchange.
"""
import hashlib
import json
import re
import tempfile
import threading
import unicodedata
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

from pypinyin import Style, __version__ as PINYIN_VERSION, lazy_pinyin, pinyin

from .transport import MAX_BYTES, archive, fetch, runtime_dir, utc_now

DIRECTORY_URL = 'https://www.cninfo.com.cn/new/data/szse_stock.json'
IDENTITY_ENDPOINT = 'https://www.cninfo.com.cn/new/information/topSearch/query'
DIRECTORY_TTL = 86400
IDENTITY_TTL = 300
MAX_ROWS = 20000
MAX_CACHE_ENTRIES = 128
LOCK = threading.RLock()
MEMORY = OrderedDict()
LIMITATIONS = [
    'The directory is a candidate index; it has no delisted or exchange field. Selection requires an exact current-issuer lookup.',
    'Exchange routing is inferred from the security-code prefix, not from CNINFO page type shj.',
    'Full pinyin and generated initials are derived using pypinyin; polyphonic names may have other readings. Phonetic collisions are not automatically selected.',
]


class ResearchSymbolsSourceError(RuntimeError):
    """An upstream shape or identity cannot be trusted."""


def normalize_query(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 64:
        raise ValueError('Search query must contain 1 to 64 characters')
    if any(unicodedata.category(char).startswith('C') for char in value):
        raise ValueError('Search query contains a control character')
    normalized = ''.join(char for char in unicodedata.normalize('NFKC', value) if not char.isspace()).casefold()
    if not normalized:
        raise ValueError('Search query must not be empty')
    return normalized


def normalized_field(value):
    return ''.join(char for char in unicodedata.normalize('NFKC', value) if not char.isspace()).casefold()


def normalize_symbol(value):
    if not isinstance(value, str):
        raise ValueError('A Shanghai or Shenzhen A-share code is required')
    match = re.fullmatch(r'((?:60|68|00|30)\d{4})(?:\.(SH|SZ))?', unicodedata.normalize('NFKC', value).strip().upper())
    if not match:
        raise ValueError('Research identity accepts Shanghai/Shenzhen A-share codes only')
    code, suffix = match.groups()
    expected = 'SH' if code.startswith(('60', '68')) else 'SZ'
    if suffix is not None and suffix != expected:
        raise ValueError('Security code and exchange suffix disagree')
    return code + '.' + expected


def exchange(symbol):
    return 'SSE' if symbol.endswith('.SH') else 'SZSE'


def source_text(value, field, limit=128):
    if (not isinstance(value, str) or not value.strip() or len(value) > limit
            or any(unicodedata.category(char).startswith('C') for char in value)):
        raise ResearchSymbolsSourceError('Invalid source ' + field)
    return value


def parse_json(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_BYTES:
        raise ResearchSymbolsSourceError('Invalid or oversized security response')
    try:
        return json.loads(raw, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError('Non-finite JSON')))
    except (ValueError, UnicodeError) as error:
        raise ResearchSymbolsSourceError('Invalid security JSON') from error


def derived_pinyin(name, style):
    # NORMAL uses v for ü. FIRST_LETTER includes vowel/y/w initials; INITIALS does not.
    value = normalized_field(''.join(lazy_pinyin(name, style=style)))
    if any(unicodedata.category(char).startswith('L') and not char.isascii() for char in value):
        return None
    value = re.sub('[^a-z0-9]', '', value)
    return value if re.fullmatch('[a-z0-9]{1,256}', value) else None


def full_pinyin(name, official_initials, generated_initials):
    default = derived_pinyin(name, Style.NORMAL)
    if default is None or generated_initials == official_initials:
        return default
    # Only choose readings present in the library. Official initials can narrow
    # polyphonic choices, but cannot prove a full pronunciation or create one.
    characters = [char for char in unicodedata.normalize('NFKC', name)
                  if char.isalnum()]
    if len(characters) != len(official_initials):
        return default
    phrase = pinyin(''.join(characters), style=Style.NORMAL, heteronym=True,
                    errors=lambda text: list(text))
    if len(phrase) != len(characters):
        return default
    selected = []
    for char, options, initial in zip(characters, phrase, official_initials):
        readings = [normalized_field(option) for option in options]
        chosen = next((reading for reading in readings
                       if re.fullmatch('[a-z0-9]+', reading) and reading.startswith(initial)), None)
        if chosen is None:
            # A phrase dictionary can suppress a valid single-character reading.
            readings = pinyin(char, style=Style.NORMAL, heteronym=True,
                              errors=lambda text: list(text))[0]
            chosen = next((normalized_field(reading) for reading in readings
                           if re.fullmatch('[a-z0-9]+', normalized_field(reading))
                           and normalized_field(reading).startswith(initial)), None)
        if chosen is None:
            return default
        selected.append(chosen)
    return ''.join(selected)


def parse_directory(raw):
    payload = parse_json(raw)
    if not isinstance(payload, dict) or not isinstance(payload.get('stockList'), list) or not 1 <= len(payload['stockList']) <= MAX_ROWS:
        raise ResearchSymbolsSourceError('Invalid security directory')
    candidates, seen = [], set()
    for row in payload['stockList']:
        if not isinstance(row, dict):
            raise ResearchSymbolsSourceError('Invalid directory row')
        code = row.get('code')
        # Exclude Beijing, B shares and CDR, including routable 689xxx CDRs.
        if row.get('category') != 'A股' or not isinstance(code, str) or not re.fullmatch(r'(?:60|68|00|30)\d{4}', code):
            continue
        symbol = normalize_symbol(code)
        if symbol in seen:
            raise ResearchSymbolsSourceError('Duplicate or conflicting directory security code')
        seen.add(symbol)
        name = source_text(row.get('zwjc'), 'issuer name')
        org_id = source_text(row.get('orgId'), 'organization ID', 64)
        if not re.fullmatch('[A-Za-z0-9_-]+', org_id):
            raise ResearchSymbolsSourceError('Invalid source organization ID')
        initials = source_text(row.get('pinyin'), 'pinyin initials', 128)
        if not re.fullmatch('[A-Za-z0-9]+', initials):
            raise ResearchSymbolsSourceError('Invalid official pinyin initials')
        generated_initials = derived_pinyin(name, Style.FIRST_LETTER)
        candidates.append({'symbol': symbol, 'code': code, 'exchange': exchange(symbol),
                           'exchangeBasis': 'code_prefix_route', 'category': 'A股',
                           'name': name, 'orgId': org_id, 'officialInitials': initials.casefold(),
                           'fullPinyin': full_pinyin(name, initials.casefold(), generated_initials),
                           'generatedInitials': generated_initials,
                           'identityBasis': 'directory_index'})
    if not candidates:
        raise ResearchSymbolsSourceError('Directory has no Shanghai/Shenzhen A-share candidates')
    return sorted(candidates, key=lambda row: row['code'])


def match_candidate(row, query):
    fields = [('code', [row['code'], row['symbol'].casefold()]),
              ('name', [normalized_field(row['name'])]),
              ('pinyin', [row['fullPinyin']] if row['fullPinyin'] else []),
              ('initials', list(dict.fromkeys(value for value in (row['officialInitials'], row['generatedInitials']) if value)))]
    for rank, (kind, values) in enumerate(fields):
        if query in values:
            return rank, kind + '_exact'
    for rank, (kind, values) in enumerate(fields, start=4):
        if any(value.startswith(query) for value in values):
            return rank, kind + '_prefix'
    for rank, (kind, values) in enumerate(fields[1:], start=8):
        if any(query in value for value in values):
            return rank, kind + '_contains'
    return None


def search_candidates(rows, query, limit):
    matches = []
    for row in rows:
        match = match_candidate(row, query)
        if match:
            matches.append((match[0], row['code'], {**row, 'matchKind': match[1]}))
    matches.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in matches[:limit]], len(matches)


def identity_url(symbol):
    return IDENTITY_ENDPOINT + '?' + urlencode({'keyWord': symbol[:6], 'maxNum': 10})


def parse_identity(raw, symbol):
    rows = parse_json(raw)
    if not isinstance(rows, list) or len(rows) > 10 or any(not isinstance(row, dict) for row in rows):
        raise ResearchSymbolsSourceError('Invalid exact issuer response')
    matches = [row for row in rows if row.get('code') == symbol[:6]]
    if len(matches) > 1:
        raise ResearchSymbolsSourceError('Ambiguous exact issuer identity')
    if not matches:
        raise LookupError('No current A-share issuer matches this security code')
    row = matches[0]
    if row.get('category') != 'A股' or row.get('delisted') != 'false':
        raise LookupError('This security is not a current Shanghai/Shenzhen A-share issuer')
    if row.get('type') != 'shj':
        raise ResearchSymbolsSourceError('Unexpected official stock page category')
    name = source_text(row.get('zwjc'), 'current issuer name')
    org_id = source_text(row.get('orgId'), 'organization ID', 64)
    initials = source_text(row.get('pinyin'), 'pinyin initials')
    if not re.fullmatch('[A-Za-z0-9_-]+', org_id) or not re.fullmatch('[A-Za-z0-9]+', initials):
        raise ResearchSymbolsSourceError('Invalid official issuer identity fields')
    official = {field: row[field] for field in ('code', 'pinyin', 'category', 'type', 'delisted', 'orgId', 'zwjc')}
    return {'schemaVersion': 1, 'mode': 'cninfo_shsz_identity', 'symbol': symbol,
            'code': symbol[:6], 'exchange': exchange(symbol), 'exchangeBasis': 'code_prefix_route',
            'name': name, 'orgId': org_id, 'identityBasis': 'official_exact_current_code',
            'officialIdentity': official}


def validate_receipt(raw, receipt, url, ttl):
    try:
        requested = datetime.fromisoformat(receipt['requestedAt'])
        received = datetime.fromisoformat(receipt['receivedAt'])
        if (receipt['sourceUrl'] != url or receipt['httpStatus'] != 200
                or receipt['sha256'] != hashlib.sha256(raw).hexdigest()
                or requested.tzinfo is None or received.tzinfo is None or requested > received):
            raise ValueError('Receipt does not describe the security response')
    except (KeyError, TypeError, ValueError) as error:
        raise ResearchSymbolsSourceError('Invalid security acquisition receipt') from error
    return {**receipt, 'provider': 'cninfo', 'sourceVersion': None, 'cacheTtlSeconds': ttl}


def cache_valid(receipt, ttl):
    try:
        received = datetime.fromisoformat(receipt['receivedAt'])
        age = (datetime.now(timezone.utc) - received).total_seconds()
        return receipt['cacheTtlSeconds'] == ttl and 0 <= age < ttl
    except (KeyError, TypeError, ValueError):
        return False


def load_source(key, url, ttl, parser, *, force=False, post=False):
    cache_dir = runtime_dir() / 'research-symbol-cache'
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / (key + '.json')
    memory_key = str(cache_file)
    # Serialize first reads/refreshes so concurrent search panes share one source request.
    with LOCK:
        existing = MEMORY.get(memory_key)
        if not force and existing and cache_valid(existing[1], ttl):
            MEMORY.move_to_end(memory_key)
            return existing[0], existing[1], True
        if not force and cache_file.exists() and cache_file.stat().st_size <= MAX_BYTES * 2:
            try:
                saved = json.loads(cache_file.read_text())
                raw = saved['raw'].encode('utf-8')
                receipt = validate_receipt(raw, saved['receipt'], url, ttl)
                if cache_valid(receipt, ttl):
                    parsed = parser(raw)
                    remember(memory_key, parsed, receipt)
                    return parsed, receipt, True
            except (KeyError, TypeError, ValueError, ResearchSymbolsSourceError):
                pass
        raw, receipt = fetch(url, body=b'' if post else None,
                             headers={'Referer': 'https://www.cninfo.com.cn/',
                                      **({'Content-Type': 'application/x-www-form-urlencoded'} if post else {})})
        receipt = validate_receipt(raw, receipt, url, ttl)
        parsed = parser(raw)
        archive(key, raw, receipt)
        with tempfile.NamedTemporaryFile(mode='w', dir=cache_dir, suffix='.tmp', delete=False) as temporary:
            json.dump({'raw': raw.decode('utf-8'), 'receipt': receipt}, temporary, ensure_ascii=False)
            temporary_path = Path(temporary.name)
        try:
            temporary_path.replace(cache_file)
        finally:
            temporary_path.unlink(missing_ok=True)
        remember(memory_key, parsed, receipt)
        for old in sorted(cache_dir.glob('*.json'), key=lambda path: path.stat().st_mtime, reverse=True)[MAX_CACHE_ENTRIES:]:
            old.unlink(missing_ok=True)
        return parsed, receipt, False


def remember(key, parsed, receipt):
    MEMORY[key] = parsed, receipt
    MEMORY.move_to_end(key)
    while len(MEMORY) > MAX_CACHE_ENTRIES:
        MEMORY.popitem(last=False)


def source_metadata(receipt):
    return {'provider': 'cninfo', 'sourceURL': receipt['sourceUrl'], 'receivedAt': receipt['receivedAt'],
            'sha256': receipt['sha256'], 'sourceVersion': None}


def get_research_symbols(query, limit=10, force=False):
    normalized = normalize_query(query)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10:
        raise ValueError('Search limit must be an integer from 1 to 10')
    rows, receipt, cached = load_source('cninfo-shsz-directory', DIRECTORY_URL, DIRECTORY_TTL, parse_directory, force=force)
    candidates, total = search_candidates(rows, normalized, limit)
    data = {'schemaVersion': 1, 'mode': 'cninfo_shsz_search', 'query': query, 'normalizedQuery': normalized,
            'limit': limit, 'totalMatches': total, 'candidates': candidates,
            'pinyin': {'provider': 'pypinyin', 'version': PINYIN_VERSION, 'derived': True,
                       'fullStyle': 'NORMAL', 'initialsStyle': 'FIRST_LETTER', 'umlaut': 'v',
                       'fullReading': 'phrase_then_official_initials_guided_heteronym'},
            'source': source_metadata(receipt), 'limitations': LIMITATIONS}
    return data, {**receipt, 'mode': data['mode'], 'fromCache': cached, 'returnedAt': utc_now()}


def get_research_identity(raw_symbol, force=False):
    symbol = normalize_symbol(raw_symbol)
    data, receipt, cached = load_source('cninfo-shsz-identity-' + symbol, identity_url(symbol), IDENTITY_TTL,
                                       lambda raw: parse_identity(raw, symbol), force=force, post=True)
    return {**data, 'source': source_metadata(receipt)}, {**receipt, 'mode': data['mode'],
                                                        'fromCache': cached, 'returnedAt': utc_now()}
