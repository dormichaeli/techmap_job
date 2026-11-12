# Security policy

Do not report credentials, checkpoint contents, source evidence, or operational database excerpts in a public issue.

The public repository must never contain:

- `.env` files or credentials;
- SQLite databases, WAL/SHM files, backups, or checkpoints;
- raw company, source, job, or observation data;
- private source identifiers or activation evidence;
- workflow logs containing collector output.

The authoritative database belongs only in the private checkpoint repository. Public export publication is disabled. If a secret is suspected to have entered Git history, stop deployment, revoke the credential first, and then follow an approved history-remediation procedure.
