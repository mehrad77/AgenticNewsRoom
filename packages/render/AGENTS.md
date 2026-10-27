# @anr/render

Renders a format's channel templates (`config/formats/<format>/templates/<channel>.liquid`) with LiquidJS. The publisher renders what it sends with it, and the verifier gate renders every rendition with it to check the AI-disclosure label (D79), so the check sees exactly what would be sent.

- Every template renders `config/formats/_partials/disclosure.liquid`; agent-written text is HTML-escaped.
- No I/O beyond reading templates.
- Commands: `pnpm --filter @anr/render test`, `pnpm --filter @anr/render typecheck`.
