"""Portable static server plus verified on-demand Forever CDN cache."""
import hashlib
import json
import mimetypes
import os
import pathlib
import re
import subprocess
import threading
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from probe import decode_blte

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CACHE = ROOT / "WoW_Forever_CDN_Cache" / "1.60.1.69893"
BASE = "https://us.cdn.blizzard.com/tpr/wow/data"
PORT = 4173
ROUTE = re.compile(r"^/data/forever/([a-z0-9-]+)/([0-9]+)$")
LOCKS = {}
LOCKS_GUARD = threading.Lock()
VERIFIED_CACHE_FILES = {}


def load_manifests():
    result = {}
    for path in HERE.glob("*-manifest.json"):
        manifest = json.loads(path.read_text(encoding="utf-8"))
        slug = manifest.get("slug") or path.name.removesuffix("-manifest.json")
        result[slug] = manifest
    return result


MANIFESTS = load_manifests()

# An asset shared by two maps has the same FileDataID and CDN metadata. Let
# Zephras resolve existing continental models without downloading new indexes.
SHARED_FILES = {}
for dataset in MANIFESTS.values():
    for file_id, metadata in dataset["files"].items():
        previous = SHARED_FILES.setdefault(file_id, metadata)
        if previous != metadata:
            raise RuntimeError(f"Conflicting CDN metadata for FileDataID {file_id}")


def lock_for(key):
    with LOCKS_GUARD:
        return LOCKS.setdefault(key, threading.Lock())


def file_fingerprint(stat):
    """Detect replacements as well as edits to an already checked cache entry."""
    return (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, stat.st_ino)


def fetch_file(slug, file_id):
    manifest = MANIFESTS.get(slug)
    if manifest is None:
        raise FileNotFoundError(f"Unknown Forever dataset {slug}")
    metadata = manifest["files"].get(file_id) or SHARED_FILES.get(file_id)
    if metadata is None:
        raise FileNotFoundError(f"FileDataID {file_id} is not in {slug}")

    content_hash = metadata["md5"]
    target = CACHE / content_hash
    target.parent.mkdir(parents=True, exist_ok=True)
    with lock_for(content_hash):
        if target.exists():
            before = file_fingerprint(target.stat())
            data = target.read_bytes()
            after = file_fingerprint(target.stat())
            unchanged = before == after and len(data) == after[0]
            if unchanged and (VERIFIED_CACHE_FILES.get(content_hash) == after
                              or hashlib.md5(data).hexdigest() == content_hash):
                VERIFIED_CACHE_FILES[content_hash] = after
                return data
            # The file changed during the read, or its contents no longer
            # match the CDN checksum. Do not keep the previous verification.
            VERIFIED_CACHE_FILES.pop(content_hash, None)
            target.rename(target.with_suffix(".invalid"))

        archive = metadata["archive"]
        start = metadata["offset"]
        end = start + metadata["size"] - 1
        url = f"{BASE}/{archive[:2]}/{archive[2:4]}/{archive}"
        request = urllib.request.Request(url, headers={
            "Range": f"bytes={start}-{end}",
            "Accept-Encoding": "identity",
            "User-Agent": "WoW-Maps-World-3D-Explorer/Forever",
        })
        with urllib.request.urlopen(request, timeout=90) as response:
            content_range = response.headers.get("Content-Range", "")
            if response.status != 206 or not content_range.startswith(f"bytes {start}-{end}/"):
                raise RuntimeError("Blizzard CDN did not honor the requested range")
            container = response.read(metadata["size"] + 1)
        if len(container) != metadata["size"]:
            raise RuntimeError("Incomplete CDN response")
        data = decode_blte(container)
        if hashlib.md5(data).hexdigest() != content_hash:
            raise RuntimeError("Decoded content checksum mismatch")
        temporary = target.with_suffix(".part")
        temporary.write_bytes(data)
        temporary.replace(target)
        VERIFIED_CACHE_FILES[content_hash] = file_fingerprint(target.stat())
        return data


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        match = ROUTE.match(self.path.split("?", 1)[0])
        if match:
            try:
                data = fetch_file(match.group(1), match.group(2))
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
                self.end_headers()
                self.wfile.write(data)
            except FileNotFoundError as error:
                self.send_error(404, str(error))
            except Exception as error:
                self.send_error(502, str(error))
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")


def find_edge():
    candidates = []
    for variable in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
        base = os.environ.get(variable)
        if base:
            candidates.append(pathlib.Path(base) / "Microsoft/Edge/Application/msedge.exe")
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise RuntimeError("Microsoft Edge non trovato")


if __name__ == "__main__":
    mimetypes.add_type("application/wasm", ".wasm")
    browser_data = ROOT / "WoW_Archaeology_BrowserData"
    disk_cache = browser_data / "DiskCache"
    disk_cache.mkdir(parents=True, exist_ok=True)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as error:
        raise SystemExit(f"La porta {PORT} e gia occupata. Chiudi la precedente istanza. ({error})")

    edge = find_edge()
    subprocess.Popen([
        str(edge),
        f"--user-data-dir={browser_data}",
        f"--disk-cache-dir={disk_cache}",
        "--no-first-run",
        "--disable-default-apps",
        f"http://localhost:{PORT}/",
    ])
    print(f"World of Warcraft Maps and World 3D Explorer: http://localhost:{PORT}/")
    print(f"Cache Forever: {CACHE}")
    print("La prima visita di una zona scarica soltanto le tile necessarie. Ctrl+C per chiudere.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
