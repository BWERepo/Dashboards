// Builds dashboard/index.html: one self-contained page with the latest results of the
// daily/weekly Search monitor workflows for every BWE site. Read-only (uses `gh`).
// Usage: node dashboard/build.mjs [--open]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "BWERepo";
const SITES = [
  { repo: "ForTheTable", name: "For The Table" },
  { repo: "BWE", name: "Business Web Express" },
  { repo: "HDBS", name: "Handmade Designs By Suzi" },
  { repo: "OneClickAnswers", name: "One Click Answers" },
];
const BRANCH = "search-monitor-data";

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const raw = (repo, path) => gh(["api", `repos/${OWNER}/${repo}/contents/${path}?ref=${BRANCH}`, "-H", "Accept: application/vnd.github.raw"]);
const tryJson = (fn) => { try { return JSON.parse(fn()); } catch { return null; } };

function parseReport(md) {
  const num = (re) => { const m = md.match(re); return m ? Number(m[1]) : null; };
  const flagged = [...md.matchAll(/^- \*\*([\w-]+)\*\* \((\w+)\) (\S+)(?: — (.*))?$/gm)]
    .map((m) => ({ kind: m[1], severity: m[2], url: m[3], detail: m[4] || "" }));
  return {
    sitemap: num(/Sitemap: (\d+) URLs/),
    sitemapNote: (md.match(/Sitemap: \d+ URLs \(([^)]*)\)/) || [])[1] || "",
    checked: num(/Checked (\d+) URLs/),
    fresh: num(/(\d+) new/),
    open: num(/Open findings across the site: (\d+)/),
    google: (md.match(/Google Search Console: (.*)/) || [])[1] || "",
    flagged,
  };
}

function collect({ repo, name }) {
  const site = { repo, name, url: `https://github.com/${OWNER}/${repo}`, setUp: false, daily: [], weekly: [] };
  const runs = tryJson(() => gh(["run", "list", "-R", `${OWNER}/${repo}`, "-w", "search-monitor-daily.yml", "-L", "1",
    "--json", "conclusion,createdAt,url"]));
  if (runs === null) return site;
  site.setUp = true;
  site.lastRun = runs[0] || null;
  const tree = tryJson(() => gh(["api", `repos/${OWNER}/${repo}/git/trees/${BRANCH}?recursive=1`, "-q", "[.tree[].path]"]));
  if (!tree) return site;
  const reports = tree.filter((p) => /^reports\/(daily|weekly)-[\d-]+\.md$/.test(p)).sort().reverse();
  for (const p of reports.slice(0, 30)) {
    const kind = p.includes("/weekly-") ? "weekly" : "daily";
    const date = p.match(/(\d{4}-\d{2}-\d{2})/)[1];
    const md = raw(repo, p);
    site[kind].push(kind === "daily" ? { date, ...parseReport(md), md } : { date, md });
  }
  const state = tryJson(() => raw(repo, "state.json"));
  if (state) {
    const urls = Object.entries(state.urls || {});
    const verdict = { indexed: 0, notIndexed: 0, unknown: 0 };
    const pages = urls.map(([u, r]) => {
      const g = r.google?.verdict;
      if (g === "PASS") verdict.indexed++; else if (g) verdict.notIndexed++; else verdict.unknown++;
      return { url: u, firstSeen: r.firstSeen, lastChecked: r.lastChecked, verdict: g || "", coverage: r.google?.coverage || "",
        lastCrawl: r.google?.lastCrawl || "", findings: (r.findings || []).map((f) => ({ kind: f.kind, severity: f.severity, detail: f.detail || f.message || "" })) };
    });
    site.state = { total: urls.length, ...verdict, lastDaily: state.lastDaily || null, pages };
  }
  return site;
}

const data = { generatedAt: new Date().toISOString(), sites: SITES.map(collect) };

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "page-template.html"), "utf8").replace("/*__DATA__*/null", () => JSON.stringify(data).replace(/</g, "\\u003c"));
const out = join(here, "index.html");
writeFileSync(out, html, "utf8");
console.log(`Wrote ${out}`);
for (const s of data.sites) console.log(`${s.name}: ${s.setUp ? `${s.daily.length} daily, ${s.weekly.length} weekly reports` : "monitor not set up"}`);
if (process.argv.includes("--open")) execFileSync("cmd", ["/c", "start", "", out]);

