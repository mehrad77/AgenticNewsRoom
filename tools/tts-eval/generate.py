"""Voices the shared test lines (lines.json) with one local TTS engine, for the listening comparison.

    python generate.py chatterbox en|tr [--voice Maya=clips/maya.wav ...]
    python generate.py xtts en|tr [--speaker "Claribel Dervla" --speaker "Damien Black"]
    python generate.py dia en

Writes out/<engine>/<language>/: line-NN.wav (one per line; Dia: dialogue.wav), stability-1..3.wav
(the same hard line three times) and timings.json (compute seconds, audio seconds, peak memory).
Run inside that engine's own virtual environment (setup.sh). The engine APIs follow each README as
of October 2026: check the README if an import fails.
"""

import argparse
import json
import resource
import sys
import time
import subprocess
from pathlib import Path

HERE = Path(__file__).parent
LINES = json.loads((HERE / "lines.json").read_text(encoding="utf-8"))


def device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def seconds_of(path: Path) -> float:
    """Any WAV, float ones included (the standard wave module reads only integer PCM)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def chatterbox(lang: str, out: Path, voices: dict[str, str]):
    import torchaudio
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    model = ChatterboxMultilingualTTS.from_pretrained(device=device())

    def say(text: str, speaker: str, path: Path) -> None:
        clip = voices.get(speaker)
        wav = model.generate(text, language_id=lang, **({"audio_prompt_path": clip} if clip else {}))
        torchaudio.save(str(path), wav, model.sr)

    return say


def xtts(lang: str, out: Path, speakers: list[str]):
    import torch
    from TTS.api import TTS

    # XTTS on Apple's GPU is unreliable; the CPU is the safe default there.
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(dev)
    available = list(getattr(tts, "speakers", None) or [])
    (out / "speakers.txt").write_text("\n".join(available), encoding="utf-8")
    chosen = speakers or available[:2]
    hosts = LINES[lang]["hosts"]
    by_host = dict(zip(hosts, chosen, strict=False))
    print(f"[xtts] speakers: {by_host} (all built-in speakers listed in speakers.txt)")

    def say(text: str, speaker: str, path: Path) -> None:
        tts.tts_to_file(text=text, language=lang, speaker=by_host.get(speaker, chosen[0]), file_path=str(path))

    return say


def dia(lang: str, out: Path):
    if lang != "en":
        sys.exit("Dia 1.6B speaks English only")
    import torch
    from dia.model import Dia

    model = Dia.from_pretrained("nari-labs/Dia-1.6B-0626", compute_dtype="float16", device=device())

    def dialogue(lines: list[list], path: Path, seed: int = 7) -> None:
        # Dia picks voices at random; a fixed seed keeps the two speakers the same between runs.
        torch.manual_seed(seed)
        text = " ".join(f"[S{who + 1}] {t}" for who, t in lines)
        audio = model.generate(text, use_torch_compile=False)
        model.save_audio(str(path), audio)

    return dialogue


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("engine", choices=["chatterbox", "xtts", "dia"])
    p.add_argument("language", choices=["en", "tr"])
    p.add_argument("--voice", action="append", default=[], help="Chatterbox: Host=reference.wav (owned or consented)")
    p.add_argument("--speaker", action="append", default=[], help="XTTS: a built-in speaker per host, in order")
    a = p.parse_args()
    out = HERE / "out" / a.engine / a.language
    out.mkdir(parents=True, exist_ok=True)
    lines = LINES[a.language]["lines"]
    hosts = LINES[a.language]["hosts"]
    started = time.perf_counter()
    made: list[Path] = []

    if a.engine == "dia":
        dialogue = dia(a.language, out)
        loaded = time.perf_counter()
        made.append(out / "dialogue.wav")
        dialogue(lines, made[-1])
        for i in range(1, 4):
            made.append(out / f"stability-{i}.wav")
            dialogue([[1, LINES["stability"][a.language]]], made[-1])
    else:
        voices = dict(v.split("=", 1) for v in a.voice)
        say = chatterbox(a.language, out, voices) if a.engine == "chatterbox" else xtts(a.language, out, a.speaker)
        loaded = time.perf_counter()
        for n, (who, text) in enumerate(lines):
            made.append(out / f"line-{n:02d}.wav")
            say(text, hosts[who], made[-1])
        for i in range(1, 4):
            made.append(out / f"stability-{i}.wav")
            say(LINES["stability"][a.language], hosts[1], made[-1])

    done = time.perf_counter()
    audio = sum(seconds_of(f) for f in made)
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    timings = {
        "load_seconds": round(loaded - started, 1),
        "compute_seconds": round(done - loaded, 1),
        "audio_seconds": round(audio, 1),
        "compute_per_audio_second": round((done - loaded) / audio, 2) if audio else None,
        # ru_maxrss is bytes on macOS, kilobytes on Linux.
        "peak_memory_mb": round(peak / (1 if sys.platform == "linux" else 1024) / 1024),
    }
    (out / "timings.json").write_text(json.dumps(timings, indent=2))
    print(f"[{a.engine}] {a.language}: {timings}")


if __name__ == "__main__":
    main()
