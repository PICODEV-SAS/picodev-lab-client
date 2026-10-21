// Client of the Picodev Lab hub's MCP (https://lab.picodev.fr/mcp): one method per tool the hub serves.
// Language, JSON and TextEncoder only: it runs in a Claude Code mod (no fetch, timers, streams, import()).

export const DEFAULT_URL = "https://lab.picodev.fr/mcp";
export const MAX_FILES = 8;
export const MAX_FILES_BYTES = 64 * 1024;
export const MAX_PROGRAM = 48 * 1024; // Intel HEX text, checked by the hub (contract 0.15)
export const MAX_COMPONENTS = 40;
export const MAX_WIRES = 120;
// The spec's illustrations (contract 0.16): 3 at most, 200 KiB each once decoded, 400 KiB in all
export const MAX_FIGURES = 3;
export const MAX_FIGURE_BYTES = 200 * 1024;
export const MAX_FIGURES_BYTES = 400 * 1024;

export type Mode = "free" | "challenge";
export type Visibility = "private" | "link" | "public";

export interface Session { session: string; agent_token: string; open_url: string }
export interface File { name: string; content: string }
export interface Setup {
  id: string; title?: string; summary?: string; modes: Mode[];
  benches: { kind: string; benches: number; free: number; waiting: number }[];
}
export interface Simulation {
  state: Record<string, any> | null;
  compile: { ok: boolean; log: string; origin?: "agent" | "cloud" } | null;
  events: { t: number; k: "pin" | "pwm" | "servo" | "serial"; pin?: number; v: any }[];
  challenge?: { level: number | null; brief: { id: string; title: string; brief: string; hints: string[] } | null; results: any };
  /** The last state's circuit differs from the sheet's (not positions, colours or wire ids); null when either is unknown. */
  circuit_modified: boolean | null;
  /** The editor's last refusal of a pushed circuit, returned once. */
  circuit_error: string | null;
}
/** A circuit in the sheet's shape (hub.py `clean_circuit`); the board is not a component, wires name it by board.kind. */
export interface CircuitComponent {
  type: string; id: string; properties?: Record<string, string | number | boolean>; x?: number; y?: number;
}
export interface WireEnd { componentId: string; pinName: string }
export interface Wire { id: string; start: WireEnd; end: WireEnd; color?: string }
export interface Circuit { components: CircuitComponent[]; wires: Wire[] }
/** An MCP `image` content: data in base 64. */
export interface ToolImage { mimeType: string; data: string }
/** The served setup sheet; `images`: schema.png when it exists. */
export interface SetupSheet {
  schema: number; id: string; title: string; summary: string; board: { kind: string; fqbn: string };
  files: File[]; libraries: string[]; circuit: Circuit;
  probes: { pin: number; label: string; kind: "scope" | "logic" }[]; levels: Record<string, any>[];
  i18n?: Record<string, any>; images?: ToolImage[]; [key: string]: unknown;
}
export interface QueueStatus {
  state: "none" | "waiting" | "turn"; kind?: string; position?: number; waiting?: number;
  eta_s?: number; bench?: string; ends_at?: number;
}
export interface SessionStatus {
  setup: string; mode: Mode; owner: boolean; visibility: Visibility; viewer_url: string | null;
  viewers: number; created_at: number; expires_at: number; run: number;
  level: number | null; levels: number | null; capture: CaptureRef | null;
}
/** The session's capture in session_status (hub v0.6.1): read it with read_capture once, when state turns ready. */
export interface CaptureRef { id: string; kind: "logic" | "analog"; state: "recording" | "ready" | "failed" }
/** @deprecated Since 0.3.0 status() is session_status: use SessionStatus. */
export type Status = SessionStatus;
/** Pulses of one level: the levels between two edges (the first and last, cut by the window, are not). */
export interface Pulses { count: number; min_ms: number | null; max_ms: number | null }
/** Measures of one pin (hub.py `channel`); period_ms and duty only when the signal is periodic. */
export interface CaptureChannel {
  pin: number; label: string; edges: number; initial: 0 | 1; high_ms: number; low_ms: number;
  period_ms?: number; duty?: number; pulses: { high: Pulses; low: Pulses };
}
/** Measures of one analog channel (hub.py `analog_channel`), in volts; null without samples. */
export interface AnalogChannel {
  pin: number; label: string; min_v: number | null; max_v: number | null; mean_v: number | null; period_ms?: number;
}
interface CaptureBase {
  capture: string; state: "recording" | "ready" | "failed"; detail?: string; duration_ms: number; next: number | null;
  /** format "png": the chart, once ready. */
  images?: ToolImage[];
}
/** edges [t_us, pin, v], absent with format "png". */
export interface LogicCapture extends CaptureBase {
  kind: "logic"; channels: CaptureChannel[]; edges?: [number, number, 0 | 1][]; truncated: boolean;
}
/** samples: rows of millivolts in the order of pins, row k at k / rate_hz; absent with format "png". */
export interface AnalogCapture extends CaptureBase {
  kind: "analog"; rate_hz: number; channels: AnalogChannel[]; samples?: number[][];
}
export type Capture = LogicCapture | AnalogCapture;
export interface Contact { name: string; email: string; company?: string; phone?: string }
export type Availabilities = { from: string; to: string }[] | { text: string };

/** The host's send: one POST, the whole answer as text. Default: fetch; in a Claude Code mod, $.http.fetch. */
export type Post = (url: string, body: string, headers: Record<string, string>) =>
  Promise<{ status: number; text: string; headers?: Record<string, string> }>;

/**
 * gone: unknown or ended session (the held one is forgotten); no_browser: no owner connected;
 * limit: refused locally, no call; hub: any other hub error; transport: no readable JSON-RPC answer.
 */
export type LabErrorKind = "gone" | "no_browser" | "limit" | "hub" | "transport";

/** An error of the hub (its text, without FastMCP's prefix) or a local refusal made before any call. */
export class LabError extends Error {
  override name = "LabError";
  constructor(message: string, readonly kind: LabErrorKind = "hub") { super(message); }
}

// The hub's texts (hub.py): English now, French in older hubs.
const GONE = /unknown or ended session|session inconnue/i;
const NO_BROWSER = /no browser is connected|aucun navigateur/i;
const PREFIX = /^Error executing tool [^:]*: /; // FastMCP's, before the hub's own text
const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

const parse = (text: string) => { try { return JSON.parse(text); } catch { return text; } };

const fetchPost: Post = async (url, body, headers) => {
  const r = await fetch(url, { method: "POST", body, headers });
  return { status: r.status, text: await r.text() };
};

/** One section of spec_draft: look_for and questions while it is not filled. */
export interface SpecSection {
  id: string; heading: string; required: boolean; state: "empty" | "thin" | "filled";
  look_for?: string; questions?: string[];
}
/** An illustration of the spec (contract 0.16), approved by the visitor: data is the file in base 64. */
export interface SpecFigure { section: string; caption: string; type: "png" | "svg"; data: string }

/** Decoded size of a base-64 string. */
const decoded = (b64: string) => Math.floor((b64.replace(/=+$/, "").length * 3) / 4);

/** The hub's bounds on `figures`, checked before sending; the hub checks the files themselves. */
function figuresProblem(figures?: SpecFigure[]): string | undefined {
  if (!figures?.length) return;
  const sizes = figures.map((f) => decoded(f.data ?? ""));
  if (figures.length > MAX_FIGURES || sizes.some((n) => n > MAX_FIGURE_BYTES) || sizes.reduce((a, b) => a + b, 0) > MAX_FIGURES_BYTES)
    return `figures: ${MAX_FIGURES} at most, ${MAX_FIGURE_BYTES / 1024} KiB each, ${MAX_FIGURES_BYTES / 1024} KiB in all (here ${figures.length}, ${sizes.join(" + ")} bytes).`;
}

export interface SpecDraft {
  rules: string[]; sections: SpecSection[]; next: string | null; ready: boolean;
  filename?: string; pdf?: string;
}

export class LabClient {
  /** The held session. The host may set it to restore one it kept (e.g. VS Code SecretStorage). */
  session: Session | null = null;
  readonly url: string;
  private post: Post;
  private id = 0;

  /** name and version are kept for compatibility: without initialize, the hub is never told them. */
  constructor(opts: { url?: string; name?: string; version?: string; post?: Post } = {}) {
    this.url = opts.url ?? DEFAULT_URL;
    this.post = opts.post ?? fetchPost;
  }

  // One JSON-RPC request, no initialize: the hub's transport is stateless.
  private async rpc(method: string, params?: Record<string, unknown>): Promise<any> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, ...(params && { params }) });
    let r: Awaited<ReturnType<Post>>;
    try {
      r = await this.post(this.url, body, { ...HEADERS });
    } catch (e: any) {
      throw new LabError(`${this.url}: ${e?.message ?? e}`, "transport");
    }
    let msg: any;
    try {
      const text = String(r.text).trim();
      const data = text.split(/\r?\n/).filter((l) => l.startsWith("data:")); // SSE: the last data line
      msg = JSON.parse(text.startsWith("{") ? text : data[data.length - 1].slice(5));
    } catch {
      msg = undefined;
    }
    if (msg?.error) throw new LabError(String(msg.error.message ?? JSON.stringify(msg.error)), "hub");
    if (!msg || !("result" in msg)) throw new LabError(`${this.url}: HTTP ${r.status}, no JSON-RPC answer.`, "transport");
    return msg.result;
  }

  /** The tools the hub serves. */
  async tools(): Promise<{ name: string; description: string }[]> {
    const { tools } = await this.rpc("tools/list");
    return tools.map((t: any) => ({ name: t.name, description: t.description ?? "" }));
  }

  /** Calls a hub tool by name and returns its result; a hub error is thrown as a LabError with its text. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text = r?.content?.find((x: any) => x.type === "text")?.text ?? "";
    if (r?.isError) {
      const message = String(text).replace(PREFIX, "");
      const kind = GONE.test(message) ? "gone" : NO_BROWSER.test(message) ? "no_browser" : "hub";
      if (kind === "gone") this.session = null;
      throw new LabError(message, kind);
    }
    const s = r?.structuredContent;
    let out = s ? (Object.keys(s).length === 1 && "result" in s ? s.result : s) : parse(text); // FastMCP wraps lists and strings
    // A result with images has no structuredContent: its JSON is the text, the images go next to it.
    const images: ToolImage[] = (r?.content ?? []).filter((x: any) => x.type === "image")
      .map((x: any) => ({ mimeType: x.mimeType, data: x.data }));
    // ponytail: the hub's image results are an object or nothing (bench_snapshot); a bare text beside images is dropped.
    if (images.length) out = { ...(out && typeof out === "object" && !Array.isArray(out) ? out : {}), images };
    return out;
  }

  private held(): { session: string; agent_token: string } {
    if (!this.session) throw new LabError("No session: call open_session first.", "gone");
    return { session: this.session.session, agent_token: this.session.agent_token };
  }

  private async withSession(name: string, args: Record<string, unknown> = {}) {
    return this.call(name, { ...this.held(), ...args });
  }

  /** @deprecated Nothing to close since 0.2.0 (one POST per call); kept for the hosts that call it. */
  async close(): Promise<void> {}

  list_setups(): Promise<Setup[]> { return this.call("list_setups"); }

  async open_session(args: { setup: string; mode: Mode }): Promise<Session> {
    const s: Session = await this.call("open_session", args);
    this.session = { session: s.session, agent_token: s.agent_token, open_url: s.open_url };
    return s;
  }

  push_to_editor(args: { files: File[]; run?: boolean }): Promise<string> {
    const { files } = args;
    const enc = new TextEncoder();
    const bytes = files.reduce((n, f) => n + enc.encode(f.content).length, 0);
    if (files.length < 1 || files.length > MAX_FILES || bytes > MAX_FILES_BYTES)
      return Promise.reject(new LabError(
        `files: 1 to ${MAX_FILES}, ${MAX_FILES_BYTES / 1024} KiB at most in all (here ${files.length} files, ${bytes} bytes).`,
        "limit"));
    return this.withSession("push_to_editor", args);
  }

  /** A program the agent compiled (Intel HEX text), loaded without compiling; files: its sources, shown read-only. */
  push_program(args: { hex: string; files?: File[]; run?: boolean }): Promise<string> {
    const enc = new TextEncoder();
    const size = enc.encode(args.hex).length;
    if (size < 1 || size > MAX_PROGRAM)
      return Promise.reject(new LabError(`hex: ${MAX_PROGRAM / 1024} KiB at most (here ${size} bytes).`, "limit"));
    const files = args.files ?? [];
    const bytes = files.reduce((n, f) => n + enc.encode(f.content).length, 0);
    if (files.length > MAX_FILES || bytes > MAX_FILES_BYTES)
      return Promise.reject(new LabError(
        `files: ${MAX_FILES} at most, ${MAX_FILES_BYTES / 1024} KiB at most in all (here ${files.length} files, ${bytes} bytes).`,
        "limit"));
    return this.withSession("push_program", args);
  }

  read_simulation(args: { since_ms?: number } = {}): Promise<Simulation> { return this.withSession("read_simulation", args); }
  set_visibility(args: { visibility: Visibility }): Promise<{ visibility: Visibility; viewer_url: string | null }> {
    return this.withSession("set_visibility", args);
  }
  queue_join(args: { kind: string }): Promise<{ kind: string; position: number; waiting: number; eta_s: number }> {
    return this.withSession("queue_join", args);
  }
  queue_status(): Promise<QueueStatus> { return this.withSession("queue_status"); }
  queue_leave(): Promise<{ state: "none" }> { return this.withSession("queue_leave"); }

  async close_session(): Promise<{ state: "ended" }> {
    const r = await this.withSession("close_session");
    this.session = null;
    return r;
  }

  session_status(): Promise<SessionStatus> { return this.withSession("session_status"); }
  capture_logic(args: { pins?: number[]; duration_ms?: number } = {}): Promise<{ capture: string; state: "recording" }> {
    return this.withSession("capture_logic", args);
  }
  read_capture(args: { capture: string; offset?: number; format?: "json" | "png"; from_ms?: number; to_ms?: number }): Promise<Capture> {
    return this.withSession("read_capture", args);
  }
  capture_analog(args: { pins?: number[]; duration_ms?: number; rate_hz?: number } = {}): Promise<{ capture: string; state: "recording" }> {
    return this.withSession("capture_analog", args);
  }
  read_setup(args: { id: string }): Promise<SetupSheet> { return this.call("read_setup", args); }
  /** Free mode only; the outcome is read with read_simulation (state.circuit, circuit_error). */
  push_circuit(args: Circuit): Promise<string> {
    const { components, wires } = args;
    if (components.length > MAX_COMPONENTS || wires.length > MAX_WIRES)
      return Promise.reject(new LabError(
        `circuit: ${MAX_COMPONENTS} components and ${MAX_WIRES} wires at most (here ${components.length} and ${wires.length}).`,
        "limit"));
    return this.withSession("push_circuit", { components, wires });
  }
  /** During the session's turn on a real bench: its photo (image/jpeg). */
  bench_snapshot(): Promise<{ images: ToolImage[] }> { return this.withSession("bench_snapshot"); }
  /** Challenge mode: the bench's "Next level", only when it would be offered; returns the new level (contract 0.8.3). */
  next_level(): Promise<{ level: number; levels: number }> { return this.withSession("next_level"); }

  // The visitor's lab session goes with a brief or a meeting request only when asked (with_session: true,
  // not sent to the hub): sending what they did at the lab needs their consent. Without a held session: gone.
  private async optSession(name: string, { with_session, ...args }: { with_session?: boolean }) {
    return this.call(name, { ...(with_session ? this.held() : {}), ...args });
  }

  /** The spec interview (contract 0.14): rules, sections and what to ask next; pdf: true adds the PDF. Never a session. */
  // sections may hold `contact` (contract 0.16): the contact details the visitor wants in the document
  spec_draft(args: {
    title?: string; sections?: Record<string, string>; language?: "fr" | "en"; pdf?: boolean; figures?: SpecFigure[];
  } = {}): Promise<SpecDraft> {
    const bad = figuresProblem(args.figures);
    return bad ? Promise.reject(new LabError(bad, "limit")) : this.call("spec_draft", args);
  }
  brief_submit(args: {
    title: string; contact?: Contact; sections?: Record<string, string>; figures?: SpecFigure[];
    nda?: boolean; consent?: boolean; send?: boolean; with_session?: boolean; language?: "fr" | "en";
  }): Promise<{ sent: boolean; filename: string; pdf?: string; missing: string[]; next: string }> {
    const bad = figuresProblem(args.figures);
    return bad ? Promise.reject(new LabError(bad, "limit")) : this.optSession("brief_submit", args);
  }
  request_meeting(args: {
    contact: Contact; context: string; availabilities: Availabilities; consent: boolean; with_session?: boolean;
  }): Promise<{ sent: boolean; next: string }> {
    return this.optSession("request_meeting", args);
  }

  /** session_status, for a host that polls it (every 2 s at most, only while a session is held). */
  status(): Promise<SessionStatus> { return this.session_status(); }
}
