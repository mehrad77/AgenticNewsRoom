-- migrate:up

-- One media item per image and lead (D119): agents see an image through its lead, so the same
-- file added for a second lead is a second item, licensed on its own, not the first lead's row.
alter table media drop constraint media_file_key;
drop index media_lead_idx;
alter table media
  add constraint media_lead_file_key unique nulls not distinct (newsroom_id, lead_id, file);

-- migrate:down
alter table media drop constraint media_lead_file_key;
create index media_lead_idx on media (newsroom_id, lead_id);
alter table media add constraint media_file_key unique (newsroom_id, file);
