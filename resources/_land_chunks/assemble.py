#!/usr/bin/env python3
"""Assemble resources/_land_chunks/*.b64.txt into resources/ rasters."""
import base64, tarfile, io, hashlib, json
from pathlib import Path
root = Path('resources/_land_chunks')
meta = json.loads((root/'manifest.json').read_text())
parts = []
for i in range(meta['n_chunks']):
    parts.append((root/f'{i:03d}.b64.txt').read_text().strip())
b64 = ''.join(parts)
assert len(b64)==meta['b64_len'], (len(b64), meta['b64_len'])
raw = base64.b64decode(b64)
assert hashlib.sha256(raw).hexdigest()==meta['tar_sha256']
bio = io.BytesIO(raw)
with tarfile.open(fileobj=bio, mode='r:gz') as tar:
    tar.extractall('.')
print('extracted ok', meta['n_chunks'], 'chunks')
