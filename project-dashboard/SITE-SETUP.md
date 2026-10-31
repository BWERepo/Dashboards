# BWE Dashboard website (read-only)

A read-only copy of the dashboard, rebuilt every 30 minutes by the **Publish dashboard site** GitHub Action and hosted on
Cloudflare Pages behind a Cloudflare Access login. It shows GitHub data only: PRs, issues, deployments, Actions, the Google tab.
Git commit/push/pull, Claude sessions, Checkpoint, Deploy and Close buttons stay on the PC dashboard.

Never commit the built page: it contains private project information. The Action uploads it straight to Cloudflare, and
the build prints nothing (this repo is public, so its Action logs are public).

## One-time setup (you do these; Claude can't)
1. **GitHub token**: create a fine-grained personal access token (owner BWERepo, all repositories) with read-only access to
   Actions, Contents, Issues, Metadata and Pull requests. Save it as the repo secret `DASHBOARD_GH_TOKEN`
   (Dashboards repo > Settings > Secrets and variables > Actions).
2. **Cloudflare Pages project**: in Cloudflare create a Pages project named `bwe-dashboard` (direct upload, no Git).
3. **Cloudflare token**: create an API token with "Cloudflare Pages: Edit". Save it as `CLOUDFLARE_API_TOKEN`, and your account id as
   `CLOUDFLARE_ACCOUNT_ID`.
4. **Login (do this before the first run)**: Cloudflare Zero Trust > Access > Applications > add a self-hosted application for the
   Pages domain (`bwe-dashboard.pages.dev` and `*.bwe-dashboard.pages.dev`), with a policy that allows only your email.
5. Run the **Publish dashboard site** Action once ("Run workflow"), then open the site and sign in.

If the Access login is not in place, do not run the Action: the page would be public.
