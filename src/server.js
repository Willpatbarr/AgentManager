import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { focusSession } from "./focus.js";

const FOCUS_PATH = /^\/api\/focus\/(local_[0-9a-f-]{36})$/;

export function startServer(getSnapshot) {
  const indexHtml = path.join(config.repoRoot, "public", "index.html");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
      } else if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(fs.readFileSync(indexHtml));
      } else if (req.method === "GET" && url.pathname === "/api/sessions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(getSnapshot() ?? { updatedAt: 0, sessions: [] }));
      } else if (req.method === "GET" && url.pathname === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else if (req.method === "POST" && FOCUS_PATH.test(url.pathname)) {
        const id = url.pathname.match(FOCUS_PATH)[1];
        await focusSession(id);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, focused: id }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(config.port, () => {
    console.log(`[server] dashboard at http://localhost:${config.port}`);
  });
  return server;
}
