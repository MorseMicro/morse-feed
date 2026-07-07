'use strict';

import { INFO, ERR } from "log";

import { positive_number } from "morselinkeval.util";

/* Runtime configuration.
 *
 * The daemon takes every tunable as an optional short command-line argument;
 * anything not supplied falls back to the hardcoded default below. There is no
 * UCI dependency in the ucode layer — the init script is responsible for
 * translating /etc/config/morselinkeval (when present) into these arguments.
 *
 * OPTIONS is the single source of truth: it drives argument parsing, default
 * values and validation. To add a tunable, add one row here.
 *
 *   flag     short command-line flag (must be unique)
 *   key      settings field it populates
 *   default  value used when the flag is omitted
 *   integer  coerce the parsed value to a whole number (e.g. counts)
 */
const OPTIONS = [
	{ flag: "-i", key: "interval_s",             default: 0.5 },
	{ flag: "-w", key: "window_s",               default: 20  },
	{ flag: "-t", key: "idle_timeout_s",         default: 15  },
	{ flag: "-m", key: "max_peer_link_sessions", default: 5, integer: true },
];

function option_for_flag(flag) {
	for (let opt in OPTIONS)
		if (opt.flag == flag)
			return opt;

	return null;
}

/* Number of samples that fit in the rolling window. */
function sample_window_count(window_s, interval_s) {
	let count = int(window_s / interval_s);

	if (count * interval_s < window_s)
		count++;

	return count > 0 ? count : 1;
}

/* Turn ARGV into a { key: raw_string } map, validating flag syntax only.
 * Returns { raw } on success or { error } on a malformed argument list. */
function parse_argv(argv) {
	const raw = {};

	for (let i = 0; i < length(argv); i++) {
		const flag = argv[i];
		const opt = option_for_flag(flag);

		if (!opt)
			return { error: `Unknown option '${flag}'` };

		const value = argv[++i];
		if (value == null)
			return { error: `Missing value for option '${flag}'` };

		raw[opt.key] = value;
	}

	return { raw };
}

const Config = {
	new: function () {
		return proto({
			settings: null,
			error: null,
		}, this);
	},

	fail: function (message) {
		this.settings = null;
		this.error = message;
		ERR("config parse failed: %s", message);
		return false;
	},

	/* Parse command-line arguments into a validated settings snapshot.
	 * Missing arguments fall back to their defaults; invalid values fail. */
	parse: function (argv) {
		const parsed = parse_argv(argv || []);
		if (parsed.error)
			return this.fail(parsed.error);

		const raw = parsed.raw;
		const settings = {};

		for (let opt in OPTIONS) {
			if (raw[opt.key] == null) {
				settings[opt.key] = opt.default;
				continue;
			}

			const value = positive_number(raw[opt.key]);
			if (value == null)
				return this.fail(`Invalid ${opt.key} '${raw[opt.key]}'`);

			settings[opt.key] = opt.integer ? int(value) : value;
		}

		settings.window_size =
			sample_window_count(settings.window_s, settings.interval_s);

		this.settings = settings;
		this.error = null;
		INFO("config parsed: interval=%ss window=%ss samples=%d idle_timeout=%ss max_peer_link_sessions=%d",
			settings.interval_s, settings.window_s, settings.window_size,
			settings.idle_timeout_s, settings.max_peer_link_sessions);
		return true;
	},

	snapshot: function () {
		return this.settings;
	},
};

export {
	Config
};
