"""A local text-to-speech server for one engine (D113), called by the publisher's local adapter.

    .venv-chatterbox/bin/python serve.py chatterbox --port 8601
    COQUI_TOS_AGREED=1 .venv-xtts/bin/python serve.py xtts --port 8602
    .venv-dia/bin/python serve.py dia --port 8603

POST /synthesize {"text", "language", "voice", "speaker", "direction"} answers 16-bit mono PCM with
its sample rate in the X-Sample-Rate header. A voice `default:<speaker>` asks for the engine's own
default for that speaker: a distinct built-in speaker (XTTS), a fixed seed (Dia), the default voice
(Chatterbox). Otherwise the voice is a built-in speaker name (XTTS), a reference clip path under
voices/ (Chatterbox, Dia; owned or consented, with a LICENSE.md, D108), or a seed (Dia). It listens
on 127.0.0.1 only; one request is voiced at a time.
"""

import argparse
import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
VOICES = HERE / "voices"
# Distinct XTTS built-in speakers, picked per speaker name when a series sets none.
XTTS_DEFAULTS = ["Claribel Dervla", "Damien Black", "Ana Florence", "Viktor Eka", "Craig Gutsy", "Gracie Wise"]


def pick(speaker: str, options: list[str]) -> str:
    return options[int(hashlib.sha256(speaker.encode()).hexdigest(), 16) % len(options)]


def clip(voice: str) -> str | None:
    """A reference clip inside voices/, never a path elsewhere on the machine."""
    path = (VOICES / voice).resolve()
    return str(path) if path.is_relative_to(VOICES.resolve()) and path.is_file() else None


def device() -> str:
    import torch

    if torch.cuda.is_available():
        return "cuda"
    return "mps" if torch.backends.mps.is_available() else "cpu"


def to_pcm(audio, scale_float: bool = True) -> bytes:
    a = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
    a = np.squeeze(a).astype(np.float32)
    return (np.clip(a, -1.0, 1.0) * 32767).astype("<i2").tobytes() if scale_float else a.tobytes()


def chatterbox():
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    model = ChatterboxMultilingualTTS.from_pretrained(device=device())

    def say(text: str, language: str, voice: str, speaker: str) -> tuple[bytes, int]:
        prompt = None if voice.startswith("default:") else clip(voice)
        wav = model.generate(text, language_id=language, **({"audio_prompt_path": prompt} if prompt else {}))
        return to_pcm(wav), model.sr

    return say


def xtts():
    import torch
    from TTS.api import TTS

    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cuda" if torch.cuda.is_available() else "cpu")
    rate = tts.synthesizer.output_sample_rate

    def say(text: str, language: str, voice: str, speaker: str) -> tuple[bytes, int]:
        name = pick(speaker, XTTS_DEFAULTS) if voice.startswith("default:") else voice
        wav = tts.tts(text=text, language=language, speaker=name)
        return to_pcm(wav), rate

    return say


def dia():
    import torch
    from dia.model import Dia

    model = Dia.from_pretrained("nari-labs/Dia-1.6B-0626", compute_dtype="float16", device=device())

    def say(text: str, language: str, voice: str, speaker: str) -> tuple[bytes, int]:
        if language != "en":
            raise ValueError("Dia speaks English only")
        prompt = None if voice.startswith("default:") else clip(voice)
        seed = int(hashlib.sha256((voice if voice.isdigit() else speaker).encode()).hexdigest(), 16) % 2**31
        # A fixed seed per speaker keeps one voice per speaker across lines.
        torch.manual_seed(int(voice) if voice.isdigit() else seed)
        audio = model.generate(f"[S1] {text}", use_torch_compile=False, **({"audio_prompt_path": prompt} if prompt else {}))
        return to_pcm(audio), 44_100

    return say


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("engine", choices=["chatterbox", "xtts", "dia"])
    p.add_argument("--port", type=int, required=True)
    a = p.parse_args()
    say = {"chatterbox": chatterbox, "xtts": xtts, "dia": dia}[a.engine]()
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            body = json.dumps({"engine": a.engine, "ok": True}).encode()
            self.send_response(200 if self.path == "/health" else 404)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            if self.path != "/synthesize":
                self.send_error(404)
                return
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                with lock:
                    pcm, rate = say(str(req["text"]), str(req["language"]), str(req["voice"]), str(req.get("speaker") or ""))
            except (KeyError, ValueError) as error:
                self.send_error(400, str(error))
                return
            except Exception as error:  # an engine failure is the request's answer, not a crash
                self.send_error(500, str(error)[:300])
                return
            self.send_response(200)
            self.send_header("content-type", "audio/L16")
            self.send_header("x-sample-rate", str(rate))
            self.send_header("content-length", str(len(pcm)))
            self.end_headers()
            self.wfile.write(pcm)

        def log_message(self, fmt: str, *args) -> None:
            print(f"[{a.engine}] {fmt % args}")

    print(f"[{a.engine}] listening on http://127.0.0.1:{a.port}")
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
