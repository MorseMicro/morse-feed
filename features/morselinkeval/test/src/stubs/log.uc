// Stub for the OpenWrt `log` (ubox ulog) native module.
//
// analytics.uc does `import { ulog, WARN, LOG_DEBUG } from "log"`. On the target
// that resolves to the ubox ulog .so, but the native x86 ucode used to run this
// test off-device does not ship those symbols. This stub provides just enough of
// the `log` surface for analytics.uc (and, if ever needed, the other package
// modules) to load: logging is a no-op — the harness has no syslog to write to.
//
// Placed first on the ucode module search path (`-L stubs`) so it shadows any
// installed `log` module. Do NOT stub `math`: analytics.uc's FSPL needs the real
// natural-log, and the native build provides it.

export const ERR       = 3;
export const WARN      = 4;
export const INFO      = 6;
export const LOG_DEBUG = 7;

export function ulog(...args) {}
export function ulog_open(...args) {}
export function ulog_threshold(...args) {}
