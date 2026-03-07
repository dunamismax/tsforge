from __future__ import annotations

import struct
import time
from pathlib import Path

CFB_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
SECTOR_SIZE = 512
MINI_SECTOR_SIZE = 64
MINI_STREAM_CUTOFF = 4096

FREESECT = 0xFFFFFFFF
ENDOFCHAIN = 0xFFFFFFFE
FATSECT = 0xFFFFFFFD
DIFSECT = 0xFFFFFFFC
NOSTREAM = 0xFFFFFFFF

FAT_ENTRIES_PER_SECTOR = SECTOR_SIZE // 4
HEADER_DIFAT_ENTRIES = 109
DIFAT_ENTRIES_PER_SECTOR = FAT_ENTRIES_PER_SECTOR - 1

DIR_TYPE_UNKNOWN = 0
DIR_TYPE_STORAGE = 1
DIR_TYPE_STREAM = 2
DIR_TYPE_ROOT = 5

COLOR_BLACK = 1

CLSID_OFT = struct.pack("<IHH", 0x0006F046, 0x0000, 0x0000) + bytes(
    [0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]
)
CLSID_NULL = b"\x00" * 16

type Buffer = bytes | bytearray | memoryview


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
        data: Buffer = b"",
    ):
        self.name = name
        self.entry_type = entry_type
        self.clsid = clsid
        self.data = memoryview(data)
        self.children: list[int] = []
        self.left_sid = NOSTREAM
        self.right_sid = NOSTREAM
        self.child_sid = NOSTREAM
        self.start_sector = ENDOFCHAIN
        self.stream_size = 0


class _StreamSector:
    """A regular sector backed by a slice of an existing stream buffer."""

    __slots__ = ("data",)

    def __init__(self, data: Buffer):
        self.data = memoryview(data)


def _python_time_to_filetime(timestamp: float) -> int:
    """Convert Unix time to Windows FILETIME."""
    epoch_diff = 11644473600
    return int((timestamp + epoch_diff) * 10_000_000)


class CFBWriter:
    """Build and write OLE2/CFB files from a tree of storages and streams."""

    def __init__(self) -> None:
        self._entries: list[_DirEntry] = []

    def add_root(self, clsid: bytes = CLSID_NULL) -> int:
        idx = len(self._entries)
        self._entries.append(_DirEntry("Root Entry", DIR_TYPE_ROOT, clsid))
        return idx

    def add_storage(self, parent: int, name: str, clsid: bytes = CLSID_NULL) -> int:
        idx = len(self._entries)
        self._entries.append(_DirEntry(name, DIR_TYPE_STORAGE, clsid))
        self._entries[parent].children.append(idx)
        return idx

    def add_stream(self, parent: int, name: str, data: Buffer) -> int:
        idx = len(self._entries)
        self._entries.append(_DirEntry(name, DIR_TYPE_STREAM, data=data))
        self._entries[parent].children.append(idx)
        return idx

    def save(self, path: str | Path) -> None:
        sectors: list[bytearray | _StreamSector] = []
        fat: list[int] = []

        def _pad(data: Buffer, boundary: int) -> bytes:
            raw = bytes(data)
            remainder = len(raw) % boundary
            return raw + b"\x00" * (boundary - remainder) if remainder else raw

        def _alloc_chain(data: Buffer) -> int:
            if not data:
                return ENDOFCHAIN
            start = len(sectors)
            n_sectors = (len(data) + SECTOR_SIZE - 1) // SECTOR_SIZE
            view = memoryview(data)
            for i in range(n_sectors):
                sectors.append(_StreamSector(view[i * SECTOR_SIZE : (i + 1) * SECTOR_SIZE]))
                fat.append(start + i + 1 if i < n_sectors - 1 else ENDOFCHAIN)
            return start

        mini_entries: list[int] = []
        regular_entries: list[int] = []
        for i, entry in enumerate(self._entries):
            if entry.entry_type != DIR_TYPE_STREAM or not entry.data:
                continue
            if len(entry.data) < MINI_STREAM_CUTOFF:
                mini_entries.append(i)
            else:
                regular_entries.append(i)

        mini_stream = bytearray()
        mini_fat: list[int] = []
        for idx in mini_entries:
            entry = self._entries[idx]
            start_ms = len(mini_stream) // MINI_SECTOR_SIZE
            padded = _pad(entry.data, MINI_SECTOR_SIZE)
            n_mini_sectors = len(padded) // MINI_SECTOR_SIZE
            entry.start_sector = start_ms
            entry.stream_size = len(entry.data)
            for j in range(n_mini_sectors):
                mini_fat.append(start_ms + j + 1 if j < n_mini_sectors - 1 else ENDOFCHAIN)
            mini_stream.extend(padded)

        if mini_stream:
            mini_stream = bytearray(_pad(mini_stream, SECTOR_SIZE))

        n_dir_entries = len(self._entries)
        dir_bytes_needed = ((n_dir_entries + 3) // 4) * SECTOR_SIZE
        dir_start = _alloc_chain(b"\x00" * dir_bytes_needed)
        n_dir_sectors = dir_bytes_needed // SECTOR_SIZE

        if mini_fat:
            mini_fat_data = _pad(b"".join(struct.pack("<I", sid) for sid in mini_fat), SECTOR_SIZE)
            mini_fat_start = _alloc_chain(mini_fat_data)
            n_mini_fat_sectors = len(mini_fat_data) // SECTOR_SIZE
        else:
            mini_fat_start = ENDOFCHAIN
            n_mini_fat_sectors = 0

        mini_stream_start = _alloc_chain(mini_stream) if mini_stream else ENDOFCHAIN

        for idx in regular_entries:
            entry = self._entries[idx]
            entry.start_sector = _alloc_chain(entry.data)
            entry.stream_size = len(entry.data)

        root = self._entries[0]
        root.start_sector = mini_stream_start
        root.stream_size = len(mini_stream)

        for entry in self._entries:
            if entry.entry_type in (DIR_TYPE_STORAGE, DIR_TYPE_ROOT) and entry is not root:
                entry.start_sector = 0
                entry.stream_size = 0

        n_fat, n_difat = self._calculate_fat_layout(len(sectors))

        fat_sids: list[int] = []
        for _ in range(n_fat):
            sid = len(sectors)
            sectors.append(bytearray(SECTOR_SIZE))
            fat.append(FATSECT)
            fat_sids.append(sid)

        difat_sids: list[int] = []
        for _ in range(n_difat):
            sid = len(sectors)
            sectors.append(bytearray(SECTOR_SIZE))
            fat.append(DIFSECT)
            difat_sids.append(sid)

        total_slots = n_fat * FAT_ENTRIES_PER_SECTOR
        while len(fat) < total_slots:
            fat.append(FREESECT)

        fat_raw = b"".join(struct.pack("<I", sid) for sid in fat[:total_slots])
        for i, sid in enumerate(fat_sids):
            sectors[sid] = bytearray(fat_raw[i * SECTOR_SIZE : (i + 1) * SECTOR_SIZE])

        for i, sid in enumerate(difat_sids):
            difat_sector = bytearray(SECTOR_SIZE)
            start = HEADER_DIFAT_ENTRIES + i * DIFAT_ENTRIES_PER_SECTOR
            entries = fat_sids[start : start + DIFAT_ENTRIES_PER_SECTOR]
            for j in range(DIFAT_ENTRIES_PER_SECTOR):
                value = entries[j] if j < len(entries) else FREESECT
                struct.pack_into("<I", difat_sector, j * 4, value)
            next_sid = difat_sids[i + 1] if i + 1 < len(difat_sids) else ENDOFCHAIN
            struct.pack_into("<I", difat_sector, SECTOR_SIZE - 4, next_sid)
            sectors[sid] = difat_sector

        self._build_dir_trees()

        directory = bytearray()
        for entry in self._entries:
            directory.extend(self._serialize_dir_entry(entry))
        directory.extend(b"\x00" * (dir_bytes_needed - len(directory)))
        for i in range(n_dir_sectors):
            sectors[dir_start + i] = bytearray(directory[i * SECTOR_SIZE : (i + 1) * SECTOR_SIZE])

        header = self._build_header(
            n_fat_sectors=n_fat,
            dir_start=dir_start,
            mini_fat_start=mini_fat_start,
            n_mini_fat_sectors=n_mini_fat_sectors,
            fat_sids=fat_sids,
            difat_sids=difat_sids,
        )

        with open(path, "wb") as fileobj:
            fileobj.write(header)
            for sector in sectors:
                if isinstance(sector, _StreamSector):
                    fileobj.write(sector.data)
                    padding = SECTOR_SIZE - len(sector.data)
                    if padding:
                        fileobj.write(b"\x00" * padding)
                    continue
                fileobj.write(bytes(sector))

    @staticmethod
    def _dir_sort_key(name: str) -> tuple[int, str]:
        return (len(name), name.upper())

    def _build_dir_trees(self) -> None:
        for entry in self._entries:
            if entry.entry_type not in (DIR_TYPE_ROOT, DIR_TYPE_STORAGE):
                continue
            if not entry.children:
                entry.child_sid = NOSTREAM
                continue
            kids = sorted(
                entry.children,
                key=lambda child_idx: self._dir_sort_key(self._entries[child_idx].name),
            )
            entry.child_sid = self._make_bst(kids, 0, len(kids) - 1)

    @staticmethod
    def _calculate_fat_layout(n_non_fat_sectors: int) -> tuple[int, int]:
        n_fat = 0
        n_difat = 0
        while True:
            total_sectors = n_non_fat_sectors + n_fat + n_difat
            next_n_fat = (total_sectors + FAT_ENTRIES_PER_SECTOR - 1) // FAT_ENTRIES_PER_SECTOR
            overflow = max(0, next_n_fat - HEADER_DIFAT_ENTRIES)
            next_n_difat = (
                (overflow + DIFAT_ENTRIES_PER_SECTOR - 1) // DIFAT_ENTRIES_PER_SECTOR
                if overflow
                else 0
            )
            if (next_n_fat, next_n_difat) == (n_fat, n_difat):
                return next_n_fat, next_n_difat
            n_fat, n_difat = next_n_fat, next_n_difat

    def _make_bst(self, kids: list[int], lo: int, hi: int) -> int:
        if lo > hi:
            return NOSTREAM
        mid = (lo + hi) // 2
        idx = kids[mid]
        entry = self._entries[idx]
        entry.left_sid = self._make_bst(kids, lo, mid - 1)
        entry.right_sid = self._make_bst(kids, mid + 1, hi)
        return idx

    @staticmethod
    def _serialize_dir_entry(entry: _DirEntry) -> bytes:
        name_utf16 = (entry.name + "\x00").encode("utf-16-le")
        name_bytes = name_utf16[:64].ljust(64, b"\x00")
        name_size = min(len(name_utf16), 64)

        buf = bytearray(128)
        buf[0:64] = name_bytes
        struct.pack_into("<H", buf, 0x40, name_size)
        buf[0x42] = entry.entry_type
        buf[0x43] = COLOR_BLACK
        struct.pack_into("<I", buf, 0x44, entry.left_sid)
        struct.pack_into("<I", buf, 0x48, entry.right_sid)
        struct.pack_into("<I", buf, 0x4C, entry.child_sid)
        buf[0x50 : 0x50 + 16] = entry.clsid if entry.clsid else CLSID_NULL

        filetime = _python_time_to_filetime(time.time())
        struct.pack_into("<Q", buf, 0x64, filetime)
        struct.pack_into("<Q", buf, 0x6C, filetime)

        struct.pack_into("<I", buf, 0x74, entry.start_sector & 0xFFFFFFFF)
        struct.pack_into("<I", buf, 0x78, entry.stream_size & 0xFFFFFFFF)
        struct.pack_into("<I", buf, 0x7C, 0)
        return bytes(buf)

    @staticmethod
    def _build_header(
        n_fat_sectors: int,
        dir_start: int,
        mini_fat_start: int,
        n_mini_fat_sectors: int,
        fat_sids: list[int],
        difat_sids: list[int],
    ) -> bytes:
        buf = bytearray(SECTOR_SIZE)
        buf[0:8] = CFB_MAGIC
        buf[8:24] = CLSID_NULL
        struct.pack_into("<H", buf, 0x18, 0x003E)
        struct.pack_into("<H", buf, 0x1A, 0x0003)
        struct.pack_into("<H", buf, 0x1C, 0xFFFE)
        struct.pack_into("<H", buf, 0x1E, 9)
        struct.pack_into("<H", buf, 0x20, 6)
        struct.pack_into("<I", buf, 0x28, 0)
        struct.pack_into("<I", buf, 0x2C, n_fat_sectors)
        struct.pack_into("<I", buf, 0x30, dir_start)
        struct.pack_into("<I", buf, 0x34, 0)
        struct.pack_into("<I", buf, 0x38, MINI_STREAM_CUTOFF)
        struct.pack_into("<I", buf, 0x3C, mini_fat_start)
        struct.pack_into("<I", buf, 0x40, n_mini_fat_sectors)
        first_difat_sector = difat_sids[0] if difat_sids else ENDOFCHAIN
        struct.pack_into("<I", buf, 0x44, first_difat_sector)
        struct.pack_into("<I", buf, 0x48, len(difat_sids))

        for i in range(HEADER_DIFAT_ENTRIES):
            value = fat_sids[i] if i < len(fat_sids) else FREESECT
            struct.pack_into("<I", buf, 0x4C + i * 4, value)

        return bytes(buf)
