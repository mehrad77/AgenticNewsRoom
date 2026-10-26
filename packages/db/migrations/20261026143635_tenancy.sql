-- migrate:up
-- Platform functions live in schema anr; tables live in public.
create schema anr;
grant usage on schema anr to anr_app, anr_system;

-- The newsroom of the current transaction, set by withNewsroom() with set_config(..., true).
-- Fails closed: an unset setting reads as null on a fresh connection and as '' on a connection
-- where an earlier transaction set it, and both raise instead of matching no rows.
-- Every tenant policy compares newsroom_id with (select anr.current_newsroom_id()).
create function anr.current_newsroom_id() returns uuid
language plpgsql stable parallel safe
as $$
declare
  value text := current_setting('anr.newsroom_id', true);
begin
  if value is null or value = '' then
    raise exception 'anr.newsroom_id is not set'
      using hint = 'Reach tenant data through withNewsroom() in @anr/db.';
  end if;
  return value::uuid;
end;
$$;

-- Trigger function for append-only tables (the audit log): no update, delete or truncate.
create function anr.forbid_change() returns trigger
language plpgsql
as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

-- migrate:down
drop schema anr cascade;
