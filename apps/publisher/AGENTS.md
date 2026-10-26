# @anr/publisher

The only code that talks to channels. When an approved publication's slot comes up it renders each channel's template, sends, and records the Post. Also runs the podcast audio pipeline (Gemini TTS per segment with host and narrator voices and delivery directions as style prompts, sound cues from stock assets, ffmpeg mix to −16 LUFS, ID3 + chapters, C2PA signing, upload to R2, feed item).

Rules (see `docs/technical-design.md#publishing`):
- Write the Post row (publication, channel, part) before calling a channel; store the message id after. A retry with a stored id skips; an unknown result is held for a person, never re-sent. After a database restore, every slot already past due is held.
- Templates come from `config/formats/<format>/templates/<channel>.liquid`; the disclosure partial is mandatory.
- Commands: `pnpm --filter @anr/publisher test`.
