# Changelog

## 0.9.0

Contract 0.21.

- `submit_answer({ test, value })`: in challenge mode, proposes `value` for the `answer` test `test` of
  the current level; one per second per session, the verdict is `ok` (true: correct, false: wrong answer).
- `read_simulation().challenge.brief.hints` now lists only the hints the visitor revealed (type unchanged).

## 0.8.0

Contract 0.20.

- Hub errors: `gone` and `no_browser` come from the code in the tool result's `_meta`
  (`lab.picodev.fr/error`); an unknown code is a `hub` error. The text is read only for a hub that
  sends no code.
- `SessionStatus.queue` (the shape of `queue_status`) and `SessionStatus.share` (the signed share link).
- `capture_logic`: `trigger` (`{ pin, edge }`), `wait_ms`, `pre_ms`; `LogicCapture.trigger` with `at_us`.
- `decode_capture`: decodes a ready logic capture of the session (uart, spi, i2c), typed by protocol.
- `Setup.status` (`available` or `soon`) and the `status` of its bench offers (`open` or `soon`).
- `Setup.i18n`: the English title and summary `list_setups` gives (`{ en: { title, summary } }`).

## 0.7.1

- First public release, on github.com/PICODEV-SAS/picodev-lab-client. No API change.

## Earlier versions

- 0.7.0: spec illustrations and the contact section of `spec_draft`.
- 0.6.0: `push_program`, a program compiled by the agent (Intel HEX, 48 KiB at most).
- 0.5.0: `spec_draft`, the spec interview.
- 0.4.2: `next_level`.
- 0.4.1: `status()` gives the session's capture.
- 0.4.0: more hub tools; image contents returned in `images`.
- 0.3.0: `status()` is `session_status`; hub errors without FastMCP's prefix.
- 0.2.0: no MCP SDK, one JSON-RPC `POST` per call over a `post` given by the host.
- 0.1.0: first client of the hub's MCP.
