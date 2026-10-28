# Scores: 1 (bad) to 5 (fit to publish)

Listen to `listen/<engine>-<language>.mp3` and `-stability.mp3`. Speed and memory come from
`out/<engine>/<language>/timings.json` (compute seconds per second of audio; peak MB, with LM Studio's
models loaded as usual).

| Criterion | What to listen for | Chatterbox en | Chatterbox tr | XTTS en | XTTS tr | Dia en |
| --- | --- | --- | --- | --- | --- | --- |
| Pronunciation | Names, numbers ("2026", "3"), Turkish ğ/ı/ş/ü, the â in "zekâ" | | | | | | |
| Naturalness | Rhythm, sentence ends, no robotic pacing | | | | | | |
| Speaker distinctness | The two hosts are easy to tell apart and stay consistent | | | | | | |
| Stability | The three stability takes: no drift, skipped words or invented words | | | | | | |
| Disclosure line | "AI voice" / "yapay zekâ" in the intro is clearly spoken | | | | | | |
| Speed | Compute s per audio s (lower is better; under 1 is faster than real time) | | | | | | |
| Memory | Peak MB | | | | | | |
| **Fit to publish** | yes / no | | | | | | |

Notes:

- XTTS-v2: the Coqui Public Model License (non-commercial) was accepted by Mehrad on 2026-10-28, for evaluation and non-commercial use; to be removed if ANR ever earns money.
