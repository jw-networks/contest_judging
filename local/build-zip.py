#!/usr/bin/env python3
"""Builds the downloadable local network server.
  python3 local/build-zip.py                      -> dist/spotlight-local-server.zip (needs Node.js installed)
  python3 local/build-zip.py --bundle-node windows -> dist/spotlight-local-server-windows.zip, with Node.js inside,
      taken from dist/node-windows/ (see fetch-node.py). Same for mac-arm64, mac-x64, linux-x64, linux-arm64.
The GitHub workflow builds all of them on every update."""
import os, stat, subprocess, sys, time, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
target = sys.argv[sys.argv.index('--bundle-node') + 1] if '--bundle-node' in sys.argv else None
OUT = os.path.join(ROOT, 'dist', f'spotlight-local-server{"-" + target if target else ""}.zip')
TOP = 'spotlight-local-server/'
os.makedirs(os.path.dirname(OUT), exist_ok=True)

def commit():
    try: return subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT, text=True).strip()
    except Exception: return 'unknown'

# (source path in repo, path in zip, executable?)
items = [('package.json', 'package.json', False), ('worker/package.json', 'worker/package.json', False),
         ('local/runtime.mjs', 'local/runtime.mjs', False), ('local/server.mjs', 'local/server.mjs', True)]
for name in os.listdir(os.path.join(ROOT, 'local', 'package')):
    items.append((f'local/package/{name}', name, name.endswith(('.command', '.sh'))))
for base in ('worker/src', 'public'):
    for d, _, files in os.walk(os.path.join(ROOT, base)):
        for f in files:
            rel = os.path.relpath(os.path.join(d, f), ROOT).replace(os.sep, '/')
            items.append((rel, rel, False))

# Node.js runtime: dist/node-<target>/ holds node.exe + LICENSE (Windows) or bin/node + LICENSE.
node_note = ''
if target:
    nd = os.path.join(ROOT, 'dist', f'node-{target}')
    if not os.path.isdir(nd): sys.exit(f'{nd} is missing: run local/fetch-node.py first')
    for d, _, files in os.walk(nd):
        for f in files:
            rel = os.path.relpath(os.path.join(d, f), nd).replace(os.sep, '/')
            if rel == 'VERSION': continue
            items.append((os.path.relpath(os.path.join(d, f), ROOT), 'node/' + rel, rel in ('bin/node',)))
    node_note = f'Includes Node.js {open(os.path.join(nd, "VERSION")).read().strip() if os.path.exists(os.path.join(nd, "VERSION")) else ""} ({target}), MIT licence in node/LICENSE.\n'

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    now = time.localtime()[:6]
    for src, dst, exe in sorted(items, key=lambda x: x[1]):
        info = zipfile.ZipInfo(TOP + dst, date_time=now)
        info.create_system = 3  # unix, so the permission bits below are honoured
        info.external_attr = ((0o755 if exe else 0o644) | stat.S_IFREG) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with open(os.path.join(ROOT, src), 'rb') as fh: z.writestr(info, fh.read())
    v = zipfile.ZipInfo(TOP + 'VERSION.txt', date_time=now); v.external_attr = (0o644 | stat.S_IFREG) << 16
    z.writestr(v, f'Spotlight local server\nBuilt {time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())} from commit {commit()}\n{node_note}')
print(f'{OUT}  ({os.path.getsize(OUT) // 1024} KB, {len(items) + 1} files)')
