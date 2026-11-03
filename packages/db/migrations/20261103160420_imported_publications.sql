-- migrate:up

-- The old archive's news and posted classics are pieces (D172): publications the legacy import
-- writes as published, with `origin = imported`. They are never sent to a channel and stay out of
-- the slot gauges. Only the system role, which the import runs as, can write that origin (AGENTS.md
-- invariant 3); every other role's rows are the pipeline's.
alter table publications add column origin text not null default 'pipeline';
alter table publications add constraint publications_origin_check
  check (origin in ('pipeline', 'imported'));

create function anr.publications_origin_guard() returns trigger
language plpgsql as $$
begin
  if new.origin = 'imported' and current_user <> 'anr_system'
     and (tg_op = 'INSERT' or old.origin is distinct from new.origin) then
    raise exception 'only the legacy import writes imported publications';
  end if;
  if tg_op = 'UPDATE' and old.origin = 'imported' and new.origin <> 'imported' then
    raise exception 'an imported publication stays imported';
  end if;
  return new;
end $$;

create trigger publications_origin_guard
  before insert or update of origin on publications
  for each row execute function anr.publications_origin_guard();

-- migrate:down
drop trigger publications_origin_guard on publications;
drop function anr.publications_origin_guard();
alter table publications drop column origin;
