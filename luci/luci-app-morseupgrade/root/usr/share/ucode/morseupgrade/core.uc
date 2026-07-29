// Copyright 2026 Morse Micro
// Licensed under the Apache License, Version 2.0.
//
// morseupgrade core logic.
//
// This module holds the whole upgrade flow, factored out of the rpcd plugin so
// it can be unit-tested without a device. It imports NO native modules: every
// I/O boundary (ubus, uci, fs, digest, and the `system` builtin) is injected
// via create(env), so tests pass mocks and the rpcd shim passes the real thing.
//
//   env = {
//     ubus,          // connected ubus instance with .call(obj, method[, args])
//     cursor,        // uci `cursor` function -> a uci cursor
//     fs,            // "fs" module namespace (access/readfile/writefile/unlink/popen/stat)
//     sha256_file,   // digest sha256_file(path) -> hex string
//     system,        // the `system` builtin (argv-array form)
//     log,           // optional info sink; defaults to print (tests silence it)
//     warn,          // optional warning sink; defaults to the warn builtin
//   }
//
// The pure helpers (parse_version/is_newer/get_upgrade_rule/format_size) are
// exported directly for straightforward unit tests.

'use strict';

const OUTPUTBIN = '/tmp/sysupgrade.bin';
const STATUS_FILE = '/tmp/sysupgrade.status';
const PID_FILE = '/tmp/sysupgrade.pid';

function parse_version(v) {
	v ??= '';

	// LAST dash → works for Morse-3.2.0 and Morse-RTK-1.1.0
	const dash = rindex(v, '-');

	// Extract version 3.0.2 from tail
	const tail = (dash >= 0) ? substr(v, dash + 1) : v;

	// Split major minor patch and build
	const parts = split(tail, '.');

	let out = [];
	for (let i = 0; i < 4; i++) {
		const m = match(parts[i] ?? '', /^[0-9]+/);
		push(out, m ? int(m[0]) : 0);
	}
	return out;
}

// True if the server version is strictly newer than the device version.
function is_newer(server_version, device_version) {
	const a = parse_version(server_version);
	const b = parse_version(device_version);
	for (let i = 0; i < 4; i++) {
		if (a[i] != b[i])
			return a[i] > b[i];
	}
	return false;
}

// Look up the single {version, server} rule for this board within one
// version bucket ("latest" or an explicit running-version key).
function get_upgrade_rule(latest_json, board_info, bucket) {
	const version_bucket = latest_json[bucket];
	if (type(version_bucket) != 'object')
		return null;

	const rule = version_bucket[board_info.board];
	if (type(rule) != 'object')
		return null;

	return rule;
}

// Format a raw byte count the way `du -h` does ("4.0K", "11.4M").
function format_size(size) {
	const units = ["B", "K", "M", "G", "T", "P"];
	let v = size, i = 0;
	while (v >= 1024 && i < length(units) - 1) { v /= 1024.0; i++; }

	// "4.0K", "11.4M"
	if (i)
		return sprintf("%.1f%s", v, units[i]);

	// "512B" — integer, no decimal
	return `${v}${units[i]}`;
}

// Build the handler object bound to an injected I/O environment.
function create(env) {
	let config = null;

	// Diagnostics go through injected sinks so tests can silence them; the shim
	// passes neither, preserving the original print/warn behaviour in production.
	const log = env.log ?? function (...m) { print(...m, "\n"); };
	const logw = env.warn ?? function (...m) { warn(...m); };

	function uclient_args() {
		return `--user=${config.user} --password=${config.password}`;
	}

	function load_config() {
		const uci = env.cursor();
		uci.load('upgrade');

		config = {
			user: uci.get('upgrade', '@upgrade[0]', 'user'),
			password: uci.get('upgrade', '@upgrade[0]', 'password'),
			repo: uci.get('upgrade', '@upgrade[0]', 'repo'),
		};

		if (!config.repo || !config.user || !config.password) {
			logw('Failed to read upgrade configuration');
			return {
				status: 'ConfigError',
				error: 'Failed to read upgrade configuration',
			};
		}

		return null;
	}

	function file_size(file) {
		const s = env.fs.stat(file);
		if (!s)
			return null;
		return format_size(s.size);
	}

	// Query ubus for this device's board info in the shape returned by query().
	function get_board_info() {
		const board = env.ubus.call('system', 'board');
		const description = board?.release?.description ?? '';
		// Split the description like the shell's `echo $description | cut -d' '`.
		const words = split(trim(description), /\s+/);

		return {
			board: board?.board_name,
			openwrt_version: words[1],
			morse_version: words[2],
			target: board?.release?.target,
			rootfs_type: board?.rootfs_type,
		};
	}

	function load_json(file) {
		const uargs = uclient_args();
		const url = `${config.repo}/${file}`;
		let out = '';
		let rc = '';

		const proc = env.fs.popen(`uclient-fetch ${uargs} -q -T 10 -O - ${url} 2>/dev/null`);

		if (proc) {
			out = proc.read('all') ?? '';
			rc = proc.close();
		}

		if (rc != 0 || length(out) == 0) {
			return {
				status: 'HTTPError',
				error: 'Could not reach upgrade server',
				code: `${rc}`,
			};
		}

		let json_object;
		try {
			json_object = json(out);
		} catch (e) {
			return { status: 'HTTPError', error: 'Could not reach upgrade server' };
		}

		if (type(json_object) != 'object')
			return { status: 'HTTPError', error: 'Could not reach upgrade server' };

		return json_object;
	}

	function resolve_latest(board_info) {
		const latest_json = load_json('latest.json');
		if (latest_json.status)
			return latest_json;

		// A rule keyed by the currently running version takes precedence.
		let upgrade_rule = get_upgrade_rule(latest_json, board_info, board_info.morse_version);
		let bucket = board_info.morse_version;

		// Fall back to the default "latest" rule.
		if (!upgrade_rule) {
			upgrade_rule = get_upgrade_rule(latest_json, board_info, "latest");
			bucket = "latest";
		}

		if (upgrade_rule)
			log(`upgrade rule match in bucket ${bucket} for ${board_info.board}  ${upgrade_rule}`);

		return upgrade_rule;
	}

	function get_sysupgrade_image(board_info, upgrade_rule) {
		let images = null;
		const base = `${upgrade_rule.server}/targets/${board_info.target}`;

		const profiles_json = load_json(`${base}/profiles.json`);
		if (profiles_json.status)
			return profiles_json;

		for (let profile_name, profile in (profiles_json.profiles ?? {})) {
			if (type(profile) != 'object')
				continue;
			if (board_info.board in (profile.supported_devices ?? [])) {
				log(`Found ${board_info.board} in ${profile_name}`);
				images = profile.images;
				break;
			}
		}

		if (type(images) != 'array' || length(images) == 0)
			return { status: 'UpdateImageNotFoundError', error: `No images found on upgrade server for ${board_info.board}` };

		// Decision is to force people to squashfs.
		let image = null;
		for (let img in images) {
			if (type(img) != 'object')
				continue;
			if (img.type == 'sysupgrade' && img.filesystem == 'squashfs') {
				log(`Image is ${img.type} with ${img.filesystem}: ${img.name} ${img.sha256}`);
				image = img;
				break;
			}
		}

		if (!image?.name)
			return { status: 'UpdateImageNotFoundError', error: `No sysupgrade image found for ${board_info.board}` };

		return {
			status: 'UpdateImageFoundOK',
			name: image.name,
			version: profiles_json.version_code,
			filesystem: image.filesystem,
			sum: image.sha256,
			url: `${config.repo}/${base}/${image.name}`,
		};
	}

	function query(request) {
		return get_board_info();
	}

	function search(request) {

		const err = load_config();
		if (err)
			return err;

		const board_info = get_board_info();

		if (!board_info.board || !board_info.morse_version || !board_info.target)
			return { status: 'BoardInfoError', error: 'Could not read board information' };

		const upgrade_rule = resolve_latest(board_info);

		// Failure/status object detected while loading latest.json.
		if (type(upgrade_rule) == 'object' && upgrade_rule.status)
			return upgrade_rule;

		// Board not listed (or deprecated) - nothing to upgrade to.
		if (!upgrade_rule || (!upgrade_rule.version && !upgrade_rule.server))
			return { status: 'NoUpdateNeededOK', message: 'Already up to date!' };

		if (!is_newer(upgrade_rule.version, board_info.morse_version))
			return { status: 'NoUpdateNeededOK', message: 'Already up to date!' };

		return get_sysupgrade_image(board_info, upgrade_rule);
	}

	function download(request) {
		const url = request.args?.url;
		const sum = request.args?.sum;

		if (!url || !sum) {
			return {
				status: 'ArgumentError',
				error: 'Correct target and sha256sum not provided to download service',
			};
		}

		const err = load_config();
		if (err)
			return err;

		// The fetch carries the repo Basic-Auth credentials, so only allow URLs
		// that live under the configured repo - never leak them to another host.
		if (substr(url, 0, length(config.repo) + 1) != `${config.repo}/`) {
			return {
				status: 'ArgumentError',
				error: 'Refusing to download from a URL outside the configured repository',
			};
		}

		env.fs.unlink(OUTPUTBIN);
		env.fs.unlink(STATUS_FILE);
		env.fs.unlink(PID_FILE);
		env.fs.writefile(STATUS_FILE, "0\n");

		const script = '(uclient-fetch --user="$1" --password="$2" -O "$3" "$4" >/dev/null 2>&1; ' +
			'echo $? > "$5") & echo $! > "$6"';
		env.system(['/bin/sh', '-c', script, 'morseupgrade-download',
			config.user, config.password, OUTPUTBIN, url, STATUS_FILE, PID_FILE]);

		return {
			status: 'DownloadStartedOK',
			file: OUTPUTBIN,
			process: trim(env.fs.readfile(PID_FILE) ?? ''),
		};
	}

	function stat(request) {
		const pid_raw = env.fs.readfile(PID_FILE);
		const status_raw = env.fs.readfile(STATUS_FILE);

		if (pid_raw == null && status_raw == null)
			return { status: 'ReadyForDownloadOK', message: 'No previous download' };

		const pid = (pid_raw != null) ? trim(pid_raw) : '';
		const status = (status_raw != null) ? trim(status_raw) : '';

		if (pid != '' && env.fs.access(`/proc/${pid}`)) {
			return {
				status: 'DownloadInProgressOK',
				code: status,
				message: 'Previous download in progress',
				process: pid,
				bytes: file_size(OUTPUTBIN),
			};
		}

		if (status != '0') {
			return {
				status: 'DownloadError',
				error: 'Firmware image download failed',
				code: status,
				process: pid,
			};
		}

		return {
			status: 'DownloadFinishOK',
			message: 'Download complete',
			code: '0',
			process: pid,
			size: file_size(OUTPUTBIN),
			sum: env.sha256_file(OUTPUTBIN),
		};
	}

	function verify(request) {
		const sum = request.args?.sum;

		if (!sum) {
			return {
				status: 'ArgumentError',
				error: 'Image sha256 sum not provided to verification service',
			};
		}

		const actual = env.sha256_file(OUTPUTBIN);
		if (!actual || lc(actual) != lc(sum)) {
			return {
				status: 'SHAMismatchError',
				error: 'Image sha256 sum does not match expected value',
			};
		}

		return { status: 'VerifyOK', message: 'Success' };
	}

	return { query, search, download, stat, verify };
}

// `export { ... }` (rather than `export function name()`) for compatibility
// with the ucode on target, whose parser predates the export-declaration form.
export { parse_version, is_newer, get_upgrade_rule, format_size, create };
