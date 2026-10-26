// Builds project-dashboard/index.html: status, outstanding issues, items to commit, recent GitHub activity
// and recent Claude Code sessions for each project in projects.mjs. Read-only (git + gh + local transcripts).
// Usage: node project-dashboard/build.mjs [--open]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { OWNER, PROJECTS, claudeSessions, winDir } from "./projects.mjs";

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const attempt = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };
const git = (dir, ...args) => run("git", ["-C", dir, ...args]);
const gh = (...args) => run("gh", args);

function gitState(dir) {
  attempt(() => git(dir, "fetch", "--quiet", "--no-tags", "origin")); // refresh remote refs so ahead/behind is current
  const branch = git(dir, "branch", "--show-current").trim();
  const files = git(dir, "status", "--porcelain=v1", "-uall").split("\n").filter(Boolean).map((l) => {
    const code = l.slice(0, 2);
    const path = l.slice(3).replace(/^"|"$/g, "");
    const kind = code === "??" ? "untracked" : /[MADRC]/.test(code[0]) && code[1] === " " ? "staged" : /U|AA|DD/.test(code) ? "conflict" : "modified";
    return { code: code.trim() || code, kind, path };
  });
  const upstream = attempt(() => git(dir, "rev-parse", "--abbrev-ref", "@{u}").trim());
  let ahead = null, behind = null;
  if (upstream) {
    const [b, a] = git(dir, "rev-list", "--left-right", "--count", "@{u}...HEAD").trim().split(/\s+/).map(Number);
    ahead = a; behind = b;
  }
  const unpushed = upstream && ahead ? git(dir, "log", "--format=%h %s", "@{u}..HEAD").split("\n").filter(Boolean) : [];
  const [hash, date, subject] = git(dir, "log", "-1", "--format=%h\t%cI\t%s").trim().split("\t");
  const stashes = git(dir, "stash", "list").split("\n").filter(Boolean).length;
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

function remote({ repo }) {
  if (!repo) return { url: null, issues: [], prs: [], activity: [] };
  const r = `${OWNER}/${repo}`;
  const json = (...args) => attempt(() => JSON.parse(gh(...args)), []);
  const issues = json("issue", "list", "-R", r, "--state", "open", "-L", "50", "--json", "number,title,url,updatedAt,body,labels");
  const prs = json("pr", "list", "-R", r, "--state", "open", "-L", "30", "--json", "number,title,url,isDraft,updatedAt");
  return {
    url: `https://github.com/${r}`,
    issues: issues.map((i) => ({ number: i.number, title: i.title, url: i.url, updatedAt: i.updatedAt, labels: i.labels.map((l) => l.name), body: (i.body || "").slice(0, 4000) })),
    prs,
    activity: activity(r, json),
  };
}

// One timeline of GitHub messages: issues and PRs (opened or updated), their comments, commits and Actions runs.
function activity(r, json) {
  const short = (s, n = 3000) => { s = String(s || "").trim(); return s.length > n ? s.slice(0, n) + " …" : s; };
  const items = [];
  for (const i of json("issue", "list", "-R", r, "--state", "all", "-L", "15", "--json", "number,title,url,state,author,createdAt,updatedAt,body"))
    items.push({ type: "issue", number: i.number, title: i.title, url: i.url, state: i.state.toLowerCase(), author: i.author?.login, at: i.updatedAt, created: i.createdAt, body: short(i.body) });
  for (const p of json("pr", "list", "-R", r, "--state", "all", "-L", "15", "--json", "number,title,url,state,isDraft,author,createdAt,updatedAt,body"))
    items.push({ type: "pr", number: p.number, title: p.title, url: p.url, state: p.isDraft && p.state === "OPEN" ? "draft" : p.state.toLowerCase(), author: p.author?.login, at: p.updatedAt, created: p.createdAt, body: short(p.body) });
  const num = (u) => Number(String(u || "").match(/\/(\d+)$/)?.[1]) || null;
  for (const c of json("api", `repos/${r}/issues/comments?sort=updated&direction=desc&per_page=25`))
    items.push({ type: "comment", number: num(c.issue_url), title: `Comment on #${num(c.issue_url)}`, url: c.html_url, author: c.user?.login, at: c.updated_at, body: short(c.body) });
  for (const c of json("api", `repos/${r}/pulls/comments?sort=updated&direction=desc&per_page=15`))
    items.push({ type: "comment", number: num(c.pull_request_url), title: `Review comment on #${num(c.pull_request_url)}${c.path ? " · " + c.path : ""}`, url: c.html_url, author: c.user?.login, at: c.updated_at, body: short(c.body) });
  for (const c of json("api", `repos/${r}/commits?per_page=15`))
    items.push({ type: "commit", title: c.commit.message.split("\n")[0], url: c.html_url, sha: c.sha.slice(0, 7), author: c.author?.login || c.commit.author?.name, at: c.commit.author?.date, body: short(c.commit.message.split("\n").slice(1).join("\n")) });
  for (const w of json("run", "list", "-R", r, "-L", "15", "--json", "displayTitle,workflowName,status,conclusion,createdAt,url,event,headBranch"))
    items.push({ type: "run", title: `${w.workflowName}: ${w.displayTitle}`, url: w.url, state: w.conclusion || w.status, author: `${w.event} · ${w.headBranch}`, at: w.createdAt });
  return items.filter((i) => i.at).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 80);
}

const data = {
  generatedAt: new Date().toISOString(),
  projects: PROJECTS.map((p) => {
    const out = { key: p.key, name: p.name, dir: winDir(p.dir), cmd: p.cmd || null };
    try { out.git = gitState(p.dir); } catch (e) { out.error = String(e.message).slice(0, 300); }
    out.doc = attempt(() => statusDoc(p.dir));
    out.remote = remote(p);
    out.sessions = attempt(() => claudeSessions(p.dir), []);
    return out;
  }),
};

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "page-template.html"), "utf8").replace("/*__DATA__*/null", () => JSON.stringify(data).replace(/</g, "\\u003c"));
const outFile = join(here, "index.html");
writeFileSync(outFile, html, "utf8");
console.log(`Wrote ${outFile}`);
for (const p of data.projects) console.log(`${p.key}: ${p.git ? `${p.git.files.length} uncommitted, ${p.git.unpushed.length} unpushed` : p.error}; ${p.remote.issues.length} issues, ${p.remote.prs.length} PRs, ${p.remote.activity.length} GitHub events, ${p.sessions.length} Claude sessions`);
if (process.argv.includes("--open")) execFileSync("cmd", ["/c", "start", "", outFile]);
