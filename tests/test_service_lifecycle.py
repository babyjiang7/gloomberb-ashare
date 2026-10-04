import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from urllib.request import urlopen

from bridge import transport

PROJECT = Path(__file__).resolve().parents[1]


def read_ready(process, timeout=5):
    # Windows selectors cannot monitor a subprocess pipe. A bounded reader
    # thread also works there and is released when cleanup closes the child.
    lines = queue.Queue(maxsize=1)
    threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
    try:
        line = lines.get(timeout=timeout)
    except queue.Empty as error:
        raise AssertionError('Service did not produce a bounded ready handshake') from error
    if not line:
        raise AssertionError('Service exited before its ready handshake')
    return json.loads(line)


class ServiceLifecycleTests(unittest.TestCase):
    def launch(self, runtime, *args):
        child = subprocess.Popen([sys.executable, '-u', '-m', 'bridge.server', '--port', '0',
                                  '--runtime-dir', str(runtime), *args], cwd=PROJECT,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.stop, child)
        return child

    @staticmethod
    def stop(child):
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=3)
        for stream in [child.stdin, child.stdout, child.stderr]:
            if stream and not stream.closed:
                stream.close()

    def test_dynamic_ports_identify_each_child_and_stdin_eof_closes_owned_service(self):
        with tempfile.TemporaryDirectory() as directory:
            first = self.launch(Path(directory) / 'first', '--parent-stdin')
            second = self.launch(Path(directory) / 'second', '--parent-stdin')
            a, b = read_ready(first), read_ready(second)
            self.assertNotEqual(a['listening'], b['listening'])
            for child, ready in [(first, a), (second, b)]:
                self.assertEqual(ready['pid'], child.pid)
                self.assertTrue(ready['parentStdin'])
                with urlopen(ready['listening'] + '/health', timeout=2) as response:
                    health = json.load(response)
                self.assertEqual(health['data']['processId'], child.pid)
                self.assertEqual(health['data']['service'], 'ashare-local')
            first.stdin.close()
            self.assertEqual(first.wait(timeout=3), 0)
            self.assertIsNone(second.poll())
            second.stdin.close()
            self.assertEqual(second.wait(timeout=3), 0)

    @unittest.skipIf(os.name == 'nt', 'Windows terminate() does not deliver a graceful SIGTERM')
    def test_manual_mode_survives_stdin_eof_and_stops_on_sigterm(self):
        with tempfile.TemporaryDirectory() as directory:
            child = self.launch(Path(directory))
            ready = read_ready(child)
            self.assertFalse(ready['parentStdin'])
            child.stdin.close()
            time.sleep(0.2)
            self.assertIsNone(child.poll())
            child.terminate()
            self.assertEqual(child.wait(timeout=3), 0)

    def test_abrupt_parent_death_closes_the_child_stdin_pipe(self):
        with tempfile.TemporaryDirectory() as directory:
            owner_code = (
                "import json,subprocess,sys,time\n"
                "p=subprocess.Popen([sys.executable,'-u','-m','bridge.server','--port','0',"
                "'--parent-stdin','--runtime-dir',sys.argv[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE)\n"
                "print(p.stdout.readline().decode().strip(),flush=True)\n"
                "time.sleep(30)\n"
            )
            owner = subprocess.Popen([sys.executable, '-u', '-c', owner_code, directory], cwd=PROJECT,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.addCleanup(self.stop, owner)
            ready = read_ready(owner)
            owner.kill()
            owner.wait(timeout=3)
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                try:
                    with urlopen(ready['listening'] + '/health', timeout=0.2):
                        pass
                except OSError:
                    break
                time.sleep(0.05)
            else:
                # Only this test's own descendant is eligible for emergency cleanup.
                os.kill(ready['pid'], signal.SIGTERM)
                self.fail('Child retained its listener after owning parent died')

    def test_configured_runtime_directory_keeps_receipts_out_of_the_source_checkout(self):
        previous = transport._RUNTIME_DIR
        self.addCleanup(setattr, transport, '_RUNTIME_DIR', previous)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'owned-runtime'
            transport.configure_runtime_directory(target)
            raw = b'audited local lifecycle fixture'
            receipt = {'sha256': hashlib.sha256(raw).hexdigest()}
            transport.archive('lifecycle', raw, receipt)
            self.assertEqual(transport.runtime_dir(), target.resolve())
            self.assertEqual((target / 'receipts' / ('lifecycle-' + receipt['sha256'] + '.raw')).read_bytes(), raw)


if __name__ == '__main__':
    unittest.main()
