// Collects the dashboard data (and saves a copy of the page in the temp folder): status, outstanding issues, items to commit, recent GitHub activity
// and recent Claude Code sessions for each project in projects.mjs. Read-only (git + gh + local transcripts).
// Projects are collected in parallel (a few at a time, in list order). Each finished project is printed as one
// "@@project <json>" line, so serve.mjs can hand it to the page straight away, before the whole build is done.
// Usage: node project-dashboard/build.mjs [--open]
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OWNER, PROJECTS, claudeSessions, collectSearch, winDir } from "./projects.mjs";

const run = (cmd, args, cwd) => new Promise((resolve, reject) => execFile(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true },
  (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out))));
const attempt = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };
const git = (dir, ...args) => run("git", ["-C", dir, ...args]);
const gh = (...args) => run("gh", args);

async function gitState(dir) {
  await attempt(() => git(dir, "fetch", "--quiet", "--no-tags", "origin")); // refresh remote refs so ahead/behind is current
  const [branchOut, statusOut, upstream, lastOut, stashOut] = await Promise.all([
    git(dir, "branch", "--show-current"), git(dir, "status", "--porcelain=v1", "-uall"),
    attempt(async () => (await git(dir, "rev-parse", "--abbrev-ref", "@{u}")).trim()),
    git(dir, "log", "-1", "--format=%h\t%cI\t%s"), git(dir, "stash", "list"),
  ]);
  const branch = branchOut.trim();
  const files = statusOut.split("\n").filter(Boolean).map((l) => {
    const code = l.slice(0, 2);
    const path = l.slice(3).replace(/^"|"$/g, "");
    const kind = code === "??" ? "untracked" : /[MADRC]/.test(code[0]) && code[1] === " " ? "staged" : /U|AA|DD/.test(code) ? "conflict" : "modified";
    return { code: code.trim() || code, kind, path };
  });
  let ahead = null, behind = null;
  if (upstream) {
    const [b, a] = (await git(dir, "rev-list", "--left-right", "--count", "@{u}...HEAD")).trim().split(/\s+/).map(Number);
    ahead = a; behind = b;
  }
  const unpushed = upstream && ahead ? (await git(dir, "log", "--format=%h %s", "@{u}..HEAD")).split("\n").filter(Boolean) : [];
  const [hash, date, subject] = lastOut.trim().split("\t");
  const stashes = stashOut.split("\n").filter(Boolean).length;
  return { branch, upstream, ahead, behind, files, unpushed, stashes, last: { hash, date, subject } };
}

// Pulls the newest session's headline and its "still open / next" bullets out of PROJECT_STATUS.md.
function statusDoc(dir) {
  const file = join(dir, "PROJECT_STATUS.md");
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const h2 = lines.map((l, i) => (/^## /.test(l) ? i : -1)).filter((i) => i >= 0);
  const pick = h2.find((i) => /^## (Current state|Session|Release|Earlier)/i.test(lines[i]) && !/resolved/i.test(lines[i])) ?? h2[0];
  if (pick === undefined) return { headline: "", open: [] };
  const end = h2.find((i) => i > pick) ?? lines.length;
  const body = lines.slice(pick + 1, end);
  const headline = lines[pick].replace(/^##\s*/, "").replace(/`/g, "");
  const open = [];
  let on = false;
  for (const l of body) {
    if (/^#{3,4} /.test(l)) on = /open|still|next|follow-?up|owed|todo|pending/i.test(l);
    else if (on && /^\s*(?:[-*]|\d+\.)\s+/.test(l)) open.push(l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/\*\*|`/g, "").trim());
  }
  return { headline, open: open.filter(Boolean).slice(0, 12), totalOpen: open.length };
}

async function remote({ repo }) {
  if (!repo) return { url: null, issues: [], prs: [], activity: [] };
  const r = `${OWNER}/${repo}`;
  const json = (...args) => attempt(async () => JSON.parse(await gh(...args)), []);
  const [issues, prs, act, runs] = await Promise.all([
    json("issue", "list", "-R", r, "--state", "open", "-L", "50", "--json", "number,title,url,updatedAt,body,labels"),
    json("pr", "list", "-R", r, "--state", "open", "-L", "30", "--json", "number,title,url,isDraft,updatedAt"),
    activity(r, json),
    deployRuns(r, json),
  ]);
  return {
    url: `https://github.com/${r}`,
    issues: issues.map((i) => ({ number: i.number, title: i.title, url: i.url, updatedAt: i.updatedAt, labels: i.labels.map((l) => l.name), body: (i.body || "").slice(0, 4000) })),
    prs,
    activity: act,
    deploys: runs.runs,
    deployWorkflows: runs.names, // every deploy workflow, including ones that have never run
  };
}

// The newest run of each deploy workflow ("Deploy to Staging", "Deploy to Production", "Deploy End-to-End"...), so the
// dashboard can say what is deployed where. Each workflow is asked for its own newest run: a repo's recent run list is
// mostly daily tests and monitors, which would push an older production deploy out of view.
// state is the run's conclusion, or its status while it is still running.
async function deployRuns(r, json) {
  const workflows = await json("workflow", "list", "-R", r, "--json", "id,name,state");
  const deployWfs = workflows.filter((w) => /deploy/i.test(w.name) && w.state === "active");
  const out = await Promise.all(deployWfs.map(async (w) => {
    const [run] = await json("run", "list", "-R", r, "-w", String(w.id), "-L", "1", "--json", "displayTitle,workflowName,status,conclusion,createdAt,url,headBranch");
    return run && { workflow: w.name, stage: /production/i.test(w.name) ? "production" : /staging/i.test(w.name) ? "staging" : "other",
      state: run.conclusion || run.status, at: run.createdAt, url: run.url, title: run.displayTitle, branch: run.headBranch };
  }));
  return { runs: out.filter(Boolean), names: deployWfs.map((w) => w.name) };
}

// One timeline of GitHub messages: issues and PRs (opened or updated), their comments, commits and Actions runs.
async function activity(r, json) {
  const short = (s, n = 3000) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n) + " …" : s; };
  const items = [];
  const [allIssues, allPrs, comments, reviewComments, commits, runs] = await Promise.all([
    json("issue", "list", "-R", r, "--state", "all", "-L", "15", "--json", "number,title,url,state,author,createdAt,updatedAt,body"),
    json("pr", "list", "-R", r, "--state", "all", "-L", "15", "--json", "number,title,url,state,isDraft,author,createdAt,updatedAt,mergedAt,body"),
    json("api", `repos/${r}/issues/comments?sort=updated&direction=desc&per_page=25`),
    json("api", `repos/${r}/pulls/comments?sort=updated&direction=desc&per_page=15`),
    json("api", `repos/${r}/commits?per_page=15`),
    json("run", "list", "-R", r, "-L", "15", "--json", "displayTitle,workflowName,status,conclusion,createdAt,url,event,headBranch"),
  ]);
  for (const i of allIssues)
    items.push({ type: "issue", number: i.number, title: i.title, url: i.url, state: i.state.toLowerCase(), author: i.author?.login, at: i.updatedAt, created: i.createdAt, body: short(i.body) });
  for (const p of allPrs)
    items.push({ type: "pr", number: p.number, title: p.title, url: p.url, state: p.isDraft && p.state === "OPEN" ? "draft" : p.state.toLowerCase(), author: p.author?.login, at: p.updatedAt, created: p.createdAt, merged: p.mergedAt || null, body: short(p.body) });
  const num = (u) => Number(String(u || "").match(/\/(\d+)$/)?.[1]) || null;
  for (const c of comments)
    items.push({ type: "comment", number: num(c.issue_url), title: `Comment on #${num(c.issue_url)}`, url: c.html_url, author: c.user?.login, at: c.updated_at, body: short(c.body) });
  for (const c of reviewComments)
    items.push({ type: "comment", number: num(c.pull_request_url), title: `Review comment on #${num(c.pull_request_url)}${c.path ? " · " + c.path : ""}`, url: c.html_url, author: c.user?.login, at: c.updated_at, body: short(c.body) });
  for (const c of commits)
    items.push({ type: "commit", title: c.commit.message.split("\n")[0], url: c.html_url, sha: c.sha.slice(0, 7), author: c.author?.login || c.commit.author?.name, at: c.commit.author?.date, body: short(c.commit.message.split("\n").slice(1).join("\n")) });
  for (const w of runs)
    items.push({ type: "run", title: `${w.workflowName}: ${w.displayTitle}`, url: w.url, state: w.conclusion || w.status, author: `${w.event} · ${w.headBranch}`, at: w.createdAt });
  return items.filter((i) => i.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 80);
}

// The pull request (newest, any state) whose head is the local branch, so a row can say where its work is going.
async function branchPr(repo, branch) {
  if (!branch) return null;
  const [pr] = await attempt(async () => JSON.parse(await gh("pr", "list", "-R", `${OWNER}/${repo}`, "--head", branch, "--state", "all", "-L", "1", "--json", "number,title,url,state,isDraft")), []);
  return pr ? { number: pr.number, title: pr.title, url: pr.url, state: pr.isDraft && pr.state === "OPEN" ? "draft" : pr.state.toLowerCase() } : null;
}

async function collect(p) {
  const out = { key: p.key, group: p.group, name: p.name, dir: winDir(p.dir), cmd: p.cmd || null };
  const [g, rem] = await Promise.all([gitState(p.dir).catch((e) => { out.error = String(e.message).slice(0, 300); return null; }), remote(p)]);
  if (g) out.git = g;
  out.doc = await attempt(() => statusDoc(p.dir));
  out.remote = rem;
  out.branchPr = out.git && p.repo ? await branchPr(p.repo, out.git.branch) : null;
  out.sessions = await attempt(() => claudeSessions(p.dir), []);
  out.updatedAt = new Date().toISOString();
  console.log("@@project " + JSON.stringify(out));
  return out;
}
// A few projects at a time, started in list order, so the first cards fill in first.
const results = new Array(PROJECTS.length);
let next = 0;
// The Google tab's search monitor data is collected alongside, and handed over as one "@@search" line.
const searchTask = (async () => {
  const s = await attempt(collectSearch, { updatedAt: new Date().toISOString(), sites: [], failed: true });
  console.log("@@search " + JSON.stringify(s));
  return s;
})();
await Promise.all(Array.from({ length: 4 }, async () => { while (next < PROJECTS.length) { const i = next++; results[i] = await collect(PROJECTS[i]); } }));
const search = await searchTask;
const data = { generatedAt: new Date().toISOString(), projects: results, search };

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "page-template.html"), "utf8").replace("/*__DATA__*/null", () => JSON.stringify(data).replace(/</g, "\\u003c"));
// A saved copy of the page. It goes in the temp folder, not here: this folder is a git repository, and a file rewritten on
// every refresh would make the project look uncommitted again right after each commit.
const outFile = join(tmpdir(), "bwe-dashboard.html");
writeFileSync(outFile, html, "utf8");
console.log(`Wrote ${outFile}`);
for (const p of data.projects) console.log(`${p.key}: ${p.git ? `${p.git.files.length} uncommitted, ${p.git.unpushed.length} unpushed` : p.error}; ${p.remote.issues.length} issues, ${p.remote.prs.length} PRs, ${p.remote.activity.length} GitHub events, ${p.sessions.length} Claude sessions`);
if (process.argv.includes("--open")) execFileSync("cmd", ["/c", "start", "", outFile]);
