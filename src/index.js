import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { scanSessions } from "./scanner.js";
import { startServer } from "./server.js";
import { startPiPush } from "./push.js";

/**
 * Exit when anything under `src/` changes, so launchd's `KeepAlive=true` brings
 * the daemon back on the new code — exiting IS the reload.
 *
 * Node caches ES modules for the life of the process, so an edited file simply
 * never takes effect until a restart. That has bitten once already: the daemon
 * ran pre-`cd04b4e` code for a day, omitted the whole `agents` field, and the
 * Pi — which degrades gracefully by design — showed an empty Subagents column
 * that read as a rendering bug.
 *
 * Armed only when AM_RELOAD_ON_CHANGE is set, so a hand-run `node src/index.js`
 * doesn't quit on save with nothing around to restart it.
 */
function watchForReload() {
  if (!process.env.AM_RELOAD_ON_CHANGE) return;
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  let pending = null;
  try {
    fs.watch(srcDir, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith(".js")) return;
      // Editors fire several events per save; take the last one.
      clearTimeout(pending);
      pending = setTimeout(() => {
        console.log(`[reload] ${filename} changed — exiting for launchd to restart`);
        process.exit(0);
      }, 200);
    });
    console.log(`[reload] watching ${srcDir} (launchd throttles the respawn to ~10s)`);
  } catch (err) {
    console.error(`[reload] watch unavailable (${err.message}); restart by hand after edits`);
  }
}

let snapshot = null;
let scanning = false;

async function refresh() {
  if (scanning) return;
  scanning = true;
  try {
    snapshot = await scanSessions();
  } catch (err) {
    console.error(`[scan] ${err.message}`);
  } finally {
    scanning = false;
  }
}

await refresh();
setInterval(refresh, 2000);

startServer(() => snapshot);
startPiPush(() => snapshot);
watchForReload();

console.log(
  `[agentmanager] watching ${config.sessionStoreDir} (${snapshot?.sessions.length ?? 0} sessions on the board)`,
);
