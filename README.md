# Dashboards

Local dashboards for the BWE projects.

- `project-dashboard/` — status, outstanding issues and items to commit for each BWE project, with a per-project Checkpoint button. Run `refresh.cmd` (http://127.0.0.1:8788).
- `dashboard/` — latest search-monitor results for each site. Run `refresh.cmd` (http://127.0.0.1:8787).

Both need Node and a signed-in `gh` CLI. `project-dashboard/jobs.json` holds checkpoint session state and is not committed.
