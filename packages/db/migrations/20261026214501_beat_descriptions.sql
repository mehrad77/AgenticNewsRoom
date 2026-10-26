-- migrate:up
-- What a beat covers, in a line from policy.yaml; the summariser reads it to place leads.
alter table beats add column description text;

-- migrate:down
alter table beats drop column description;
