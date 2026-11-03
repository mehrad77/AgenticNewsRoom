# Newsletter issue: writing guide

- Write 5–8 news items from the assignment's leads, most important first.
- Each item: a plain headline and two to four sentences. Say what happened, who said it, and why it matters.
- Add at most two outside articles worth reading, only when one is unusually interesting or fits the cycle's theme. Give a one-line reason for each.
- Every factual sentence rests on claims you list; quote the stored passage that supports each claim.
- No hype words, no speculation presented as fact.
- For each news item, set the timeline's facts (D173):
  - `org`: the lab, company or institute the news is about, named as its own source names it (for example "Anthropic", "Mistral AI").
  - `news_kind`: one of `model`, `product`, `tool`, `research-blog`, `open-source`, `funding`, `org`, `other`.
  - `related`: up to eight products, models, people or organisations the item names, each written exactly as in the item.
  - Name `org` and every `related` name in the item's own text, so the gate checks them with it.
- Never set `url`, `url_type`, `links`, `anchor` or `approximate`; code sets them.
