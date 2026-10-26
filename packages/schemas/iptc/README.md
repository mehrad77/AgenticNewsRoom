# IPTC NewsCodes (vendored)

Pruned snapshots of four IPTC controlled vocabularies, and the ninjs 3.2 JSON Schema, used by config validation, the publisher and the verifier:

| File                     | Scheme                                                  | Used for                                              |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------- |
| `mediatopic.json`        | http://cv.iptc.org/newscodes/mediatopic/                | Subjects: each beat maps to Media Topics              |
| `genre.json`             | http://cv.iptc.org/newscodes/genre/                     | Genre: one per format, plus `genre:Opinion`           |
| `digitalsourcetype.json` | http://cv.iptc.org/newscodes/digitalsourcetype/         | AI disclosure (ninjs, JSON-LD, XMP, C2PA)             |
| `trustindicator.json`    | http://cv.iptc.org/newscodes/trustindicator/            | Links to the AI policy, corrections and verification  |
| `ninjs-schema_3.2.json`  | https://www.iptc.org/std/ninjs/ninjs-schema_3.2.json    | ninjs 3.2 JSON Schema, unchanged; the publisher's ninjs output is tested against it |

Each concept keeps `qcode`, the en-GB `label`, `broader` and `retired`. IPTC publishes labels in en-GB only for these schemes; reader-facing names in fa, en and tr are ANR's own.

Refresh with `pnpm --filter @anr/schemas iptc` and commit the result. CI never fetches.

© IPTC, International Press Telecommunications Council (https://iptc.org), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The vocabularies are pruned to the fields above.
