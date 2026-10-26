// Local-only server: serves index.html and rebuilds it on POST /refresh.
// Usage: node project-dashboard/serve.mjs [--open]   (http://127.0.0.1:8788)
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8788;
const build = () => new Promise((resolve, reject) =>
  execFile("node", [join(here, "build.mjs")], { cwd: here }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out))));

// Checkpoint skills (staging + production release, commit, push) per project.
const CHECKPOINTS = {
  BWE: { dir: "Z:\\Backup\\Websites\\BusinessWebExpress", cmd: "/BWECheckpoint" },
  BWE_HDBS: { dir: "Z:\\Backup\\Websites\\HandmadeDesignsBySuzi", cmd: "/BWEHDBSCheckpoint" },
  BWE_OneClickAnswers: { dir: "Z:\\Backup\\websites\\OneClickAnswers", cmd: "/BWEOCACheckpoint" },
  BWE_JKClassicBuggies: { dir: "Z:\\Backup\\websites\\JKClassicBuggiesV2", cmd: "/BWEJKCBCheckpoint" },
};

// Checkpoints run headless (no window) as `claude -p` with stream-json output; progress is kept here and
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

function runClaude(key, prompt, { resume, allow = [] } = {}) {
  const cp = CHECKPOINTS[key];
  const prev = jobs[key];
  const job = jobs[key] = { status: "running", startedAt: prev?.startedAt || Date.now(), endedAt: null, log: prev?.log || "", sessionId: prev?.sessionId, denials: [], result: "" };
  const args = ["-p", q(prompt), "--output-format", "stream-json", "--verbose"];
  if (resume) args.push("--resume", resume);
  if (allow.length) args.push("--allowedTools", ...allow.map(q));
  const say = (t) => { job.log = (job.log + t + "\n").slice(-30000); };
  const child = spawn("claude", args, { cwd: cp.dir, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
    const tail = job.result.trim().slice(-1200);
    const asking = /\?/.test(tail.slice(-300)) || /^\s*(?:[-*]\s*)?\**\(?[A-C][:.)]/m.test(tail) ||
      /\b(tell me which|let me know|which (one )?(do )?you (want|prefer)|please confirm|should i|do you want)\b/i.test(tail);
    job.status = job.denials.length || (code === 0 && !job.isError && asking) ? "waiting" : code === 0 && !job.isError ? "done" : "failed";
    job.code = code; job.endedAt = Date.now();
    saveJobs();
    try { await build(); } catch {} // pick up the new commit/push state
  });
}
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => resolve(b)); });

const server = createServer(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(jobs));
    return;
  }
  const key = req.method === "POST" && req.url.startsWith("/checkpoint/") ? decodeURIComponent(req.url.slice(12)) : "";
  if (CHECKPOINTS[key]) {
    if (jobs[key]?.status === "running") { res.writeHead(409, cors).end("already running"); return; }
    runClaude(key, CHECKPOINTS[key].cmd);
    res.writeHead(200, cors).end("started");
    return;
  }
  const rk = req.method === "POST" && req.url.startsWith("/reply/") ? decodeURIComponent(req.url.slice(7)) : "";
  if (CHECKPOINTS[rk]) {
    const job = jobs[rk];
    if (!job?.sessionId || job.status === "running") { res.writeHead(409, cors).end("nothing to reply to"); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
    const allow = body.allow ? [...new Set(job.denials.map(allowSpec))] : [];
    const text = String(body.text || "").trim() || (allow.length ? "Permission granted. Continue." : "");
    if (!text) { res.writeHead(400, cors).end("empty reply"); return; }
    job.log += `\n[you] ${text}${allow.length ? "  (allowed: " + allow.join(", ") + ")" : ""}\n`;
    runClaude(rk, text, { resume: job.sessionId, allow });
    res.writeHead(200, cors).end("sent");
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
