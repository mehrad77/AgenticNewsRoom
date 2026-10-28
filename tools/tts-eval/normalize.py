"""Joins each engine's lines into one dialogue and normalises it like the pipeline does (D109):
two-pass loudnorm to -16 LUFS, true peak -1.5 dBTP, 44.1 kHz mono MP3. Equal loudness keeps the
comparison fair. Needs only ffmpeg and the standard library:

    python3 normalize.py            # every out/<engine>/<language>/ → listen/<engine>-<language>.mp3
"""

import json
import re
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
TARGET = "I=-16:TP=-1.5:LRA=11"


def ffmpeg(*args: str) -> str:
    done = subprocess.run(["ffmpeg", "-hide_banner", "-nostdin", "-y", *args], capture_output=True, text=True, check=True)
    return done.stderr


def normalize(sources: list[Path], target: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        parts = []
        for n, src in enumerate(sources):
            part = work / f"{n:02d}.wav"
            # One format for every clip, then 0.35 s between lines, as in an episode.
            ffmpeg("-i", str(src), "-af", "apad=pad_dur=0.35", "-ar", "24000", "-ac", "1", str(part))
            parts.append(part)
        listing = work / "list.txt"
        listing.write_text("".join(f"file '{p}'\n" for p in parts))
        joined = work / "joined.wav"
        ffmpeg("-f", "concat", "-safe", "0", "-i", str(listing), str(joined))
        report = ffmpeg("-i", str(joined), "-af", f"loudnorm={TARGET}:print_format=json", "-f", "null", "-")
        m = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", report).group(0))
        second = (
            f"loudnorm={TARGET}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
            f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
        )
        ffmpeg("-i", str(joined), "-af", f"{second},aresample=44100", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", str(target))


def main() -> None:
    listen = HERE / "listen"
    listen.mkdir(exist_ok=True)
    for folder in sorted((HERE / "out").glob("*/*")):
        engine, language = folder.parent.name, folder.name
        lines = sorted(folder.glob("line-*.wav")) or sorted(folder.glob("dialogue.wav"))
        if lines:
            normalize(lines, listen / f"{engine}-{language}.mp3")
        # Each line alone, at the same loudness, for line-by-line A/B listening.
        (listen / "lines").mkdir(exist_ok=True)
        for line in sorted(folder.glob("line-*.wav")):
            target = listen / "lines" / f"{engine}-{language}-{line.stem.split('-')[1]}.mp3"
            ffmpeg("-i", str(line), "-af", f"loudnorm={TARGET},aresample=44100", "-ac", "1",
                   "-c:a", "libmp3lame", "-b:a", "128k", str(target))
        stability = sorted(folder.glob("stability-*.wav"))
        if stability:
            normalize(stability, listen / f"{engine}-{language}-stability.mp3")
        print(f"{engine}-{language}: done")
    manifest(listen)


LICENCES = {
    "chatterbox": "MIT",
    "xtts": "Coqui Public Model License (non-commercial)",
    "dia": "Apache 2.0",
}


def manifest(listen: Path) -> None:
    """What the comparison page shows: each engine's files, timings and voices, per language."""
    lines = json.loads((HERE / "lines.json").read_text(encoding="utf-8"))
    out: dict = {"languages": {}, "engines": json.loads((HERE / "engines.json").read_text(encoding="utf-8"))}
    for language in ("en", "tr"):
        engines = []
        for folder in sorted((HERE / "out").glob(f"*/{language}")):
            engine = folder.parent.name
            if not (listen / f"{engine}-{language}.mp3").exists():
                continue
            timings = folder / "timings.json"
            speakers = folder / "speakers.txt"
            engines.append(
                {
                    "engine": engine,
                    "licence": LICENCES.get(engine, ""),
                    "dialogue": f"listen/{engine}-{language}.mp3",
                    "stability": f"listen/{engine}-{language}-stability.mp3",
                    "lines": sorted(f"listen/lines/{p.name}" for p in (listen / "lines").glob(f"{engine}-{language}-*.mp3")),
                    "timings": json.loads(timings.read_text()) if timings.exists() else None,
                    "voices": speakers.exists(),
                }
            )
        if not engines:
            continue
        out["languages"][language] = {
            "hosts": lines[language]["hosts"],
            "lines": lines[language]["lines"],
            "stability": lines["stability"][language],
            "engines": engines,
        }
    (listen / "manifest.json").write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
