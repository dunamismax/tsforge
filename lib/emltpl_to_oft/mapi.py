from __future__ import annotations

import struct
import time
from pathlib import Path

from .cfb import CLSID_OFT, CFBWriter, _python_time_to_filetime

PT_INT32 = 0x0003
PT_BOOLEAN = 0x000B
PT_STRING = 0x001F
PT_BINARY = 0x0102
PT_SYSTIME = 0x0040

PROP_RW = 0x00000006

MSGFLAG_UNSENT = 0x00000008
MSGFLAG_HASATTACH = 0x00000010

DEFAULT_INTERNET_CODEPAGE = 65001


def _utf16le(text: str) -> bytes:
    return text.encode("utf-16-le")


def _stream_name(prop_id: int, prop_type: int) -> str:
    return f"__substg1.0_{prop_id:04X}{prop_type:04X}"


def _short_filename(name: str) -> str:
    path = Path(name)
    return f"{path.stem[:8]}{path.suffix[:4]}"


class PropertyStreamBuilder:
    """Build a __properties_version1.0 stream and its value streams."""

    def __init__(self, is_top_level: bool = False):
        self._is_top_level = is_top_level
        self._fixed: list[bytes] = []
        self._streams: dict[str, bytes | memoryview] = {}
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
        entry = struct.pack("<HHI", PT_STRING, prop_id, PROP_RW)
        entry += struct.pack("<I", len(data)) + b"\x00" * 4
        self._fixed.append(entry)

    def add_binary(self, prop_id: int, data: bytes | memoryview) -> None:
        name = _stream_name(prop_id, PT_BINARY)
        self._streams[name] = data
        entry = struct.pack("<HHI", PT_BINARY, prop_id, PROP_RW)
        entry += struct.pack("<I", len(data)) + b"\x00" * 4
        self._fixed.append(entry)

    def build_props_stream(self) -> bytes:
        if self._is_top_level:
            header = struct.pack(
                "<QIIII",
                0,
                self._n_recipients,
                self._n_attachments,
                self._n_recipients,
                self._n_attachments,
            )
            header += b"\x00" * 8
        else:
            header = b"\x00" * 8
        return header + b"".join(self._fixed)

    @property
    def value_streams(self) -> dict[str, bytes | memoryview]:
        return dict(self._streams)


class OFTBuilder:
    """Build an OFT file from decoded message components."""

    def __init__(self) -> None:
        self.subject: str = ""
        self.body_text: str = ""
        self.body_html: bytes = b""
        self.internet_codepage = DEFAULT_INTERNET_CODEPAGE
        self.attachments: list[dict] = []

    def build(self, path: str | Path) -> None:
        cfb = CFBWriter()

        root = cfb.add_root(clsid=CLSID_OFT)

        nameid = cfb.add_storage(root, "__nameid_version1.0")
        cfb.add_stream(nameid, "__substg1.0_00020102", b"")
        cfb.add_stream(nameid, "__substg1.0_00030102", b"")
        cfb.add_stream(nameid, "__substg1.0_00040102", b"")

        props = PropertyStreamBuilder(is_top_level=True)
        n_attach = len(self.attachments)
        props.set_counts(recipients=0, attachments=n_attach)

        now_ft = _python_time_to_filetime(time.time())
        msg_flags = MSGFLAG_UNSENT | (MSGFLAG_HASATTACH if n_attach > 0 else 0)

        props.add_string(0x001A, "IPM.Note")
        props.add_string(0x0037, self.subject)
        props.add_string(0x003D, "")
        props.add_string(0x0070, self.subject)
        props.add_string(0x0E1D, self.subject)
        props.add_int32(0x0E07, msg_flags)
        props.add_int32(0x340D, 0x00040E79)
        props.add_int32(0x3FDE, self.internet_codepage)
        props.add_int32(0x3FF1, 0x0409)
        props.add_time(0x3007, now_ft)
        props.add_time(0x3008, now_ft)

        if self.body_text:
            props.add_string(0x1000, self.body_text)
        if self.body_html:
            props.add_binary(0x1013, self.body_html)

        cfb.add_stream(root, "__properties_version1.0", props.build_props_stream())
        for stream_name, stream_data in props.value_streams.items():
            cfb.add_stream(root, stream_name, stream_data)

        for attachment_index, attachment in enumerate(self.attachments):
            attachment_storage = cfb.add_storage(
                root, f"__attach_version1.0_#{attachment_index:08X}"
            )
            props = PropertyStreamBuilder(is_top_level=False)

            props.add_int32(0x3705, 0x00000001)
            props.add_int32(0x370B, 0xFFFFFFFF)
            props.add_int32(0x0E20, len(attachment["data"]))
            props.add_int32(0x0FFE, 0x00000007)

            filename = attachment.get("filename", f"attachment_{attachment_index}")
            props.add_string(0x3707, filename)
            props.add_string(0x3704, _short_filename(filename))
            props.add_string(0x3001, filename)

            mime_type = attachment.get("mime_type", "application/octet-stream")
            props.add_string(0x370E, mime_type)

            extension = Path(filename).suffix
            if extension:
                props.add_string(0x3703, extension)

            content_id = attachment.get("content_id")
            if content_id:
                props.add_string(0x3712, content_id)

            props.add_binary(0x3701, attachment["data"])
            props.add_binary(0x3702, b"")

            cfb.add_stream(
                attachment_storage,
                "__properties_version1.0",
                props.build_props_stream(),
            )
            for stream_name, stream_data in props.value_streams.items():
                cfb.add_stream(attachment_storage, stream_name, stream_data)

        cfb.save(path)
