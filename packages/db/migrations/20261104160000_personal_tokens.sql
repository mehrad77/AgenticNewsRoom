-- migrate:up

-- Personal tokens (D191): a person gives one to an agent of their own, which then acts as them
-- through the API and the MCP server (D189). Only the token's SHA-256 hash is kept; the token is
-- shown once. Issued and revoked from a desk session signed in through Access, never with a token.
create table personal_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  name text not null check (length(name) between 1 and 80),
  token_hash bytea not null unique check (length(token_hash) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index personal_tokens_user on personal_tokens (user_id, created_at desc);
grant select, insert, update on personal_tokens to anr_app, anr_system;

-- Which token an act came through; the actor is still the person (D189).
alter table audit_log add column via_token_id uuid references personal_tokens (id),
  add constraint audit_log_via_token_person check (via_token_id is null or actor_kind = 'person');
alter table platform_audit_log add column via_token_id uuid references personal_tokens (id);

-- migrate:down
alter table platform_audit_log drop column via_token_id;
alter table audit_log drop column via_token_id;
drop table personal_tokens;
