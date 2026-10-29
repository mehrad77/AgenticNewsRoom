"""Photo Metadata from XMP and licences from Commons: pure, on recorded files."""

import json

from conftest import FIXTURES

from anr_ingestion.media import (
    PhotoMetadata,
    commons_api_url,
    commons_title,
    credit_line,
    parse_commons,
    read_xmp,
    sniff_type,
)

PAGE = "https://commons.wikimedia.org/wiki/File:North_Hall_concert.jpg"


def xmp(rdf: str) -> bytes:
    return (
        b"\xff\xd8\xff\xe1junk<x:xmpmeta xmlns:x='adobe:ns:meta/'>"
        b"<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'"
        b" xmlns:dc='http://purl.org/dc/elements/1.1/'"
        b" xmlns:photoshop='http://ns.adobe.com/photoshop/1.0/'"
        b" xmlns:xmpRights='http://ns.adobe.com/xap/1.0/rights/'"
        b" xmlns:plus='http://ns.useplus.org/ldf/xmp/1.0/'"
        b" xmlns:Iptc4xmpExt='http://iptc.org/std/Iptc4xmpExt/2008-02-29/'>"
        + rdf.encode()
        + b"</rdf:RDF></x:xmpmeta>more junk"
    )


def test_reads_iptc_photo_metadata_from_a_jpeg() -> None:
    meta = read_xmp((FIXTURES / "media-press.jpg").read_bytes())
    assert meta == PhotoMetadata(
        creator="Ada Example, Bo Example",
        credit_line="Ada Example / North Label",
        copyright_notice="© 2026 North Label",
        web_statement="https://label.example/licensing",
        licensor="North Label",
        digital_source_type="http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
        description="The band on stage in Oslo",
    )


def test_reads_a_png_and_never_guesses_a_digital_source_type() -> None:
    meta = read_xmp((FIXTURES / "media-press.png").read_bytes())
    assert meta.creator == "Cem Example" and meta.credit_line == "Cem Example"
    # The file says "trainedAlgorithmicMedia", not the IPTC code's URI: not recorded.
    assert meta.digital_source_type is None
    assert meta.licensor is None and meta.description is None


def test_no_xmp_and_malformed_xmp_read_as_nothing() -> None:
    assert read_xmp((FIXTURES / "media-plain.jpg").read_bytes()) == PhotoMetadata()
    assert read_xmp(b"\xff\xd8\xff<x:xmpmeta><rdf:RDF><broken</x:xmpmeta>") == PhotoMetadata()
    assert read_xmp(b"\xff\xd8\xff<x:xmpmeta xmlns:x='adobe:ns:meta/'>") == PhotoMetadata()
    entity = b"<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///etc/passwd'>]>"
    assert read_xmp(entity + b"<x:xmpmeta>&e;</x:xmpmeta>") == PhotoMetadata()


def test_attribute_values_and_struct_descriptions_are_read_too() -> None:
    meta = read_xmp(
        xmp(
            "<rdf:Description rdf:about='' photoshop:Credit='  Fay   Example '"
            " xmpRights:WebStatement='https://label.example/terms'"
            " Iptc4xmpExt:DigitalSourceType="
            "'http://cv.iptc.org/newscodes/digitalsourcetype/compositeCapture'>"
            "<dc:rights><rdf:Alt><rdf:li xml:lang='de'>Alle Rechte</rdf:li>"
            "<rdf:li xml:lang='x-default'>All rights reserved</rdf:li></rdf:Alt></dc:rights>"
            "<dc:creator><rdf:Seq><rdf:li> </rdf:li></rdf:Seq></dc:creator>"
            "<plus:Licensor><rdf:Seq><rdf:li><rdf:Description plus:LicensorName='Label One'/>"
            "</rdf:li><rdf:li rdf:parseType='Resource'><plus:LicensorName>Label Two"
            "</plus:LicensorName></rdf:li></rdf:Seq></plus:Licensor>"
            "</rdf:Description>"
        )
    )
    assert meta.credit_line == "Fay Example"
    assert meta.web_statement == "https://label.example/terms"
    assert meta.digital_source_type == (
        "http://cv.iptc.org/newscodes/digitalsourcetype/compositeCapture"
    )
    assert meta.copyright_notice == "All rights reserved"
    assert meta.creator is None
    assert meta.licensor == "Label One, Label Two"


def test_a_plain_licensor_name_and_a_resource_source_type() -> None:
    meta = read_xmp(
        xmp(
            "<rdf:Description plus:LicensorName='Label Three'>"
            "<Iptc4xmpExt:DigitalSourceType rdf:resource="
            "'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture'/>"
            "</rdf:Description>"
        )
    )
    assert meta.licensor == "Label Three"
    assert meta.digital_source_type == (
        "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"
    )


def test_odd_but_well_formed_xmp_reads_as_nothing() -> None:
    odd = xmp(
        "<!-- a comment --><rdf:Description><dc:creator><rdf:Seq><!-- none -->"
        "</rdf:Seq></dc:creator><dc:rights><rdf:Alt/></dc:rights>"
        "<plus:Licensor><rdf:Seq><rdf:li><!-- x --></rdf:li></rdf:Seq></plus:Licensor>"
        "<Iptc4xmpExt:DigitalSourceType><rdf:Bag/></Iptc4xmpExt:DigitalSourceType>"
        "</rdf:Description><rdf:Description/>"
    )
    assert read_xmp(odd) == PhotoMetadata()


def test_sniffs_the_type_from_the_bytes() -> None:
    assert sniff_type((FIXTURES / "media-press.jpg").read_bytes()) == "image/jpeg"
    assert sniff_type((FIXTURES / "media-press.png").read_bytes()) == "image/png"
    assert sniff_type(b"RIFF\x24\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert sniff_type((FIXTURES / "not-an-image.html").read_bytes()) is None
    assert sniff_type(b"GIF89a") is None


def test_a_webp_xmp_chunk_is_found_by_scanning() -> None:
    packet = xmp("<rdf:Description photoshop:Credit='Gil Example'/>")
    data = b"RIFF\x00\x00\x00\x00WEBPVP8X" + b"\x00" * 14 + b"XMP " + packet[packet.find(b"<") :]
    assert read_xmp(data).credit_line == "Gil Example"


def test_commons_titles() -> None:
    assert commons_title(PAGE) == "File:North Hall concert.jpg"
    assert commons_title("https://commons.wikimedia.org/wiki/File:Caf%C3%A9_Oslo.jpg") == (
        "File:Café Oslo.jpg"
    )
    assert commons_title(
        "https://commons.wikimedia.org/w/index.php?title=File:North_Hall_concert.jpg&oldid=1"
    ) == ("File:North Hall concert.jpg")
    assert commons_title("https://upload.wikimedia.org/wikipedia/commons/a/ab/North.jpg") is None
    assert commons_title("https://commons.wikimedia.org/wiki/Category:Concerts") is None
    assert commons_title("https://commons.wikimedia.org/wiki/File:") is None
    assert commons_title("https://label.example/wiki/File:North.jpg") is None


def test_commons_api_url() -> None:
    assert commons_api_url("File:North Hall concert.jpg") == (
        "https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2"
        "&prop=imageinfo&iiprop=url%7Cmime%7Cextmetadata&titles=File%3ANorth+Hall+concert.jpg"
    )


def test_a_cc_by_sa_file_records_its_licence_and_credit() -> None:
    commons = parse_commons((FIXTURES / "commons-bysa.json").read_bytes())
    assert commons.file_url == (
        "https://upload.wikimedia.org/wikipedia/commons/a/ab/North_Hall_concert.jpg"
    )
    assert commons.mime == "image/jpeg"
    assert commons.licence == "CC BY-SA 4.0"
    assert commons.licence_url == "https://creativecommons.org/licenses/by-sa/4.0"
    assert commons.creator == "Dana Example"  # the Artist's HTML, as text
    assert commons.credit_line == "Dana Example, Wikimedia Commons"
    assert commons.description == "The North Hall during a concert, from the balcony."


def test_a_commons_author_is_the_credit_whatever_the_file_says() -> None:
    commons = parse_commons((FIXTURES / "commons-bysa.json").read_bytes())
    agency = PhotoMetadata(credit_line="Example Agency")
    assert credit_line(agency, commons) == "Dana Example, Wikimedia Commons"
    # Without an author from Commons, or off Commons, the file's own credit is used.
    assert credit_line(agency, None) == "Example Agency"
    nameless = json.loads((FIXTURES / "commons-bysa.json").read_bytes())
    del nameless["query"]["pages"][0]["imageinfo"][0]["extmetadata"]["Artist"]
    assert credit_line(agency, parse_commons(json.dumps(nameless).encode())) == "Example Agency"


def test_a_licence_url_that_is_not_http_gives_no_licence() -> None:
    data = (
        (FIXTURES / "commons-bysa.json")
        .read_bytes()
        .replace(b"https://creativecommons.org/licenses/by-sa/4.0", b"javascript:alert(1)")
    )
    commons = parse_commons(data)
    assert commons.licence is None and commons.licence_url is None


def test_a_non_commercial_file_has_no_licence() -> None:
    commons = parse_commons((FIXTURES / "commons-nc.json").read_bytes())
    assert commons.licence is None and commons.licence_url is None
    assert commons.credit_line == "Eli Example, Wikimedia Commons"


def test_public_domain_without_a_licence_url_uses_the_file_page() -> None:
    page = "https://commons.wikimedia.org/wiki/File:Old_poster.png"
    commons = parse_commons((FIXTURES / "commons-pd.json").read_bytes())
    assert commons.licence == "Public domain" and commons.licence_url == page
    assert commons.credit_line == "Unknown printer, Wikimedia Commons"


def answer(meta: dict[str, str], page: str | None = PAGE) -> bytes:
    extmetadata = {k: {"value": v} for k, v in meta.items()}
    info = {"url": "https://upload.wikimedia.org/x.jpg", "mime": "image/jpeg"}
    if page is not None:
        info["descriptionurl"] = page
    file = {"title": "File:X.jpg", "imageinfo": [{**info, "extmetadata": extmetadata}]}
    return json.dumps({"query": {"pages": [file]}}).encode()


def test_public_domain_without_any_page_url_has_no_licence() -> None:
    assert parse_commons(answer({"Artist": "Ada", "LicenseShortName": "CC0"}, None)).licence is None


def test_only_the_free_licences_are_recorded() -> None:
    url = "https://creativecommons.org/licenses/by/2.0"
    free = [
        {"LicenseShortName": "CC BY 2.0", "License": "cc-by-2.0", "LicenseUrl": url},
        {"LicenseShortName": "CC BY-SA 3.0 de", "License": "cc-by-sa-3.0-de", "LicenseUrl": url},
        {"LicenseShortName": "CC0", "License": "cc0"},
    ]
    for meta in free:
        assert parse_commons(answer({"Artist": "Ada", **meta})).licence is not None, meta
    unfree = [
        {"LicenseShortName": "CC BY-ND 4.0", "LicenseUrl": url},
        {"LicenseShortName": "CC BY 2.0"},  # no licence URL
        {"LicenseShortName": "CC BY 2.0", "License": "cc-by-nc-2.0", "LicenseUrl": url},
        {"LicenseShortName": "GFDL", "License": "gfdl", "LicenseUrl": url},
        {"LicenseShortName": "Fair use", "NonFree": "true"},
        {"LicenseShortName": "CC BY 2.0", "LicenseUrl": url, "NonFree": "true"},
        {"License": "cc-by-2.0", "LicenseUrl": url},
    ]
    for meta in unfree:
        assert parse_commons(answer({"Artist": "Ada", **meta})).licence is None, meta
    no_artist = {"LicenseShortName": "CC BY 2.0", "LicenseUrl": url}
    assert parse_commons(answer(no_artist)).licence is None
