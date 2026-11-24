#!/usr/bin/env python3
"""Downloads the official Node.js runtime for each download target, checked against nodejs.org's SHA-256 list.
Puts just the program and its licence in dist/node-<target>/ for build-zip.py --bundle-node to include.
Used by the GitHub workflow:  python3 local/fetch-node.py  (or NODE_VERSION=v24.11.1 to pin a version)."""
import hashlib, io, json, os, sys, tarfile, urllib.request, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = 'https://nodejs.org/dist'
# target name -> nodejs.org platform name, archive type
TARGETS = {
    'windows':     ('win-x64', 'zip'),
    'mac-arm64':   ('darwin-arm64', 'tar.gz'),
    'mac-x64':     ('darwin-x64', 'tar.gz'),
    'linux-x64':   ('linux-x64', 'tar.gz'),
    'linux-arm64': ('linux-arm64', 'tar.gz'),
}

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'spotlight-build'}), timeout=120) as r:
        return r.read()

def pick_version():
    if os.environ.get('NODE_VERSION'): return os.environ['NODE_VERSION']
    for rel in json.loads(get(f'{DIST}/index.json')):  # newest first
        major, minor = (int(x) for x in rel['version'].lstrip('v').split('.')[:2])
        if rel.get('lts') and (major, minor) >= (22, 13): return rel['version']
    sys.exit('No suitable Node.js LTS release found')

def main():
    version = pick_version()
    sums = {line.split()[1]: line.split()[0] for line in get(f'{DIST}/{version}/SHASUMS256.txt').decode().splitlines() if line.strip()}
    for target, (plat, kind) in TARGETS.items():
        name = f'node-{version}-{plat}.{kind}'
        data = get(f'{DIST}/{version}/{name}')
        digest = hashlib.sha256(data).hexdigest()
        if sums.get(name) != digest: sys.exit(f'Checksum mismatch for {name}')
        out = os.path.join(ROOT, 'dist', f'node-{target}')
        os.makedirs(out, exist_ok=True)
        top = f'node-{version}-{plat}/'
        if kind == 'zip':
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for src, dst in [(top + 'node.exe', 'node.exe'), (top + 'LICENSE', 'LICENSE')]:
                    with open(os.path.join(out, dst), 'wb') as fh: fh.write(z.read(src))
        else:
            os.makedirs(os.path.join(out, 'bin'), exist_ok=True)
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as t:
                for src, dst in [(top + 'bin/node', 'bin/node'), (top + 'LICENSE', 'LICENSE')]:
                    with open(os.path.join(out, dst), 'wb') as fh: fh.write(t.extractfile(src).read())
            os.chmod(os.path.join(out, 'bin', 'node'), 0o755)
        with open(os.path.join(out, 'VERSION'), 'w') as fh: fh.write(version + '\n')
        print(f'{target}: {name} ({len(data) // 1048576} MB, sha256 ok)')

if __name__ == '__main__':
    main()
