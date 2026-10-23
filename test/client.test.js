// node --test. A fake `post` stands in for the hub: it answers JSON-RPC like FastMCP (stateless, json_response).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { LabClient, LabError, MAX_PROGRAM } = require("../dist/index.js");

const UNKNOWN = "Error executing tool x: Unknown or ended session: open another one with open_session.";
const NO_BROWSER = "Error executing tool x: No browser is connected to this session: open open_url in a browser.";
const bare = (text) => text.replace("Error executing tool x: ", ""); // LabError.message: the hub's text alone

// A tool answering {[RAW]: result} gets that MCP result as is (e.g. image contents, no structuredContent).
const RAW = Symbol("raw");
const PNG = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const JPEG = { type: "image", data: "/9j/4AAQ", mimeType: "image/jpeg" };
const withImage = (out, ...images) => ({ [RAW]: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }, ...images], isError: false } });

// An error a hub of contract 0.20 codes: the code goes in the tool result's _meta.
const coded = (text, code) => Object.assign(new Error(text), { code });

// tools: {name: (args) => result | throws Error(text), with a code when made by coded()}. sse: answer as an SSE stream. Returns post + calls.
function fakeHub(tools, { sse = false } = {}) {
  const calls = [];
  const post = async (url, body, headers) => {
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers.Accept, "application/json, text/event-stream");
    const req = JSON.parse(body);
    assert.equal(req.jsonrpc, "2.0");
    let result;
    if (req.method === "tools/list") {
      result = { tools: Object.keys(tools).map((name) => ({ name, description: `${name}.`, inputSchema: { type: "object" } })) };
    } else if (req.method === "tools/call") {
      const { name, arguments: args } = req.params;
      calls.push({ name, args });
      try {
        const out = await tools[name](args);
        const wrapped = out !== null && typeof out === "object" && !Array.isArray(out) ? out : { result: out };
        result = out?.[RAW] ?? { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }], structuredContent: wrapped };
      } catch (e) {
        result = { content: [{ type: "text", text: e.message }], isError: true, ...(e.code && { _meta: { "lab.picodev.fr/error": e.code } }) };
      }
    } else {
      return { status: 200, text: JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found" } }) };
    }
    const json = JSON.stringify({ jsonrpc: "2.0", id: req.id, result });
    return sse
      ? { status: 200, text: `event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\nevent: message\r\ndata: ${json}\r\n\r\n` }
      : { status: 200, text: json, headers: { "content-type": "application/json" } };
  };
  return { post, calls };
}

const opened = { session: "s1", agent_token: "t1", open_url: "https://lab/bench/a?s=s1#o=o1" };
const base = {
  list_setups: () => [{ id: "setup-a", modes: ["free"], benches: [] }],
  open_session: () => opened,
  close_session: () => ({ state: "ended" }),
  push_to_editor: () => "Code sent to the browser.",
  read_simulation: () => ({ state: { setup: "setup-a", mode: "challenge", level: 2, running: true }, compile: null, events: [] }),
  session_status: () => status,
};
const status = { setup: "setup-a", mode: "free", owner: true, visibility: "link", viewer_url: null, viewers: 0,
  created_at: 1, expires_at: 2, run: 3, level: null, levels: null, capture: null, queue: { state: "none" } };
const kind = (k, message) => (e) => e instanceof LabError && e.kind === k && (message === undefined || e.message === message);

test("transport: JSON body and SSE body, results unwrapped", async () => {
  for (const sse of [false, true]) {
    const hub = fakeHub(base, { sse });
    const c = new LabClient({ post: hub.post });
    assert.deepEqual(await c.list_setups(), [{ id: "setup-a", modes: ["free"], benches: [] }]); // FastMCP {result}
    assert.deepEqual(await c.open_session({ setup: "setup-a", mode: "free" }), opened);
    assert.equal(await c.push_to_editor({ files: [{ name: "a.ino", content: "" }] }), "Code sent to the browser.");
    assert.deepEqual(await c.tools(), Object.keys(base).map((name) => ({ name, description: `${name}.` })));
  }
});

test("list_setups: i18n passed through as the hub serves it", async () => {
  const setup = { id: "setup-a", title: "Feu", summary: "Un feu.", modes: ["free"], benches: [],
    i18n: { en: { title: "Light", summary: "A light." } } };
  const c = new LabClient({ post: fakeHub({ list_setups: () => [setup] }).post });
  assert.deepEqual(await c.list_setups(), [setup]);
});

test("transport: unreadable answers, JSON-RPC errors, a throwing post", async () => {
  const bad = (text, status = 200) => new LabClient({ post: async () => ({ status, text }) });
  await assert.rejects(bad("<html>502</html>", 502).list_setups(), kind("transport"));
  await assert.rejects(bad("").list_setups(), kind("transport"));
  await assert.rejects(bad('{"jsonrpc":"2.0","id":1}').list_setups(), kind("transport"));
  await assert.rejects(bad('{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}').list_setups(),
    kind("hub", "Method not found"));
  const down = new LabClient({ url: "http://x/mcp", post: async () => { throw new Error("ECONNREFUSED"); } });
  await assert.rejects(down.list_setups(), kind("transport", "http://x/mcp: ECONNREFUSED"));
});

test("limits: refused locally, no call", async () => {
  const hub = fakeHub(base);
  const c = new LabClient({ post: hub.post });
  await c.open_session({ setup: "setup-a", mode: "free" });
  const nine = Array.from({ length: 9 }, (_, i) => ({ name: `f${i}.ino`, content: "" }));
  await assert.rejects(c.push_to_editor({ files: nine }), kind("limit"));
  await assert.rejects(c.push_to_editor({ files: [] }), kind("limit"));
  // 64 KiB counted in UTF-8 bytes: 32 Ki two-byte chars + 1 byte is over.
  await assert.rejects(c.push_to_editor({ files: [{ name: "a.ino", content: "é".repeat(32 * 1024) + "x" }] }), kind("limit"));
  assert.deepEqual(hub.calls.map((x) => x.name), ["open_session"]);
  const max = Array.from({ length: 8 }, (_, i) => ({ name: `f${i}`, content: "x".repeat(8 * 1024) }));
  assert.equal(await c.push_to_editor({ files: max, run: false }), "Code sent to the browser.");
  assert.deepEqual(hub.calls.at(-1).args, { session: "s1", agent_token: "t1", files: max, run: false });
});

test("session: kept, filled in, forgotten on close and on gone, restorable", async () => {
  const hub = fakeHub({ ...base, queue_status: () => { throw new Error(UNKNOWN); } });
  const c = new LabClient({ post: hub.post });
  await assert.rejects(c.read_simulation(), kind("gone", "No session: call open_session first."));
  assert.equal(hub.calls.length, 0);
  assert.deepEqual(await c.open_session({ setup: "setup-a", mode: "free" }), opened);
  assert.deepEqual(c.session, opened);
  await c.read_simulation({ since_ms: 5 });
  assert.deepEqual(hub.calls.at(-1).args, { session: "s1", agent_token: "t1", since_ms: 5 });
  assert.deepEqual(await c.close_session(), { state: "ended" });
  assert.equal(c.session, null);
  c.session = opened; // restored by the host
  await assert.rejects(c.queue_status(), kind("gone", bare(UNKNOWN)));
  assert.equal(c.session, null);
});

test("hub errors: the kind from the _meta code, whatever the text; an unknown code is a hub error", async () => {
  const hub = fakeHub({
    ...base,
    push_to_editor: () => { throw coded("Le navigateur n'est plus là.", "no_browser"); },
    set_visibility: () => { throw coded("Unknown or ended session.", "rate"); },
    queue_status: () => { throw coded("Session partie.", "gone"); },
  });
  const c = new LabClient({ post: hub.post });
  await c.open_session({ setup: "setup-a", mode: "free" });
  await assert.rejects(c.push_to_editor({ files: [{ name: "a.ino", content: "" }] }), kind("no_browser", "Le navigateur n'est plus là."));
  await assert.rejects(c.set_visibility({ visibility: "link" }), kind("hub", "Unknown or ended session."));
  assert.deepEqual(c.session, opened);
  await assert.rejects(c.queue_status(), kind("gone", "Session partie."));
  assert.equal(c.session, null);
});

// No _meta: a hub older than contract 0.20, read by its text.
test("hub errors: their text, no_browser and hub kinds, the session kept", async () => {
  const hub = fakeHub({
    ...base,
    push_to_editor: () => { throw new Error(NO_BROWSER); },
    set_visibility: () => { throw new Error("visibility: private, link or public."); },
  });
  const c = new LabClient({ post: hub.post });
  await c.open_session({ setup: "setup-a", mode: "free" });
  await assert.rejects(c.push_to_editor({ files: [{ name: "a.ino", content: "" }] }), kind("no_browser", bare(NO_BROWSER)));
  await assert.rejects(c.set_visibility({ visibility: "nope" }), { name: "LabError", kind: "hub", message: "visibility: private, link or public." });
  assert.deepEqual(c.session, opened);
});

test("brief_submit, request_meeting: the session only with with_session: true, never forwarded", async () => {
  const hub = fakeHub({ ...base, brief_submit: () => ({ sent: false }), request_meeting: () => ({ sent: true, next: "" }) });
  const c = new LabClient({ post: hub.post });
  const meeting = { contact: { name: "A", email: "a@b.c" }, context: "x", availabilities: { text: "any" }, consent: true };
  await assert.rejects(c.brief_submit({ title: "T", with_session: true }), kind("gone"));
  await c.brief_submit({ title: "T" });
  await c.open_session({ setup: "setup-a", mode: "free" });
  await c.brief_submit({ title: "T" });
  await c.brief_submit({ title: "T", with_session: false });
  await c.brief_submit({ title: "T", with_session: true });
  await c.request_meeting(meeting);
  await c.request_meeting({ ...meeting, with_session: true });
  assert.deepEqual(hub.calls.filter((x) => x.name !== "open_session").map((x) => x.args), [
    { title: "T" }, { title: "T" }, { title: "T" }, { session: "s1", agent_token: "t1", title: "T" },
    meeting, { session: "s1", agent_token: "t1", ...meeting },
  ]);
});

test("push_program: with the session, bounded before sending", async () => {
  const hub = fakeHub({ ...base, push_program: () => "Program sent to the browser." });
  const c = new LabClient({ post: hub.post });
  await assert.rejects(c.push_program({ hex: ":00000001FF" }), kind("gone"));
  await c.open_session({ setup: "setup-a", mode: "free" });
  await assert.rejects(c.push_program({ hex: "x".repeat(MAX_PROGRAM + 1) }), kind("limit"));
  await assert.rejects(c.push_program({ hex: ":00000001FF", files: Array(9).fill({ name: "a.ino", content: "" }) }), kind("limit"));
  await c.push_program({ hex: ":00000001FF", files: [{ name: "a.ino", content: "x" }], run: false });
  assert.deepEqual(hub.calls.filter((x) => x.name === "push_program").map((x) => x.args), [
    { session: "s1", agent_token: "t1", hex: ":00000001FF", files: [{ name: "a.ino", content: "x" }], run: false },
  ]);
});

test("spec_draft: the arguments as given, never a session", async () => {
  const draft = { rules: ["r"], sections: [], next: "envelope", ready: false };
  const hub = fakeHub({ ...base, spec_draft: () => draft });
  const c = new LabClient({ post: hub.post });
  await c.open_session({ setup: "setup-a", mode: "free" });
  assert.deepEqual(await c.spec_draft(), draft);
  await c.spec_draft({ title: "T", sections: { envelope: "x" }, language: "en", pdf: true });
  assert.deepEqual(hub.calls.filter((x) => x.name === "spec_draft").map((x) => x.args), [
    {}, { title: "T", sections: { envelope: "x" }, language: "en", pdf: true },
  ]);
});

test("spec_draft, brief_submit: figures sent as given, over the bounds refused before sending", async () => {
  const hub = fakeHub({ ...base, spec_draft: () => ({ rules: [], sections: [], next: null, ready: true }), brief_submit: () => ({ sent: false }) });
  const c = new LabClient({ post: hub.post });
  const fig = { section: "format", caption: "Boîtier", type: "svg", data: Buffer.from("<svg/>").toString("base64") };
  await c.spec_draft({ title: "T", sections: { contact: "Ana, ana@x.fr" }, pdf: true, figures: [fig] });
  assert.deepEqual(hub.calls.at(-1).args.figures, [fig]);
  const big = { ...fig, data: "A".repeat(300 * 1024) };
  await assert.rejects(c.spec_draft({ figures: [big] }), kind("limit"));
  await assert.rejects(c.brief_submit({ title: "T", figures: [fig, fig, fig, fig] }), kind("limit"));
  assert.equal(hub.calls.filter((x) => x.name === "brief_submit").length, 0);
});

test("status: session_status, nothing else", async () => {
  const hub = fakeHub(base);
  const c = new LabClient({ post: hub.post });
  await c.open_session({ setup: "setup-a", mode: "free" });
  assert.deepEqual(await c.status(), status);
  assert.deepEqual(hub.calls.map((x) => x.name), ["open_session", "session_status"]);
  assert.deepEqual(hub.calls.at(-1).args, { session: "s1", agent_token: "t1" });
});

test("status: queue and share passed through (contract 0.20)", async () => {
  const st = { ...status, queue: { state: "turn", kind: "uno", bench: "uno-1", ends_at: 9 }, share: "/p/setup-a.free.0.42.AAAAAAAAAAAAAAAA" };
  const c = new LabClient({ post: fakeHub({ ...base, session_status: () => st }).post });
  await c.open_session({ setup: "setup-a", mode: "free" });
  assert.deepEqual(await c.status(), st);
});

test("capture_logic with a trigger, decode_capture: forwarded with the session", async () => {
  const decoded = { capture: "c1", protocol: "uart", frames: [{ t_us: 10, value: 0x55 }], text: "U", next: null, problems: [] };
  const hub = fakeHub({ ...base, capture_logic: () => ({ capture: "c1", state: "recording" }), decode_capture: () => decoded });
  const c = new LabClient({ post: hub.post });
  await c.open_session({ setup: "setup-a", mode: "free" });
  const trig = { pins: [2, 3], duration_ms: 200, trigger: { pin: 2, edge: "falling" }, wait_ms: 1000, pre_ms: 50 };
  await c.capture_logic(trig);
  const dec = { capture: "c1", protocol: "uart", channels: { rx: 2 }, options: { baud: 9600 }, offset: 0 };
  assert.deepEqual(await c.decode_capture(dec), decoded);
  assert.deepEqual(hub.calls.slice(1).map((x) => x.args), [
    { session: "s1", agent_token: "t1", ...trig }, { session: "s1", agent_token: "t1", ...dec },
  ]);
});

test("status: capture passed through as the hub gives it", async () => {
  const capture = { id: "c1", kind: "logic", state: "ready" };
  const hub = fakeHub({ ...base, session_status: () => ({ ...status, capture }) });
  const c = new LabClient({ post: hub.post });
  await c.open_session({ setup: "setup-a", mode: "free" });
  assert.deepEqual((await c.status()).capture, capture);
  assert.deepEqual(hub.calls.map((x) => x.name), ["open_session", "session_status"]); // no read_capture by the client
});

test("session tools without a session: gone, no request at all", async () => {
  const c = new LabClient({ post: async (url, body) => assert.fail(`no request expected: ${body}`) });
  const file = [{ name: "a.ino", content: "" }];
  for (const call of [() => c.status(), () => c.session_status(), () => c.read_simulation(), () => c.push_to_editor({ files: file }),
    () => c.set_visibility({ visibility: "link" }), () => c.queue_join({ kind: "uno" }), () => c.queue_status(), () => c.queue_leave(),
    () => c.close_session(), () => c.capture_logic(), () => c.read_capture({ capture: "c1" }),
    () => c.decode_capture({ capture: "c1", protocol: "i2c", channels: { scl: 2, sda: 3 } }),
    () => c.capture_analog(), () => c.push_circuit({ components: [], wires: [] }), () => c.bench_snapshot(), () => c.next_level(),
    () => c.brief_submit({ title: "T", with_session: true }),
    () => c.request_meeting({ contact: { name: "A", email: "a@b.c" }, context: "", availabilities: { text: "" }, consent: true, with_session: true })])
    await assert.rejects(call(), kind("gone", "No session: call open_session first."));
});

test("next_level: session filled in, the new level, hub errors as they come", async () => {
  const errors = ["Error executing tool next_level: Not in challenge mode.", NO_BROWSER];
  const hub = fakeHub({ ...base, next_level: () => { if (errors.length) throw new Error(errors.shift()); return { level: 3, levels: 4 }; } });
  const c = new LabClient({ post: hub.post });
  await c.open_session({ setup: "setup-a", mode: "challenge" });
  await assert.rejects(c.next_level(), kind("hub", "Not in challenge mode."));
  await assert.rejects(c.next_level(), kind("no_browser", bare(NO_BROWSER)));
  assert.deepEqual(await c.next_level(), { level: 3, levels: 4 });
  assert.deepEqual(hub.calls.at(-1), { name: "next_level", args: { session: "s1", agent_token: "t1" } });
  assert.ok(c.session); // hub errors keep the session
});

const sheet = { schema: 1, id: "setup-a", circuit: { components: [], wires: [] }, probes: [] };

test("images: image contents next to the JSON, with or without structuredContent", async () => {
  const hub = fakeHub({
    ...base,
    read_setup: ({ id }) => (id === "setup-a" ? withImage(sheet, PNG) : { ...sheet, id }),
    read_capture: ({ format }) => {
      const out = { capture: "c1", kind: "analog", state: "ready", duration_ms: 10, channels: [], rate_hz: 100, next: null };
      return format === "png" ? withImage(out, PNG) : { ...out, samples: [[5000]] };
    },
    bench_snapshot: () => ({ [RAW]: { content: [JPEG] } }),
  });
  const c = new LabClient({ post: hub.post });
  assert.deepEqual(await c.read_setup({ id: "setup-a" }), { ...sheet, images: [{ mimeType: "image/png", data: PNG.data }] });
  assert.deepEqual(await c.read_setup({ id: "setup-b" }), { ...sheet, id: "setup-b" }); // no schema.png: no images key
  assert.deepEqual(hub.calls.at(-1).args, { id: "setup-b" }); // not a session tool
  await c.open_session({ setup: "setup-a", mode: "free" });
  const png = await c.read_capture({ capture: "c1", format: "png", from_ms: 1, to_ms: 5 });
  assert.equal(png.kind, "analog");
  assert.deepEqual(png.images, [{ mimeType: "image/png", data: PNG.data }]);
  assert.deepEqual(hub.calls.at(-1).args, { session: "s1", agent_token: "t1", capture: "c1", format: "png", from_ms: 1, to_ms: 5 });
  const json = await c.read_capture({ capture: "c1" });
  assert.deepEqual([json.samples, json.images], [[[5000]], undefined]);
  assert.deepEqual(await c.bench_snapshot(), { images: [{ mimeType: "image/jpeg", data: JPEG.data }] });
  assert.deepEqual(hub.calls.at(-1), { name: "bench_snapshot", args: { session: "s1", agent_token: "t1" } });
});

test("push_circuit: 40 components, 120 wires, refused locally beyond; capture_analog forwarded", async () => {
  const hub = fakeHub({ ...base, push_circuit: () => "Circuit sent to the browser: read the outcome with read_simulation.",
    capture_analog: () => ({ capture: "c2", state: "recording" }) });
  const c = new LabClient({ post: hub.post });
  await c.open_session({ setup: "setup-a", mode: "free" });
  const comps = (n) => Array.from({ length: n }, (_, i) => ({ type: "led", id: `c${i}`, properties: {} }));
  const end = { componentId: "c0", pinName: "A" };
  const wires = (n) => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, start: end, end: { componentId: "uno", pinName: "13" } }));
  await assert.rejects(c.push_circuit({ components: comps(41), wires: [] }), kind("limit"));
  await assert.rejects(c.push_circuit({ components: [], wires: wires(121) }), kind("limit"));
  assert.deepEqual(hub.calls.map((x) => x.name), ["open_session"]);
  const circuit = { components: comps(40), wires: wires(120) };
  assert.match(await c.push_circuit(circuit), /^Circuit sent/);
  assert.deepEqual(hub.calls.at(-1).args, { session: "s1", agent_token: "t1", ...circuit });
  assert.deepEqual(await c.capture_analog({ pins: [14], rate_hz: 1000 }), { capture: "c2", state: "recording" });
  assert.deepEqual(hub.calls.at(-1).args, { session: "s1", agent_token: "t1", pins: [14], rate_hz: 1000 });
});

const BUNDLE = path.join(__dirname, "../dist/picodev-lab-client.mjs");

test("bundle: no import, codegen, timer, Buffer; fetch only in the default post", () => {
  const src = fs.readFileSync(BUNDLE, "utf8");
  for (const bad of [/\bimport\s*[({"'`*]/, /\brequire\s*\(/, /new Function|\beval\s*\(/, /setTimeout|setInterval|queueMicrotask/,
    /\bBuffer\b/, /\bprocess\b/, /Stream\b/, /\b(Headers|Request|Response|AbortController)\b/])
    assert.doesNotMatch(src, bad);
  assert.equal(src.match(/fetch\(/g).length, 1);
});

// The mod runtime, at its narrowest: the language, JSON and TextEncoder; no code generation, no WebAssembly.
// The ESM bundle runs as a script, its final `export{a as B,...}` turned into an object.
test("bundle: runs in a vm with only TextEncoder and a fake post", async () => {
  const src = fs.readFileSync(BUNDLE, "utf8").replace(/export\s*\{([^}]*)\};?\s*$/, (_, list) =>
    `({${list.split(",").map((x) => { const [a, b] = x.trim().split(/\s+as\s+/); return `${b ?? a}:${a}`; }).join(",")}})`);
  const ctx = vm.createContext({ TextEncoder }, { codeGeneration: { strings: false, wasm: false } });
  // What the context offers beyond the language's own globals: TextEncoder alone.
  assert.equal(vm.runInContext("JSON.stringify(Object.keys(globalThis))", ctx), '["TextEncoder"]');
  assert.equal(vm.runInContext(`[${["fetch", "setTimeout", "queueMicrotask", "Buffer", "process", "require", "TransformStream",
    "TextDecoderStream", "Headers", "Request", "Response", "URL"].map((g) => `typeof ${g}`)}].join()`, ctx),
  Array(12).fill("undefined").join());
  assert.throws(() => vm.runInContext("new Function('return 1')", ctx), /Code generation from strings disallowed/);
  const lib = vm.runInContext(src, ctx, { filename: "picodev-lab-client.mjs" });
  const hub = fakeHub({ ...base, queue_status: () => { throw new Error(UNKNOWN); }, read_setup: () => withImage(sheet, PNG) }, { sse: true });
  const c = new lib.LabClient({ post: hub.post });
  const plain = (x) => JSON.parse(JSON.stringify(x)); // values of the vm's realm
  assert.deepEqual(plain(await c.open_session({ setup: "setup-a", mode: "free" })), opened);
  assert.deepEqual(plain(await c.tools()).map((t) => t.name), Object.keys(base).concat("queue_status", "read_setup"));
  assert.deepEqual(plain(await c.read_setup({ id: "setup-a" })), { ...sheet, images: [{ mimeType: "image/png", data: PNG.data }] });
  assert.deepEqual(plain(await c.status()), status);
  assert.equal(await c.push_to_editor({ files: [{ name: "a", content: "x" }] }), "Code sent to the browser.");
  await assert.rejects(c.push_to_editor({ files: [{ name: "a", content: "é".repeat(40000) }] }), (e) => e instanceof lib.LabError && e.kind === "limit");
  await assert.rejects(c.queue_status(), (e) => e instanceof lib.LabError && e.kind === "gone" && e.message === bare(UNKNOWN));
  assert.equal(c.session, null);
  assert.equal(lib.MAX_FILES, 8);
});

test("live: tools, list_setups and a gone session on lab.picodev.fr", { skip: !process.env.LAB_LIVE && "set LAB_LIVE=1" }, async () => {
  const c = new LabClient(); // default post: fetch
  const tools = await c.tools();
  assert.ok(tools.some((t) => t.name === "list_setups") && tools.every((t) => typeof t.description === "string"));
  const setups = await c.list_setups();
  assert.ok(Array.isArray(setups) && setups.length > 0);
  assert.ok(setups.every((s) => typeof s.id === "string" && Array.isArray(s.modes)));
  c.session = { session: "no-such-session", agent_token: "x", open_url: "" };
  await assert.rejects(c.read_simulation(), (e) => e instanceof LabError && e.kind === "gone" && /^Unknown or ended session/.test(e.message));
  assert.equal(c.session, null);
  console.log(`${tools.map((t) => t.name).join(", ")}\n${setups.map((s) => `${s.id} (${s.modes.join(", ")})`).join("\n")}`);
});

test("live: the v0.8 tools and read_setup on lab.picodev.fr", { skip: !process.env.LAB_LIVE && "set LAB_LIVE=1" }, async () => {
  const c = new LabClient();
  const names = (await c.tools()).map((t) => t.name);
  for (const t of ["read_setup", "push_circuit", "capture_analog", "bench_snapshot", "read_capture"]) assert.ok(names.includes(t), t);
  const s = await c.read_setup({ id: "setup-a" });
  assert.equal(s.id, "setup-a");
  assert.ok(Array.isArray(s.circuit.components) && Array.isArray(s.circuit.wires) && Array.isArray(s.files));
  // schema.png is optional: when there, one PNG in base 64.
  if (s.images) assert.ok(s.images.length === 1 && s.images[0].mimeType === "image/png" && s.images[0].data.startsWith("iVBORw0KGgo"));
  console.log(`read_setup setup-a: ${s.circuit.components.length} components, ${s.circuit.wires.length} wires, ` +
    (s.images ? `schema.png ${Math.round(s.images[0].data.length * 3 / 4 / 1024)} KiB` : "no schema.png"));
});

test("live: session_status carries capture (hub v0.6.1) on lab.picodev.fr", { skip: !process.env.LAB_LIVE && "set LAB_LIVE=1" }, async () => {
  const c = new LabClient();
  await c.open_session({ setup: "setup-a", mode: "free" });
  try {
    const st = await c.status();
    assert.ok("capture" in st, `no capture in session_status: ${JSON.stringify(st)}`);
    assert.equal(st.capture, null);
  } finally {
    await c.close_session();
  }
});
