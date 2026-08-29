import { config } from "./config.js";
import { scanSessions } from "./scanner.js";
import { startServer } from "./server.js";
import { startPiPush } from "./push.js";

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

console.log(
  `[agentmanager] watching ${config.sessionStoreDir} (${snapshot?.sessions.length ?? 0} sessions on the board)`,
);
