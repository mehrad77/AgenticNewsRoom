-- migrate:up
-- One summariser run per lead (D63): two workers enqueueing the same new lead write one run.
create unique index agent_runs_summariser_lead_key on agent_runs (newsroom_id, lead_id)
  where role = 'summariser';

-- migrate:down
drop index agent_runs_summariser_lead_key;
