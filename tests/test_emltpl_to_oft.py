from __future__ import annotations

import importlib.util
import struct
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "tools" / "emltpl_to_oft.py"

SPEC = importlib.util.spec_from_file_location("emltpl_to_oft", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


@dataclass(frozen=True)
class Header:
    dir_start: int
    first_difat: int
    mini_fat_start: int
    n_difat: int
    n_fat: int
    n_mini_fat: int


@dataclass(frozen=True)
class DirEntry:
    child_sid: int
    entry_type: int
    left_sid: int
    name: str
    right_sid: int
    start_sector: int
    stream_size: int


class CFBReader:
    def __init__(self, path: Path) -> None:
        self._data = path.read_bytes()
        self.header = self._parse_header()
        self.difat = self._read_difat()
        self.fat = self._read_fat()
        self.entries = self._read_directory_entries()
        self.children = self._build_children()
        self.mini_fat = self._read_mini_fat()
        root = self.entries[0]
        self.mini_stream = self._read_regular_chain(root.start_sector, root.stream_size)

    def _parse_header(self) -> Header:
        header = self._data[: MODULE.SECTOR_SIZE]
        return Header(
            dir_start=struct.unpack_from("<I", header, 0x30)[0],
            first_difat=struct.unpack_from("<I", header, 0x44)[0],
            mini_fat_start=struct.unpack_from("<I", header, 0x3C)[0],
            n_difat=struct.unpack_from("<I", header, 0x48)[0],
            n_fat=struct.unpack_from("<I", header, 0x2C)[0],
            n_mini_fat=struct.unpack_from("<I", header, 0x40)[0],
        )

    def _sector_bytes(self, sid: int) -> bytes:
        start = MODULE.SECTOR_SIZE * (sid + 1)
        end = start + MODULE.SECTOR_SIZE
        return self._data[start:end]

    def _read_difat(self) -> list[int]:
        header = self._data[: MODULE.SECTOR_SIZE]
        difat = [
            struct.unpack_from("<I", header, 0x4C + i * 4)[0]
            for i in range(MODULE.HEADER_DIFAT_ENTRIES)
        ]
        difat = [sid for sid in difat if sid != MODULE.FREESECT]

        next_sid = self.header.first_difat
        for _ in range(self.header.n_difat):
            sector = self._sector_bytes(next_sid)
            difat.extend(
                sid
                for sid in struct.unpack("<127I", sector[: MODULE.SECTOR_SIZE - 4])
                if sid != MODULE.FREESECT
            )
            next_sid = struct.unpack_from("<I", sector, MODULE.SECTOR_SIZE - 4)[0]

        return difat[: self.header.n_fat]

    def _read_fat(self) -> list[int]:
        fat: list[int] = []
        for sid in self.difat:
            fat.extend(struct.unpack("<128I", self._sector_bytes(sid)))
        return fat

    def _read_regular_chain(self, start_sid: int, stream_size: int | None = None) -> bytes:
        if start_sid == MODULE.ENDOFCHAIN:
            return b""

        chunks: list[bytes] = []
        sid = start_sid
        visited: set[int] = set()
        while sid != MODULE.ENDOFCHAIN:
            if sid in visited:
                raise AssertionError(f"cycle detected in FAT chain at sector {sid}")
            visited.add(sid)
            chunks.append(self._sector_bytes(sid))
            sid = self.fat[sid]
        data = b"".join(chunks)
        return data[:stream_size] if stream_size is not None else data

    def _read_mini_fat(self) -> list[int]:
        if self.header.mini_fat_start == MODULE.ENDOFCHAIN or self.header.n_mini_fat == 0:
            return []
        raw = self._read_regular_chain(
            self.header.mini_fat_start,
            self.header.n_mini_fat * MODULE.SECTOR_SIZE,
        )
        return list(struct.unpack(f"<{len(raw) // 4}I", raw))

    def _read_directory_entries(self) -> list[DirEntry]:
        directory = self._read_regular_chain(self.header.dir_start)
        entries: list[DirEntry] = []
        for offset in range(0, len(directory), 128):
            chunk = directory[offset : offset + 128]
            if len(chunk) < 128:
                break
            name_size = struct.unpack_from("<H", chunk, 0x40)[0]
            name = chunk[: name_size - 2].decode("utf-16-le") if name_size >= 2 else ""
            entries.append(
                DirEntry(
                    child_sid=struct.unpack_from("<I", chunk, 0x4C)[0],
                    entry_type=chunk[0x42],
                    left_sid=struct.unpack_from("<I", chunk, 0x44)[0],
                    name=name,
                    right_sid=struct.unpack_from("<I", chunk, 0x48)[0],
                    start_sector=struct.unpack_from("<I", chunk, 0x74)[0],
                    stream_size=struct.unpack_from("<I", chunk, 0x78)[0],
                )
            )
        return entries

    def _build_children(self) -> dict[int, list[int]]:
        def walk_tree(sid: int, acc: list[int]) -> None:
            if sid == MODULE.NOSTREAM:
                return
            entry = self.entries[sid]
            walk_tree(entry.left_sid, acc)
            acc.append(sid)
            walk_tree(entry.right_sid, acc)

        children: dict[int, list[int]] = {}
        for parent_sid, entry in enumerate(self.entries):
            if entry.entry_type not in (MODULE.DIR_TYPE_ROOT, MODULE.DIR_TYPE_STORAGE):
                continue
            acc: list[int] = []
            walk_tree(entry.child_sid, acc)
            children[parent_sid] = acc
        return children

    def _find_entry(self, path: tuple[str, ...]) -> DirEntry:
        parent_sid = 0
        entry: DirEntry | None = None
        for name in path:
            entry = None
            for child_sid in self.children[parent_sid]:
                child = self.entries[child_sid]
                if child.name == name:
                    entry = child
                    parent_sid = child_sid
                    break
            if entry is None:
                raise KeyError(path)
        assert entry is not None
        return entry

    def read_stream(self, path: tuple[str, ...]) -> bytes:
        entry = self._find_entry(path)
        if entry.stream_size < MODULE.MINI_STREAM_CUTOFF:
            return self._read_mini_chain(entry.start_sector, entry.stream_size)
        return self._read_regular_chain(entry.start_sector, entry.stream_size)

    def _read_mini_chain(self, start_sid: int, stream_size: int) -> bytes:
        if start_sid == MODULE.ENDOFCHAIN:
            return b""

        chunks: list[bytes] = []
        sid = start_sid
        visited: set[int] = set()
        while sid != MODULE.ENDOFCHAIN:
            if sid in visited:
                raise AssertionError(f"cycle detected in mini FAT chain at sector {sid}")
            visited.add(sid)
            start = sid * MODULE.MINI_SECTOR_SIZE
            end = start + MODULE.MINI_SECTOR_SIZE
            chunks.append(self.mini_stream[start:end])
            sid = self.mini_fat[sid]
        return b"".join(chunks)[:stream_size]


def _parse_int32_properties(data: bytes, *, is_top_level: bool) -> dict[int, int]:
    offset = 32 if is_top_level else 8
    properties: dict[int, int] = {}
    while offset + 16 <= len(data):
        prop_type, prop_id, _flags = struct.unpack_from("<HHI", data, offset)
        value = struct.unpack_from("<I", data, offset + 8)[0]
        if prop_id == 0 and prop_type == 0:
            offset += 16
            continue
        if prop_type == MODULE.PT_INT32:
            properties[prop_id] = value
        offset += 16
    return properties


class EmltplToOftTests(unittest.TestCase):
    def test_large_fat_emits_difat_chain(self) -> None:
        writer = MODULE.CFBWriter()
        root = writer.add_root(clsid=MODULE.CLSID_OFT)
        writer.add_stream(root, "large.bin", b"x" * (8 * 1024 * 1024))

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "large.oft"
            writer.save(output_path)
            cfb = CFBReader(output_path)

        self.assertGreater(cfb.header.n_fat, MODULE.HEADER_DIFAT_ENTRIES)
        self.assertNotEqual(cfb.header.first_difat, MODULE.ENDOFCHAIN)
        self.assertGreater(cfb.header.n_difat, 0)
        self.assertEqual(len(cfb.difat), cfb.header.n_fat)

    def test_iso_8859_1_body_and_codepage_are_preserved(self) -> None:
        message = (
            b"Subject: Charset check\n"
            b"MIME-Version: 1.0\n"
            b"Content-Type: text/plain; charset=iso-8859-1\n"
            b"Content-Transfer-Encoding: quoted-printable\n"
            b"\n"
            b"Ol=E1\n"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            tempdir = Path(tmpdir)
            emltpl_path = tempdir / "sample.emltpl"
            output_path = tempdir / "sample.oft"
            emltpl_path.write_bytes(message)
            MODULE.convert_emltpl(emltpl_path, output_path)
            cfb = CFBReader(output_path)

        body = cfb.read_stream(("__substg1.0_1000001F",)).decode("utf-16-le")
        props = _parse_int32_properties(
            cfb.read_stream(("__properties_version1.0",)),
            is_top_level=True,
        )

        self.assertEqual(body, "Olá\n")
        self.assertEqual(props[0x3FDE], 28591)

    def test_attachment_data_round_trips(self) -> None:
        message = (
            b"Subject: Attachment check\n"
            b"MIME-Version: 1.0\n"
            b"Content-Type: multipart/mixed; boundary=BOUNDARY\n"
            b"\n"
            b"--BOUNDARY\n"
            b"Content-Type: text/plain; charset=utf-8\n"
            b"\n"
            b"hello\n"
            b"--BOUNDARY\n"
            b"Content-Type: application/octet-stream\n"
            b"Content-Disposition: attachment; filename=test.bin\n"
            b"Content-Transfer-Encoding: base64\n"
            b"\n"
            b"AAECAwQF\n"
            b"--BOUNDARY--\n"
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            tempdir = Path(tmpdir)
            emltpl_path = tempdir / "sample.emltpl"
            output_path = tempdir / "sample.oft"
            emltpl_path.write_bytes(message)
            MODULE.convert_emltpl(emltpl_path, output_path)
            cfb = CFBReader(output_path)

        attachment_data = cfb.read_stream(("__attach_version1.0_#00000000", "__substg1.0_37010102"))

        self.assertEqual(attachment_data, b"\x00\x01\x02\x03\x04\x05")


if __name__ == "__main__":
    unittest.main()
