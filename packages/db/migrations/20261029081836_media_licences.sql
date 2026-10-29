-- migrate:up

-- A media item (D119): an image a member added by URL, fetched by ingestion with its IPTC Photo
-- Metadata read from XMP. Its licence is a free Wikimedia Commons licence recorded by code, or
-- an artist's or label's press kit recorded by a person; a licence always comes with a credit.
alter table media
  add column source_url text not null,
  add column file_url text not null,
  add column content_type text not null,
  add column description text,
  add column added_by uuid not null references users (id),
  add column licence_kind text,
  add column licence_url text,
  add column licence_recorded_by uuid references users (id),
  add column licence_recorded_at timestamptz,
  -- The publisher's copy, with the Photo Metadata written in and signed (D120).
  add column published_file text,
  add constraint media_content_type_check
    check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  add constraint media_licence_kind_check check (licence_kind in ('press-kit', 'commons')),
  add constraint media_licence_check check (
    (licence is null) = (licence_kind is null)
    and (licence is null) = (licence_recorded_at is null)
    and (licence is null or nullif(trim(credit_line), '') is not null)
    and (licence_kind is distinct from 'press-kit' or licence_recorded_by is not null)
    and (licence_kind is distinct from 'commons' or licence_url is not null)),
  add constraint media_file_key unique (newsroom_id, file);
create index media_lead_idx on media (newsroom_id, lead_id);

-- A recorded licence, and the metadata it was recorded with, never change: a published copy
-- carries them. A different licence is a new media item.
create function anr.forbid_licensed_media_change() returns trigger
language plpgsql
as $$
begin
  if old.licence is not null and (
    new.licence, new.licence_kind, new.licence_url, new.licence_recorded_by,
    new.licence_recorded_at, new.creator, new.credit_line, new.copyright_notice,
    new.web_statement, new.licensor, new.digital_source_type, new.description, new.file,
    new.content_type, new.source_url, new.file_url
  ) is distinct from (
    old.licence, old.licence_kind, old.licence_url, old.licence_recorded_by,
    old.licence_recorded_at, old.creator, old.credit_line, old.copyright_notice,
    old.web_statement, old.licensor, old.digital_source_type, old.description, old.file,
    old.content_type, old.source_url, old.file_url
  ) then
    raise exception 'a media item''s licence is recorded (media %)', old.id;
  end if;
  return new;
end;
$$;
create trigger media_licence_frozen before update on media
  for each row execute function anr.forbid_licensed_media_change();

alter table notices drop constraint notices_kind_check;
alter table notices add constraint notices_kind_check
  check (kind in ('budget-warning', 'budget-cap', 'no-leads', 'no-channel', 'no-theme',
                  'pick-missed', 'plan-failed', 'challenge-due', 'challenge-overdue',
                  'media-failed'));

-- migrate:down
alter table notices drop constraint notices_kind_check;
alter table notices add constraint notices_kind_check
  check (kind in ('budget-warning', 'budget-cap', 'no-leads', 'no-channel', 'no-theme',
                  'pick-missed', 'plan-failed', 'challenge-due', 'challenge-overdue'));
drop trigger media_licence_frozen on media;
drop function anr.forbid_licensed_media_change();
drop index media_lead_idx;
alter table media
  drop constraint media_file_key,
  drop constraint media_licence_check,
  drop constraint media_licence_kind_check,
  drop constraint media_content_type_check,
  drop column published_file,
  drop column licence_recorded_at,
  drop column licence_recorded_by,
  drop column licence_url,
  drop column licence_kind,
  drop column added_by,
  drop column description,
  drop column content_type,
  drop column file_url,
  drop column source_url;
