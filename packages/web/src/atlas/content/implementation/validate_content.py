#!/usr/bin/env python3
"""Validate this package's content integrity; does not contact or test vendors."""
import json,re
from pathlib import Path
from urllib.parse import urlparse
ROOT=Path(__file__).resolve().parents[1]
def load(p): return json.loads((ROOT/p).read_text())
errors=[]
def check(condition,message):
 if not condition:errors.append(message)
for p in ROOT.rglob('*.json'):
 try:json.loads(p.read_text())
 except Exception as e:errors.append(f'{p}: {e}')
entities=load('data/entities.json');ids={x['id'] for x in entities}
check(len(ids)==len(entities),'Duplicate entity IDs')
routes=load('implementation/route-manifest.json');route_set={x['route'] for x in routes}
check(len(routes)==len(route_set),'Duplicate routes')
categories=load('content/categories.json');cat_ids={x['id'] for x in categories}
for e in entities:
 check(e['route'] in route_set,f"Missing route {e['id']}")
 check(e['category_id'] in cat_ids,f"Missing category {e['id']}")
 check(bool(e['description'].strip()),f"Empty description {e['id']}")
 check(bool(e['sources']),f"No sources {e['id']}")
 check(not e['runtime_tested'] and not e['payment_tested'] and not e['security_audited'],f"Unexpected test claim {e['id']}")
 check(not e['indexable'],f"Unexpected default indexing {e['id']}")
 check(all(x in ids for x in e['related_ids']),f"Broken related ID {e['id']}")
 if e['identity_status']=='upstream_unresolved':check(e['website_url'] is None and e['repository_url'] is None,f"Unresolved URL misrepresented {e['id']}")
 evidence_ids={x['evidence_id'] for x in e['evidence']}
 for f in e['facts']:
  check(all(x in evidence_ids for x in f.get('evidence_ids',[])),f"Broken evidence reference {e['id']} {f['path']}")
  if f['value'] is not None:check(bool(f.get('evidence_ids') or f.get('source_urls')),f"Unsourced fact {e['id']} {f['path']}")
 for s in e['sources']:
  u=urlparse(s['url']);check(u.scheme in ['http','https'] and bool(u.netloc),f"Invalid source URL {e['id']}")
for c in categories:
 check(all(x in ids for x in c['entity_ids']),f"Broken category members {c['id']}")
for g in load('content/task-guides.json'):
 check(all(x in ids for x in g['candidate_ids']),f"Broken guide candidates {g['id']}")
 check(g['route'] in route_set,f"Missing guide route {g['id']}")
for p in load('content/protocols.json'):
 check(p['entity_id'] in ids and p['route'] in route_set,f"Broken protocol link {p['entity_id']}")
for c in load('content/comparisons.json'):
 check(all(x in ids for x in c['entity_ids']),f"Broken comparison {c['id']}")
for p in (ROOT/'pages').rglob('*.md'):
 for href in re.findall(r'\]\((/[^)]+)\)',p.read_text()):check(href in route_set,f'Broken internal link {p.name}: {href}')
launch=load('implementation/launch-manifest.json')
check(all(x in route_set for x in launch['recommended_review_order']),'Broken launch-review route')
check(all(x in route_set for x in launch['approved_indexable_routes']),'Broken approved route')
manifest=load('manifest.json')['counts']
check(manifest['entities']==len(entities),'Manifest entity count mismatch')
check(manifest['glossary_terms']==len(load('content/glossary.json')),'Glossary count mismatch')
if errors:
 print('\n'.join('ERROR: '+x for x in errors));raise SystemExit(1)
print(f"PASS: {len(entities)} entities; {len(routes)} unique routes; valid source/evidence and internal references. No live product or URL tests performed.")
