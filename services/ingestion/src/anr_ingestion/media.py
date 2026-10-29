"""Images a desk member adds by URL (D119): IPTC Photo Metadata read from XMP, and the free
licences Wikimedia Commons records for a file. Pure: no network, no database."""

import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, unquote, urlencode, urlsplit

from lxml import etree, html

RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
DC = "http://purl.org/dc/elements/1.1/"
PHOTOSHOP = "http://ns.adobe.com/photoshop/1.0/"
XMP_RIGHTS = "http://ns.adobe.com/xap/1.0/rights/"
PLUS = "http://ns.useplus.org/ldf/xmp/1.0/"
IPTC_EXT = "http://iptc.org/std/Iptc4xmpExt/2008-02-29/"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"
DIGITAL_SOURCE_TYPE = re.compile(r"http://cv\.iptc\.org/newscodes/digitalsourcetype/[A-Za-z]+")

COMMONS_HOST = "commons.wikimedia.org"
COMMONS_API = f"https://{COMMONS_HOST}/w/api.php"
CONTENT_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})


@dataclass(frozen=True)
class PhotoMetadata:
    creator: str | None = None
    credit_line: str | None = None
    copyright_notice: str | None = None
    web_statement: str | None = None
    licensor: str | None = None
    digital_source_type: str | None = None
    description: str | None = None


def _clean(value: str | None) -> str | None:
    return (" ".join(value.split()) or None) if value else None


def _xmp_packet(data: bytes) -> bytes | None:
    """The first `x:xmpmeta` element anywhere in the file: XMP packet scanning, which finds it in
    a JPEG APP1 segment, a PNG iTXt chunk or a WebP XMP chunk alike."""
    start = data.find(b"<x:xmpmeta")
    if start < 0:
        return None
    end = data.find(b"</x:xmpmeta>", start)
    return data[start : end + len(b"</x:xmpmeta>")] if end >= 0 else None


def _items(prop: etree._Element) -> list[str]:
    """A property's values: an rdf:resource, an rdf:Seq/Bag's items, an rdf:Alt's x-default (or
    first) item, or its text."""
    resource = prop.get(f"{{{RDF}}}resource")
    if resource is not None:
        return [resource]
    for kind in ("Seq", "Bag"):
        container = prop.find(f"{{{RDF}}}{kind}")
        if container is not None:
            return [li.text or "" for li in container.findall(f"{{{RDF}}}li")]
    alt = prop.find(f"{{{RDF}}}Alt")
    if alt is not None:
        items = alt.findall(f"{{{RDF}}}li")
        default = [li for li in items if li.get(XML_LANG) == "x-default"]
        return [(default or items)[0].text or ""] if items else []
    return [prop.text or ""]


def _values(descriptions: list[etree._Element], ns: str, name: str) -> list[str]:
    """A top-level property's values, written as an attribute or as an element."""
    tag = f"{{{ns}}}{name}"
    found: list[str] = []
    for desc in descriptions:
        if (attr := desc.get(tag)) is not None:
            found.append(attr)
        for prop in desc.findall(tag):
            found.extend(_items(prop))
    return [v for v in (_clean(x) for x in found) if v]


def _licensors(descriptions: list[etree._Element]) -> list[str]:
    """plus:Licensor is an rdf:Seq of structs; each struct's plus:LicensorName, as an attribute
    or an element, on the item or on an rdf:Description inside it."""
    name = f"{{{PLUS}}}LicensorName"
    found: list[str] = []
    for desc in descriptions:
        for licensor in desc.findall(f"{{{PLUS}}}Licensor"):
            for li in licensor.iter(f"{{{RDF}}}li"):
                for node in li.iter():
                    if (attr := node.get(name)) is not None:
                        found.append(attr)
                    elif node.tag == name:
                        found.append(node.text or "")
    return [v for v in (_clean(x) for x in found) if v] or _values(
        descriptions, PLUS, "LicensorName"
    )


def read_xmp(data: bytes) -> PhotoMetadata:
    """The image's IPTC Photo Metadata; all None when it has no XMP or the XMP is unreadable."""
    packet = _xmp_packet(data)
    if packet is None:
        return PhotoMetadata()
    parser = etree.XMLParser(
        resolve_entities=False, no_network=True, huge_tree=False, load_dtd=False
    )
    try:
        return _photo_metadata(etree.fromstring(packet, parser))
    except (etree.LxmlError, ValueError):
        return PhotoMetadata()


def _photo_metadata(root: etree._Element) -> PhotoMetadata:
    descriptions = list(root.iter(f"{{{RDF}}}Description"))

    def joined(ns: str, name: str) -> str | None:
        return ", ".join(_values(descriptions, ns, name)) or None

    def first(ns: str, name: str) -> str | None:
        return next(iter(_values(descriptions, ns, name)), None)

    source_type = first(IPTC_EXT, "DigitalSourceType")
    return PhotoMetadata(
        creator=joined(DC, "creator"),
        credit_line=first(PHOTOSHOP, "Credit"),
        copyright_notice=first(DC, "rights"),
        web_statement=first(XMP_RIGHTS, "WebStatement"),
        licensor=", ".join(_licensors(descriptions)) or None,
        # Only a full IPTC code; a bare or unknown word is never guessed into one.
        digital_source_type=(
            source_type if source_type and DIGITAL_SOURCE_TYPE.fullmatch(source_type) else None
        ),
        description=first(DC, "description"),
    )


def sniff_type(data: bytes) -> str | None:
    """The image type from its bytes, never from the Content-Type header."""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


# Wikimedia Commons


class NoSuchFile(ValueError):
    pass


@dataclass(frozen=True)
class CommonsFile:
    file_url: str
    mime: str | None
    licence: str | None
    """The free licence's short name as Commons gives it ("CC BY-SA 4.0"); None for any other."""
    licence_url: str | None
    credit_line: str | None
    creator: str | None
    description: str | None


def commons_title(url: str) -> str | None:
    """`File:…` for a Commons file page (`/wiki/File:…` or `?title=File:…`), else None."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or parts.hostname != COMMONS_HOST:
        return None
    if parts.path.startswith("/wiki/"):
        title = unquote(parts.path.removeprefix("/wiki/"))
    else:
        title = next(iter(parse_qs(parts.query).get("title", [])), "")
    title = title.replace("_", " ").strip()
    return title if title.startswith("File:") and len(title) > len("File:") else None


def commons_page_url(title: str) -> str:
    return f"https://{COMMONS_HOST}/wiki/{title.replace(' ', '_')}"


def commons_api_url(title: str) -> str:
    query = {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "prop": "imageinfo",
        "iiprop": "url|mime|extmetadata",
        "titles": title,
    }
    return f"{COMMONS_API}?{urlencode(query)}"


# Any version and any port ("CC BY-SA 3.0 de", "cc-by-sa-3.0-igo"); never NC or ND.
_CC = re.compile(r"CC BY(-SA)? \d\.\d(?: [a-z]{2,5})?")
_CC_CODE = re.compile(r"cc-by(-sa)?-\d\.\d(?:-[a-z]{2,5})?")
_PD = re.compile(r"(Public domain|PD(-[A-Za-z0-9.-]+)?|CC0(?: 1\.0)?)")
_PD_CODE = re.compile(r"(pd(-[a-z0-9.-]+)?|cc0(-1\.0)?)")


def _text(value: str | None) -> str | None:
    """Text of an extmetadata value, which is HTML."""
    if not value or not value.strip():
        return None
    try:
        fragment = html.fragment_fromstring(value, create_parent="div")
    except etree.ParserError:
        return _clean(value)
    return _clean(fragment.text_content())


def _free(short: str | None, code: str | None) -> tuple[bool, bool]:
    """(free, public domain) for Commons' LicenseShortName and License; only CC0, public domain,
    CC BY and CC BY-SA are free here, and both fields must agree when both are given."""
    if not short:
        return False, False
    pd = bool(_PD.fullmatch(short))
    if not (pd or _CC.fullmatch(short)):
        return False, False
    if code and not (_PD_CODE if pd else _CC_CODE).fullmatch(code.lower()):
        return False, False
    return True, pd


def credit_line(xmp: PhotoMetadata, commons: CommonsFile | None) -> str | None:
    """A Commons file is credited to its author, as its free licence requires; the file's own
    credit only fills in where Commons names no author."""
    return (commons.credit_line if commons else None) or xmp.credit_line


def parse_commons(data: bytes) -> CommonsFile:
    """Commons' imageinfo answer (formatversion=2) for one file. Raises NoSuchFile when it names
    no file, another ValueError when it cannot be read. A licence needs an Artist (its credit)
    and, unless public domain (then its file page will do), a LicenseUrl."""
    answer = json.loads(data)
    pages = answer.get("query", {}).get("pages", [])
    page = pages[0] if pages else {}
    info = (page.get("imageinfo") or [None])[0]
    if page.get("missing") or not info or not info.get("url"):
        raise NoSuchFile(f"{page.get('title')}: Commons has no such file")
    meta: dict[str, Any] = info.get("extmetadata") or {}

    def field(name: str) -> str | None:
        value = (meta.get(name) or {}).get("value")
        return value if isinstance(value, str) else None

    artist = _text(field("Artist"))
    short = _text(field("LicenseShortName"))
    licence_url = _clean(field("LicenseUrl"))
    free, pd = _free(short, _clean(field("License")))
    if (field("NonFree") or "").strip().lower() in ("true", "1"):
        free = False
    if free and pd and not licence_url:
        # Commons may omit a public-domain file's URL; its file page says why.
        licence_url = _clean(info.get("descriptionurl"))
    if licence_url is not None and not licence_url.startswith(("https://", "http://")):
        licence_url = None
    licensed = free and artist is not None and licence_url is not None
    return CommonsFile(
        file_url=str(info["url"]),
        mime=info.get("mime"),
        licence=short if licensed else None,
        licence_url=licence_url if licensed else None,
        credit_line=f"{artist}, Wikimedia Commons" if artist else None,
        creator=artist,
        description=_text(field("ImageDescription")),
    )
