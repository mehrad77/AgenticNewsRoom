-- migrate:up
-- Whether a publication went out after its slot's grace, decided by the publisher when it sends
-- (D158), so a later change to a format's grace never moves a past slot between on time and late.
-- Null before this release and while unsent; the gauges then compare against the grace.
alter table publications add column published_late boolean;

-- migrate:down
alter table publications drop column published_late;
