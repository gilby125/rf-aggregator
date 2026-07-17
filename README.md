# rf-aggregator

Open-source platform that **consumes decoded RF event feeds**, aggregates/groups them, retains and
gateways the results, and serves them to multiple users through a Cloudflare edge front (sign-up, auth,
per-user config). The operator self-hosts the private backend on any container host; Cloudflare fronts
everything user-facing.

Hardware-agnostic and format-flexible — it starts at the **decoded feed** (bring your own decoder:
rtl_433, rtlamr, dump1090, …) and does not manage SDRs, dongles, drivers, or frequencies.

See [docs/PLAN.md](docs/PLAN.md) for the architecture, data flow, and build plan.

## Status
Planning. No implementation yet.
