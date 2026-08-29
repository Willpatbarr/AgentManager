import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const LOCAL_ID = /^local_[0-9a-f-]{36}$/;

/**
 * Bring Claude.app to the front and navigate it to the given desktop session.
 * The claude://claude.ai/claude-code-desktop/<id> deep link resolves to the
 * session's route (the app redirects it to /epitaxy/<id> internally).
 */
export async function focusSession(localSessionId) {
  if (!LOCAL_ID.test(localSessionId)) {
    throw new Error(`invalid session id: ${localSessionId}`);
  }
  await execFileP("osascript", ["-e", 'tell application "Claude" to activate']);
  await execFileP("open", [`claude://claude.ai/claude-code-desktop/${localSessionId}`]);
}
