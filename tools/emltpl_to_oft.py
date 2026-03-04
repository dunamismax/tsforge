#!/usr/bin/env python3
"""
emltpl_to_oft.py - Convert macOS .emltpl email templates to Windows .oft format.

Creates valid OLE2 Compound File Binary (CFB) files following the MS-OXMSG
specification for Outlook Template (.oft) files.

Usage:
    python3 emltpl_to_oft.py <input_dir_or_file> [output_dir]

    If output_dir is omitted, .oft files are placed alongside .emltpl files.

Dependencies: Python 3.10+ (stdlib only, no third-party packages)

References:
    - [MS-CFB]   Compound File Binary File Format
    - [MS-OXMSG] Outlook Item (.msg) File Format
"""

from __future__ import annotations

import email
import email.policy
import struct
import sys
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# CFB (Compound File Binary) constants
# ---------------------------------------------------------------------------
CFB_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
SECTOR_SIZE = 512
MINI_SECTOR_SIZE = 64
MINI_STREAM_CUTOFF = 4096

FREESECT = 0xFFFFFFFF
ENDOFCHAIN = 0xFFFFFFFE
FATSECT = 0xFFFFFFFD
NOSTREAM = 0xFFFFFFFF

DIR_TYPE_UNKNOWN = 0
DIR_TYPE_STORAGE = 1
DIR_TYPE_STREAM = 2
DIR_TYPE_ROOT = 5

COLOR_BLACK = 1

# OFT root CLSID: {0006F046-0000-0000-C000-000000000046}
CLSID_OFT = struct.pack("<IHH", 0x0006F046, 0x0000, 0x0000) + bytes(
    [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]
)
CLSID_NULL = b"\x00" * 16

# ---------------------------------------------------------------------------
# MAPI / MS-OXMSG constants
# ---------------------------------------------------------------------------
PT_INT32 = 0x0003
PT_BOOLEAN = 0x000B
PT_STRING = 0x001F  # PtypString (UTF-16LE)
PT_BINARY = 0x0102
PT_SYSTIME = 0x0040

# Property flags
PROP_RW = 0x00000006  # readable | writable

# Message flags
MSGFLAG_UNSENT = 0x00000008
MSGFLAG_HASATTACH = 0x00000010


# ============================================================================
# CFB Writer -- builds OLE2 compound documents from scratch
# ============================================================================
class _DirEntry:
    """A directory entry in the compound file."""

    __slots__ = (
        "child_sid",
        "children",
        "clsid",
        "data",
        "entry_type",
        "left_sid",
        "name",
        "right_sid",
        "start_sector",
        "stream_size",
    )

    def __init__(
        self,
        name: str,
        entry_type: int,
        clsid: bytes = CLSID_NULL,
        data: bytes = b"",
    ):
        self.name = name
        self.entry_type = entry_type
        self.clsid = clsid
        self.data = data
        self.children: list[int] = []  # indices of child entries
        self.left_sid = NOSTREAM
        self.right_sid = NOSTREAM
        self.child_sid = NOSTREAM
        self.start_sector = ENDOFCHAIN
        self.stream_size = 0


class CFBWriter:
    """Builds and writes OLE2 / CFB files from a tree of storages and streams."""

    def __init__(self) -> None:
        self._entries: list[_DirEntry] = []

    # -- public API ----------------------------------------------------------

    def add_root(self, clsid: bytes = CLSID_NULL) -> int:
        idx = len(self._entries)
        self._entries.append(_DirEntry("Root Entry", DIR_TYPE_ROOT, clsid))
        return idx

    def add_storage(self, parent: int, name: str, clsid: bytes = CLSID_NULL) -> int:
        idx = len(self._entries)
        self._entries.append(_DirEntry(name, DIR_TYPE_STORAGE, clsid))
        self._entries[parent].children.append(idx)
        return idx

    def add_stream(self, parent: int, name: str, data: bytes) -> int:
        idx = len(self._entries)
        e = _DirEntry(name, DIR_TYPE_STREAM, data=data)
        self._entries.append(e)
        self._entries[parent].children.append(idx)
        return idx

    def save(self, path: str | Path) -> None:
        sectors: list[bytearray] = []
        fat: list[int] = []

        def _pad(data: bytes, boundary: int) -> bytes:
            r = len(data) % boundary
            return data + b"\x00" * (boundary - r) if r else data

        def _alloc_chain(data: bytes) -> int:
            """Allocate sectors for *data*, return starting SID."""
            if not data:
                return ENDOFCHAIN
            start = len(sectors)
            n = (len(data) + SECTOR_SIZE - 1) // SECTOR_SIZE
            for i in range(n):
                chunk = data[i * SECTOR_SIZE : (i + 1) * SECTOR_SIZE]
                chunk = chunk + b"\x00" * (SECTOR_SIZE - len(chunk))
                sectors.append(bytearray(chunk))
                fat.append(start + i + 1 if i < n - 1 else ENDOFCHAIN)
            return start

        # -- 1. separate mini vs regular streams ----------------------------
        mini_entries: list[int] = []
        regular_entries: list[int] = []
        for i, e in enumerate(self._entries):
            if e.entry_type != DIR_TYPE_STREAM or not e.data:
                continue
            if len(e.data) < MINI_STREAM_CUTOFF:
                mini_entries.append(i)
            else:
                regular_entries.append(i)

        # -- 2. build mini-stream + mini-FAT --------------------------------
        mini_stream = bytearray()
        mini_fat: list[int] = []

        for idx in mini_entries:
            e = self._entries[idx]
            start_ms = len(mini_stream) // MINI_SECTOR_SIZE
            padded = _pad(e.data, MINI_SECTOR_SIZE)
            n_ms = len(padded) // MINI_SECTOR_SIZE
            e.start_sector = start_ms
            e.stream_size = len(e.data)
            for j in range(n_ms):
                mini_fat.append(start_ms + j + 1 if j < n_ms - 1 else ENDOFCHAIN)
            mini_stream.extend(padded)

        if mini_stream:
            mini_stream = bytearray(_pad(bytes(mini_stream), SECTOR_SIZE))

        # -- 3. allocate directory sectors (placeholder) --------------------
        n_dir_entries = len(self._entries)
        dir_bytes_needed = ((n_dir_entries + 3) // 4) * SECTOR_SIZE  # 4 per sector
        dir_start = _alloc_chain(b"\x00" * dir_bytes_needed)
        n_dir_sectors = dir_bytes_needed // SECTOR_SIZE

        # -- 4. allocate mini-FAT sectors -----------------------------------
        if mini_fat:
            mf_data = b"".join(struct.pack("<I", x) for x in mini_fat)
            mf_data = _pad(mf_data, SECTOR_SIZE)
            mini_fat_start = _alloc_chain(mf_data)
            n_mini_fat_sectors = len(mf_data) // SECTOR_SIZE
        else:
            mini_fat_start = ENDOFCHAIN
            n_mini_fat_sectors = 0

        # -- 5. allocate mini-stream (root entry data) ----------------------
        mini_stream_start = _alloc_chain(bytes(mini_stream)) if mini_stream else ENDOFCHAIN

        # -- 6. allocate regular data streams --------------------------------
        for idx in regular_entries:
            e = self._entries[idx]
            e.start_sector = _alloc_chain(e.data)
            e.stream_size = len(e.data)

        # -- 7. root entry points to mini-stream ----------------------------
        root = self._entries[0]
        root.start_sector = mini_stream_start
        root.stream_size = len(mini_stream)

        # mark storages (no data of their own via regular sectors)
        for e in self._entries:
            if e.entry_type in (DIR_TYPE_STORAGE, DIR_TYPE_ROOT) and e is not root:
                e.start_sector = 0
                e.stream_size = 0

        # -- 8. allocate FAT sectors ----------------------------------------
        n_data = len(sectors)
        n_fat = 1
        while n_fat * (SECTOR_SIZE // 4) < n_data + n_fat:
            n_fat += 1

        fat_sids: list[int] = []
        for _ in range(n_fat):
            sid = len(sectors)
            sectors.append(bytearray(SECTOR_SIZE))
            fat.append(FATSECT)
            fat_sids.append(sid)

        # pad FAT entries to fill allocated FAT sectors
        total_slots = n_fat * (SECTOR_SIZE // 4)
        while len(fat) < total_slots:
            fat.append(FREESECT)

        # write FAT data into the FAT sectors
        fat_raw = b"".join(struct.pack("<I", x) for x in fat[:total_slots])
        for i, sid in enumerate(fat_sids):
            sectors[sid] = bytearray(fat_raw[i * SECTOR_SIZE : (i + 1) * SECTOR_SIZE])

        # -- 9. build balanced BST for directory tree -----------------------
        self._build_dir_trees()

        # -- 10. serialize directory entries into their sectors ---------------
        dir_raw = bytearray()
        for e in self._entries:
            dir_raw.extend(self._serialize_dir_entry(e))
        # pad to fill all directory sectors
        dir_raw.extend(b"\x00" * (dir_bytes_needed - len(dir_raw)))
        for i in range(n_dir_sectors):
            sectors[dir_start + i] = bytearray(dir_raw[i * SECTOR_SIZE : (i + 1) * SECTOR_SIZE])

        # -- 11. build header -----------------------------------------------
        header = self._build_header(
            n_fat_sectors=n_fat,
            dir_start=dir_start,
            mini_fat_start=mini_fat_start,
            n_mini_fat_sectors=n_mini_fat_sectors,
            fat_sids=fat_sids,
        )

        # -- 12. write file --------------------------------------------------
        with open(path, "wb") as f:
            f.write(header)
            for s in sectors:
                f.write(bytes(s))

    # -- internals -----------------------------------------------------------

    @staticmethod
    def _dir_sort_key(name: str) -> tuple[int, str]:
        """MS-CFB directory entry comparison: length first, then upper-case."""
        return (len(name), name.upper())

    def _build_dir_trees(self) -> None:
        """Set left/right/child SIDs for balanced BSTs per storage."""
        for _i, e in enumerate(self._entries):
            if e.entry_type not in (DIR_TYPE_ROOT, DIR_TYPE_STORAGE):
                continue
            if not e.children:
                e.child_sid = NOSTREAM
                continue
            # sort children for BST
            kids = sorted(
                e.children,
                key=lambda c: self._dir_sort_key(self._entries[c].name),
            )
            root = self._make_bst(kids, 0, len(kids) - 1)
            e.child_sid = root

    def _make_bst(self, kids: list[int], lo: int, hi: int) -> int:
        """Recursively build a balanced BST; return root dir-entry index."""
        if lo > hi:
            return NOSTREAM
        mid = (lo + hi) // 2
        idx = kids[mid]
        e = self._entries[idx]
        e.left_sid = self._make_bst(kids, lo, mid - 1)
        e.right_sid = self._make_bst(kids, mid + 1, hi)
        return idx

    @staticmethod
    def _serialize_dir_entry(e: _DirEntry) -> bytes:
        """Serialize a single 128-byte directory entry."""
        # name as UTF-16LE with null terminator
        name_utf16 = (e.name + "\x00").encode("utf-16-le")
        name_bytes = name_utf16[:64].ljust(64, b"\x00")
        name_size = min(len(name_utf16), 64)

        buf = bytearray(128)
        buf[0:64] = name_bytes
        struct.pack_into("<H", buf, 0x40, name_size)
        buf[0x42] = e.entry_type
        buf[0x43] = COLOR_BLACK
        struct.pack_into("<I", buf, 0x44, e.left_sid)
        struct.pack_into("<I", buf, 0x48, e.right_sid)
        struct.pack_into("<I", buf, 0x4C, e.child_sid)
        buf[0x50 : 0x50 + 16] = e.clsid if e.clsid else CLSID_NULL

        # creation/modified time: current time as FILETIME
        ft = _python_time_to_filetime(time.time())
        struct.pack_into("<Q", buf, 0x64, ft)
        struct.pack_into("<Q", buf, 0x6C, ft)

        struct.pack_into("<I", buf, 0x74, e.start_sector & 0xFFFFFFFF)
        struct.pack_into("<I", buf, 0x78, e.stream_size & 0xFFFFFFFF)
        struct.pack_into("<I", buf, 0x7C, 0)  # high 32 bits (v4 only)
        return bytes(buf)

    @staticmethod
    def _build_header(
        n_fat_sectors: int,
        dir_start: int,
        mini_fat_start: int,
        n_mini_fat_sectors: int,
        fat_sids: list[int],
    ) -> bytes:
        buf = bytearray(SECTOR_SIZE)
        buf[0:8] = CFB_MAGIC
        buf[8:24] = CLSID_NULL  # header CLSID
        struct.pack_into("<H", buf, 0x18, 0x003E)  # minor version
        struct.pack_into("<H", buf, 0x1A, 0x0003)  # major version (v3)
        struct.pack_into("<H", buf, 0x1C, 0xFFFE)  # byte order (LE)
        struct.pack_into("<H", buf, 0x1E, 9)  # sector size power (2^9=512)
        struct.pack_into("<H", buf, 0x20, 6)  # mini sector size power (2^6=64)
        # reserved 6 bytes at 0x22 already zero
        struct.pack_into("<I", buf, 0x28, 0)  # total sectors (v4 only)
        struct.pack_into("<I", buf, 0x2C, n_fat_sectors)
        struct.pack_into("<I", buf, 0x30, dir_start)
        struct.pack_into("<I", buf, 0x34, 0)  # transaction signature
        struct.pack_into("<I", buf, 0x38, MINI_STREAM_CUTOFF)
        struct.pack_into("<I", buf, 0x3C, mini_fat_start)
        struct.pack_into("<I", buf, 0x40, n_mini_fat_sectors)
        struct.pack_into("<I", buf, 0x44, ENDOFCHAIN)  # first DIFAT sector
        struct.pack_into("<I", buf, 0x48, 0)  # DIFAT sector count

        # DIFAT array in header (109 entries)
        for i in range(109):
            val = fat_sids[i] if i < len(fat_sids) else FREESECT
            struct.pack_into("<I", buf, 0x4C + i * 4, val)

        return bytes(buf)


# ============================================================================
# Helpers
# ============================================================================
def _python_time_to_filetime(t: float) -> int:
    """Convert Unix timestamp to Windows FILETIME (100ns intervals since 1601-01-01)."""
    epoch_diff = 11644473600  # seconds between 1601-01-01 and 1970-01-01
    return int((t + epoch_diff) * 10_000_000)


def _utf16le(text: str) -> bytes:
    """Encode string as UTF-16LE (no BOM, no null terminator)."""
    return text.encode("utf-16-le")


def _prop_tag(prop_id: int, prop_type: int) -> int:
    """Build a 32-bit property tag from ID and type."""
    return (prop_id << 16) | prop_type


def _stream_name(prop_id: int, prop_type: int) -> str:
    """Build __substg1.0_XXXXYYYY stream name."""
    return f"__substg1.0_{prop_id:04X}{prop_type:04X}"


# ============================================================================
# Property Stream Builder
# ============================================================================
class PropertyStreamBuilder:
    """Builds a __properties_version1.0 stream and associated value streams."""

    def __init__(self, is_top_level: bool = False):
        self._is_top_level = is_top_level
        self._fixed: list[bytes] = []  # 16-byte fixed entries
        self._streams: dict[str, bytes] = {}  # stream_name -> data
        self._n_recipients = 0
        self._n_attachments = 0

    def set_counts(self, recipients: int, attachments: int) -> None:
        self._n_recipients = recipients
        self._n_attachments = attachments

    def add_int32(self, prop_id: int, value: int) -> None:
        entry = struct.pack("<HHI", PT_INT32, prop_id, PROP_RW)
        entry += struct.pack("<I", value & 0xFFFFFFFF) + b"\x00" * 4
        self._fixed.append(entry)

    def add_bool(self, prop_id: int, value: bool) -> None:
        entry = struct.pack("<HHI", PT_BOOLEAN, prop_id, PROP_RW)
        entry += struct.pack("<I", 1 if value else 0) + b"\x00" * 4
        self._fixed.append(entry)

    def add_time(self, prop_id: int, filetime: int) -> None:
        entry = struct.pack("<HHI", PT_SYSTIME, prop_id, PROP_RW)
        entry += struct.pack("<Q", filetime)
        self._fixed.append(entry)

    def add_string(self, prop_id: int, value: str) -> None:
        data = _utf16le(value)
        name = _stream_name(prop_id, PT_STRING)
        self._streams[name] = data
        # size field = data length (Outlook expects just the data length for
        # variable-length properties in the property entry)
        size = len(data)
        entry = struct.pack("<HHI", PT_STRING, prop_id, PROP_RW)
        entry += struct.pack("<I", size) + b"\x00" * 4
        self._fixed.append(entry)

    def add_binary(self, prop_id: int, data: bytes) -> None:
        name = _stream_name(prop_id, PT_BINARY)
        self._streams[name] = data
        size = len(data)
        entry = struct.pack("<HHI", PT_BINARY, prop_id, PROP_RW)
        entry += struct.pack("<I", size) + b"\x00" * 4
        self._fixed.append(entry)

    def build_props_stream(self) -> bytes:
        """Return the __properties_version1.0 bytes."""
        if self._is_top_level:
            header = struct.pack(
                "<QIIII",
                0,  # reserved
                self._n_recipients,  # next recipient id
                self._n_attachments,  # next attachment id
                self._n_recipients,  # recipient count
                self._n_attachments,  # attachment count
            )
            header += b"\x00" * 8  # reserved
        else:
            header = b"\x00" * 8
        return header + b"".join(self._fixed)

    @property
    def value_streams(self) -> dict[str, bytes]:
        return dict(self._streams)


# ============================================================================
# OFT Builder -- constructs a complete Outlook Template file
# ============================================================================
class OFTBuilder:
    """Build an OFT file from message components."""

    def __init__(self) -> None:
        self.subject: str = ""
        self.body_text: str = ""
        self.body_html: bytes = b""
        self.attachments: list[dict] = []
        # Each attachment: {"filename": str, "mime_type": str, "data": bytes,
        #                   "content_id": str | None, "disposition": str | None}

    def build(self, path: str | Path) -> None:
        cfb = CFBWriter()

        # -- root storage with OFT CLSID -----------------------------------
        root = cfb.add_root(clsid=CLSID_OFT)

        # -- named property mapping (minimal / empty) -----------------------
        nameid = cfb.add_storage(root, "__nameid_version1.0")
        cfb.add_stream(nameid, "__substg1.0_00020102", b"")  # GUID stream
        cfb.add_stream(nameid, "__substg1.0_00030102", b"")  # Entry stream
        cfb.add_stream(nameid, "__substg1.0_00040102", b"")  # String stream

        # -- build root properties ------------------------------------------
        props = PropertyStreamBuilder(is_top_level=True)
        n_attach = len(self.attachments)
        props.set_counts(recipients=0, attachments=n_attach)

        now_ft = _python_time_to_filetime(time.time())
        msg_flags = MSGFLAG_UNSENT
        if n_attach > 0:
            msg_flags |= MSGFLAG_HASATTACH

        props.add_string(0x001A, "IPM.Note")  # MessageClass
        props.add_string(0x0037, self.subject)  # Subject
        props.add_string(0x003D, "")  # SubjectPrefix
        props.add_string(0x0070, self.subject)  # ConversationTopic
        props.add_string(0x0E1D, self.subject)  # NormalizedSubject
        props.add_int32(0x0E07, msg_flags)  # MessageFlags
        props.add_int32(0x340D, 0x00040E79)  # StoreSupportMask (UNICODE_OK)
        props.add_int32(0x3FDE, 65001)  # InternetCodepage (UTF-8)
        props.add_int32(0x3FF1, 0x0409)  # MessageLocaleId (en-US)
        props.add_time(0x3007, now_ft)  # CreationTime
        props.add_time(0x3008, now_ft)  # LastModificationTime

        # body content
        if self.body_text:
            props.add_string(0x1000, self.body_text)  # Body (text)
        if self.body_html:
            props.add_binary(0x1013, self.body_html)  # Html (binary)

        # write root properties and value streams
        cfb.add_stream(root, "__properties_version1.0", props.build_props_stream())
        for sname, sdata in props.value_streams.items():
            cfb.add_stream(root, sname, sdata)

        # -- attachments ----------------------------------------------------
        for ai, att in enumerate(self.attachments):
            att_stor = cfb.add_storage(root, f"__attach_version1.0_#{ai:08X}")
            ap = PropertyStreamBuilder(is_top_level=False)

            ap.add_int32(0x3705, 0x00000001)  # AttachMethod = BY_VALUE
            ap.add_int32(0x370B, 0xFFFFFFFF)  # RenderingPosition (hidden)
            ap.add_int32(0x0E20, len(att["data"]))  # AttachSize
            ap.add_int32(0x0FFE, 0x00000007)  # ObjectType (attachment)

            fname = att.get("filename", f"attachment_{ai}")
            ap.add_string(0x3707, fname)  # AttachLongFilename
            ap.add_string(0x3704, _short_filename(fname))  # AttachFilename
            ap.add_string(0x3001, fname)  # DisplayName

            mime = att.get("mime_type", "application/octet-stream")
            ap.add_string(0x370E, mime)  # AttachMimeTag

            ext = Path(fname).suffix
            if ext:
                ap.add_string(0x3703, ext)  # AttachExtension

            cid = att.get("content_id")
            if cid:
                ap.add_string(0x3712, cid)  # AttachContentId

            ap.add_binary(0x3701, att["data"])  # AttachDataBinary
            ap.add_binary(0x3702, b"")  # AttachEncoding (empty)

            cfb.add_stream(
                att_stor,
                "__properties_version1.0",
                ap.build_props_stream(),
            )
            for sname, sdata in ap.value_streams.items():
                cfb.add_stream(att_stor, sname, sdata)

        cfb.save(path)


def _short_filename(name: str) -> str:
    """Generate an 8.3-ish short filename."""
    p = Path(name)
    stem = p.stem[:8]
    ext = p.suffix[:4]  # includes dot
    return f"{stem}{ext}"


# ============================================================================
# EMLTPL parser -> OFTBuilder
# ============================================================================
def convert_emltpl(emltpl_path: str | Path, oft_path: str | Path) -> None:
    """Parse a .emltpl MIME file and write a .oft Outlook template."""
    with open(emltpl_path, "rb") as f:
        msg = email.message_from_binary_file(f, policy=email.policy.default)

    builder = OFTBuilder()
    builder.subject = msg.get("Subject", "") or ""

    # walk MIME parts
    for part in msg.walk():
        ct = part.get_content_type()
        cd = part.get_content_disposition()
        payload = part.get_payload(decode=True)

        if payload is None:
            continue

        if ct == "text/plain" and cd != "attachment":
            builder.body_text = payload.decode("utf-8", errors="replace")

        elif ct == "text/html" and cd != "attachment":
            builder.body_html = payload  # raw bytes (usually UTF-8)

        elif cd == "attachment" or (ct.startswith("image/") and part.get("Content-ID")):
            att: dict = {
                "filename": part.get_filename() or "attachment.bin",
                "mime_type": ct,
                "data": payload,
                "content_id": _strip_angle_brackets(part.get("Content-ID")),
                "disposition": cd,
            }
            builder.attachments.append(att)

    builder.build(oft_path)


def _strip_angle_brackets(s: str | None) -> str | None:
    if s is None:
        return None
    s = s.strip()
    if s.startswith("<") and s.endswith(">"):
        s = s[1:-1]
    return s


# ============================================================================
# CLI
# ============================================================================
def main() -> None:
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <input_dir_or_file> [output_dir]")
        print()
        print("Convert .emltpl email templates to Outlook .oft format.")
        print()
        print("  input_dir_or_file  Path to a single .emltpl or directory of them")
        print("  output_dir         (optional) Output directory for .oft files")
        print("                     Defaults to same directory as each .emltpl")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    output_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else None

    if input_path.is_file():
        emltpl_files = [input_path]
    elif input_path.is_dir():
        emltpl_files = sorted(input_path.glob("*.emltpl"))
        if not emltpl_files:
            print(f"No .emltpl files found in {input_path}")
            sys.exit(1)
    else:
        print(f"Not found: {input_path}")
        sys.exit(1)

    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)

    succeeded = 0
    failed = 0

    for emltpl in emltpl_files:
        dest_dir = output_dir or emltpl.parent
        oft_name = emltpl.stem + ".oft"
        oft_path = dest_dir / oft_name

        try:
            convert_emltpl(emltpl, oft_path)
            size_kb = oft_path.stat().st_size / 1024
            print(f"  OK  {emltpl.name}  ->  {oft_name} ({size_kb:.1f} KB)")
            succeeded += 1
        except Exception as exc:
            print(f"  FAIL  {emltpl.name}: {exc}")
            failed += 1

    print()
    print(f"Done: {succeeded} converted, {failed} failed")


if __name__ == "__main__":
    main()
