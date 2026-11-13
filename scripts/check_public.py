"""Fail publication on common credential and private-data leaks."""
import json
import re
from pathlib import Path
snapshot = json.loads(Path('public/data/latest.json').read_text(encoding='utf-8'))
if set(snapshot) != {'schemaVersion', 'generatedAt', 'tradeDate', 'source', 'sourceUrl', 'partial', 'failures', 'coverage', 'quotes', 'ai'}:
    raise SystemExit('Unexpected report fields')
if set(snapshot['ai']) != {'status', 'text', 'model'} or snapshot['ai']['status'] not in {'available','unavailable'}:
    raise SystemExit('Unexpected AI fields')
for q in snapshot['quotes'].values():
    if not {'code', 'price', 'prevClose', 'changePct', 'open', 'high', 'low', 'volume', 'amount', 'tradeDate', 'fetchedAt', 'source', 'bars'} <= set(q) or set(q) - {'code', 'price', 'prevClose', 'changePct', 'open', 'high', 'low', 'volume', 'amount', 'tradeDate', 'fetchedAt', 'source', 'bars', 'provider', 'adjustment'}:
        raise SystemExit('Unexpected quote fields')
if not re.search(r'initialStocks\s*:\s*Stock\[\]\s*=\s*\[\s*\]', Path('src/data/initialStocks.ts').read_text()):
    raise SystemExit('Initial records must not be bundled')
secret = re.compile(rb'(?i)(?:sk-[a-z0-9]{24,}|ghp_[a-z0-9]{30,}|github_pat_[a-z0-9_]{40,})')
for path in Path('dist').rglob('*'):
    if path.is_file() and path.suffix.lower() in {'.js', '.json', '.html', '.map', '.css'}:
        if secret.search(path.read_bytes()):
            raise SystemExit('Possible credential found in public build')
print('Public report structure and credential scan passed')
