# Techmap Job

An independent, company-first collector for public Israeli technology vacancies. It preserves job identity and observation history in SQLite, treats source failures differently from confirmed empty boards, and supports verified ATS adapters without modifying the upstream Techmap project.

This repository is the application boundary only. Operational databases, checkpoints, source evidence, generated reports, credentials, and exports are intentionally excluded from version control.

## Runtime

- Node.js `26.13.1` exactly (`.nvmrc`)
- Embedded SQLite `3.53.2` or newer; the pinned Node runtime currently embeds SQLite `3.54.1`
- No third-party runtime dependencies

Verify the runtime and run the complete suite:

```sh
npm run runtime:verify
npm test
```

## Safety model

- The public code repository never contains the operational SQLite database.
- Authoritative checkpoints belong only in the separate private checkpoint repository.
- Imported ATS candidates remain disabled until verified and explicitly activated.
- A failed source observation cannot close jobs.
- Job closure requires two successful observations that omit the same source-scoped job.
- Checkpoints are immutable, checksummed, independently restored, and promoted with compare-and-swap protection.
- Public export upload remains disabled pending a separate licensing and data-policy approval.

## Manual cloud workflow

`.github/workflows/daily-collection.yml` is manual-only. It runs on `main`, pins reviewed action commits and Node `26.13.1`, executes all tests, restores a trusted private checkpoint, and collects the deterministic `first_cloud_v1` cohort.

That cohort is derived inside the restored private database; no company/source CSV is stored in this public repository. It is limited to five enabled `live_verified` or `manual_verified` structured ATS sources across supported one-request providers, concurrency two, and at most 15 HTTP attempts including retries.

The workflow requires the `checkpoint-production` environment and its `CHECKPOINT_REPOSITORY_TOKEN` secret. Repository creation, credential setup, bootstrap, and the first two manual runs require separate operator approval. No schedule is active.

## Local commands

```sh
npm run phase7a:rehearse
npm run checkpoint:create -- --source /private/path/jobs.sqlite --repository /private/path/checkpoints --id approved-bootstrap-id
npm run checkpoint:validate -- --checkpoint /private/path/checkpoints/approved-bootstrap-id
```

Do not pass credentials on the command line. Use the documented environment variable only for an explicitly approved bootstrap or manual remote run.

## Licensing status

The original software in this repository is licensed under the [MIT License](LICENSE). That software license does not cover imported company data, third-party ATS data, job descriptions, generated databases, checkpoints, or exports. Techmap-derived database content is governed by the upstream ODbL notice and attribution requirements, and third-party ATS vacancy content has separate redistribution considerations. See [DATA-LICENSE.md](DATA-LICENSE.md).

No public job export is approved yet.

Upstream data source: [mluggy/techmap](https://github.com/mluggy/techmap) by Michael Lugassy.
