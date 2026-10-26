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
    for (const j of Object.values(saved)) if (j.status === "running") { j.status = "failed"; j.log += "\n" + problem("The dashboard server restarted while Claude was running, so this run was cut off.", "Send Claude a message below (or run it again) to carry on.") + "\n"; }
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
  // answered: session id -> when the user last replied to it from here. A resumed headless run can carry on under a
  // new session id, so the page uses this to stop showing a question that has already been answered.
  const answered = { ...(prev?.answered || jobs[key]?.answered || {}), ...(resume ? { [resume]: Date.now() } : {}) };
  const job = jobs[key] = { status: "running", kind: kind || prev?.kind || "checkpoint", startedAt: prev?.startedAt || Date.now(), lastStart: Date.now(), endedAt: null, log: prev?.log || "", sessionId: resume || prev?.sessionId, denials: [], result: "", answered };
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
  child.on("error", (e) => { say(problem("Claude Code couldn't be started.", "Check Claude Code is installed: open PowerShell and run claude --version. Then try again.", e.message)); job.status = "failed"; job.endedAt = Date.now(); });
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
// git output for both streams (push reports on stderr); rejects with git's own message. There is no terminal to answer
// a login prompt, so git is told not to ask, and a call that still hangs is stopped after 3 minutes.
const git = (dir, ...args) => new Promise((resolve, reject) => execFile("git", ["-C", dir, ...args],
  { windowsHide: true, timeout: 180000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, out, errOut) =>
  err ? reject(new Error(err.killed ? `git ${args[0]} took over 3 minutes and was stopped. Try it in a terminal to see if it is waiting for a login.` : String(errOut || out || err.message).trim()))
    : resolve(String(out + errOut).trim())));
const SECRETISH = /(^|\/)(\.env(\..*)?|\.dev\.vars|id_rsa.*|.*\.(pem|key|p12|pfx)|credentials.*|secrets?\.(json|ya?ml|txt))$/i;
// Every error the page shows says what went wrong and what to do about it: "<problem>\nWhat to do: <fix>".
// (Function declarations, so the saved-jobs loader near the top can use them.)
function problem(what, fix, details) { return `${what}\nWhat to do: ${fix}${details ? `\n\nDetails: ${String(details).trim().slice(-600)}` : ""}`; }
function fail(res, code, what, fix, details) { res.writeHead(code, { "Access-Control-Allow-Origin": "*" }).end(problem(what, fix, details)); }
const NOT_OWN_PAGE = ["This request didn't come from the dashboard page, so it was refused.", "Use the dashboard at http://127.0.0.1:8788."];
// Turns git's own wording into a plain problem and fix for the common cases.
function explainGit(msg, dir) {
  const m = String(msg).split("\n").filter((l) => !/^hint:/.test(l)).join("\n").trim();
  if (/took over 3 minutes/.test(m)) return problem("Git didn't finish within 3 minutes, so it was stopped. It is probably waiting for a GitHub sign-in that can't be shown here.", `Open PowerShell in ${dir}, run git push (or git pull) once and sign in when asked, then try again here.`);
  if (/rejected|non-fast-forward|fetch first/i.test(m)) return problem("GitHub refused the push because it has commits this PC doesn't have yet.", "Pick Pull (or Fix diverged) in the Git dropdown first, then push again.", m);
  if (/authentication|could not read username|permission denied|403|terminal prompts disabled/i.test(m)) return problem("GitHub didn't accept the sign-in for this repository.", `Open PowerShell in ${dir}, run git push once and sign in when asked, then try again here.`, m);
  if (/could not resolve host|unable to access|timed out|connection/i.test(m)) return problem("This PC couldn't reach GitHub.", "Check the internet connection, then try again.", m);
  if (/index\.lock|another git process/i.test(m)) return problem("Another program is using git in this folder right now.", `Wait for it to finish (or close it), then try again. If nothing is running, delete ${dir}\\.git\\index.lock and try again.`, m);
  if (/tell me who you are|user\.email/i.test(m)) return problem("Git doesn't know your name and email, so it can't commit.", 'In PowerShell run: git config --global user.name "Your Name" and git config --global user.email you@example.com, then try again.', m);
  if (/no upstream|no tracking information/i.test(m)) return problem("This branch isn't linked to a branch on GitHub.", "Pick Push once to create it on GitHub, then try again.", m);
  return problem("Git reported an error.", "Read the details below. If they don't make sense, send a screenshot of this message to Claude.", m);
}
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => resolve(b)); });

const server = createServer(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(jobs));
    return;
  }
  const key = req.method === "POST" && req.url.startsWith("/checkpoint/") ? decodeURIComponent(req.url.slice(12)) : "";
  if (byKey(key)?.cmd) {
    if (jobs[key]?.status === "running") { fail(res, 409, "A checkpoint is already running for this project.", "Wait for it to finish; the card shows a clock while it runs."); return; }
    runClaude(key, byKey(key).cmd, { kind: "checkpoint" });
    res.writeHead(200, cors).end("started");
    return;
  }
  // Reply to the project's job, or (with sessionId) to one of the project's Claude Code sessions.
  const rk = req.method === "POST" && req.url.startsWith("/reply/") ? decodeURIComponent(req.url.slice(7)) : "";
  if (byKey(rk)) {
    if (!ownPage(req)) { fail(res, 403, ...NOT_OWN_PAGE); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
    if (jobs[rk]?.status === "running") { fail(res, 409, "Claude is still working on this project, so it can't take a new message yet.", "Wait until the Claude is working panel goes away, then send your answer."); return; }
    const sid = body.sessionId ? String(body.sessionId) : jobs[rk]?.sessionId;
    if (!sid || !isSessionId(sid) || (body.sessionId && !sessionFiles(byKey(rk).dir).some((f) => f.id === sid))) { fail(res, 409, "That Claude session can't be found any more, so there is nothing to reply to.", "Click Refresh now to load the current sessions, then try again."); return; }
    const job = jobs[rk]?.sessionId === sid ? jobs[rk] : null;
    const allow = body.allow && job ? [...new Set(job.denials.map(allowSpec))] : [];
    const text = String(body.text || "").trim().slice(0, 20000) || (allow.length ? "Permission granted. Continue." : "");
    if (!text) { fail(res, 400, "The answer was empty.", "Type your answer in the box, then press Send."); return; }
    if (job) job.log += `\n[you] ${text}${allow.length ? "  (allowed: " + allow.join(", ") + ")" : ""}\n`;
    runClaude(rk, text, { resume: sid, allow, kind: job ? job.kind : "reply" });
    if (!job) jobs[rk].log = `[you] ${text}\n`;
    res.writeHead(200, cors).end("sent");
    return;
  }
  // Post the user's reply as a comment on an issue or pull request (the issues comments API covers both).
  const gk = req.method === "POST" && req.url.startsWith("/gh-comment/") ? decodeURIComponent(req.url.slice(12)) : "";
  if (byKey(gk)?.repo) {
    if (!ownPage(req)) { fail(res, 403, ...NOT_OWN_PAGE); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
    const num = Number(body.number), text = String(body.text || "").trim().slice(0, 60000);
    if (!Number.isInteger(num) || num < 1 || !text) { fail(res, 400, "The comment was empty.", "Type your comment in the box, then press Post comment."); return; }
    const child = execFile("gh", ["api", `repos/${OWNER}/${byKey(gk).repo}/issues/${num}/comments`, "-F", "body=@-", "--jq", ".html_url"], { windowsHide: true }, (err, out, errOut) => {
      if (err) {
        const m = String(errOut || err.message);
        if (/auth|login|401|403/i.test(m)) fail(res, 500, "GitHub didn't accept the comment because the gh tool isn't signed in.", "In PowerShell run: gh auth login, sign in, then try again.", m);
        else fail(res, 500, "GitHub didn't accept the comment.", "Check the internet connection and try again. If it keeps failing, send a screenshot of this message to Claude.", m);
        return;
      }
      res.writeHead(200, cors).end(out.trim() || "posted");
      build().catch(() => {});
    });
    child.stdin.end(text);
    return;
  }
  // Commit everything that is changed, push the current branch, or both. Push is a plain push (never forced): if the
  // remote has moved on, git refuses and says why. Files that look like secrets are never committed.
  const gk2 = req.method === "POST" && req.url.startsWith("/git/") ? decodeURIComponent(req.url.slice(5)) : "";
  if (byKey(gk2)) {
    if (!ownPage(req)) { fail(res, 403, ...NOT_OWN_PAGE); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
    const act = body.action, message = String(body.message || "").trim().slice(0, 5000), dir = winDir(byKey(gk2).dir);
    const commits = act === "commit" || act === "both";
    if (!["commit", "push", "both", "pull", "sync"].includes(act) || (commits && !message)) { fail(res, 400, act && commits ? "The commit message was empty." : "The dashboard sent an unknown Git action.", act && commits ? "Pick the option again and type a short message describing the change." : "Click Refresh now and try again."); return; }
    try {
      const out = [];
      const changedFiles = async () => [...new Set([
        ...(await git(dir, "ls-files", "--modified", "--others", "--exclude-standard")).split("\n"),
        ...(await git(dir, "diff", "--cached", "--name-only")).split("\n"),
      ].filter(Boolean))];
      // Pull rebases local commits on top of GitHub's. Commits already on GitHub are dropped by the rebase; on a
      // conflict the rebase is undone, so the folder is left exactly as it was.
      if (act === "pull" || act === "sync") {
        if ((await changedFiles()).length) throw new Error(problem("This folder has changes that aren't committed, so pulling could mix them up.", "Pick Commit in the Git dropdown first, then try again."));
        try { out.push(await git(dir, "pull", "--rebase")); }
        catch (e) {
          await git(dir, "rebase", "--abort").catch(() => {});
          if (!/conflict|could not apply/i.test(e.message)) throw new Error(explainGit(e.message, dir));
          throw new Error(problem("Your commits and GitHub's change the same lines, so they can't be combined automatically. The pull was undone and nothing changed.",
            `Open Claude Code in ${dir} and ask it to "pull from GitHub and resolve the merge conflicts", then come back and push.`, e.message.split("\n").filter((l) => !/^hint:/.test(l)).join("\n")));
        }
      }
      if (commits) {
        const changed = await changedFiles();
        const risky = changed.filter((f) => SECRETISH.test(f) && !/\.(example|sample|template)$/i.test(f));
        if (risky.length) throw new Error(problem(`Nothing was committed, because these files look like passwords or keys:\n${risky.join("\n")}`, "Add them to the project's .gitignore file (or ask Claude in that project to do it), then commit again."));
        if (!changed.length) throw new Error(problem("There's nothing to commit; every change is already committed.", "Nothing to do. Click Refresh now if the card still shows changes."));
        await git(dir, "add", "-A");
        out.push(await git(dir, "commit", "-m", message));
      }
      if (act === "push" || act === "both" || act === "sync") {
        const upstream = await git(dir, "rev-parse", "--abbrev-ref", "@{u}").catch(() => "");
        out.push(upstream ? await git(dir, "push") : await git(dir, "push", "-u", "origin", "HEAD"));
      }
      res.writeHead(200, cors).end(out.join("\n").trim() || "done"); // the page asks for the rebuild, so it can show that step
    } catch (e) { res.writeHead(500, cors).end(/\nWhat to do: /.test(e.message) ? e.message : explainGit(e.message, dir)); }
    return;
  }
  if (req.method === "POST" && req.url === "/refresh") {
    const cors = { "Access-Control-Allow-Origin": "*" }; // lets a double-clicked index.html trigger a refresh
    try { await build(); res.writeHead(200, cors).end("ok"); }
    catch (e) { fail(res, 500, "The dashboard couldn't collect the latest project data.", /gh|auth/i.test(e.message) ? "Make sure the gh tool is signed in (in PowerShell: gh auth status), then click Refresh now." : "Click Refresh now to try again. If it keeps failing, send a screenshot of this message to Claude.", e.message); }
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
