// Local-only server: serves index.html and rebuilds it on POST /refresh.
// Usage: node project-dashboard/serve.mjs [--open]   (http://127.0.0.1:8788)
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER, asksUser, byKey, isSessionId, sessionFiles, winDir } from "./projects.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8788;
const build = () => new Promise((resolve, reject) =>
  execFile("node", [join(here, "build.mjs")], { cwd: here }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out))));

// Checkpoints, and replies to a project's Claude Code sessions, run headless (no window) as `claude -p` with
// stream-json output, one job per project; progress is kept here and
// polled by the page. Claude can't prompt in headless mode: a tool needing approval is denied and reported
// back as `permission_denials`, and any question arrives as the final text. The page shows both in a textbox;
// the user's reply (or "Allow") resumes the same session with `--resume`.
// Job state survives a server restart, so a pending question can still be answered.
const JOBS_FILE = join(here, "jobs.json");
const jobs = (() => {
  try {
    const saved = JSON.parse(readFileSync(JOBS_FILE, "utf8"));
    for (const j of Object.values(saved)) if (j.status === "running") { j.status = "failed"; j.log += "\n[dashboard server restarted while this was running]\n"; }
    return saved;
  } catch { return {}; }
})();
const saveJobs = () => { try { writeFileSync(JOBS_FILE, JSON.stringify(jobs)); } catch {} };
const q =(s) => `"${String(s).replace(/"/g, '\\"')}"`;
const allowSpec = (d) => (d.tool_name === "Bash" && d.tool_input?.command ? `Bash(${d.tool_input.command})` : d.tool_name);

// The prompt goes in on stdin, so a multi-line reply reaches Claude intact and is never parsed by the shell.
function runClaude(key, prompt, { resume, allow = [], kind } = {}) {
  const dir = winDir(byKey(key).dir);
  const prev = resume && jobs[key]?.sessionId === resume ? jobs[key] : null; // a new session starts a fresh log
  const job = jobs[key] = { status: "running", kind: kind || prev?.kind || "checkpoint", startedAt: prev?.startedAt || Date.now(), endedAt: null, log: prev?.log || "", sessionId: resume || prev?.sessionId, denials: [], result: "" };
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (resume) args.push("--resume", resume);
  if (allow.length) args.push("--allowedTools", ...allow.map(q));
  const say = (t) => { job.log = (job.log + t + "\n").slice(-30000); };
  const child = spawn("claude", args, { cwd: dir, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
  let buf = "";
  const onLine = (line) => {
    let ev; try { ev = JSON.parse(line); } catch { if (line.trim()) say(line); return; }
    if (ev.session_id) job.sessionId = ev.session_id;
    if (ev.type === "assistant") for (const c of ev.message?.content || []) {
      if (c.type === "text") say(c.text);
      else if (c.type === "tool_use") say(`> ${c.name}${c.input?.command ? ": " + c.input.command : c.input?.file_path ? ": " + c.input.file_path : ""}`);
    }
    if (ev.type === "result") { job.result = ev.result || ""; job.denials = ev.permission_denials || []; job.isError = !!ev.is_error; }
  };
  child.stdout.on("data", (d) => { buf += d; const lines = buf.split("\n"); buf = lines.pop(); lines.forEach(onLine); });
  child.stderr.on("data", (d) => say(String(d).trim()));
  child.on("error", (e) => { say(String(e.message)); job.status = "failed"; job.endedAt = Date.now(); });
  child.on("close", async (code) => {
    if (buf.trim()) onLine(buf);
    // A clean exit is not a finished release: Claude may have stopped to ask the user something.
    const asking = asksUser(job.result);
    job.status = job.denials.length || (code === 0 && !job.isError && asking) ? "waiting" : code === 0 && !job.isError ? "done" : "failed";
    job.code = code; job.endedAt = Date.now();
    saveJobs();
    try { await build(); } catch {} // pick up the new commit/push state
  });
}
// Replies speak for the user (to Claude, or as a GitHub comment), so only this page may send them: any other
// site open in the browser could otherwise POST here.
const ownPage = (req) => !req.headers.origin || /^http:\/\/(127\.0\.0\.1|localhost):8788$/.test(req.headers.origin);
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => resolve(b)); });

const server = createServer(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(jobs));
    return;
  }
  const key = req.method === "POST" && req.url.startsWith("/checkpoint/") ? decodeURIComponent(req.url.slice(12)) : "";
  if (byKey(key)?.cmd) {
    if (jobs[key]?.status === "running") { res.writeHead(409, cors).end("already running"); return; }
    runClaude(key, byKey(key).cmd, { kind: "checkpoint" });
    res.writeHead(200, cors).end("started");
    return;
  }
  // Reply to the project's job, or (with sessionId) to one of the project's Claude Code sessions.
  const rk = req.method === "POST" && req.url.startsWith("/reply/") ? decodeURIComponent(req.url.slice(7)) : "";
  if (byKey(rk)) {
    if (!ownPage(req)) { res.writeHead(403).end("forbidden"); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
    if (jobs[rk]?.status === "running") { res.writeHead(409, cors).end("Claude is still working on this project. Wait for it to finish."); return; }
    const sid = body.sessionId ? String(body.sessionId) : jobs[rk]?.sessionId;
    if (!sid || !isSessionId(sid) || (body.sessionId && !sessionFiles(byKey(rk).dir).some((f) => f.id === sid))) { res.writeHead(409, cors).end("nothing to reply to"); return; }
    const job = jobs[rk]?.sessionId === sid ? jobs[rk] : null;
    const allow = body.allow && job ? [...new Set(job.denials.map(allowSpec))] : [];
    const text = String(body.text || "").trim().slice(0, 20000) || (allow.length ? "Permission granted. Continue." : "");
    if (!text) { res.writeHead(400, cors).end("empty reply"); return; }
    if (job) job.log += `\n[you] ${text}${allow.length ? "  (allowed: " + allow.join(", ") + ")" : ""}\n`;
    runClaude(rk, text, { resume: sid, allow, kind: job ? job.kind : "reply" });
    if (!job) jobs[rk].log = `[you] ${text}\n`;
    res.writeHead(200, cors).end("sent");
    return;
  }
  // Post the user's reply as a comment on an issue or pull request (the issues comments API covers both).
  const gk = req.method === "POST" && req.url.startsWith("/gh-comment/") ? decodeURIComponent(req.url.slice(12)) : "";
  if (byKey(gk)?.repo) {
    if (!ownPage(req)) { res.writeHead(403).end("forbidden"); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
    const num = Number(body.number), text = String(body.text || "").trim().slice(0, 60000);
    if (!Number.isInteger(num) || num < 1 || !text) { res.writeHead(400, cors).end("need an issue or PR number and some text"); return; }
    const child = execFile("gh", ["api", `repos/${OWNER}/${byKey(gk).repo}/issues/${num}/comments`, "-F", "body=@-", "--jq", ".html_url"], { windowsHide: true }, (err, out, errOut) => {
      if (err) { res.writeHead(500, cors).end(String(errOut || err.message).slice(0, 500)); return; }
      res.writeHead(200, cors).end(out.trim() || "posted");
      build().catch(() => {});
    });
    child.stdin.end(text);
    return;
  }
  if (req.method === "POST" && req.url === "/refresh") {
    const cors = { "Access-Control-Allow-Origin": "*" }; // lets a double-clicked index.html trigger a refresh
    try { await build(); res.writeHead(200, cors).end("ok"); }
    catch (e) { res.writeHead(500, cors).end(String(e.message).slice(0, 500)); }
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(readFileSync(join(here, "index.html")));
    return;
  }
  res.writeHead(404).end();
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.log(`Already running at http://127.0.0.1:${PORT}`); if (process.argv.includes("--open")) open(); process.exit(0); }
  throw e;
});
server.listen(PORT, "127.0.0.1", async () => {
  console.log(`Dashboard at http://127.0.0.1:${PORT}  (Ctrl+C to stop)`);
  try { await build(); } catch (e) { console.log("Initial build failed:", e.message); }
  if (process.argv.includes("--open")) open();
});

function open() { execFile("cmd", ["/c", "start", "", `http://127.0.0.1:${PORT}`]); }
