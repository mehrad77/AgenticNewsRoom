# Local TTS comparison: English and Turkish

Persian stays on Gemini TTS. This kit compares local engines for English and Turkish, so ANR can later
choose an API or one of these models. Only the tooling is committed: virtual environments, model
weights (in the Hugging Face cache) and generated audio are git-ignored.

| Engine | Licence | Languages here | Voices without cloning |
| --- | --- | --- | --- |
| Chatterbox Multilingual (Resemble AI) | MIT | en, tr | one default voice |
| XTTS-v2 (Coqui, community fork `coqui-tts`) | Coqui Public Model License: **non-commercial only** | en, tr | about 58 built-in speakers |
| Dia 1.6B (Nari Labs) | Apache 2.0 | **en only** | random per run; fixed by a seed here |

## 1. Install (you run these: each downloads a model)

Each engine in its own virtual environment, inside this folder. Read each README first; package
names and APIs change. The first run of `generate.py` downloads the model weights from Hugging Face.

```bash
cd tools/tts-eval

# Chatterbox Multilingual (MIT): https://github.com/resemble-ai/chatterbox
python3 -m venv .venv-chatterbox && .venv-chatterbox/bin/pip install chatterbox-tts

# XTTS-v2 (non-commercial): https://github.com/idiap/coqui-ai-TTS
python3 -m venv .venv-xtts && .venv-xtts/bin/pip install coqui-tts
# The first use asks you to accept the CPML licence (COQUI_TOS_AGREED=1 accepts it non-interactively).

# Dia 1.6B (English only): https://github.com/nari-labs/dia
python3 -m venv .venv-dia && .venv-dia/bin/pip install git+https://github.com/nari-labs/dia.git
```

## 2. Generate

```bash
.venv-chatterbox/bin/python generate.py chatterbox en
.venv-chatterbox/bin/python generate.py chatterbox tr
.venv-xtts/bin/python generate.py xtts en      # speakers.txt lists the built-in voices;
.venv-xtts/bin/python generate.py xtts tr      # pick two with --speaker "Name" --speaker "Name"
.venv-dia/bin/python generate.py dia en
```

Chatterbox has one default voice, so both hosts sound the same unless you give reference clips:
`--voice Maya=clips/maya.wav --voice Leo=clips/leo.wav`. A clip must be owned or consented, never a
recording of a real person without their consent; a clip that ships needs a `LICENSE.md`, like the
sound cues (D108).

## 3. Normalise and listen

```bash
python3 normalize.py     # listen/<engine>-<language>.mp3 and listen/<engine>-<language>-stability.mp3
```

Everything is brought to −16 LUFS like the episode pipeline, so loudness does not bias the comparison.
Or open the comparison page: start `tts-eval` from `.claude/launch.json` (a static server on :4430),
then http://localhost:4430/. It has side-by-side players, line-by-line A/B, blind mode, the models'
parameters and features, and scores saved in the browser. Score in `SCORES.md` or export from the page.
Each run's speed and memory are in `out/<engine>/<language>/timings.json`.

## Removing an engine

The weights are in `~/.cache/huggingface/hub/` (`models--ResembleAI--chatterbox`,
`models--tts-hub--XTTS-v2`, `models--nari-labs--Dia-1.6B-0626`). Delete that folder and the engine's
`.venv-*` here; `uv cache clean` frees the package cache.
