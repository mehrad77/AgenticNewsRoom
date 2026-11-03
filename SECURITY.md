# Security policy

## Supported versions

Only the latest release on `main` is supported. Fixes are not backported.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through [GitHub's private vulnerability reporting](https://github.com/mehrad77/AgenticNewsRoom/security/advisories/new), with the steps to reproduce it and what an attacker could do.

You will get an acknowledgement within 72 hours and an assessment within a week. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Scope

Of particular interest:

- crossing a tenant boundary (one newsroom reading or changing another's data);
- an agent publishing, sending or writing anywhere other than through `submit`;
- a publication passing the gate without its checks, or without its AI disclosure;
- reading channel credentials or other secrets;
- the reader challenge form, the only public write.
