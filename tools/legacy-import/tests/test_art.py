import pytest
from anr_legacy_import.art import content_type_of


def test_artwork_takes_its_type_from_its_file_name() -> None:
    assert content_type_of("https://media.example/covers/show-1400.jpg") == "image/jpeg"
    assert content_type_of("https://media.example/hosts/niloofar-512.PNG?v=2") == "image/png"
    assert content_type_of("https://media.example/hosts/leo.webp") == "image/webp"
    with pytest.raises(SystemExit):
        content_type_of("https://media.example/hosts/leo.gif")
