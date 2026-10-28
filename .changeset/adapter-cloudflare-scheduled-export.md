---
"@atmo-dev/contrail": patch
---

Fix `contrail append-scheduled` for adapter-cloudflare 8 / SvelteKit 3 Worker output. The command now accesses the Worker's public default export through a live ESM self-import instead of assuming a generated variable named `worker_default`. Older bundled default exports remain supported, and no extra files are added to the public assets directory.

Preserve authenticated cron forwarding and existing Worker handlers. Safely quote custom cron paths and secret environment-variable names in the generated JavaScript.
