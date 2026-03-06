from __future__ import annotations

import email
import email.policy
import encodings
from email.message import Message
from pathlib import Path

from .mapi import OFTBuilder

CHARSET_CODEPAGES = {
    "ascii": 20127,
    "big5": 950,
    "euc_jp": 20932,
    "gb2312": 936,
    "iso8859-1": 28591,
    "iso8859-15": 28605,
    "shift_jis": 932,
    "utf-16": 1200,
    "utf-16-be": 1201,
    "utf-16-le": 1200,
    "utf-8": 65001,
}


def _charset_to_codepage(charset: str | None) -> int | None:
    if not charset:
        return None
    codec = encodings.search_function(charset)
    canonical = codec.name if codec is not None else charset.lower().replace("_", "-")

    if canonical in CHARSET_CODEPAGES:
        return CHARSET_CODEPAGES[canonical]
    if canonical.startswith("cp") and canonical[2:].isdigit():
        return int(canonical[2:])
    return None


def _decode_text_part(part: Message) -> str:
    content = part.get_content()
    if isinstance(content, str):
        return content

    payload = part.get_payload(decode=True) or b""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset)
    except (LookupError, UnicodeDecodeError):
        return payload.decode(charset, errors="replace")


def _strip_angle_brackets(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if value.startswith("<") and value.endswith(">"):
        return value[1:-1]
    return value


def convert_emltpl(emltpl_path: str | Path, oft_path: str | Path) -> None:
    with open(emltpl_path, "rb") as fileobj:
        message = email.message_from_binary_file(fileobj, policy=email.policy.default)

    builder = OFTBuilder()
    builder.subject = message.get("Subject", "") or ""

    for part in message.walk():
        content_type = part.get_content_type()
        content_disposition = part.get_content_disposition()
        payload = part.get_payload(decode=True)

        if payload is None:
            continue

        if content_type == "text/plain" and content_disposition != "attachment":
            builder.body_text = _decode_text_part(part)
            if codepage := _charset_to_codepage(part.get_content_charset()):
                builder.internet_codepage = codepage
            continue

        if content_type == "text/html" and content_disposition != "attachment":
            builder.body_html = payload
            if not builder.body_text and (
                codepage := _charset_to_codepage(part.get_content_charset())
            ):
                builder.internet_codepage = codepage
            continue

        if content_disposition == "attachment" or (
            content_type.startswith("image/") and part.get("Content-ID")
        ):
            builder.attachments.append(
                {
                    "filename": part.get_filename() or "attachment.bin",
                    "mime_type": content_type,
                    "data": payload,
                    "content_id": _strip_angle_brackets(part.get("Content-ID")),
                    "disposition": content_disposition,
                }
            )

    builder.build(oft_path)
