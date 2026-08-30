import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { config } from "./config.js";

const execFileP = promisify(execFile);

const LOCAL_ID = /^local_[0-9a-f-]{36}$/;

/**
 * The two ways to reach a session, and why they differ.
 *
 * Both land in the SAME place. `claudeURLHandler` switches on the URL's host,
 * not its pathname, so neither one is "special-cased" against the other — they
 * reach one session handler that ends in the app's `navigateTo`:
 *
 *     const d = dispatchers.get(win.webContents);
 *     if (d && !coldStart) { d.dispatchNavigate(route); return; }  // no page load
 *     win.webContents.loadURL(...)                                 // full reload
 *
 * Which branch runs is decided by an internal per-webContents dispatcher that a
 * URL cannot conjure, and in practice the session route lands on `loadURL` —
 * confirmed by `Loaded https://claude.ai (web commit …)` appearing in
 * ~/Library/Logs/Claude/main.log on every focus. That reload reboots the
 * renderer every torn-off window is registered against, which is why they die.
 *
 * **There is therefore no URL that focuses a session without costing popouts.**
 * That is what `protectPopouts` in `focusSession` exists to work around; don't
 * go hunting for a better path here.
 *
 * HARD reaches the session. SOFT does not: on 1.24012.9 it is accepted (no
 * `unrecognized code path` warning, which a bare `/local_<id>` does produce) but
 * the window never changes session and the target's `lastFocusedAt` never
 * updates — a silent no-op, which is worse than the reload.
 *
 * So HARD is the default. The builder and the knob stay because this routing is
 * version-coupled — if a later build starts honouring the route,
 * `AM_FOCUS_LINK=soft` is the whole switch.
 */
const hardURL = (id) => `claude://claude.ai/claude-code-desktop/${id}`;
const softURL = (id) => `claude://claude.ai/epitaxy/${id}`;

/**
 * Claude's window names, in window order. Empty when the app isn't up or the
 * accessibility bridge refuses us.
 *
 * Listed rather than matched inside AppleScript so the comparison happens in JS:
 * no quoting of arbitrary session titles into an osascript literal, and the list
 * itself is the diagnostic when a match doesn't happen.
 */
async function claudeWindowNames() {
  const script = `
    tell application "System Events"
      if not (exists process "Claude") then return ""
      tell process "Claude"
        set AppleScript's text item delimiters to linefeed
        return (name of every window) as text
      end tell
    end tell`;
  const { stdout } = await execFileP("osascript", ["-e", script]);
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** The main window's title; every other window is a torn-off session. */
const MAIN_WINDOW = "Claude";

/**
 * Bring window `index` (1-based, in Claude's own window order) to the front.
 *
 * Raised by INDEX so no session title is ever interpolated into AppleScript.
 */
async function raiseWindow(index, title) {
  try {
    await execFileP("osascript", [
      "-e",
      `tell application "System Events" to tell process "Claude" to perform action "AXRaise" of window ${index}`,
    ]);
    console.log(`[focus] raised existing window for ${JSON.stringify(title)}`);
    return true;
  } catch (err) {
    console.error(`[focus] AXRaise failed for ${JSON.stringify(title)}: ${err.message.split("\n")[0]}`);
    return false;
  }
}

/**
 * Whether Claude.app is up right now.
 *
 * Note `pgrep -x Claude` does NOT match this process — don't reach for it.
 */
async function claudeIsRunning() {
  try {
    const { stdout } = await execFileP("osascript", [
      "-e",
      'application "Claude" is running',
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Bring Claude.app to the front and navigate it to the given desktop session.
 *
 * Fire-and-forget, as before: the app reports nothing back either way.
 */
export async function focusSession(localSessionId, title = null) {
  if (!LOCAL_ID.test(localSessionId)) {
    throw new Error(`invalid session id: ${localSessionId}`);
  }
  await execFileP("osascript", ["-e", 'tell application "Claude" to activate']);

  // One window query drives both decisions below.
  let windows = [];
  try {
    windows = await claudeWindowNames();
  } catch (err) {
    // Almost always the Accessibility permission: this runs under launchd, so
    // it is a DIFFERENT TCC subject from whatever shell you tested in. Logged
    // loudly rather than swallowed — silence here is indistinguishable from
    // "nothing is torn off", and sends the tap down the deep link, which is the
    // thing that closes the windows we are trying to protect.
    console.error(
      `[focus] cannot read Claude's windows (${err.message.split("\n")[0]}); ` +
        "grant Accessibility to the AgentManager LaunchAgent's node binary in " +
        "System Settings > Privacy & Security > Accessibility, or torn-off " +
        "windows will keep closing on tap",
    );
  }

  // Already torn off? Raise that window and stop. Deep-linking the main window
  // to it would make the main window reclaim the session and close the popout.
  const index = windows.findIndex((n) => n === title);
  if (index !== -1 && (await raiseWindow(index + 1, title))) return;

  // Not torn off, but something else is. A session deep link reboots the
  // renderer that every popout is registered against, so following it here
  // would destroy windows the user deliberately tore off — to switch anyway,
  // set AM_PROTECT_POPOUTS=0.
  const popouts = windows.filter((n) => n !== MAIN_WINDOW);
  if (config.protectPopouts && popouts.length > 0) {
    console.log(
      `[focus] not switching to ${JSON.stringify(title ?? localSessionId)}: ` +
        `${popouts.length} torn-off window(s) open (${popouts.join(", ")}) and the ` +
        "deep link would close them. Claude is frontmost; AM_PROTECT_POPOUTS=0 to switch anyway",
    );
    return;
  }

  // The cold-start fallback is load-bearing, not belt-and-braces: on a cold
  // launch the soft link dispatches into a renderer that does not exist yet and
  // is silently dropped, whereas the hard link works — and a just-launched app
  // has no popouts to protect anyway.
  const soft = config.focusLink === "soft" && (await claudeIsRunning());
  await execFileP("open", [soft ? softURL(localSessionId) : hardURL(localSessionId)]);
}
