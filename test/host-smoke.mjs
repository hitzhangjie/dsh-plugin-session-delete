/**
 * Host-half smoke test for @hitzhangjie/dsh-plugin-session-delete.
 *
 * Runs the plugin against a stub Cordis context and a temporary harness home:
 * no harness, no running app, and no real session is touched. It pins the
 * behavior the plugin promises — the files actually disappear, running work is
 * stopped first, a session with forked children is refused, and the request
 * guards hold.
 *
 * Run: node test/host-smoke.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SESSION_ID = "session-11111111-2222-3333-4444-555555555555";
const CHILD_ID = "session-99999999-8888-7777-6666-555555555555";
const CWD = process.platform === "win32" ? "C:\\work\\demo" : "/work/demo";
const PROJECT_KEY = process.platform === "win32" ? "--C-work-demo--" : "--work-demo--";

const home = await mkdtemp(join(tmpdir(), "dsh-delete-test-"));
process.env.DSH_HOME = home;

const spills = [];

/** Build one stub host context over the temporary home. */
function makeContext({ children = [], exists = true, live = false } = {}) {
  const calls = { archive: [], unarchive: [], unpin: [], detach: [], events: [] };
  const sessionDir = join(home, "sessions", PROJECT_KEY, SESSION_ID);
  const projectionCache = join(home, "storages", "session_projcache", "sessions", `${SESSION_ID}.json`);

  const persistence = {
    root: join(home, "sessions"),
    async stat(id) {
      return exists && id === SESSION_ID ? { header: { id, cwd: CWD } } : void 0;
    },
    async list() {
      const rows = exists ? [{ header: { id: SESSION_ID, cwd: CWD } }] : [];
      return [...rows, ...children.map((id) => ({ header: { id, cwd: CWD, parentSession: SESSION_ID } }))];
    },
    async flush() {
      calls.flushed = true;
    }
  };

  const workspaceRegistry = {
    archivedSessionIds: [SESSION_ID],
    pinnedSessionIds: [SESSION_ID],
    async archiveSession(id, options) {
      calls.archive.push({ id, options });
    },
    async unarchiveSession(id) {
      calls.unarchive.push(id);
    },
    async unpinSession(id) {
      calls.unpin.push(id);
    },
    async readSessionHeader() {
      return exists ? { id: SESSION_ID, cwd: CWD } : void 0;
    },
    async resolveByPath() {
      return {
        async detachSession(id) {
          calls.detach.push(id);
        }
      };
    }
  };

  const ctx = {
    webServer: {
      port: 19387,
      register(route) {
        calls.route = route;
        return () => void 0;
      }
    },
    workspaceRegistry,
    sessionPersistence: persistence,
    sessions: { get: () => (live ? { id: SESSION_ID } : void 0) },
    logger: { warn: () => void 0, info: () => void 0 },
    emit: (name, payload) => calls.events.push([name, payload]),
    effect: (fn) => {
      fn();
    }
  };

  return { ctx, calls, sessionDir, projectionCache };
}

function fakeRequest({ method = "POST", headers = {}, body = "" } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.headers = headers;
  request.destroy = () => void 0;
  setImmediate(() => {
    if (body.length > 0) request.emit("data", Buffer.from(body, "utf8"));
    request.emit("end");
  });
  return request;
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: void 0,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(text) {
      this.body = text;
      this.done = true;
    }
  };
}

/** Invoke the registered route once and return the parsed response. */
async function call(route, options) {
  const response = fakeResponse();
  await route.handler(fakeRequest(options), response);
  let json = null;
  try {
    json = JSON.parse(response.body);
  } catch {
    json = null;
  }
  return { status: response.statusCode, json };
}

const SAME_ORIGIN = { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:19387" };

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

const { apply } = await import("../lib/index.js");

console.log(`harness home: ${home}`);

// --- guards ---------------------------------------------------------------

{
  const { ctx, calls } = makeContext();
  apply(ctx);
  const route = calls.route;
  assert.ok(route !== void 0, "apply() must register the route");
  assert.equal(route.kind, "exact");
  assert.equal(route.path, "/api/hitzhangjie/session-delete");

  await check("GET is refused with 405", async () => {
    const { status, json } = await call(route, { method: "GET", headers: SAME_ORIGIN });
    assert.equal(status, 405);
    assert.equal(json.reason, "method-not-allowed");
  });

  await check("cross-site request is refused with 403", async () => {
    const { status, json } = await call(route, {
      headers: { "sec-fetch-site": "cross-site", origin: "http://evil.example" },
      body: JSON.stringify({ sessionId: SESSION_ID })
    });
    assert.equal(status, 403);
    assert.equal(json.reason, "forbidden");
  });

  await check("foreign loopback port is refused with 403", async () => {
    const { status, json } = await call(route, {
      headers: { origin: "http://127.0.0.1:4999" },
      body: JSON.stringify({ sessionId: SESSION_ID })
    });
    assert.equal(status, 403);
    assert.equal(json.reason, "forbidden");
  });

  await check("path-traversal session id is refused with 409 invalid-id", async () => {
    const { status, json } = await call(route, { headers: SAME_ORIGIN, body: JSON.stringify({ sessionId: "../../etc" }) });
    assert.equal(status, 409);
    assert.equal(json.reason, "invalid-id");
  });

  await check("unknown session is refused with 409 not-found", async () => {
    const inner = makeContext({ exists: false });
    apply(inner.ctx);
    const { status, json } = await call(inner.calls.route, {
      headers: SAME_ORIGIN,
      body: JSON.stringify({ sessionId: SESSION_ID })
    });
    assert.equal(status, 409);
    assert.equal(json.reason, "not-found");
  });

  await check("malformed body is refused with 400 bad-request", async () => {
    const { status, json } = await call(route, { headers: SAME_ORIGIN, body: "{not json" });
    assert.equal(status, 400);
    assert.equal(json.reason, "bad-request");
  });
}

// --- fork children --------------------------------------------------------

await check("a session with forked children is refused and left on disk", async () => {
  const { ctx, calls } = makeContext({ children: [CHILD_ID] });
  apply(ctx);
  await mkdir(join(home, "sessions", PROJECT_KEY, SESSION_ID), { recursive: true });
  await writeFile(join(home, "sessions", PROJECT_KEY, SESSION_ID, "session.v4.jsonl.zstd"), "x");
  const { status, json } = await call(calls.route, { headers: SAME_ORIGIN, body: JSON.stringify({ sessionId: SESSION_ID }) });
  assert.equal(status, 409);
  assert.equal(json.reason, "has-children");
  assert.deepEqual(json.children, [CHILD_ID]);
  assert.equal(calls.archive.length, 0, "no stop is attempted for a refused delete");
  await stat(join(home, "sessions", PROJECT_KEY, SESSION_ID, "session.v4.jsonl.zstd"));
});

// --- the real delete ------------------------------------------------------

await check("a committed delete stops work and removes every storage surface", async () => {
  const { ctx, calls, sessionDir, projectionCache } = makeContext({ live: true });
  apply(ctx);

  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "session.v4.jsonl.zstd"), "payload");
  await mkdir(join(projectionCache, ".."), { recursive: true });
  await writeFile(projectionCache, "{}");

  const spillRoot = join(tmpdir(), "dsh-spill-abc123");
  const spillHash = createHash("sha256").update(SESSION_ID).digest("hex").slice(0, 12);
  const spillDir = join(spillRoot, `session-${spillHash}`);
  await mkdir(spillDir, { recursive: true });
  await writeFile(join(spillDir, "part"), "spill");
  spills.push(spillRoot);

  const { status, json } = await call(calls.route, { headers: SAME_ORIGIN, body: JSON.stringify({ sessionId: SESSION_ID }) });

  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.deferred, void 0, "no retry was needed");

  assert.deepEqual(calls.archive, [{ id: SESSION_ID, options: { stopActivity: true } }]);
  assert.equal(calls.flushed, true, "a live session is drained before removal");
  assert.deepEqual(calls.detach, [SESSION_ID]);
  assert.deepEqual(calls.unarchive, [SESSION_ID]);
  assert.deepEqual(calls.unpin, [SESSION_ID]);
  assert.deepEqual(calls.events, [["api-session/removed", SESSION_ID]]);

  await assert.rejects(stat(sessionDir), "the event-log directory is gone");
  await assert.rejects(stat(projectionCache), "the projection cache is gone");
  await assert.rejects(stat(spillDir), "the spill directory is gone");

  const pending = await readdir(join(home, "plugins")).catch(() => []);
  assert.equal(pending.length, 0, "nothing is journaled after a clean removal");
});

for (const spillRoot of spills) await rm(spillRoot, { recursive: true, force: true });
await rm(home, { recursive: true, force: true });

console.log(failures === 0 ? "\nall checks passed" : `\n${String(failures)} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
