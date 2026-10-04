"""Bounded HTTP reads with acquisition receipts and preserved cache timestamps."""
import hashlib
import json
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
_RUNTIME_DIR = None
MAX_BYTES = 2 * 1024 * 1024

def configure_runtime_directory(directory):
    """Choose this service process's cache/receipt directory before serving."""
    global _RUNTIME_DIR
    _RUNTIME_DIR = Path(directory).expanduser().resolve()
    _RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

def runtime_dir():
    return _RUNTIME_DIR if _RUNTIME_DIR is not None else ROOT / 'runtime'

def utc_now():
    return datetime.now(timezone.utc).isoformat()

def fetch(url, *, body=None, headers=None):
    started = utc_now()
    request = Request(url, data=body, headers={'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'identity', **(headers or {})})
    with urlopen(request, timeout=12) as response:
        raw = response.read(MAX_BYTES + 1)
        status = response.status
    if len(raw) > MAX_BYTES:
        raise ValueError('Upstream response exceeded size bound')
    if status != 200:
        raise ConnectionError(f'Upstream HTTP {status}')
    return raw, {'sourceUrl': url, 'requestedAt': started, 'receivedAt': utc_now(),
                 'httpStatus': status, 'sha256': hashlib.sha256(raw).hexdigest()}

def archive(name, raw, receipt):
    folder = runtime_dir() / 'receipts'
    folder.mkdir(parents=True, exist_ok=True)
    # Content identity allows repeated refreshes without pretending the content changed.
    target = folder / (name + '-' + receipt['sha256'] + '.raw')
    target.write_bytes(raw)
    (folder / (name + '-latest.json')).write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    for old in sorted(folder.glob(name + '-*.raw'), key=lambda path:path.stat().st_mtime, reverse=True)[32:]:
        old.unlink(missing_ok=True)

class Cache:
    def __init__(self, ttl=30, max_entries=128):
        self.ttl, self.max_entries = ttl, max_entries
        self.values, self.lock = OrderedDict(), threading.RLock()

    def get(self, key, loader):
        with self.lock:
            entry = self.values.get(key)
            if entry and time.monotonic() - entry[0] < self.ttl:
                self.values.move_to_end(key)
                return entry[1]
            result = loader()
            self.values[key] = (time.monotonic(), result)
            self.values.move_to_end(key)
            while len(self.values) > self.max_entries:
                self.values.popitem(last=False)
            return result
