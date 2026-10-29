# @anr/publisher

The only code that talks to channels. When an approved publication's slot comes up it renders each channel's template, sends, and records the Post. Also runs the podcast audio pipeline (Gemini TTS per segment with host and narrator voices and delivery directions as style prompts, sound cues from stock assets, ffmpeg mix to −16 LUFS, ID3 + chapters, C2PA signing, upload to R2, feed item).

Rules (see `docs/technical-design.md#publishing`):
- Write the Post row (publication, channel, part) before calling a channel; store the message id after. A retry with a stored id skips; an unknown result is held for a person, never re-sent. After a database restore, every slot already past due is held.
- A channel test (`channel-check` job, D101) asks the channel without sending and stores the answer on the channel row.
- Template context comes from `@anr/render` (`templateContext`, `editedByPerson`), shared with the desk's preview.
- Templates come from `config/formats/<format>/templates/<channel>.liquid`; the disclosure partial is mandatory.
- An upheld challenge's corrections are published by the `publish-correction` job (`src/corrections.ts`, D115): notice live, piece Corrected; nothing is re-sent.
- Images (`src/media.ts`, D120): before anything is sent, a piece whose image lacks a licence or credit is held; each licensed image is written once (exiftool XMP, then c2patool with the source as parent) to `m/<id>.<ext>` in the media store. Tests use `unchangedForTests` where the tools are missing.
- Commands: `pnpm --filter @anr/publisher test`.
