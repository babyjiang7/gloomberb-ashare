"""Loopback-only CNINFO search and current-issuer identity API."""
import argparse
import json
import os
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from .research_symbols import get_research_symbols, get_research_identity
from .transport import configure_runtime_directory, utc_now

def route(path, params):
    def get(key,default=None):
        values = params.get(key)
        if values and len(values)!=1:
            raise ValueError('Duplicate request parameter')
        value = values[0] if values else default
        if value is None:
            raise ValueError('Missing request parameter: '+key)
        return value
    if path == '/health':
        return {'service':'ashare-local','schemaVersion':1,'readOnly':True,
                'processId':os.getpid(),
                'scope':'shanghai-shenzhen-a-shares',
                'operations':['research-symbols','research-identity']}, {'receivedAt':utc_now(),'mode':'health'}
    if path in ('/v1/research-symbols', '/v1/research-identity'):
        force = get('force', '0')
        if force not in ('0', '1'):
            raise ValueError('force must be 0 or 1')
        if path == '/v1/research-symbols':
            return get_research_symbols(get('q'), int(get('limit', '10')), force == '1')
        return get_research_identity(get('symbol'), force == '1')
    raise LookupError('Unknown route')

class Handler(BaseHTTPRequestHandler):
    def send_json(self,status,body):
        raw = json.dumps(body,ensure_ascii=False,allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(raw)))
        self.send_header('Cache-Control','no-store')
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if len(self.path)>4096:
            return self.send_json(414,{'ok':False,'error':{'code':'invalid_request','message':'Request too long'}})
        target = urlsplit(self.path)
        try:
            data,meta = route(target.path,parse_qs(target.query,keep_blank_values=True,max_num_fields=12))
            self.send_json(200,{'ok':True,'data':data,'meta':meta})
        except ValueError as error:
            self.send_json(400,{'ok':False,'error':{'code':'invalid_request','message':str(error)}})
        except LookupError as error:
            self.send_json(404,{'ok':False,'error':{'code':'not_found','message':str(error)}})
        except Exception as error:
            self.send_json(502,{'ok':False,'error':{'code':'source_unavailable','message':str(error)}})

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--parent-stdin',action='store_true',
                        help='Stop when the owning host closes its stdin pipe')
    parser.add_argument('--runtime-dir',help='Directory for this service process\'s receipts and cache')
    args=parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error('--port must be between 0 and 65535')
    if args.runtime_dir:
        configure_runtime_directory(args.runtime_dir)
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    server.daemon_threads=True
    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    print(json.dumps({'event':'ready','service':'ashare-local','schemaVersion':1,
                      'listening':f'http://127.0.0.1:{server.server_port}',
                      'pid':os.getpid(),'readOnly':True,'parentStdin':args.parent_stdin}),flush=True)
    if args.parent_stdin:
        def watch_parent():
            try:
                while sys.stdin.buffer.read(64):
                    pass
            finally:
                server.shutdown()
        threading.Thread(target=watch_parent,daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__=='__main__':
    main()
