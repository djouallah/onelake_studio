# Copies a local folder to OneLake as it is, replacing what was there:
#   ONELAKE_TOKEN=<storage token> python upload.py <local folder> <https://onelake.dfs.fabric.microsoft.com/<ws>/<item>/<path>>
# DFS's own calls: delete the folder, then each file created, appended and flushed. A table is copied log last,
# so a reader never finds a commit whose files aren't there yet.
import os, sys, time, urllib.request, urllib.error, urllib.parse

LOCAL, URL = sys.argv[1], sys.argv[2].rstrip('/')
TOKEN = os.environ['ONELAKE_TOKEN']

def call(method, url, body=None, ok=(200, 201, 202), headers=None):
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header('Authorization', f'Bearer {TOKEN}'); req.add_header('x-ms-version', '2023-11-03')
    for k, v in (headers or {}).items(): req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return r.status
    except urllib.error.HTTPError as e:
        if e.code in ok: return e.code
        if e.code in (408, 429, 500, 502, 503, 504): raise Busy(f'{method} {url}: {e.code}')
        raise RuntimeError(f'{method} {url}: {e.code} {e.read()[:300]!r}')
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        raise Busy(f'{method} {url}: {e}')

# No answer, or one that says try again. A table is hundreds of calls, and one refused connection ended the job.
class Busy(Exception): pass

# `step` again from its start, a few times, when OneLake didn't answer: each step here can be done twice.
def again(step):
    for attempt in range(5):
        try: return step()
        except Busy as e:
            if attempt == 4: raise RuntimeError(str(e))
            print(f'  again in {2 ** attempt * 2}s: {e}', file=sys.stderr)
            time.sleep(2 ** attempt * 2)

again(lambda: call('DELETE', f'{URL}?recursive=true', ok=(200, 202, 404)))
files = []
for d, _, names in os.walk(LOCAL):
    for n in names:
        rel = os.path.relpath(os.path.join(d, n), LOCAL).replace(os.sep, '/')
        files.append(rel)
files.sort(key=lambda r: (r.startswith('_delta_log/'), r))
for rel in files:
    data = open(os.path.join(LOCAL, rel), 'rb').read()
    u = f'{URL}/{urllib.parse.quote(rel)}'
    # A file whole: created again, it is empty again, so a file half written is written from its start.
    def put(u=u, data=data):
        call('PUT', f'{u}?resource=file', b'', headers={'Content-Length': '0'})
        if data: call('PATCH', f'{u}?action=append&position=0', data, headers={'Content-Type': 'application/octet-stream'})
        call('PATCH', f'{u}?action=flush&position={len(data)}', b'', headers={'Content-Length': '0'})
    again(put)
print(f'{len(files)} files to {URL}')
