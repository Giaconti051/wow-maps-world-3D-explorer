"""Apply the pinned, independently verified Zephras 28,26 object sample.

Run from this distribution to recreate its experimental center-tile patch.
All other Zephras tiles remain terrain and water until their CDN metadata is
known; no guessed archive offsets or unverified payloads are introduced.
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MANIFEST = HERE / "zephras-manifest.json"
BUNDLE = ROOT / "static/js/214.53516c88.js"

# The BLTE ranges and decoded MD5s are the Zephras 28,26 sample in probe.py.
OBJECT_FILES = {
    "7199995": {
        "archive": "f02483eeca28ccac422e2047e29ce308",
        "offset": 66478694,
        "size": 8027,
        "md5": "cdcc0b37ca443d494677d9cb2bb48dda",
    },
    "7199996": {
        "archive": "f02483eeca28ccac422e2047e29ce308",
        "offset": 66486721,
        "size": 12737,
        "md5": "1dd1f8722c1c17b3a2a8be1346d4f45c",
    },
}

manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
assert manifest["build"] == "1.60.1.69893"
tile = next(t for t in manifest["tiles"] if t["x"] == 28 and t["y"] == 26)
assert tile["root"] == 7199994
for file_id, metadata in OBJECT_FILES.items():
    assert file_id not in manifest["files"] or manifest["files"][file_id] == metadata
    manifest["files"][file_id] = metadata
tile["obj0"] = 7199995
tile["obj1"] = 7199996

bundle = BUNDLE.read_text(encoding="utf-8")
replacements = (
    (
        '"/data/forever/zephras"!==this.dataPath,!0,i,!1',
        'true,!0,i,!1',
    ),
    (
        'async loadLodInner(e,t){let[a,i,r]=await Promise.all(',
        'async loadLodInner(e,t){if(e.fileSource.basePath==="/data/forever/zephras"&&this.fileIDs.root_adt!==7199994)return;let[a,i,r]=await Promise.all(',
    ),
)
for old, new in replacements:
    if old in bundle:
        assert bundle.count(old) == 1, f"Non-unique patch target: {old}"
        bundle = bundle.replace(old, new)
    else:
        assert bundle.count(new) == 1, f"Unexpected bundle version: {old}"

BUNDLE.write_text(bundle, encoding="utf-8")
MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("Zephras center-tile object support installed; other tiles unchanged.")
