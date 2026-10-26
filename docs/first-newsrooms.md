# First newsrooms

Oct 26, 2026 · Mehrad Rousta

ANR starts with two newsrooms: the AI newsroom, rebuilt fresh in Persian with an English edition, and Kültür, a Turkish culture newsroom covering Türkiye's music and visual artists. The second one is the v1 test, so it must run on configuration alone, and it adds what the first doesn't need: a second topic, a third language, and podcasts in three languages from one story. All times are Europe/Istanbul.

## At a glance

|                                       | AI newsroom                                                                                                                                       | Kültür                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Slug                                  | `ai`                                                                                                                                              | `kultur`                                                                                                                  |
| Name                                  | اتاق خبر هوش مصنوعی (fa), AI Newsroom (en)                                                                                                        | Kültür (tr, en), کولتور (fa)                                                                                              |
| Language                              | Persian (right-to-left) first, with an English rendition of every piece                                                                           | Turkish; site and podcast also in English and Persian                                                                     |
| Beats                                 | Labs and products, research, policy, open source                                                                                                  | Music: rock, indie, pop, electronic, punk and other opinionated genres; visual and audio art                              |
| Daily                                 | Newsletter: the day's news, plus up to two articles                                                                                               | None                                                                                                                      |
| Weekly                                | Podcast, about 30 minutes: the week's news (15 min) and a story about the classic paper of the week (15 min); the classic paper as a site article | Artist story: one influential or rising Turkish artist; a 20-minute podcast in Turkish, English and Persian on that story |
| Each editorial cycle (one month)      | Editorial theme from the planner, approved by the Editor-in-Chief                                                                                 | Same                                                                                                                      |
| Channels                              | Site and a podcast feed in Persian and English; Telegram in Persian only                                                                          | Site in three languages and three podcast feeds; no Telegram                                                              |
| Editor-in-Chief and corrections owner | Mehrad Rousta                                                                                                                                     | Mehrad Rousta                                                                                                             |

## A week in both newsrooms

| Series                           | Mon        | Tue          | Wed                | Thu                    | Fri                                       | Sat | Sun |
| -------------------------------- | ---------- | ------------ | ------------------ | ---------------------- | ----------------------------------------- | --- | --- |
| **AI** · Newsletter, daily 21:00 | ●          | ●            | ●                  | ●                      | ●                                         | ●   | ●   |
| **AI** · Classic paper           | 3 proposed | editor picks | publishes (fa, en) |                        |                                           |     |     |
| **AI** · Podcast, news + story   |            |              |                    |                        | **fa + en** ← newsletters + classic paper |     |     |
| **Kültür** · Artist story        | 3 proposed | editor picks |                    | publishes (tr, en, fa) |                                           |     |     |
| **Kültür** · Podcast, the story  |            |              |                    |                        | **tr, en, fa** ← artist story             |     |     |

Both newsrooms pick on Monday and Tuesday, publish the pick midweek, and retell it on Friday. The AI podcast also recaps the week's newsletters.

## AI newsroom

The AI newsroom publishes one newsletter a day and one podcast a week. The weekly classic paper feeds both a site article and the podcast's story half. Every piece has a Persian and an English rendition written from the same story, so research happens once; both go through the verifier.

**Daily newsletter.** It publishes at 21:00 to Telegram and the site.

1. At 16:00, code creates the day's assignment from the last 24 hours of leads, ranked by tier.
2. The desk writes 5–8 news items. It may add up to two articles, each one an outside piece worth reading (not ANR's own article), and only if it is unusually interesting or fits the cycle's theme. The desk gives a one-line reason for each; code enforces the limit of two.
3. The verifier runs. With no hold, the issue auto-publishes as daily news.

**Weekly classic paper.**

1. On Monday, the planner proposes three classic papers that fit the cycle's theme. The Editor-in-Chief picks one by Tuesday.
2. The desk researches the paper once into a story, then writes the site article.
3. The article waits for an editor's approval and publishes on Wednesday at 10:00.

**Weekly podcast.** One episode of about 30 minutes publishes on Friday at 18:00, in each language: the two current Persian hosts, Niloofar and Farzad, and two English hosts, Maya and Leo, with their own voices.

- **News half, about 15 minutes:** a renderer turns the week's published newsletter stories into a script. No new research.
- **Story half, about 15 minutes:** the classic paper's story, told as a narrative arc that follows its authors, with a narrator, delivery directions and sound cues. It reuses Wednesday's story.

The episode is themed, so an editor approves its script before audio is made.

## AI newsroom config

These files live in [`config/newsrooms/ai/`](../config/newsrooms/ai/). Its channels are set up in the editor's desk, not here. The site is served at `ai.$ANR_ROOT_DOMAIN`.

```yaml
# newsroom.yaml
slug: ai
name: { fa: اتاق خبر هوش مصنوعی, en: AI Newsroom }
languages: [fa, en] # fa is primary and right-to-left; en is left-to-right
timezone: Europe/Istanbul
subdomain: ai # ai.$ANR_ROOT_DOMAIN; English at /en
editor_in_chief: Mehrad Rousta
corrections_owner: Mehrad Rousta
planning: { cycle: 1mo, from: 2026-11-01 } # editorial cycles of one calendar month
```

```yaml
# policy.yaml
# Each beat: its status, and the IPTC Media Topics that classify it
# (codes in packages/schemas/iptc/mediatopic.json; publications carry their beat's topics).
beats:
  labs: { status: open, media_topics: [medtop:20001298] } # artificial intelligence
  research: { status: open, media_topics: [medtop:20001298, medtop:20000735] } # + scientific research
  open-source: { status: open, media_topics: [medtop:20001298, medtop:20000231] } # + software and applications
  # regulation and law always go to an editor
  policy: { status: restricted, media_topics: [medtop:20001298, medtop:20000636] } # + regulation of industry
sources:
  min_independent: 2
  tier1_alone: true # a lab's own post, a paper or a filing can stand alone
papers:
  tiers: [flagged, high, medium, low] # flagged is dropped; high, medium, low map to tiers 1, 2, 3
  newsletter_min: high
auto_publish: [newsletter-issue]
```

```yaml
# sources.yaml (excerpt)
- {
    id: arxiv,
    kind: api,
    url: "https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG&sortBy=submittedDate",
    publisher: arXiv,
    tier: 2,
    every: 2h,
  }
- {
    id: openai-news,
    kind: rss,
    url: "https://openai.com/news/rss.xml",
    publisher: OpenAI,
    tier: 1,
    every: 1h,
  }
- {
    id: hn-front,
    kind: api,
    url: "https://hacker-news.firebaseio.com/v0/topstories.json",
    publisher: Hacker News,
    tier: 3,
    every: 2h,
  }
- {
    id: semantic-scholar,
    kind: api,
    url: "https://api.semanticscholar.org/graph/v1",
    publisher: Semantic Scholar,
    tier: 2,
    every: 24h,
    use: enrichment,
  }
```

Lab blogs are tier 1, one entry per lab (a feed where the lab has one, else its listing page). arXiv is one source over all the newsroom's categories, so a paper's primary category is judged against all of them (D59). Each source is fetched only after a person has read its terms and set `terms_checked`; milestone 2 completes the list.

```yaml
# series/daily-newsletter.yaml (excerpt)
format: newsletter-issue
languages: [fa, en]
cadence: { daily: "21:00" }
assignment_at: "16:00"
items: { news: 5-8, articles: 0-2 }
channels:
  site: [fa, en]
  telegram: [fa]

# series/weekly-classic.yaml (excerpt)
format: classic-article
languages: [fa, en]
cadence: { weekly: wed 10:00 }
pick: { planner_proposes: 3, by: mon, editor_picks_by: tue }
channels:
  site: [fa, en]
  telegram: [fa]

# series/weekly-podcast.yaml (excerpt)
format: podcast-episode
languages: [fa, en]
cadence: { weekly: fri 18:00 }
segments:
  - { kind: news-recap, minutes: 15, from: week.daily-newsletter }
  - { kind: story, minutes: 15, from: week.weekly-classic }
hosts:
  fa: { niloofar: Sulafat, farzad: Algenib }
  en: { maya: Kore, leo: Puck }
narrator: # story segments only
  fa: Alnilam
  en: Enceladus
channels:
  podcast-rss: [fa, en] # one feed per language
  site: [fa, en]
  telegram: [fa]
```

## Kültür

Kültür publishes one artist story a week and a podcast about it in three languages. It covers Türkiye's music scene (rock, indie, pop, electronic, punk and other opinionated genres) and its visual and audio artists. Turkish comes first; the site carries English and Persian renditions of every story. It has no Telegram channel: the site and the three podcast feeds are its only channels.

**Weekly artist story.** It publishes on Thursday at 12:00.

1. On Monday, the planner proposes three artists, influential or rising, that fit the cycle's theme. The Editor-in-Chief picks one by Tuesday.
2. The desk researches the artist once into a story: background, key works, and what they and critics have said, all from stored sources.
3. The desk writes the Turkish, English and Persian renditions natively from the story. The verifier checks each one.
4. An editor approves the three renditions before they publish.

**Weekly podcast.** One 20-minute episode per language publishes on Friday at 18:00, each telling the week's artist story as a narrative arc that follows the artist, with its own hosts and a narrator: Deniz and Emre in Turkish, Ada and Sam in English, Shirin and Kian in Persian. Episodes describe the music and contain no recorded-music clips.

**Images.** A story may carry artist photos only with a recorded licence: the artist's or label's press kit allowing press use, or a free Wikimedia Commons licence, always credited.

**No daily output.** Ingestion still runs on each source's interval over music press, labels, venues and festival line-ups. The pool feeds the planner's artist picks and the cycle's theme.

**Voice.** The newsroom's style guide allows a critical, opinionated voice about music. Opinion is marked as opinion; facts about an artist still need sources like any other claim.

## Kültür config

These files live in [`config/newsrooms/kultur/`](../config/newsrooms/kultur/). They need no code of their own. The platform features this newsroom relies on (several languages, marked opinion, media licences) are built before it starts; see the next section. Its channels are set up in the editor's desk, not here.

```yaml
# newsroom.yaml
slug: kultur
name: { tr: Kültür, en: Kültür, fa: کولتور }
languages: [tr, en, fa] # tr is primary; fa is right-to-left
timezone: Europe/Istanbul
subdomain: kultur # kultur.$ANR_ROOT_DOMAIN; English at /en, Persian at /fa
editor_in_chief: Mehrad Rousta
corrections_owner: Mehrad Rousta
planning: { cycle: 1mo, from: 2026-11-01 } # editorial cycles of one calendar month
```

```yaml
# policy.yaml
# Each beat: its status, and the IPTC Media Topics that classify it
# (codes in packages/schemas/iptc/mediatopic.json; publications carry their beat's topics).
beats:
  # rock, indie, pop, electronic, punk, other genres
  music: { status: open, media_topics: [medtop:20000018] } # music
  visual-art: { status: open, media_topics: [medtop:20000031] } # visual arts
  audio-art: { status: open, media_topics: [medtop:20000002] } # arts and entertainment
  # artists' political statements, court cases, bans
  politics: { status: restricted, media_topics: [medtop:20000588, medtop:20001132] } # censorship and freedom of speech, cultural policy
  # relationships, health, rumours
  private-life: { status: banned, media_topics: [medtop:20000505, medtop:20001300] } # celebrity, privacy
sources:
  min_independent: 2
  tier1_alone: true # the artist's or label's own statement
auto_publish: [] # every piece is themed and waits for an editor
opinion: allowed_marked # opinion is labelled and never carries a factual claim
```

```yaml
# sources.yaml (excerpt)
- {
    id: musicbrainz,
    kind: api,
    url: "https://musicbrainz.org/ws/2/",
    publisher: MusicBrainz,
    tier: 2,
    every: 24h,
    use: enrichment,
  }
```

Milestone 6 adds the Turkish music press (tier 2, every 6 hours, one entry per outlet), label release feeds (tier 1, every 12 hours), venue calendars and festival line-ups (tier 2, daily), each after a person has checked its terms.

```yaml
# series/artist-story.yaml (excerpt)
format: artist-story
languages: [tr, en, fa]
cadence: { weekly: thu 12:00 }
pick: { planner_proposes: 3, by: mon, editor_picks_by: tue }
channels:
  site: [tr, en, fa]

# series/weekly-podcast.yaml (excerpt)
format: podcast-episode
languages: [tr, en, fa]
cadence: { weekly: fri 18:00 }
segments:
  - { kind: story, minutes: 20, from: week.artist-story }
hosts:
  tr: { deniz: Aoede, emre: Charon }
  en: { ada: Leda, sam: Orus }
  fa: { shirin: Despina, kian: Iapetus }
narrator: # story segments only
  tr: Gacrux
  en: Schedar
  fa: Achernar
channels:
  podcast-rss: [tr, en, fa] # one feed per language
  site: [tr, en, fa]
```

## What the platform needs

These are the platform features the two newsrooms need. The first two rows changed the charter's v1 scope; all of them are in the technical design and are built before Kültür starts.

| Need                                           | For    | Change                                                                                                                                                                        |
| ---------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Several languages per story                    | Both   | **Charter v1 scope:** renditions in several languages are in v1. A rendition gets a language; a newsroom gets a list of languages with one primary                            |
| Weekly picks inside the editorial cycle        | Both   | **Charter planning:** each week the planner proposes three candidates (a classic paper, an artist) and the Editor-in-Chief picks one                                          |
| Claims checked once, not per language          | Both   | Claims live on the story. Each rendition points at story claims, so the fact-checker runs once per claim, and code checks that every rendition's facts map to a checked claim |
| A podcast built from other series              | AI     | A segment can take its source from another series' output for the week, such as the newsletters                                                                               |
| Right-to-left and left-to-right on one site    | Both   | The site picks direction per language, not per newsroom                                                                                                                       |
| Text-to-speech in Persian, English and Turkish | Both   | Voices per host per language in the series config; English and Turkish voice quality is checked as part of milestone 5's gate                                                 |
| Marked opinion                                 | Kültür | Opinion becomes a kind of claim: templates label it, and the fact-checker skips it                                                                                            |
| Rights for images                              | Kültür | A media item records its licence; the publisher refuses media without one                                                                                                     |
