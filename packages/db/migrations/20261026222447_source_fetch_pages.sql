-- migrate:up
-- False: a feed item's own text (title and summary) is the lead and its page is never fetched,
-- for a source whose terms allow its feed but not robots on its pages (D70).
alter table sources add column fetch_pages boolean not null default true;

-- migrate:down
alter table sources drop column fetch_pages;
