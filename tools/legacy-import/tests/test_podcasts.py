from anr_legacy_import.podcasts import episodes, url_map

ROW = {
    "slug": "2026-10-23-classic",
    "kind": "classic",
    "status": "published",
    "published_at": "2026-10-23T10:47:54+03:00",
    "title_fa": "داستان",
    "summary_fa": "خلاصه",
    "transcript_md": "# متن",
    "audio_url": "https://media.example/episodes/x.mp3",
    "duration_sec": "665",
    "chapters": "[{'start_sec': 17.1, 'title_fa': 'دوم'}, {'start_sec': 0, 'title_fa': 'اول'}]",
}


def test_published_episodes_with_their_chapters_and_new_paths() -> None:
    found = episodes([ROW, {**ROW, "slug": "draft", "status": "draft"}])
    assert len(found) == 1
    e = found[0]
    assert e.path == "/weekly-podcast/2026-10-23-classic"
    # Chapters in order, each ending where the next starts, the last at the episode's end.
    assert e.chapters == [
        {"title": "اول", "start": 0.0, "end": 17.1},
        {"title": "دوم", "start": 17.1, "end": 665.0},
    ]
    assert e.body()["summary"] == "خلاصه"
    assert url_map(found) == {
        "/podcast/": "/podcast/weekly-podcast.xml",
        "/podcast/feed.xml": "/podcast/weekly-podcast.xml",
        "/podcast/2026-10-23-classic/": "/weekly-podcast/2026-10-23-classic",
    }
