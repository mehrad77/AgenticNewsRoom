-- migrate:up
-- Traces that outlive one job (D137): a publication's trace starts at its assignment, and work for
-- it later continues that trace; a lead keeps the ingest span that stored it, for span links. W3C
-- traceparent (`00-<trace id>-<span id>-<flags>`), null where no SDK ran. Nullable: the previous
-- release never writes them (D134).
alter table publications add column traceparent text
  check (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
alter table leads add column traceparent text
  check (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');

-- migrate:down
alter table leads drop column traceparent;
alter table publications drop column traceparent;
