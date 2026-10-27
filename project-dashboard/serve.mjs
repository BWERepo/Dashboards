// Local-only server: serves index.html and rebuilds it on POST /refresh.
// Usage: node project-dashboard/serve.mjs [--open]   (http://127.0.0.1:8788)
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { OWNER, PROJECTS, asksUser, byKey, isSessionId, sessionFiles, winDir } from "./projects.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8788;
// The data is collected by build.mjs, which prints each project as it finishes ("@@project {json}"). Those are kept
// here so the page can show every project as soon as it arrives (GET /progress) instead of waiting for all of them.
// A build asked for while one is running is queued (once), so it still picks up the newest state.
const progress = { run: 0, running: false, seq: 0, done: 0, total: PROJECTS.length + 1, projects: {}, search: null, startedAt: null, generatedAt: null, error: null };
let current = null, queued = null;
function build() {
  if (!current) return (current = runBuild().finally(() => { current = null; }));
  return (queued ||= current.catch(() => {}).then(() => { queued = null; return build(); }));
}
function runBuild() {
  const run = ++progress.run;
  Object.assign(progress, { running: true, done: 0, startedAt: Date.now(), error: null });
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(here, "build.mjs")], { cwd: here, windowsHide: true });
    let buf = "", errOut = "", ended = false;
    child.stdout.on("data", (d) => {
      buf += d; const lines = buf.split("\n"); buf = lines.pop();
      for (const l of lines) if (l.startsWith("@@search ")) try {
        progress.search = { ...JSON.parse(l.slice(9).trim()), run, seq: ++progress.seq }; progress.done++;
      } catch {}
      else if (l.startsWith("@@project ")) try {
        const p = JSON.parse(l.slice(10).trim());
        progress.projects[p.key] = { ...p, run, seq: ++progress.seq }; progress.done++;
      } catch {}
    });
    child.stderr.on("data", (d) => { errOut = (errOut + d).slice(-4000); });
    const end = (err) => {
      if (ended) return; ended = true;
      progress.running = false;
      if (err) { progress.error = problem("The dashboard couldn't collect the latest project data.", /gh|auth/i.test(err.message) ? "Make sure the gh tool is signed in (in PowerShell: gh auth status), then click Refresh now." : "Click Refresh now to try again. If it keeps failing, send a screenshot of this message to Claude.", err.message); reject(err); }
      else { progress.generatedAt = new Date().toISOString(); resolve(); }
    };
    child.on("error", end);
    child.on("close", (code) => end(code ? new Error(errOut || `build.mjs stopped with exit code ${code}`) : null));
  });
}
// The page is always served fresh from the template with every card "loading"; the data then arrives from /progress.
// (The copy build.mjs saves in the temp folder is not served, so an old one can never show an old dashboard.)
const blankPage = () => readFileSync(join(here, "page-template.html"), "utf8").replace("/*__DATA__*/null", () => JSON.stringify({ generatedAt: null,
  projects: PROJECTS.map((p) => ({ key: p.key, name: p.name, dir: winDir(p.dir), cmd: p.cmd || null, group: p.group, loading: true, remote: { url: null, issues: [], prs: [], activity: [] }, sessions: [] })) }).replace(/</g, "\\u003c"));

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
// A missing or broken "origin" remote ("'origin' does not appear to be a git repository") is repaired from the project's
// repo name, then the command is tried once more.
const BAD_ORIGIN = /does not appear to be a git repository|No such remote|Could not read from remote repository/i;
async function withOrigin(dir, proj, fn) {
  try { return await fn(); }
  catch (e) {
    if (!proj?.repo || !BAD_ORIGIN.test(e.message)) throw e;
    const url = `https://github.com/${OWNER}/${proj.repo}.git`;
    await git(dir, "remote", "set-url", "origin", url).catch(() => git(dir, "remote", "add", "origin", url));
    return fn();
  }
}
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
  if (BAD_ORIGIN.test(m)) return problem("This folder's link to GitHub (the \"origin\" remote) is missing or wrong.", `Open PowerShell in ${dir}, run git remote -v to see it, and git remote set-url origin <the repo's GitHub URL> to fix it, then try again.`, m);
  if (/no upstream|no tracking information/i.test(m)) return problem("This branch isn't linked to a branch on GitHub.", "Pick Push once to create it on GitHub, then try again.", m);
  return problem("Git reported an error.", "Read the details below. If they don't make sense, send a screenshot of this message to Claude.", m);
}
// A plain-words version of a Claude message, written by a short headless `claude -p` run (nothing is resumed or saved
// in the project). Kept in memory by text, so each message is only summarised once.
const summaries = new Map();
function summarize(text) {
  const id = createHash("sha1").update(text).digest("hex").slice(0, 16);
  if (!summaries.has(id)) {
    const entry = { status: "working", text: "" }; summaries.set(id, entry);
    const prompt = "Below is a message Claude Code wrote to its user, who is not a programmer. Rewrite it in plain, simple English for a busy business owner: no code, file names, commit ids or jargon. Use exactly these four lines, in this order, and nothing else:\n" +
      "What happened: (1-2 short sentences)\nWhat Claude needs from you: (1 short sentence, the actual question)\nYour choices: (each choice in a few plain words, separated by ' / ', or 'Any answer in your own words')\nRecommended: (the choice Claude recommends and why in a few words, or 'None given')\n\nIf the message is cut off or does not ask anything, say so on the 'What Claude needs from you' line.\n\n--- MESSAGE ---\n" + text.slice(-6000);
    const child = spawn("claude", ["-p", "--model", "haiku"], { cwd: tmpdir(), shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", errOut = "";
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdin.on("error", () => {}); child.stdin.end(prompt);
    child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (errOut += d));
    child.on("error", (e) => { errOut += e.message; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) Object.assign(entry, { status: "done", text: out.trim().slice(0, 1500) });
      else { Object.assign(entry, { status: "failed", text: problem("Claude couldn't write the plain summary.", "Read the original message below instead. If it keeps failing, check Claude Code is signed in (in PowerShell run claude --version).", errOut) }); setTimeout(() => summaries.delete(id), 60000); }
    });
  }
  return { id, ...summaries.get(id) };
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
  // Start a deploy workflow on GitHub ("Run workflow", workflow_dispatch) for the project: staging, production or end-to-end.
  const dk = req.method === "POST" && req.url.startsWith("/deploy/") ? decodeURIComponent(req.url.slice(8)) : "";
  if (byKey(dk)?.repo) {
    if (!ownPage(req)) { fail(res, 403, ...NOT_OWN_PAGE); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
    const stage = String(body.stage), repo = `${OWNER}/${byKey(dk).repo}`;
    const pick = { staging: (n) => /staging/i.test(n) && !/end-to-end|e2e/i.test(n), production: (n) => /production/i.test(n) && !/end-to-end|e2e/i.test(n), e2e: (n) => /end-to-end|e2e/i.test(n) }[stage];
    const label = { staging: "Staging", production: "Production", e2e: "End-to-End" }[stage];
    if (!pick) { fail(res, 400, "The dashboard sent an unknown deployment type.", "Click Refresh now and try again."); return; }
    const ghx = (...a) => new Promise((resolve, reject) => execFile("gh", a, { windowsHide: true, timeout: 60000 }, (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out.trim()))));
    try {
      const wfs = JSON.parse(await ghx("workflow", "list", "-R", repo, "--json", "id,name,state"));
      const wf = wfs.find((w) => w.state === "active" && pick(w.name));
      if (!wf) { fail(res, 404, `${byKey(dk).key} has no ${label} deployment workflow on GitHub.`, "Nothing to start. Ask Claude in that project to create the standard workflows (the /bwe-create-workflows skill)."); return; }
      const branch = await ghx("repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name");
      const run = (...extra) => ghx("workflow", "run", String(wf.id), "-R", repo, "--ref", branch || "main", ...extra);
      // Production and End-to-End workflows can require a typed "release" confirmation input. The dashboard has already asked you
      // to confirm in its own dialog, so it supplies that input when GitHub says it is required.
      try { await run(); }
      catch (e) { if (/Required input 'confirm' not provided/i.test(e.message)) await run("-f", "confirm=release"); else throw e; }
      res.writeHead(200, cors).end(wf.name);
    } catch (e) {
      const m = String(e.message);
      if (/workflow_dispatch/i.test(m)) fail(res, 500, `GitHub can't start the "${label}" workflow by hand, because it has no manual trigger.`, `Ask Claude in ${byKey(dk).key} to add "workflow_dispatch:" under "on:" in that workflow file, deploy that change, then try again.`, m);
      else if (/auth|login|401|403|admin rights|resource not accessible/i.test(m)) fail(res, 500, "GitHub didn't let the dashboard start the workflow, because the gh tool isn't signed in or can't run workflows here.", "In PowerShell run: gh auth login (or gh auth refresh -s workflow), then try again.", m);
      else fail(res, 500, `The ${label} deployment wasn't started.`, "Check the internet connection and try again. If it keeps failing, start it on GitHub from the repo's Actions tab.", m);
    }
    return;
  }
  // Close an open pull request (without merging it; the branch is left alone) or an issue. Asked for by the user's button press.
  const ck = req.method === "POST" && req.url.startsWith("/gh-close/") ? decodeURIComponent(req.url.slice(10)) : "";
  if (byKey(ck)?.repo) {
    if (!ownPage(req)) { fail(res, 403, ...NOT_OWN_PAGE); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
    const num = Number(body.number), kind = body.kind === "issue" ? "issue" : "pr", noun = kind === "issue" ? "issue" : "pull request";
    if (!Number.isInteger(num) || num < 1) { fail(res, 400, `The dashboard didn't say which ${noun} to close.`, "Click Refresh now and try again."); return; }
    execFile("gh", [kind, "close", String(num), "-R", `${OWNER}/${byKey(ck).repo}`], { windowsHide: true }, (err, out, errOut) => {
      const m = String(errOut || err?.message || "");
      if (err && !/already closed/i.test(m)) {
        if (/auth|login|401|403/i.test(m)) fail(res, 500, `GitHub didn't let the dashboard close the ${noun} because the gh tool isn't signed in.`, "In PowerShell run: gh auth login, sign in, then try again.", m);
        else fail(res, 500, `The ${noun} wasn't closed.`, "Check the internet connection and try again. If it keeps failing, close it on GitHub with its Open on GitHub button.", m);
        return;
      }
      res.writeHead(200, cors).end("closed");
    });
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
        try { out.push(await withOrigin(dir, byKey(gk2), () => git(dir, "pull", "--rebase"))); }
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
        out.push(await withOrigin(dir, byKey(gk2), () => upstream ? git(dir, "push") : git(dir, "push", "-u", "origin", "HEAD")));
      }
      res.writeHead(200, cors).end(out.join("\n").trim() || "done"); // the page asks for the rebuild, so it can show that step
    } catch (e) { res.writeHead(500, cors).end(/\nWhat to do: /.test(e.message) ? e.message : explainGit(e.message, dir)); }
    return;
  }
  if (req.method === "POST" && req.url === "/summary") {
    if (!ownPage(req)) { fail(res, 403, ...NOT_OWN_PAGE); return; }
    let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
    const text = String(body.text || "").trim();
    if (!text) { fail(res, 400, "There was no message to summarise.", "Reload the page and try again."); return; }
    res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(summarize(text)));
    return;
  }
  // Starts collecting (or queues it behind the run in progress) and answers at once with the run that will have the
  // fresh data; the page then follows /progress.
  if (req.method === "POST" && req.url === "/refresh") {
    const busy = !!current;
    build().catch(() => {});
    res.writeHead(200, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify({ run: busy ? progress.run + 1 : progress.run }));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/progress")) {
    const since = Number(new URL(req.url, "http://x").searchParams.get("since")) || 0;
    const { projects, search, ...rest } = progress;
    res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" })
      .end(JSON.stringify({ ...rest, queued: !!queued, projects: Object.values(projects).filter((p) => p.seq > since), search: search && search.seq > since ? search : null }));
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(blankPage());
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
  // The page opens straight away and fills in each project as its data arrives.
  build().then(() => console.log("Data collected."), (e) => console.log("Collecting data failed:", e.message));
  if (process.argv.includes("--open")) open();
});

function open() { execFile("cmd", ["/c", "start", "", `http://127.0.0.1:${PORT}`]); }
