# Dashboards

Local dashboards for the BWE projects.

- `project-dashboard/` — status, outstanding issues and items to commit for each BWE project, with a per-project Checkpoint button. Selecting a project opens it full screen with its recent Claude Code sessions and GitHub messages (issues, PRs, comments, commits, Actions runs); anything waiting on you shows under USER INPUT NEEDED with a box to answer Claude or comment on GitHub. Each card has a Git dropdown (Commit, Push, Commit & push, Pull, Fix diverged). Projects are listed in `projects.mjs`. Run `refresh.cmd` (http://127.0.0.1:8788); `update.cmd` downloads the latest version from GitHub and restarts it.
- `dashboard/` — latest search-monitor results for each site. Run `refresh.cmd` (http://127.0.0.1:8787).

Both need Node and a signed-in `gh` CLI. `project-dashboard/jobs.json` holds checkpoint session state and is not committed.

## BWE Dashboard (project-dashboard/)

One page with three tabs: **Websites** (BWE, HDBS, One Click Answers, JK Classic Buggies, For The Table), **Utilities**
(SEO, FAQ and Blog Engines, Claude Skills, this dashboard) and **Google** (the Search Monitor reports from each site's
`search-monitor-data` branch). It replaces the separate search-monitor dashboard in `dashboard/`. Run `update.cmd` in
`project-dashboard` to install it. Tab membership is the `group` of each project in `project-dashboard/projects.mjs`.
