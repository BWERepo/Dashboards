// Shared by build.mjs and serve.mjs: the projects on the dashboard and where their Claude Code sessions live.
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OWNER = "BWERepo";
// cmd = the project's Checkpoint skill (staging + production release, commit, push), when it has one.
export const PROJECTS = [
  // group = the dashboard tab the project is shown under.
  { group: "websites", key: "BWE", name: "Business Web Express", dir: "Z:/Backup/Websites/BusinessWebExpress", repo: "BWE", cmd: "/BWECheckpoint" },
  { group: "websites", key: "BWE_HDBS", name: "Handmade Designs By Suzi", dir: "Z:/Backup/Websites/HandmadeDesignsBySuzi", repo: "HDBS", cmd: "/BWEHDBSCheckpoint" },
  { group: "websites", key: "BWE_OneClickAnswers", name: "One Click Answers", dir: "Z:/Backup/websites/OneClickAnswers", repo: "OneClickAnswers", cmd: "/BWEOCACheckpoint" },
  { group: "websites", key: "BWE_JKClassicBuggies", name: "JK Classic Buggies V2", dir: "Z:/Backup/websites/JKClassicBuggiesV2", repo: "JKClassicBuggiesV2", cmd: "/BWEJKCBCheckpoint" },
  { group: "websites", key: "BWE_ForTheTable", name: "For The Table", dir: "Z:/Backup/websites/ForTheTable", repo: "ForTheTable" },
  { group: "utilities", key: "BWE_SEOEngine", name: "SEO Engine", dir: "Z:/Backup/websites/SEOEngine", repo: "SEOEngine" },
  { group: "utilities", key: "BWE_FAQEngine", name: "FAQ Engine", dir: "Z:/Backup/websites/FAQEngine", repo: "FAQEngine" },
  { group: "utilities", key: "BWE_BlogEngine", name: "Blog Engine", dir: "Z:/Backup/websites/BlogEngine", repo: "BlogEngine" },
  { group: "utilities", key: "BWE_ClaudeSkills", name: "Claude Skills", dir: "Z:/Backup/websites/ClaudeSkills", repo: "ClaudeSkills" },
  { group: "utilities", key: "BWE_Dashboard", name: "BWE Dashboard", dir: "Z:/Backup/websites/Dashboards", repo: "Dashboards" },
];
export const byKey = (key) => PROJECTS.find((p) => p.key === key);
export const winDir = (dir) => dir.replace(/\//g, "\\");

// Claude Code keeps one transcript (<session id>.jsonl) per session under ~/.claude/projects/<cwd with every
// non-alphanumeric character turned into "-">. Folder case follows how the session was started, so match loosely.
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export function sessionFiles(dir) {
  const root = join(CLAUDE_HOME, "projects");
  const want = dir.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
  let folders = [];
  try { folders = readdirSync(root).filter((n) => n.toLowerCase() === want); } catch { return []; }
  return folders.flatMap((f) => readdirSync(join(root, f)).filter((n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n)).map((n) => {
    const path = join(root, f, n);
    return { id: n.slice(0, -6), path, mtime: statSync(path).mtimeMs };
  })).sort((a, b) => b.mtime - a.mtime);
}
export const isSessionId = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));

// Transcripts can be many MB; the newest messages are at the end, so read only the tail.
function tail(path, bytes) {
  const size = statSync(path).size, len = Math.min(size, bytes), buf = Buffer.alloc(len), fd = openSync(path, "r");
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const text = buf.toString("utf8");
  return size > len ? text.slice(text.indexOf("\n") + 1) : text;
}

const clean = (s) => String(s)
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
  .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
  .replace(/<command-name>([\s\S]*?)<\/command-name>/g, "$1 ")
  .replace(/<command-args>([\s\S]*?)<\/command-args>/g, "$1")
  .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
  .trim();
const toolLine = (c) => `${c.name}${c.input?.command ? ": " + c.input.command : c.input?.file_path ? ": " + c.input.file_path : c.input?.description ? ": " + c.input.description : ""}`.slice(0, 300);

// Same test the server uses on a finished headless run: does Claude's last message wait on the user?
export const asksUser = (text) => {
  const t = String(text || "").trim().slice(-1200);
  return /\?/.test(t.slice(-300)) || /^\s*(?:[-*]\s*)?\**\(?[A-C][:.)]/m.test(t) || /USER INPUT NEEDED/i.test(t) ||
    /\b(tell me which|let me know|which (one )?(do )?you (want|prefer)|please confirm|should i|do you want)\b/i.test(t);
};

// The newest sessions of a project, each with its latest messages (user, Claude, and one-line tool calls).
export function claudeSessions(dir, { sessions = 4, messages = 40 } = {}) {
  return sessionFiles(dir).slice(0, sessions).map((f) => {
    const msgs = [];
    let title = "";
    for (const line of tail(f.path, 3 << 20).split("\n")) {
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "summary" && ev.summary) title = ev.summary;
      if ((ev.type !== "user" && ev.type !== "assistant") || ev.isSidechain || ev.isMeta) continue;
      const content = typeof ev.message?.content === "string" ? [{ type: "text", text: ev.message.content }] : ev.message?.content || [];
      for (const c of content) {
        const role = c.type === "tool_use" ? "tool" : c.type === "text" ? (ev.type === "user" ? "user" : "claude") : null;
        const text = role === "tool" ? toolLine(c) : role ? clean(c.text) : "";
        if (!text || /^\[Request interrupted/.test(text)) continue;
        const prev = msgs[msgs.length - 1];
        if (prev && prev.role === role && role !== "tool") prev.text += "\n\n" + text; // one turn spans several lines
        else msgs.push({ role, text, at: ev.timestamp });
      }
    }
    const firstUser = msgs.find((m) => m.role === "user");
    const shown = msgs.slice(-messages).map((m) => ({ ...m, text: m.text.length > 4000 ? m.text.slice(0, 4000) + " …" : m.text }));
    const last = [...msgs].reverse().find((m) => m.role !== "tool");
    return {
      id: f.id,
      // Prompts relayed from other tools can start with XML-like tags; title the session by its first plain line.
      title: (title || [firstUser, msgs.find((m) => m.role === "claude")].map((m) => m?.text.replace(/<[^>]*>/g, " ").split("\n").map((l) => l.trim()).find(Boolean)).find(Boolean) || "Session").slice(0, 120),
      updatedAt: new Date(f.mtime).toISOString(),
      total: msgs.length,
      messages: shown,
      // Only a recent session that ended on a question counts as waiting on the user.
      asking: !!last && last.role === "claude" && Date.now() - f.mtime < 3 * 864e5 && asksUser(last.text),
    };
  });
}

// ---- The Google tab: the latest results of the daily/weekly Search monitor workflows for each BWE site (the reports
// the workflows commit to the search-monitor-data branch). Read-only, uses `gh`. Sites are read in parallel.
export const SEARCH_SITES = [
  { repo: "ForTheTable", name: "For The Table" },
  { repo: "BWE", name: "Business Web Express" },
  { repo: "HDBS", name: "Handmade Designs By Suzi" },
  { repo: "OneClickAnswers", name: "One Click Answers" },
];
const BRANCH = "search-monitor-data";

const gh = (args) => new Promise((resolve, reject) => execFile("gh", args, { encoding: "utf8", maxBuffer: 64 << 20, windowsHide: true },
  (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out))));
const raw = (repo, path, ref = BRANCH) => gh(["api", `repos/${OWNER}/${repo}/contents/${path}?ref=${ref}`, "-H", "Accept: application/vnd.github.raw"]);
const tryJson = async (fn) => { try { return JSON.parse(await fn()); } catch { return null; } };

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

async function collectSite({ repo, name }) {
  const site = { repo, name, url: `https://github.com/${OWNER}/${repo}`, setUp: false, daily: [], weekly: [] };
  const runs = await tryJson(() => gh(["run", "list", "-R", `${OWNER}/${repo}`, "-w", "search-monitor-daily.yml", "-L", "1", "--json", "conclusion,createdAt,url"]));
  if (runs === null) return site;
  site.setUp = true;
  site.lastRun = runs[0] || null;
  const tree = await tryJson(() => gh(["api", `repos/${OWNER}/${repo}/git/trees/${BRANCH}?recursive=1`, "-q", "[.tree[].path]"]));
  if (!tree) return site;
  const reports = tree.filter((p) => /^reports\/(daily|weekly)-[\d-]+\.md$/.test(p)).sort().reverse().slice(0, 30);
  const [mds, state] = await Promise.all([
    Promise.all(reports.map((p) => raw(repo, p).catch(() => ""))),
    tryJson(() => raw(repo, "state.json")),
  ]);
  reports.forEach((p, i) => {
    const kind = p.includes("/weekly-") ? "weekly" : "daily", date = p.match(/(\d{4}-\d{2}-\d{2})/)[1], md = mds[i];
    site[kind].push(kind === "daily" ? { date, ...parseReport(md), md } : { date, md });
  });
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
    site.history = await indexedHistory(repo);
  }
  return site;
}

// Indexed pages over time: state.json is committed after every daily run, so its older versions give one data point per
// day (the newest commit of each day, up to 30 days).
async function indexedHistory(repo) {
  const commits = await tryJson(() => gh(["api", `repos/${OWNER}/${repo}/commits?sha=${BRANCH}&path=state.json&per_page=60`, "-q", "[.[] | {sha: .sha, at: .commit.committer.date}]"]));
  if (!commits) return [];
  const perDay = new Map();
  for (const c of commits) { const day = c.at.slice(0, 10); if (!perDay.has(day)) perDay.set(day, c); } // newest first
  const picks = [...perDay.values()].slice(0, 30);
  const points = await Promise.all(picks.map(async (c) => {
    const s = await tryJson(() => raw(repo, "state.json", c.sha));
    if (!s) return null;
    const v = Object.values(s.urls || {}).map((r) => r.google?.verdict);
    return { at: c.at, indexed: v.filter((x) => x === "PASS").length, notIndexed: v.filter((x) => x && x !== "PASS").length, total: v.length };
  }));
  return points.filter(Boolean).reverse(); // oldest first
}

export async function collectSearch() {
  return { updatedAt: new Date().toISOString(), sites: await Promise.all(SEARCH_SITES.map(collectSite)) };
}
