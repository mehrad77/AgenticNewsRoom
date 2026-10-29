# Recorded responses for tests

Hand-built in the real formats (RSS 2.0, Atom, the arXiv API's Atom, the Hacker News Firebase API,
Semantic Scholar's batch API, HTML pages). The organisations are real feed hosts but every item,
text and person here is invented, so tests never touch the network and quote no one.

`web.json` maps each URL to the file served for it (and optional status and headers).

Media (D119): tiny 16x16 images made with ffmpeg, metadata written with exiftool (`-all=` first):
- `media-press.jpg`: XMP dc:creator (two), photoshop:Credit, dc:rights, xmpRights:WebStatement,
  plus:Licensor, a full IPTC DigitalSourceType URI and a dc:description with extra whitespace.
- `media-press.png`: XMP in an iTXt chunk; a bare `trainedAlgorithmicMedia`, not a URI.
- `media-plain.jpg`: no metadata. `media-commons.jpg`: only a dc:description.
- `commons-*.json`: Commons API answers (`prop=imageinfo&iiprop=url|mime|extmetadata`,
  `formatversion=2`): CC BY-SA 4.0 with an HTML Artist, CC BY-NC-SA, public domain without a
  LicenseUrl, a missing file. `not-an-image.html` is served as `image/jpeg`.
