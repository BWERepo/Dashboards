// Builds project-dashboard/index.html: status, outstanding issues and items to commit for the
// BWE, BWE_HDBS, BWE_OneClickAnswers and BWE_JKClassicBuggies projects. Read-only (git + gh).
// Usage: node project-dashboard/build.mjs [--open]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "BWERepo";
const PROJECTS = [
  { key: "BWE", name: "Business Web Express", dir: "Z:/Backup/Websites/BusinessWebExpress", repo: "BWE" },
  { key: "BWE_HDBS", name: "Handmade Designs By Suzi", dir: "Z:/Backup/Websites/HandmadeDesignsBySuzi", repo: "HDBS" },
  { key: "BWE_OneClickAnswers", name: "One Click Answers", dir: "Z:/Backup/websites/OneClickAnswers", repo: "OneClickAnswers" },
  { key: "BWE_JKClassicBuggies", name: "JK Classic Buggies V2", dir: "Z:/Backup/websites/JKClassicBuggiesV2", repo: "JKClassicBuggiesV2" },
  { key: "BWE_BlogEngine", name: "Blog Engine", dir: "Z:/Backup/websites/BlogEngine", repo: "BlogEngine" },
  { key: "BWE_SEOEngine", name: "SEO Engine", dir: "Z:/Backup/websites/SEOEngine", repo: "SEOEngine" },
  { key: "BWE_FAQEngine", name: "FAQ Engine", dir: "Z:/Backup/websites/FAQEngine", repo: "FAQEngine" },
  { key: "BWE_ClaudeSkills", name: "Claude Skills", dir: "Z:/Backup/websites/ClaudeSkills", repo: "ClaudeSkills" },
];

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
  const r = `${OWNER}/${repo}`;
  const issues = attempt(() => JSON.parse(gh("issue", "list", "-R", r, "--state", "open", "-L", "50", "--json", "number,title,url,updatedAt,body,labels")), []);
  const prs = attempt(() => JSON.parse(gh("pr", "list", "-R", r, "--state", "open", "-L", "30", "--json", "number,title,url,isDraft,updatedAt")), []);
  return {
    url: `https://github.com/${r}`,
    issues: issues.map((i) => ({ number: i.number, title: i.title, url: i.url, updatedAt: i.updatedAt, labels: i.labels.map((l) => l.name), body: (i.body || "").slice(0, 4000) })),
    prs,
  };
}

const data = {
  generatedAt: new Date().toISOString(),
  projects: PROJECTS.map((p) => {
    const out = { key: p.key, name: p.name, dir: p.dir.replace(/\//g, "\\") };
    try { out.git = gitState(p.dir); } catch (e) { out.error = String(e.message).slice(0, 300); }
    out.doc = attempt(() => statusDoc(p.dir));
    out.remote = remote(p);
    return out;
  }),
};

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "page-template.html"), "utf8").replace("/*__DATA__*/null", () => JSON.stringify(data).replace(/</g, "\\u003c"));
const outFile = join(here, "index.html");
writeFileSync(outFile, html, "utf8");
console.log(`Wrote ${outFile}`);
for (const p of data.projects) console.log(`${p.key}: ${p.git ? `${p.git.files.length} uncommitted, ${p.git.unpushed.length} unpushed` : p.error}; ${p.remote.issues.length} issues, ${p.remote.prs.length} PRs`);
if (process.argv.includes("--open")) execFileSync("cmd", ["/c", "start", "", outFile]);
