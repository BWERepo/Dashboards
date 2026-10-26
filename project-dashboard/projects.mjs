// Shared by build.mjs and serve.mjs: the projects on the dashboard and where their Claude Code sessions live.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OWNER = "BWERepo";
// cmd = the project's Checkpoint skill (staging + production release, commit, push), when it has one.
export const PROJECTS = [
  { key: "BWE", name: "Business Web Express", dir: "Z:/Backup/Websites/BusinessWebExpress", repo: "BWE", cmd: "/BWECheckpoint" },
  { key: "BWE_HDBS", name: "Handmade Designs By Suzi", dir: "Z:/Backup/Websites/HandmadeDesignsBySuzi", repo: "HDBS", cmd: "/BWEHDBSCheckpoint" },
  { key: "BWE_OneClickAnswers", name: "One Click Answers", dir: "Z:/Backup/websites/OneClickAnswers", repo: "OneClickAnswers", cmd: "/BWEOCACheckpoint" },
  { key: "BWE_JKClassicBuggies", name: "JK Classic Buggies V2", dir: "Z:/Backup/websites/JKClassicBuggiesV2", repo: "JKClassicBuggiesV2", cmd: "/BWEJKCBCheckpoint" },
  { key: "BWE_BlogEngine", name: "Blog Engine", dir: "Z:/Backup/websites/BlogEngine", repo: "BlogEngine" },
  { key: "BWE_SEOEngine", name: "SEO Engine", dir: "Z:/Backup/websites/SEOEngine", repo: "SEOEngine" },
  { key: "BWE_FAQEngine", name: "FAQ Engine", dir: "Z:/Backup/websites/FAQEngine", repo: "FAQEngine" },
  { key: "BWE_ClaudeSkills", name: "Claude Skills", dir: "Z:/Backup/websites/ClaudeSkills", repo: "ClaudeSkills" },
  { key: "BWE_Dashboards", name: "Dashboards", dir: "Z:/Backup/websites/Dashboards", repo: "Dashboards" },
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
      title: (title || firstUser?.text || "Session").split("\n")[0].slice(0, 140),
      updatedAt: new Date(f.mtime).toISOString(),
      total: msgs.length,
      messages: shown,
      // Only a recent session that ended on a question counts as waiting on the user.
      asking: !!last && last.role === "claude" && Date.now() - f.mtime < 3 * 864e5 && asksUser(last.text),
    };
  });
}
