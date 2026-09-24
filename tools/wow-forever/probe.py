"""Fetch two pinned Forever beta samples; no third-party Python dependencies.

Only downloads the byte ranges listed below (about 145 KiB), not the archive.
Source discovery: https://wago.tools/builds, Blizzard build/CDN manifests.
This is a compatibility probe, not a complete map importer.
"""
import argparse
import hashlib
from pathlib import Path
import struct
import urllib.request
import zlib

BUILD = "1.60.1.69893"
ARCHIVE = "f02483eeca28ccac422e2047e29ce308"
SAMPLES = (
    ("zephras.wdt", 187316961, 1818, "f4af6c9dfbc2be6a06408dde5abd0912"),
    ("zephras-25-22.adt", 53324694, 146261, "a35b74f30a235e7dbdb7a0573030a70e"),
)
CENTRAL_SAMPLES = (
    ("zephras-28-26.adt", 66168004, 310690, "85ca8f9baa02a75ed9b77dc72707b9fa", ARCHIVE),
    ("zephras-28-26_obj0.adt", 66478694, 8027, "cdcc0b37ca443d494677d9cb2bb48dda", ARCHIVE),
    ("zephras-28-26_obj1.adt", 66486721, 12737, "1dd1f8722c1c17b3a2a8be1346d4f45c", ARCHIVE),
    ("zephras-28-26_tex0.adt", 54682240, 1915110, "552ec80109f95c7cb7366e8309c492f7", "05d90f56f94947293901f4f5b46c5b60"),
    ("zephras-28-26.blp", 258382850, 121968, "1bd633b15154e6e564ad283e1ad9d180", "ceb31ef77467ea0ddae9ce9ea24a30d1"),
)


def decode_blte(data):
    if len(data) < 12 or data[:4] != b"BLTE":
        raise ValueError("Not a BLTE container")
    header_size = int.from_bytes(data[4:8], "big")
    count = int.from_bytes(data[9:12], "big")
    if data[8] != 15 or header_size != 12 + count * 24:
        raise ValueError("Unsupported BLTE header")
    pos = header_size
    result = bytearray()
    for i in range(count):
        compressed, decoded = struct.unpack_from(">II", data, 12 + i * 24)
        block = data[pos:pos + compressed]
        pos += compressed
        if len(block) != compressed or hashlib.md5(block).digest() != data[20+i*24:36+i*24]:
            raise ValueError("BLTE chunk checksum mismatch")
        if block[:1] == b"Z":
            raw = zlib.decompress(block[1:])
        elif block[:1] == b"N":
            raw = block[1:]
        else:
            raise ValueError("Unsupported or encrypted BLTE chunk")
        if len(raw) != decoded:
            raise ValueError("BLTE chunk size mismatch")
        result.extend(raw)
    if pos != len(data):
        raise ValueError("Unexpected BLTE trailing data")
    return bytes(result)


def fetch_sample(output, name, offset, size, ckey, archive=ARCHIVE):
    target = output / name
    if target.exists() and hashlib.md5(target.read_bytes()).hexdigest() == ckey:
        print(f"Cache verified: {name}")
        return
    end = offset + size - 1
    url = f"https://us.cdn.blizzard.com/tpr/wow/data/{archive[:2]}/{archive[2:4]}/{archive}"
    request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-{end}", "Accept-Encoding": "identity"})
    with urllib.request.urlopen(request, timeout=60) as response:
        content_range = response.headers.get("Content-Range", "")
        if response.status != 206 or not content_range.startswith(f"bytes {offset}-{end}/"):
            raise ValueError("CDN did not honor the requested range; refusing full archive download")
        data = response.read(size + 1)
    if len(data) != size:
        raise ValueError("CDN response length mismatch")
    raw = decode_blte(data)
    if hashlib.md5(raw).hexdigest() != ckey:
        raise ValueError("Decoded file checksum mismatch")
    output.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".part")
    temporary.write_bytes(raw)
    temporary.replace(target)
    print(f"Downloaded and verified: {name} ({len(raw)} bytes)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("data/forever-probe"))
    parser.add_argument("--central", action="store_true", help="Also fetch the central tile, texture and object placement files (about 2.4 MB)")
    args = parser.parse_args()
    for sample in SAMPLES:
        fetch_sample(args.output, *sample)
    if args.central:
        for sample in CENTRAL_SAMPLES:
            fetch_sample(args.output, *sample)
