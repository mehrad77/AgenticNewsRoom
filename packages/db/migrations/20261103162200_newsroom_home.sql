-- migrate:up

-- What a newsroom's reader home lists (newsroom.yaml `home`): "pieces", its newest publications,
-- or {"news": "<series>"}, the newest news items of that series' timeline. Synced from config.
alter table newsrooms add column home jsonb not null default '"pieces"';

-- migrate:down
alter table newsrooms drop column home;
