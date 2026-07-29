// Unit tests for the morseupgrade core logic (root/usr/share/ucode/morseupgrade/core.uc).
//
// Run via the generic morse-feed runner:
//     morse-feed/tests/ucode/run-tests.sh
// core.uc imports no native modules, so no stub -L path is needed: every I/O
// seam is injected here as a mock through create(env).
//
// Contract (see tests/ucode/run.uc): this file `import`s the code under test and
// ends in `return { name: function(){}, ... }`; a test PASSES if it returns
// without throwing, FAILS if an assert() throws.
"use strict";

import * as core from "../root/usr/share/ucode/morseupgrade/core.uc";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO = "https://repo.example/openwrt/releases";
const CFG_OK = { user: "u", password: "p", repo: REPO };

const OUTPUTBIN = "/tmp/sysupgrade.bin";
const STATUS_FILE = "/tmp/sysupgrade.status";
const PID_FILE = "/tmp/sysupgrade.pid";

// latest.json with a default "latest" bucket and a version-specific bucket that
// must take precedence for a device running "Morse-2.12.6".
const LATEST = '{' +
	'"latest": {' +
		'"morse,halowlink2": {"version": "Morse-3.2.0", "server": "3.2.0/halowlink2"},' +
		'"morse,mm6108":     {"version": "Morse-3.0.2", "server": "3.0.2/mm6108"}' +
	'},' +
	'"Morse-2.12.6": {' +
		'"morse,mm6108":     {"version": "Morse-9.9.9", "server": "bucket-2126/mm6108"}' +
	'}}';

// profiles.json whose profile matches both test boards and offers three images;
// only the squashfs *sysupgrade* one must be selected.
const PROFILES = '{' +
	'"version_code": "Morse-9.8.7",' +
	'"profiles": {"p1": {' +
		'"supported_devices": ["morse,halowlink2", "morse,mm6108"],' +
		'"images": [' +
			'{"type": "factory",    "filesystem": "squashfs", "name": "factory.bin",           "sha256": "f00d"},' +
			'{"type": "sysupgrade", "filesystem": "ext4",     "name": "sysupgrade-ext4.bin",   "sha256": "e4"},' +
			'{"type": "sysupgrade", "filesystem": "squashfs", "name": "sysupgrade-squash.bin", "sha256": "5011a5"}' +
		']}}}';

// profile present but the board is not among supported_devices.
const PROFILES_NOMATCH = '{"version_code": "Morse-9.8.7", "profiles": {"p1": ' +
	'{"supported_devices": ["morse,other"], "images": [' +
	'{"type": "sysupgrade", "filesystem": "squashfs", "name": "x.bin", "sha256": "aa"}]}}}';

// board matches, but no squashfs sysupgrade image is offered.
const PROFILES_NOSQUASH = '{"version_code": "Morse-9.8.7", "profiles": {"p1": ' +
	'{"supported_devices": ["morse,halowlink2"], "images": [' +
	'{"type": "factory", "filesystem": "squashfs", "name": "f.bin", "sha256": "aa"},' +
	'{"type": "sysupgrade", "filesystem": "ext4", "name": "e.bin", "sha256": "bb"}]}}}';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// ubus mock: .call('system','board') returns the given object (or null).
function mock_ubus(board) {
	return { call: (obj, method) => (obj == "system" && method == "board") ? board : null };
}

// Build the `board` object `ubus call system board` would return from a simple
// info spec. Empty board -> board_name null (mirrors an empty board_name file);
// empty/absent morse_version or target -> those words fall out of the split.
function board_of(info) {
	const owrt = info.owrt ?? "24.10";
	const ver = info.morse_version ?? "";
	return {
		board_name: (info.board ?? "") == "" ? null : info.board,
		rootfs_type: info.rootfs_type ?? "squashfs",
		release: {
			description: trim(`OpenWrt ${owrt} ${ver}`),
			target: info.target,
		},
	};
}

// uci cursor mock: get() serves keys of cfg; a missing key -> null (ConfigError).
function mock_cursor(cfg) {
	return () => ({
		load: () => true,
		get: (c, s, o) => cfg[o],
	});
}

// fs mock. opts:
//   latest/profiles      : bodies served for the matching fetch URL
//   fail_latest/profiles : force the fetch to fail (rc != 0)
//   files                : in-memory {path: content} for readfile/writefile/unlink
//   sizes                : {path: byte-count} for stat().size
//   procs                : {path: bool} for access()
function mock_fs(opts) {
	const files = opts.files ?? {};
	const sizes = opts.sizes ?? {};
	const procs = opts.procs ?? {};
	return {
		_files: files,
		popen: (cmd) => {
			if (opts.null_popen)
				return null;
			let body = "", rc = 0;
			if (index(cmd, "latest.json") >= 0)
				opts.fail_latest ? (rc = 1) : (body = opts.latest ?? LATEST);
			else if (index(cmd, "profiles.json") >= 0)
				opts.fail_profiles ? (rc = 1) : (body = opts.profiles ?? PROFILES);
			else
				rc = 1;
			return { read: () => body, close: () => rc };
		},
		stat: (p) => (sizes[p] != null) ? { size: sizes[p] } :
		             (files[p] != null) ? { size: length(files[p]) } : null,
		access: (p) => procs[p] ?? false,
		readfile: (p) => files[p] ?? null,
		writefile: (p, c) => { files[p] = c; return true; },
		unlink: (p) => { delete files[p]; return true; },
	};
}

// create(env) with sane defaults; each test overrides only what it needs.
// Silent log/warn keep code-under-test diagnostics out of the runner output.
function mk(o) {
	o ??= {};
	return core.create({
		ubus: o.ubus ?? mock_ubus(null),
		cursor: o.cursor ?? mock_cursor(CFG_OK),
		fs: o.fs ?? mock_fs({}),
		sha256_file: o.sha256_file ?? (() => "deadbeef"),
		system: o.system ?? (() => 0),
		log: () => {},
		warn: () => {},
	});
}

// Full env for search()/query() flows (board + fetch fixtures).
function env_flow(o) {
	return mk({
		ubus: mock_ubus(o.board ?? null),
		cursor: mock_cursor(o.cfg ?? CFG_OK),
		fs: mock_fs({
			latest: o.latest, profiles: o.profiles,
			fail_latest: o.fail_latest, fail_profiles: o.fail_profiles,
			null_popen: o.null_popen,
		}),
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

return {
	// ---- parse_version ------------------------------------------------
	parse_version_plain: function () {
		assert(join(",", core.parse_version("Morse-3.2.0")) == "3,2,0,0");
	},
	parse_version_last_dash_wins: function () {
		assert(join(",", core.parse_version("Morse-RTK-1.1.0")) == "1,1,0,0");
	},
	parse_version_no_dash: function () {
		assert(join(",", core.parse_version("3.2.0")) == "3,2,0,0");
	},
	parse_version_null: function () {
		assert(join(",", core.parse_version(null)) == "0,0,0,0");
	},
	parse_version_empty: function () {
		assert(join(",", core.parse_version("")) == "0,0,0,0");
	},
	parse_version_build_component: function () {
		assert(join(",", core.parse_version("Morse-3.2.0.5")) == "3,2,0,5");
	},
	parse_version_extra_components_dropped: function () {
		assert(join(",", core.parse_version("1.2.3.4.5")) == "1,2,3,4");
	},
	parse_version_non_numeric_is_zero: function () {
		assert(join(",", core.parse_version("Morse-3.x.0")) == "3,0,0,0");
	},
	parse_version_numeric_prefix: function () {
		assert(join(",", core.parse_version("3.2.0rc1")) == "3,2,0,0");
	},
	parse_version_short: function () {
		assert(join(",", core.parse_version("Morse-3")) == "3,0,0,0");
	},

	// ---- is_newer -----------------------------------------------------
	is_newer_major: function () { assert(core.is_newer("Morse-3.0.0", "Morse-1.0.0")); },
	is_newer_older_false: function () { assert(!core.is_newer("Morse-1.0.0", "Morse-3.0.0")); },
	is_newer_equal_false: function () { assert(!core.is_newer("Morse-3.2.0", "Morse-3.2.0")); },
	is_newer_patch: function () { assert(core.is_newer("Morse-3.2.1", "Morse-3.2.0")); },
	is_newer_minor_before_patch: function () { assert(core.is_newer("Morse-3.3.0", "Morse-3.2.9")); },
	is_newer_build_level: function () { assert(core.is_newer("Morse-3.2.0.2", "Morse-3.2.0.1")); },
	is_newer_null_equal_false: function () { assert(!core.is_newer(null, null)); },
	is_newer_vendor_prefix: function () { assert(core.is_newer("Morse-RTK-1.1.0", "Morse-1.0.0")); },
	is_newer_cross_format_equal_false: function () { assert(!core.is_newer("3.2.0", "Morse-3.2.0")); },

	// ---- get_upgrade_rule --------------------------------------------
	get_rule_found: function () {
		const j = { latest: { "morse,x": { version: "1", server: "s" } } };
		assert(core.get_upgrade_rule(j, { board: "morse,x" }, "latest").server == "s");
	},
	get_rule_bucket_absent: function () {
		assert(core.get_upgrade_rule({}, { board: "morse,x" }, "nope") == null);
	},
	get_rule_bucket_not_object: function () {
		assert(core.get_upgrade_rule({ latest: "str" }, { board: "morse,x" }, "latest") == null);
	},
	get_rule_board_absent: function () {
		const j = { latest: { "morse,y": {} } };
		assert(core.get_upgrade_rule(j, { board: "morse,x" }, "latest") == null);
	},
	get_rule_board_not_object: function () {
		const j = { latest: { "morse,x": "str" } };
		assert(core.get_upgrade_rule(j, { board: "morse,x" }, "latest") == null);
	},
	get_rule_board_null: function () {
		const j = { latest: { "morse,x": {} } };
		assert(core.get_upgrade_rule(j, { board: null }, "latest") == null);
	},

	// ---- format_size (fixed byte-branch) ------------------------------
	format_size_kib: function () { assert(core.format_size(1024) == "1.0K"); },
	format_size_1p5k: function () { assert(core.format_size(1536) == "1.5K"); },
	format_size_rounding: function () { assert(core.format_size(1280) == "1.2K"); },
	format_size_mib: function () { assert(core.format_size(11.4 * 1024 * 1024) == "11.4M"); },
	format_size_gib: function () { assert(core.format_size(1024 * 1024 * 1024) == "1.0G"); },
	format_size_tib: function () { assert(core.format_size(2 * 1024 * 1024 * 1024 * 1024) == "2.0T"); },
	format_size_bytes: function () { assert(core.format_size(512) == "512B"); },
	format_size_zero: function () { assert(core.format_size(0) == "0B"); },
	format_size_just_under_kib: function () { assert(core.format_size(1023) == "1023B"); },

	// ---- query --------------------------------------------------------
	query_full: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-3.2.0", target: "ramips/mt7621" }) });
		const q = h.query({});
		assert(q.board == "morse,halowlink2");
		assert(q.openwrt_version == "24.10");
		assert(q.morse_version == "Morse-3.2.0");
		assert(q.target == "ramips/mt7621");
		assert(q.rootfs_type == "squashfs");
	},
	query_empty_board_is_null: function () {
		const h = env_flow({ board: board_of({ board: "", morse_version: "", target: "" }) });
		assert(h.query({}).board == null);
	},
	query_ubus_null_no_throw: function () {
		const h = env_flow({ board: null });
		const q = h.query({});
		assert(q.board == null && q.morse_version == null);
	},

	// ---- search -------------------------------------------------------
	search_config_error: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }), cfg: { user: "u", password: "p" } });
		assert(h.search({}).status == "ConfigError");
	},
	search_board_error_no_board: function () {
		const h = env_flow({ board: board_of({ board: "", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }) });
		assert(h.search({}).status == "BoardInfoError");
	},
	search_board_error_no_version: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "", target: "ramips/mt7621" }) });
		assert(h.search({}).status == "BoardInfoError");
	},
	search_board_error_no_target: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0" }) });
		assert(h.search({}).status == "BoardInfoError");
	},
	search_http_error_latest_fetch: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }), fail_latest: true });
		assert(h.search({}).status == "HTTPError");
	},
	search_http_error_latest_badjson: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }), latest: "not json" });
		assert(h.search({}).status == "HTTPError");
	},
	search_http_error_popen_null: function () {
		// popen() itself returns null (spawn failed) -> rc stays '' -> HTTPError.
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }), null_popen: true });
		assert(h.search({}).status == "HTTPError");
	},
	search_http_error_latest_empty_body: function () {
		// Reachable server but empty response (rc 0, length 0) -> HTTPError.
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }), latest: "" });
		assert(h.search({}).status == "HTTPError");
	},
	search_http_error_latest_non_object: function () {
		// Valid JSON that is not an object (an array) -> HTTPError.
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }), latest: "[]" });
		assert(h.search({}).status == "HTTPError");
	},
	search_no_update_deprecated_empty_rule: function () {
		// Board present in latest.json but with an empty rule {} (deprecated):
		// the (!version && !server) gate -> NoUpdateNeededOK.
		const h = env_flow({
			board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }),
			latest: '{"latest": {"morse,halowlink2": {}}}',
		});
		assert(h.search({}).status == "NoUpdateNeededOK");
	},
	search_no_update_board_not_listed: function () {
		const h = env_flow({ board: board_of({ board: "morse,unknown", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }) });
		assert(h.search({}).status == "NoUpdateNeededOK");
	},
	search_no_update_equal_version: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-3.2.0", target: "ramips/mt7621" }) });
		assert(h.search({}).status == "NoUpdateNeededOK");
	},
	search_no_update_device_newer: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-9.9.9", target: "ramips/mt7621" }) });
		assert(h.search({}).status == "NoUpdateNeededOK");
	},
	search_version_bucket_precedence: function () {
		// Running Morse-2.12.6 -> the version-specific bucket (server bucket-2126)
		// must win over the "latest" bucket (server 3.0.2/mm6108).
		const h = env_flow({ board: board_of({ board: "morse,mm6108", morse_version: "Morse-2.12.6", target: "bcm27xx/bcm2711" }) });
		const r = h.search({});
		assert(r.status == "UpdateImageFoundOK");
		assert(index(r.url, "bucket-2126") >= 0);
	},
	search_latest_bucket_fallback: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }) });
		const r = h.search({});
		assert(r.status == "UpdateImageFoundOK");
		assert(index(r.url, "3.2.0/halowlink2") >= 0);
	},
	search_image_found_fields: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }) });
		const r = h.search({});
		assert(r.status == "UpdateImageFoundOK");
		assert(r.name == "sysupgrade-squash.bin");        // skips factory + ext4-sysupgrade
		assert(r.version == "Morse-9.8.7");                // from profiles.version_code
		assert(r.filesystem == "squashfs");
		assert(r.sum == "5011a5");
		assert(r.url == `${REPO}/3.2.0/halowlink2/targets/ramips/mt7621/sysupgrade-squash.bin`);
	},
	search_http_error_profiles_fetch: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }), fail_profiles: true });
		assert(h.search({}).status == "HTTPError");
	},
	search_image_not_found_board_unsupported: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }), profiles: PROFILES_NOMATCH });
		assert(h.search({}).status == "UpdateImageNotFoundError");
	},
	search_image_not_found_no_squashfs: function () {
		const h = env_flow({ board: board_of({ board: "morse,halowlink2", morse_version: "Morse-1.0.0", target: "ramips/mt7621" }), profiles: PROFILES_NOSQUASH });
		assert(h.search({}).status == "UpdateImageNotFoundError");
	},

	// ---- download -----------------------------------------------------
	download_arg_error_missing_url: function () {
		const h = env_flow({});
		assert(h.download({ args: { sum: "abc" } }).status == "ArgumentError");
	},
	download_arg_error_missing_sum: function () {
		const h = env_flow({});
		assert(h.download({ args: { url: `${REPO}/x.bin` } }).status == "ArgumentError");
	},
	download_arg_error_missing_both: function () {
		const h = env_flow({});
		assert(h.download({ args: {} }).status == "ArgumentError");
	},
	download_config_error: function () {
		const h = mk({ cursor: mock_cursor({ user: "u", password: "p" }) });
		assert(h.download({ args: { url: `${REPO}/x.bin`, sum: "abc" } }).status == "ConfigError");
	},
	download_off_repo_host: function () {
		const h = env_flow({});
		assert(h.download({ args: { url: "http://example.com/x.bin", sum: "abc" } }).status == "ArgumentError");
	},
	download_repo_without_trailing_slash: function () {
		const h = env_flow({});
		assert(h.download({ args: { url: REPO, sum: "abc" } }).status == "ArgumentError");
	},
	download_repo_as_substring_prefix: function () {
		// Security: repo appearing as a substring of another host must be rejected.
		const h = env_flow({});
		assert(h.download({ args: { url: `${REPO}.evil.com/x.bin`, sum: "abc" } }).status == "ArgumentError");
	},
	download_started_and_side_effects: function () {
		const files = {};
		let sys = [];
		const fs = mock_fs({ files });
		const h = mk({
			fs,
			// simulate the spawned shell writing the pid file
			system: (argv) => { push(sys, argv); files[PID_FILE] = "4242\n"; return 0; },
		});
		const url = `${REPO}/targets/ramips/mt7621/img.bin`;
		const r = h.download({ args: { url, sum: "abc" } });
		assert(r.status == "DownloadStartedOK");
		assert(r.file == OUTPUTBIN);
		assert(r.process == "4242");
		assert(fs._files[STATUS_FILE] == "0\n");          // status seeded
		assert(length(sys) == 1);                          // system spawned once
		const argv = sys[0];
		assert(argv[4] == "u" && argv[5] == "p");          // credentials
		assert(argv[7] == url);                            // url
	},

	// ---- stat ---------------------------------------------------------
	stat_ready_when_clean: function () {
		const h = mk({ fs: mock_fs({ files: {} }) });
		assert(h.stat({}).status == "ReadyForDownloadOK");
	},
	stat_in_progress: function () {
		const files = {}; files[PID_FILE] = "4242\n"; files[STATUS_FILE] = "0\n";
		const sizes = {}; sizes[OUTPUTBIN] = 11.4 * 1024 * 1024;
		const procs = {}; procs["/proc/4242"] = true;
		const h = mk({ fs: mock_fs({ files, sizes, procs }) });
		const r = h.stat({});
		assert(r.status == "DownloadInProgressOK");
		assert(r.process == "4242");
		assert(r.bytes == "11.4M");
	},
	stat_finish_ok: function () {
		const files = {}; files[PID_FILE] = "4242\n"; files[STATUS_FILE] = "0\n";
		const sizes = {}; sizes[OUTPUTBIN] = 1024 * 1024;
		const h = mk({ fs: mock_fs({ files, sizes, procs: {} }), sha256_file: () => "abcd" });
		const r = h.stat({});
		assert(r.status == "DownloadFinishOK");
		assert(r.size == "1.0M");
		assert(r.sum == "abcd");
	},
	stat_error_nonzero_status: function () {
		const files = {}; files[PID_FILE] = "4242\n"; files[STATUS_FILE] = "1\n";
		const h = mk({ fs: mock_fs({ files, procs: {} }) });
		const r = h.stat({});
		assert(r.status == "DownloadError");
		assert(r.code == "1");
	},
	stat_empty_pid_falls_through: function () {
		const files = {}; files[PID_FILE] = ""; files[STATUS_FILE] = "1\n";
		const h = mk({ fs: mock_fs({ files, procs: {} }) });
		assert(h.stat({}).status == "DownloadError");
	},
	stat_only_status_finish: function () {
		const files = {}; files[STATUS_FILE] = "0\n";
		const sizes = {}; sizes[OUTPUTBIN] = 1024 * 1024;
		const h = mk({ fs: mock_fs({ files, sizes, procs: {} }), sha256_file: () => "abcd" });
		assert(h.stat({}).status == "DownloadFinishOK");
	},
	stat_only_pid_null_status_errors: function () {
		// Edge: pid present, status file absent -> "" != "0" -> DownloadError.
		const files = {}; files[PID_FILE] = "4242\n";
		const h = mk({ fs: mock_fs({ files, procs: {} }) });
		assert(h.stat({}).status == "DownloadError");
	},

	// ---- verify -------------------------------------------------------
	verify_arg_error_no_sum: function () {
		const h = env_flow({});
		assert(h.verify({ args: {} }).status == "ArgumentError");
	},
	verify_ok_case_insensitive: function () {
		const h = mk({ sha256_file: () => "ABCDEF" });
		assert(h.verify({ args: { sum: "abcdef" } }).status == "VerifyOK");
	},
	verify_mismatch: function () {
		const h = mk({ sha256_file: () => "abcdef" });
		assert(h.verify({ args: { sum: "ffffff" } }).status == "SHAMismatchError");
	},
	verify_missing_file: function () {
		const h = mk({ sha256_file: () => null });
		assert(h.verify({ args: { sum: "abcdef" } }).status == "SHAMismatchError");
	},

	// ---- create smoke -------------------------------------------------
	create_returns_all_handlers: function () {
		const h = env_flow({});
		for (let m in ["query", "search", "download", "stat", "verify"])
			assert(type(h[m]) == "function", `${m} missing`);
	},
};
