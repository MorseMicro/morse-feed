'use strict';

import * as nl80211 from "nl80211";
import * as fs from "fs";
import { ulog, WARN, LOG_DEBUG } from "log";

import { normalize_mac } from "morselinkeval.util";

function DBG(...args) { ulog(LOG_DEBUG, ...args); }

const CHIP_MM8108 = "MM8108";
const CHIP_MM6108 = "MM6108";

const MORSE_CLI_STATS_MAP = {
	"Current Operating BW (MHz)":            "current_op_bw_mhz",
	"Packet Detect fired STF":               "stf_pd_fired",
	"Packet Detect fired LTF":               "ltf_pd_fired",
	"Corr2S energy":                         "corr2s_energy",
	"Received power (dBm)":                  "received_pwr",
	"Detected channel BW (Hz)":              "channel_bandwidth",
	"AGC false trigger":                     "agc_false_trigger",
	"AGC false trigger gain code":           "agc_false_trigger_gc",
	"AGC interference detected":             "agc_intrf_detected",
	"Noise (dBm)":                           "noise_dbm",
	"Medium energy (dBm)":                   "medium_energy_dbm",
	"Narrowband interference power (dBm)":   "nb_intrf_power_dbm",
	"Narrowband interference detected":      "nb_intrf_detected",
	"RX NDP not for us":                     "rx_ndp_not_for_us",
};

function as_number(value) {
	return type(value) == "int" || type(value) == "double" ? value : null;
}

function sanitize_rssi(value) {
	const n = as_number(value);
	return n != null && n < 0 ? n : null;
}

/* Received power validity, matching the Python reference's (-100, 0) window:
 * firmware emits 0/positive or <= -100 dBm sentinels when there is no valid
 * reading. Without this filter a no-connection floor sample (e.g. -128 dBm)
 * would dominate rx_power_stats.min and flip the link-stability verdict. */
function sanitize_rx_power(value) {
	const n = as_number(value);
	return n != null && n > -100 && n < 0 ? n : null;
}

function now_ms() {
	const t = clock(true);
	return t[0] * 1000 + int(t[1] / 1e6);
}

/* Active Morse stats reader. Pull the JSON snapshot from morse_cli and map
 * the small subset of fields the link-quality math consumes onto the internal
 * names listed in MORSE_CLI_STATS_MAP above. */
function fetch_morse_stats(ifname) {
	const proc = fs.popen(`morse_cli -i ${ifname} stats -j 2>/dev/null`, "r");
	if (!proc) {
		WARN("morse_cli stats on %s: popen failed", ifname);
		return {};
	}

	const out = proc.read("all");
	const rc = proc.close();

	if (rc != 0) {
		WARN("morse_cli stats on %s: exit=%s", ifname, rc);
		return {};
	}

	if (!out) {
		WARN("morse_cli stats on %s: empty output", ifname);
		return {};
	}

	const raw = json(out);
	if (type(raw) != "object") {
		WARN("morse_cli stats on %s: unexpected output: %s", ifname, out);
		return {};
	}

	const stats = {};
	for (let label, name in MORSE_CLI_STATS_MAP) {
		const value = raw[label];
		if (value != null)
			stats[name] = value;
	}

	return stats;
}

/* morse_cli stats are radio-wide, not interface-scoped — ifname is just the
 * control-socket handle. One cached snapshot serves every Sampler regardless
 * of which session ticks first. Whichever caller misses the TTL pays the
 * fork; siblings within the window reuse. On failure, ts_ms is not advanced,
 * so the next call retries and the current tick sees an empty snapshot (the
 * pre-cache behaviour analytics is tuned for). */
let _stats_cache = { ts_ms: 0, stats: {} };

function get_morse_stats(ifname, max_age_ms) {
	const now = now_ms();
	if (now - _stats_cache.ts_ms < max_age_ms)
		return _stats_cache.stats;

	const fresh = fetch_morse_stats(ifname);
	if (length(fresh)) {
		_stats_cache.stats = fresh;
		_stats_cache.ts_ms = now;
		return fresh;
	}

	return {};
}

function get_nl_uphy_stats(ifname) {
	return get_nl_morse_stats(ifname, MORSE_UPHY_STATS_REQUEST, MORSE_UPHY_TAGS);
}

function get_nl_mac_stats(ifname) {
	return get_nl_morse_stats(ifname, MORSE_MAC_STATS_REQUEST, MORSE_MAC_TAGS);
}

function get_channel_info(ifname) {
	const proc = fs.popen(`morse_cli -i ${ifname} channel -j 2>/dev/null`, "r");
	if (!proc) {
		WARN("morse_cli channel on %s: popen failed", ifname);
		return null;
	}

	const out = proc.read("all");
	proc.close();

	if (!out) {
		WARN("morse_cli channel on %s: empty output", ifname);
		return null;
	}

	const j = json(out);
	if (type(j) != "object" || j.channel_frequency == null) {
		WARN("morse_cli channel on %s: unexpected output: %s", ifname, out);
		return null;
	}

	return {
		freq_mhz:         int(j.channel_frequency / 1000),
		bw_mhz:           j.channel_op_bw,
		primary_bw_mhz:   j.channel_primary_bw,
		primary_chan_idx: j.channel_index,
	};
}

/* Subcarrier count tables for the 5 GHz shim → S1G bandwidth mapping.
 * Mirrors dot11ah_channel.c:s1g_rate(). */
const SC_MAP_5G  = [[20, 52], [40, 108], [80, 234], [160, 468]];
const SC_MAP_S1G = [[20, 24], [40,  52], [80, 108], [160, 234]];

/* Scale a 5 GHz shim-layer rate (kbps) down to the actual S1G rate using the
 * subcarrier count ratio.  frq_mhz is the shim bandwidth (20/40/80/160);
 * unknown values fall back to dividing by 20 (the 1 MHz channel approximation). */
function s1g_rate(five_g_rate, frq_mhz) {
	let scale = 20;
	for (let i = 0; i < length(SC_MAP_5G); i++) {
		if (SC_MAP_5G[i][0] == frq_mhz) {
			scale = int(10 * SC_MAP_5G[i][1] / SC_MAP_S1G[i][1]);
			break;
		}
	}
	return int(five_g_rate / scale);
}

/* Mirror iwinfo _sanitise_rate_entry + nl80211_parse_rateinfo: extract and
 * sanitize rate (kbps), mcs, and sgi from the nested bitrate object returned
 * by NL80211_CMD_GET_STATION.  Returns null when the object is missing or
 * carries no usable information. */
function parse_rateinfo(br) {
	if (type(br) != "object")
		return null;

	let rate = null;
	if (type(br.bitrate32) == "int")
		rate = br.bitrate32 * 100;
	else if (type(br.bitrate) == "int")
		rate = br.bitrate * 100;

	let mcs = null;
	if (type(br.mcs) == "int")
		mcs = br.mcs;
	else if (type(br.vht_mcs) == "int")
		mcs = br.vht_mcs;
	else if (type(br.he_mcs) == "int")
		mcs = br.he_mcs;
	else if (type(br.eht_mcs) == "int")
		mcs = br.eht_mcs;

	const sgi = br.short_gi ? true : false;

	if (rate == null && mcs == null)
		return null;

	/* Sanitize: the S1G driver reports rates via the 5 GHz HT/VHT shim layer.
	 * Determine the shim bandwidth from the width flags, then scale the rate
	 * down to the actual HaLow value using the subcarrier count ratio. */
	if (rate != null) {
		let mhz = 20;
		if (br.width_160 || br.width_80p80)
			mhz = 160;
		else if (br.width_80)
			mhz = 80;
		else if (br["40_mhz_width"] || br.width_40)
			mhz = 40;

		rate = s1g_rate(rate, mhz);
	}

	return { rate, mcs, sgi };
}

function set_medium_eval(ifname, enabled) {
	const action = enabled ? "enable" : "disable";
	const proc = fs.popen(`morse_cli -i ${ifname} medium_eval ${action} 2>/dev/null`, "r");
	if (!proc) {
		WARN("morse_cli medium_eval %s on %s: popen failed", action, ifname);
		return false;
	}

	proc.read("all");
	const rc = proc.close();
	if (rc != 0) {
		WARN("morse_cli medium_eval %s on %s: exit=%s", action, ifname, rc);
		return false;
	}

	DBG("morse_cli medium_eval %s on %s: ok", action, ifname);
	return true;
}

function read_chip(ifname) {
	const proc = fs.popen(`morse_cli -i ${ifname} hw_version 2>/dev/null`, "r");
	if (!proc) {
		WARN("morse_cli hw_version on %s: popen failed", ifname);
		return null;
	}

	const out = proc.read("all");
	const rc = proc.close();

	if (rc != 0 || !out) {
		WARN("morse_cli hw_version on %s: exit=%s", ifname, rc);
		return null;
	}

	const m = match(out, /HW[^:]*:[ \t]*([^ \t\r\n]+)/);
	const raw = m ? uc(m[1]) : null;

	if (raw != null && index(raw, "MM81") == 0)
		return CHIP_MM8108;
	if (raw != null && index(raw, "MM61") == 0)
		return CHIP_MM6108;

	WARN("morse_cli hw_version on %s: unrecognised chip '%s'", ifname, raw != null ? raw : out);
	return null;
}

/* The chip family is fixed for the device's lifetime, so it is detected once
 * and cached (including a failed null). */
let _chip = null;
let _chip_detected = false;

/* Cached Morse chip family, read from morse_cli on first call: CHIP_MM8108,
 * CHIP_MM6108, or null when detection failed (treated as MM8108 downstream). */
function get_chip(ifname) {
	if (_chip_detected)
		return _chip;

	_chip = read_chip(ifname);
	_chip_detected = true;
	return _chip;
}

/* Highest of the three noise/interference indicators in the morse_cli stats,
 * or null if none are valid. Firmware uses positive sentinels (0, 1, etc.) for
 * "no reading" on some fields, so reject anything not in a plausible dBm range. */
function max_noise_dbm(fields) {
	const candidates = [];
	for (let name in [ "noise_dbm", "medium_energy_dbm", "nb_intrf_power_dbm" ]) {
		const n = as_number(fields[name]);
		/* Python keeps -100 dB as boundary for noise. Fix needed in python? */
		if (n != null && n > -140 && n < 0)
			push(candidates, n);
	}

	if (!length(candidates))
		return null;

	return sort(candidates, (a, b) => a - b)[length(candidates) - 1];
}

/* Channel bandwidth fields from the morse_cli stats snapshot. Two distinct
 * concepts:
 *   - current_bw_mhz: the driver's configured operating bandwidth — what
 *     data packets to/from the peer use. Stable for a session.
 *   - detected_bw_hz: the bandwidth of the most recently received packet —
 *     varies per RX (e.g. 2 MHz mgmt vs 8 MHz data within an 8 MHz session). */
function channel_bw(fields) {
	const current_bw_mhz = as_number(fields.current_op_bw_mhz);
	const detected_bw_hz = as_number(fields.channel_bandwidth);

	return {
		current_bw_mhz: current_bw_mhz > 0 ? current_bw_mhz : null,
		detected_bw_hz: detected_bw_hz > 0 ? detected_bw_hz : null,
	};
}

/* Look up an interface in NL80211_CMD_GET_INTERFACE and return a normalized
 * snapshot: { iftype, tx_power_dbm }. Returns null if the interface isn't
 * present in the dump or the iftype isn't one we support.
 *   iftype       — "ap" | "sta"
 *   tx_power_dbm — float (mBm/100), or null when the kernel didn't report it */
function get_interface_info(ifname) {
	let interfaces = nl80211.request(
		nl80211.const.NL80211_CMD_GET_INTERFACE,
		nl80211.const.NLM_F_DUMP
	);
	if (interfaces == null)
		interfaces = [];

	for (let iface in interfaces) {
		if (iface.ifname != ifname)
			continue;

		let iftype = null;
		switch (iface.iftype) {
		case nl80211.const.NL80211_IFTYPE_AP:      iftype = "ap";  break;
		case nl80211.const.NL80211_IFTYPE_STATION: iftype = "sta"; break;
		}
		if (!iftype)
			return null;

		const mbm = iface.wiphy_tx_power_level;
		const tx_power_dbm = (type(mbm) == "int" || type(mbm) == "double")
			? mbm / 100
			: null;

		return { iftype, tx_power_dbm };
	}

	return null;
}

/* Query nl80211 for the given peer's station info on ifname and return the
 * sta_info subobject. Returns null if peer_mac is missing, the netlink query
 * yields no station, or the station response carries no sta_info. */
function get_station_info(ifname, peer_mac) {
	if (!peer_mac)
		return null;

	nl80211.error();
	const result = nl80211.request(
		nl80211.const.NL80211_CMD_GET_STATION,
		0,
		{ dev: ifname, mac: peer_mac }
	);

	let station = null;
	if (type(result) == "array")
		station = length(result) ? result[0] : null;
	else if (result)
		station = result;

	return station ? station.sta_info : null;
}

function get_connected_bssid(ubus, ifname) {
	const res = ubus.call("iwinfo", "assoclist", { device: ifname });
	if (type(res) != "object" || type(res.results) != "array" || !length(res.results))
		return null;

	return normalize_mac(res.results[0].mac);
}

function csv_field(value) {
	return value == null ? "" : `${value}`;
}

/* Sample is the value-object form of one collected snapshot. It owns the
 * schema (via Sample.empty) and the per-instance behaviour (is_valid, to_csv). */
const Sample = {
	/* All fields a Sample can carry. Sets the schema in one place; both
	 * Sample.empty() and Sampler.collect_morse_stats/collect_peer_stats key
	 * off it. */
	FIELDS: [
		"peer",
		"rssi",
		"signal",
		"signal_avg",
		"rx_power",
		"max_noise",
		"current_bw_mhz",
		"detected_bw_hz",
		"agc_false_trigger",
		"agc_false_trigger_gc",
		"agc_intrf_detected",
		"corr2s_energy",
		"nb_intrf_detected",
		"stf_pd_fired",
		"ltf_pd_fired",
		"rx_ndp_not_for_us",
		"rx",
		"tx",
	],

	new: function (fields) {
		return proto(fields, this);
	},

	/* A zeroed Sample. Used by Sampler as its long-lived pending buffer
	 * and as the source for fresh per-tick copies. */
	empty: function () {
		const fields = {};
		for (let k in this.FIELDS)
			fields[k] = null;
		return this.new(fields);
	},

	/* Reset all fields to null in place. Called between ticks so a quiet
	 * data source doesn't leak stale values into the next sample. */
	clear: function () {
		for (let k in this.FIELDS)
			this[k] = null;
	},

	is_valid: function () {
		return this.rssi != null || this.rx_power != null;
	},

	to_csv: function () {
		return `${csv_field(this.rssi)},${csv_field(this.signal)},${csv_field(this.signal_avg)},${csv_field(this.rx_power)},${csv_field(this.max_noise)},${csv_field(this.agc_false_trigger)},${csv_field(this.agc_false_trigger_gc)}`;
	},
};


const Sampler = {
	new: function (ifname, peer_mac, interval_ms) {
		return proto({
			ifname,
			peer_mac,
			/* Half-interval TTL: when N samplers tick roughly together the
			 * first call hits morse_cli and the rest reuse the snapshot. */
			max_stats_age_ms: int(interval_ms / 2),
			scratch: Sample.empty(),
		}, this);
	},

	set_peer: function (peer_mac) {
		this.peer_mac = peer_mac;
	},

	/* Read Morse stats via morse_cli and write the stats-side fields into
	 * scratch. No validation here — Sample.is_valid() decides what's usable. */
	collect_morse_stats: function () {
		const stats = get_morse_stats(this.ifname, this.max_stats_age_ms);
		const bw    = channel_bw(stats);

		this.scratch.rx_power             = sanitize_rx_power(stats.received_pwr);
		this.scratch.max_noise            = max_noise_dbm(stats);
		this.scratch.current_bw_mhz       = bw.current_bw_mhz;
		this.scratch.detected_bw_hz       = bw.detected_bw_hz;
		this.scratch.agc_false_trigger    = as_number(stats.agc_false_trigger);
		this.scratch.agc_false_trigger_gc = as_number(stats.agc_false_trigger_gc);
		this.scratch.agc_intrf_detected   = as_number(stats.agc_intrf_detected);
		this.scratch.corr2s_energy        = as_number(stats.corr2s_energy);
		this.scratch.nb_intrf_detected    = as_number(stats.nb_intrf_detected);
		this.scratch.stf_pd_fired         = as_number(stats.stf_pd_fired);
		this.scratch.ltf_pd_fired         = as_number(stats.ltf_pd_fired);
		this.scratch.rx_ndp_not_for_us    = as_number(stats.rx_ndp_not_for_us);
	},

	collect_peer_stats: function () {
		this.scratch.peer = this.peer_mac;

		const sta_info = get_station_info(this.ifname, this.peer_mac);
		if (!sta_info)
			return;

		const signal = sta_info.signal;
		const signal_avg = sta_info.signal_avg;
		let rssi = sanitize_rssi(signal);

		if (rssi == null)
			rssi = sanitize_rssi(signal_avg);

		this.scratch.rssi       = rssi;
		this.scratch.signal     = signal;
		this.scratch.signal_avg = signal_avg;
		this.scratch.rx         = parse_rateinfo(sta_info.rx_bitrate);
		this.scratch.tx         = parse_rateinfo(sta_info.tx_bitrate);
	},

	collect: function () {
		this.scratch.clear();
		this.collect_morse_stats();
		this.collect_peer_stats();

		return Sample.new({...this.scratch});
	},
};

export {
	get_interface_info,
	get_station_info,
	get_channel_info,
	get_connected_bssid,
	set_medium_eval,
	get_chip,
	CHIP_MM8108,
	CHIP_MM6108,
	Sample,
	Sampler
};
