#!/usr/bin/env python3
"""Build the Drive v3 list query string for evergreen-form backups."""
import sys, urllib.parse

folder_id = sys.argv[1]
params = {
    "q": f"name contains 'evergreen-form_' and '{folder_id}' in parents and trashed=false",
    "fields": "files(id,name,createdTime)",
    "pageSize": "100",
    "orderBy": "name",
}
parts = []
for k, v in params.items():
    safe = "'" if k == "q" else ""
    parts.append(k + "=" + urllib.parse.quote(v, safe=safe))
print("&".join(parts))
