import sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
from database import get_db
db = get_db()

docs = list(db.quotations.find({}, {"product_name": 1, "base_name": 1, "_id": 0}))

from collections import defaultdict
groups = defaultdict(list)
for d in docs:
    bn = d.get("base_name") or "??"
    pn = d.get("product_name") or "??"
    if pn not in groups[bn]:
        groups[bn].append(pn)

print(f"Grup base_name: {len(groups)}\n")
for bn in sorted(groups.keys()):
    variants = sorted(set(groups[bn]))
    marker = "  " if len(variants) == 1 else "▼ "
    print(f"{marker}[{bn}]")
    if len(variants) > 1:
        for v in variants:
            print(f"     • {v}")
