// Local-only server for the dashboard: serves index.html and rebuilds it on POST /refresh.
// Usage: node dashboard/serve.mjs [--open]   (http://127.0.0.1:8787)
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
const build = () => new Promise((resolve, reject) =>
  execFile("node", [join(here, "build.mjs")], { cwd: here }, (err, out, errOut) => (err ? reject(new Error(errOut || err.message)) : resolve(out))));

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/refresh") {
    try { await build(); res.writeHead(200).end("ok"); }
    catch (e) { res.writeHead(500).end(String(e.message).slice(0, 500)); }
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
