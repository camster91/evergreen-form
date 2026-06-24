#!/usr/bin/env python3
"""Read the Drive list JSON, return file IDs to delete (keep N most recent by name)."""
import sys, json

list_path = sys.argv[1]
keep = int(sys.argv[2])
with open(list_path) as f:
    d = json.load(f)
files = sorted(d.get("files", []), key=lambda f: f["name"])
to_delete = files[:max(0, len(files) - keep)]
for f in to_delete:
    print(f["id"])
