/**
 * @hitzhangjie/dsh-plugin-session-delete — host half.
 *
 * DeepSeek Harness ships archive only: an archived session stays on disk
 * forever. This plugin adds the missing operation — a real, irreversible
 * delete — and exposes it to the browser half over one loopback HTTP route,
 * because a profile plugin has no `harness.handle` / `host.call` channel
 * (that belongs to dynamic sandbox packages).
 *
 * What one delete does, in order:
 *   1. validate the session id and refuse an unknown session (`not-found`)
 *   2. refuse a session that has forked children (`has-children`), whose
 *      durable headers would otherwise name a missing parent
 *   3. stop running work through the archive `stopActivity` waterfall, whose
 *      durable archive set gates every wake the stops induce
 *   4. let the stopped writer settle (final turn/end checkpoint and the
 *      projection-cache write-behind), then drain its write handle
 *   5. detach the live store entry, when the store exposes one
 *   6. detach workspace accounting (`Workspace.detachSession`)
 *   7. remove the event-log directory, the projection-cache entry and the
 *      session's spill directories, with a short retry loop
 *   8. drop the id from the archive and pin sets
 *   9. tell connected clients the row is gone (`api-session/removed`)
 *
 * A file still held by a live writer is journaled and reaped on the next
 * start, when every session is cold.
 *
 * Verified against DeepSeek Harness desktop 0.2.0-rc.2: the JSONL storage
 * layout `<root>/<projectKey>/<sessionId>/session.v4.jsonl.zstd`, the
 * projection cache at `<home>/storages/session_projcache/sessions/<id>.json`,
 * and the `sessionPersistence` / `workspaceRegistry` / `sessions` services.
 */
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";

/** Host services this plugin reaches through the Cordis context. */
const inject = ["webServer", "workspaceRegistry", "sessionPersistence", "sessions"];

/** Loopback route the browser half calls. Exact routes win over the app's
 * `/api` prefix route in `webServer.match()`, so this path never reaches the
 * app's own admission layer — this handler owns its guard below. */
const ROUTE_PATH = "/api/hitzhangjie/session-delete";

/** Pending-deletion journal under the harness home. */
const PENDING_FILE = "session-delete.pending.json";

/** Quiet window after `stopActivity` before the first removal attempt. */
const QUIET_AFTER_STOP_MS = 1200;
/** Removal attempts, to outlast a writer's last flush recreating the log. */
const REMOVAL_ATTEMPTS = 4;
const REMOVAL_RETRY_DELAY_MS = 900;

const BODY_LIMIT_BYTES = 64 * 1024;

/** Hostnames a loopback web surface may legitimately use. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Session ids and session uuids are safe path segments. */
const SESSION_ID_RE = /^[A-Za-z0-9._~-]{1,200}$/;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Encode one path segment exactly like `@deepseek-ai/dsh-session-persistence-jsonl`:
 * safe characters pass through, everything else becomes `~XXXX`.
 * @param value - raw path segment.
 * @returns the encoded segment.
 */
function encodeSegment(value) {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character !== "~" && /^[A-Za-z0-9._-]$/.test(character)) out += character;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * Build the readable project directory key exactly like the JSONL backend:
 * `\`, `/` and `:` collapse to one `-`, unsafe code units become `~XXXX`, the
 * result is trimmed, bounded to 251 characters, and wrapped in `--…--`.
 * @param cwd - the session's working directory.
 * @returns the project directory name.
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const character = String.fromCharCode(code);
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && /^[A-Za-z0-9._-]$/.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * Resolve the harness home: `$DSH_HOME` (with `~/` and `~\` expansion), then
 * `~/.dsh` — the precedence the harness itself uses.
 * @returns absolute harness home.
 */
function dshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === "string" && configured.trim().length > 0) {
    if (configured === "~") return resolve(homedir());
    if (configured.startsWith("~/") || configured.startsWith("~\\")) return resolve(join(homedir(), configured.slice(2)));
    return resolve(configured);
  }
  return resolve(join(homedir(), ".dsh"));
}

/** Absolute path of the pending-deletion journal. */
function pendingPath() {
  return join(dshHome(), "plugins", PENDING_FILE);
}

/**
 * Resolve the on-disk session root: the mounted backend's configured `root`
 * when it exposes one, else `<home>/sessions`.
 * @param ctx - host context.
 * @param home - resolved harness home.
 * @returns absolute session root.
 */
function sessionRoot(ctx, home) {
  const configured = ctx.sessionPersistence?.root;
  return typeof configured === "string" && configured.length > 0 ? configured : join(home, "sessions");
}

// --- pending-deletion journal ---------------------------------------------

async function readPending() {
  try {
    const parsed = JSON.parse(await readFile(pendingPath(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function writePending(ids) {
  try {
    const file = pendingPath();
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, `${JSON.stringify(ids, void 0, 2)}\n`, "utf8");
  } catch {
    /* best effort: the journal only accelerates a later cleanup */
  }
}

async function addPending(sessionId) {
  const ids = await readPending();
  if (ids.includes(sessionId)) return;
  await writePending([...ids, sessionId]);
}

async function removePending(sessionId) {
  const ids = await readPending();
  if (!ids.includes(sessionId)) return;
  await writePending(ids.filter((id) => id !== sessionId));
}

/**
 * Reap journaled sessions on plugin start: after a restart every session is
 * cold, so removal cannot be undone by a live writer.
 * @param ctx - host context.
 */
async function reapPending(ctx) {
  const ids = await readPending();
  if (ids.length === 0) return;
  const home = dshHome();
  const root = sessionRoot(ctx, home);
  for (const id of ids) {
    if (!SESSION_ID_RE.test(id)) {
      await removePending(id);
      continue;
    }
    try {
      for (const projectName of await readdir(root).catch(() => [])) {
        const candidate = join(root, projectName, id);
        try {
          await stat(candidate);
          await rm(candidate, { recursive: true, force: true });
        } catch {
          /* absent */
        }
      }
      await rm(join(home, "storages", "session_projcache", "sessions", `${id}.json`), { force: true });
      await removePending(id);
      ctx.logger?.info?.(`[session-delete] reaped pending session "${id}"`);
    } catch (error) {
      ctx.logger?.warn?.(`[session-delete] failed to reap "${id}": ${messageOf(error)}`);
    }
  }
}

// --- deletion --------------------------------------------------------------

/**
 * Every on-disk directory that may hold this session's event log. The precise
 * path comes from the header's cwd; the scan covers a relocated root or a
 * header whose cwd no longer encodes to the same directory.
 */
async function sessionDirectories(root, cwd, sessionId) {
  const directories = new Set();
  if (typeof cwd === "string" && cwd.length > 0) {
    try {
      directories.add(join(root, projectKey(cwd), sessionId));
    } catch {
      /* unencodable cwd: the scan below still finds the directory */
    }
  }
  for (const projectName of await readdir(root).catch(() => [])) {
    directories.add(join(root, projectName, sessionId));
  }
  return [...directories];
}

/**
 * Permanently delete one session.
 * @param ctx - host context.
 * @param sessionId - the session to delete.
 * @returns `{ ok: true }` or a structured refusal.
 */
async function deleteSession(ctx, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return { ok: false, reason: "invalid-id" };

  const persistence = ctx.sessionPersistence;
  const registry = ctx.workspaceRegistry;

  // 1. Existence and the canonical cwd (the header carries it).
  let header;
  try {
    header = (await persistence.stat(sessionId))?.header;
  } catch {
    header = void 0;
  }
  const live = ctx.sessions.get(sessionId);
  if (header === void 0) {
    try {
      header = await registry.readSessionHeader(sessionId);
    } catch {
      header = void 0;
    }
  }
  if (header === void 0 && live === void 0) return { ok: false, reason: "not-found" };

  // 2. Refuse a session with fork children: every child header names it as
  //    `parentSession`, and removing the parent would orphan that lineage.
  //    A failed listing refuses the delete instead of assuming "no children".
  let snapshots;
  try {
    snapshots = await persistence.list();
  } catch (error) {
    return { ok: false, reason: "list-failed", message: messageOf(error) };
  }
  const children = snapshots
    .filter((snapshot) => snapshot?.header?.parentSession === sessionId)
    .map((snapshot) => snapshot.header.id);
  if (children.length > 0) return { ok: false, reason: "has-children", children: children.slice(0, 10) };

  // 3. Stop running work. The archive writes its durable set first and then
  //    asks every provider to stop, so no stop can trigger a fresh wake.
  try {
    await registry.archiveSession(sessionId, { stopActivity: true });
  } catch (error) {
    ctx.logger?.warn?.(`[session-delete] archive/stop "${sessionId}": ${messageOf(error)}`);
  }

  // 4. Let the stopped session settle, then drain its write handle: the final
  //    turn/end checkpoint and the projection-cache write-behind would
  //    otherwise recreate the files right after their removal.
  await sleep(QUIET_AFTER_STOP_MS);
  if (live !== void 0) {
    try {
      await persistence.flush?.();
    } catch (error) {
      ctx.logger?.warn?.(`[session-delete] flush "${sessionId}": ${messageOf(error)}`);
    }
  }

  // 5. Release a live store entry when the store exposes one. Harmless when
  //    it does not: the durable removal below is what makes the delete real.
  try {
    ctx.sessions.store?.get?.(sessionId)?.detach?.();
  } catch (error) {
    ctx.logger?.warn?.(`[session-delete] store detach "${sessionId}": ${messageOf(error)}`);
  }

  // 6. Workspace accounting.
  const cwd = header?.cwd;
  try {
    if (typeof cwd === "string" && cwd.length > 0) {
      const workspace = await registry.resolveByPath(cwd);
      if (workspace !== void 0) await workspace.detachSession(sessionId);
    }
  } catch (error) {
    ctx.logger?.warn?.(`[session-delete] detach "${sessionId}": ${messageOf(error)}`);
  }

  // 7. Physical removal with a retry loop.
  const home = dshHome();
  const root = sessionRoot(ctx, home);
  const projectionCache = join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
  const spillHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 12);

  const removeOnce = async (directories) => {
    for (const directory of directories) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        /* retried below */
      }
    }
    try {
      await rm(projectionCache, { force: true });
    } catch {
      /* retried below */
    }
    try {
      for (const name of await readdir(tmpdir())) {
        if (/^dsh-spill-[A-Za-z0-9]{6}$/.test(name)) {
          await rm(join(tmpdir(), name, `session-${spillHash}`), { recursive: true, force: true });
        }
      }
    } catch {
      /* best effort: the OS sweeps spill roots too */
    }
  };

  const gone = async (directories) => {
    for (const directory of directories) {
      try {
        await stat(directory);
        return false;
      } catch {
        /* absent */
      }
    }
    try {
      await stat(projectionCache);
      return false;
    } catch {
      return true;
    }
  };

  let removed = false;
  for (let attempt = 0; attempt < REMOVAL_ATTEMPTS; attempt += 1) {
    const directories = await sessionDirectories(root, cwd, sessionId);
    await removeOnce(directories);
    if (await gone(directories)) {
      removed = true;
      break;
    }
    if (attempt < REMOVAL_ATTEMPTS - 1) await sleep(REMOVAL_RETRY_DELAY_MS);
  }

  // 8. Registry-global sets: leave no id behind.
  try {
    if (registry.archivedSessionIds.includes(sessionId)) await registry.unarchiveSession(sessionId);
  } catch {
    /* best effort */
  }
  try {
    if (registry.pinnedSessionIds.includes(sessionId)) await registry.unpinSession(sessionId);
  } catch {
    /* best effort */
  }

  // 9. Tell connected clients to drop the row. `api-session/removed` is the
  //    declared client-facing relay of session disposal, so a live row goes
  //    away at once; the client also re-pulls the list for cold sessions.
  try {
    ctx.emit("api-session/removed", sessionId);
  } catch {
    /* best effort: the client refresh below covers the row anyway */
  }

  if (removed) {
    await removePending(sessionId);
    return { ok: true };
  }
  await addPending(sessionId);
  return { ok: true, deferred: true };
}

// --- HTTP surface ----------------------------------------------------------

/**
 * Guard the loopback endpoint. A same-origin browser call carries
 * `Sec-Fetch-Site: same-origin` and an `Origin` naming this server; a foreign
 * page carries its own origin, which is refused. A non-browser local client
 * (no Origin, no Sec-Fetch-Site) is accepted, guarded by the loopback bind.
 * @param req - incoming request.
 * @param ctx - host context (for the listening port).
 * @returns whether the request may delete a session.
 */
function requestAllowed(req, ctx) {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string" && site.length > 0 && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
    const port = ctx.webServer?.port;
    if (typeof port === "number" && port > 0 && parsed.port !== "" && Number(parsed.port) !== port) return false;
  }
  return true;
}

function readBody(req, limit = BODY_LIMIT_BYTES) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

function apply(ctx) {
  void reapPending(ctx);

  const disposeRoute = ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
        return;
      }
      if (!requestAllowed(req, ctx)) {
        sendJson(res, 403, { ok: false, reason: "forbidden" });
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        sendJson(res, 413, { ok: false, reason: "bad-request", message: messageOf(error) });
        return;
      }
      let sessionId;
      try {
        sessionId = JSON.parse(body || "{}").sessionId;
      } catch {
        sendJson(res, 400, { ok: false, reason: "bad-request" });
        return;
      }
      let result;
      try {
        result = await deleteSession(ctx, sessionId);
      } catch (error) {
        ctx.logger?.warn?.(`[session-delete] "${String(sessionId)}": ${messageOf(error)}`);
        sendJson(res, 500, { ok: false, reason: "internal-error", message: messageOf(error) });
        return;
      }
      sendJson(res, result.ok ? 200 : 409, result);
    }
  });

  ctx.effect?.(() => disposeRoute, "hitzhangjie-session-delete: HTTP route");
}

export { apply, inject };
