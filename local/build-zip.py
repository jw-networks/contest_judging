#!/usr/bin/env python3
"""Builds dist/spotlight-local-server.zip: the downloadable local network server.
Run from the repo root:  python3 local/build-zip.py  (the GitHub workflow does this on every update)."""
import os, stat, subprocess, sys, time, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'dist', 'spotlight-local-server.zip')
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

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    now = time.localtime()[:6]
    for src, dst, exe in sorted(items, key=lambda x: x[1]):
        info = zipfile.ZipInfo(TOP + dst, date_time=now)
        info.create_system = 3  # unix, so the permission bits below are honoured
        info.external_attr = ((0o755 if exe else 0o644) | stat.S_IFREG) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with open(os.path.join(ROOT, src), 'rb') as fh: z.writestr(info, fh.read())
    v = zipfile.ZipInfo(TOP + 'VERSION.txt', date_time=now); v.external_attr = (0o644 | stat.S_IFREG) << 16
    z.writestr(v, f'Spotlight local server\nBuilt {time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())} from commit {commit()}\n')
print(f'{OUT}  ({os.path.getsize(OUT) // 1024} KB, {len(items) + 1} files)')
