'use strict';

import { ulog, WARN, LOG_DEBUG } from "log";
import { log as ln } from "math";

import * as mcs_table from "morselinkeval.mcs_table";
import { round1 } from "morselinkeval.util";

function DBG(...args) { ulog(LOG_DEBUG, ...args); }

const AGC_DIFF_THRESHOLD    = 10;
const NOISE_FIGURE_DB       = 5;
const AGC_GAIN_CODE_STEP_DB = 3;
const STABILITY_MARGIN_DB   = 3;

/* Per-bandwidth thermal noise floor base (dBm), keyed by detected_bw_hz. */
const NOISE_FLOOR_BASE = {
	"1000000": -114,
	"2000000": -111,
	"4000000": -108,
	"8000000": -105,
};

/* ---------------------------------------------------------------------------
 * Statistical helpers
 * --------------------------------------------------------------------------- */

function dominant(values) {
	const counts = {};
	let best_value = null;
	let best_count = -1;

	for (let value in values) {
		if (value == null)
			continue;

		if (counts[value] == null)
			counts[value] = 0;
		counts[value]++;

		if (counts[value] > best_count) {
			best_count = counts[value];
			best_value = value;
		}
	}

	return best_value;
}

function median(sorted_values) {
	const n = length(sorted_values);

	if (!n)
		return null;

	const mid = int(n / 2);
	if (n % 2)
		return sorted_values[mid];

	return round1((sorted_values[mid - 1] + sorted_values[mid]) / 2);
}

function summarise(values) {
	const valid = filter(values, (value) => value != null);
	if (!length(valid))
		return null;

	const sorted_values = sort(slice(valid), (a, b) => a - b);
	let sum = 0;

	for (let value in sorted_values)
		sum += value;

	const n = length(sorted_values);

	return {
		count: n,
		min: sorted_values[0],
		max: sorted_values[n - 1],
		average: round1(sum / n),
		median: median(sorted_values),
		q1: sorted_values[int(n * 0.25)],
		q3: sorted_values[int(n * 0.75)],
	};
}

/* ---------------------------------------------------------------------------
 * MCS lookup and quality classification
 * --------------------------------------------------------------------------- */

function get_max_operable_mcs(snr_db, bw_mhz) {
	/* Check standard MCS values first and only consider MCS10 as a
	 * last-resort fallback below MCS0. */
	for (let mcs in [ 9, 8, 7, 6, 5, 4, 3, 2, 1, 0 ]) {
		const required = mcs_table.required_snr(mcs, bw_mhz);
		if (required != null && snr_db >= required)
			return { mcs, req_snr: required };
	}

	const required = mcs_table.required_snr(10, bw_mhz);
	if (required != null && snr_db >= required)
		return { mcs: 10, req_snr: required };

	return { mcs: null, req_snr: null };
}

function classify_link_quality(mcs) {
	if (mcs == null || mcs == 10)
		return "Very Poor";
	if (mcs > 6)
		return "Excellent";
	if (mcs >= 4)
		return "Good";
	if (mcs >= 2)
		return "Moderate";
	return "Low";
}

function compute_snr_scenario(rssi_dbm, noise_dbm, bw_mhz) {
	const snr_db = rssi_dbm - noise_dbm;
	const res = get_max_operable_mcs(snr_db, bw_mhz);

	return {
		rssi_dbm,
		noise_dbm,
		snr_db: round1(snr_db),
		max_mcs: res.mcs != null ? res.mcs : 0,
		req_snr: res.req_snr,
		quality: classify_link_quality(res.mcs),
	};
}

function complete_link_quality(rssi_stats, max_noise_stats, bw_mhz, overall_max_nf) {
	if (!rssi_stats || !max_noise_stats || !bw_mhz) {
		WARN("mcs_quality unavailable: rssi=%s noise=%s bw_mhz=%s",
			rssi_stats ? "ok" : "null",
			max_noise_stats ? "ok" : "null",
			bw_mhz);
		return null;
	}

	const worst_noise = overall_max_nf != null ? overall_max_nf : max_noise_stats.max;

	return {
		bw_mhz,
		rssi: {
			median: rssi_stats.median,
			q1: rssi_stats.q1,
			min: rssi_stats.min,
		},
		noise: {
			median: max_noise_stats.median,
			q3: max_noise_stats.q3,
			max: max_noise_stats.max,
			worst: worst_noise,
		},
		typical: compute_snr_scenario(rssi_stats.median, max_noise_stats.median, bw_mhz),
		conservative: compute_snr_scenario(rssi_stats.q1, max_noise_stats.q3, bw_mhz),
		worst_case: compute_snr_scenario(rssi_stats.min, worst_noise, bw_mhz),
	};
}

/* ---------------------------------------------------------------------------
 * AGC-derived thermal noise floor and link stability
 * --------------------------------------------------------------------------- */

/* AGC-derived thermal noise floor. Uses each sample's detected_bw_hz at the
 * AGC trigger event — the thermal NF base table is keyed by the actual RX
 * passband, which can differ packet-to-packet from the operating bandwidth. */
function compute_agc_noise_floor(samples) {
	const intervals = [];
	const max_noise_values = filter(map(samples, (sample) => sample.max_noise), (value) => value != null);
	const max_noise_dbm = length(max_noise_values)
		? sort(slice(max_noise_values), (a, b) => a - b)[length(max_noise_values) - 1]
		: null;

	for (let i = 1; i < length(samples); i++) {
		const prev = samples[i - 1];
		const cur = samples[i];

		if (prev.agc_false_trigger == null || cur.agc_false_trigger == null ||
		    cur.agc_false_trigger_gc == null || cur.detected_bw_hz == null)
			continue;

		const diff = cur.agc_false_trigger - prev.agc_false_trigger;
		if (diff <= AGC_DIFF_THRESHOLD)
			continue;

		const base = NOISE_FLOOR_BASE[cur.detected_bw_hz];
		if (base == null)
			continue;

		/* The off-chip tool uses a fixed 5 dB receiver noise figure and
		 * 3 dB per AGC gain-code step when estimating thermal noise floor. */
		const thermal_nf = base + NOISE_FIGURE_DB + cur.agc_false_trigger_gc * AGC_GAIN_CODE_STEP_DB;
		push(intervals, {
			agc_diff: diff,
			gain_code: cur.agc_false_trigger_gc,
			detected_bw_hz: cur.detected_bw_hz,
			thermal_nf,
		});
	}

	if (!length(intervals)) {
		return {
			triggered: false,
			intervals: [],
			max_noise_dbm,
			detected_bw_mhz: null,
			overall_max_nf: null,
		};
	}

	const thermal_values = map(intervals, (interval) => interval.thermal_nf);
	const max_thermal_nf = sort(slice(thermal_values), (a, b) => a - b)[length(thermal_values) - 1];
	const overall_max_nf = max_noise_dbm != null && max_noise_dbm > max_thermal_nf
		? max_noise_dbm
		: max_thermal_nf;

	DBG("agc_noise_floor: %d intervals, max_thermal_nf=%ddBm, max_noise=%sdBm, overall_max_nf=%ddBm",
		length(intervals), max_thermal_nf,
		max_noise_dbm != null ? max_noise_dbm : "n/a",
		overall_max_nf);

	/* detected_bw_mhz is the dominant detected bandwidth across triggered
	 * intervals. Used by link-stability's MCS0 threshold lookup so the noise
	 * floor (computed at detected BW) and the SNR requirement reference the
	 * same bandwidth. */
	const bw_hz_values = filter(map(intervals, (i) => i.detected_bw_hz), (v) => v > 0);
	const dominant_bw_hz = dominant(bw_hz_values);

	return {
		triggered: true,
		intervals,
		max_noise_dbm,
		max_thermal_nf,
		detected_bw_mhz: dominant_bw_hz ? int(dominant_bw_hz / 1000000) : null,
		overall_max_nf,
	};
}

function compute_link_stability(rssi_stats, rx_power_stats, agc_noise_floor) {
	if (!agc_noise_floor || !agc_noise_floor.triggered) {
		return {
			agc_triggered: false,
			impacted: false,
			reason: "No AGC false trigger spikes detected",
		};
	}

	const noise_ref = agc_noise_floor.overall_max_nf;
	/* Use the AGC's detected bandwidth — same passband the noise floor
	 * was computed at — so the MCS0 threshold reference is consistent. */
	let bw_mhz = agc_noise_floor.detected_bw_mhz;
	if (bw_mhz == null)
		bw_mhz = 8;
	let min_signal = null;
	let signal_source = null;

	if (rssi_stats) {
		min_signal = rssi_stats.min;
		signal_source = "RSSI";
	} else if (rx_power_stats) {
		min_signal = rx_power_stats.min;
		signal_source = "Received Power";
	} else {
		return {
			agc_triggered: true,
			impacted: false,
			noise_ref,
			bw_mhz,
			reason: "Missing RSSI and Received Power samples",
		};
	}

	let mcs0_snr = mcs_table.mcs0_required_snr(bw_mhz);
	if (mcs0_snr == null)
		mcs0_snr = mcs_table.mcs0_required_snr(8);

	const min_snr2 = min_signal - noise_ref;
	const threshold = mcs0_snr + STABILITY_MARGIN_DB;
	const impacted = min_snr2 < threshold;

	return {
		agc_triggered: true,
		min_signal,
		signal_source,
		noise_ref,
		bw_mhz,
		min_snr2: round1(min_snr2),
		mcs0_snr,
		threshold,
		impacted,
		reason: impacted
			? "Interference can introduce instabilities"
			: "Link is stable",
	};
}

/* ---------------------------------------------------------------------------
 * Interference characterisation — pairwise scan over the window detecting
 * five interference categories from per-sample counters and corr2s energy.
 * Mirrors halow_link_quality.py:parse_interference_characteristics.
 * --------------------------------------------------------------------------- */

const CORR2S_CELLULAR        = 2;     /* very high-power OOB (cellular) */
const CORR2S_CLOSE_CHANNEL   = 7;     /* high power close to channel */
/* Note: corr2s == 255 is a firmware sentinel for "no reading"; the explicit
 * equality checks below filter it out naturally. */
const STF_LTF_DELTA_MIN      = 10;    /* STF deltas below this are noise */
const STF_LTF_RATIO          = 1.5;   /* STF/LTF ratio for adjacent-channel */
const ADJACENT_FRACTION_GATE = 0.10;  /* 10% of intervals must flag */

function compute_interference(samples) {
	const flags = {
		cellular_suspected:        false,
		in_channel_detected:       false,
		close_channel_detected:    false,
		same_channel_detected:     false,
		adjacent_channel_detected: false,
	};

	if (length(samples) < 2)
		return flags;

	let adjacent_flagged_intervals = 0;
	const total_intervals          = length(samples) - 1;

	for (let i = 0; i < length(samples); i++) {
		const cur = samples[i];

		/* Per-sample: cellular detection (any sample). */
		if (cur.corr2s_energy == CORR2S_CELLULAR)
			flags.cellular_suspected = true;

		if (i == 0)
			continue;

		const prev = samples[i - 1];

		/* NB counter incrementing → in-channel interference. */
		const nb_diff = (cur.nb_intrf_detected != null && prev.nb_intrf_detected != null)
			? cur.nb_intrf_detected - prev.nb_intrf_detected
			: 0;
		if (nb_diff > 0)
			flags.in_channel_detected = true;

		/* RX NDP not for us incrementing → traffic from same-channel HaLow. */
		const halow_diff = (cur.rx_ndp_not_for_us != null && prev.rx_ndp_not_for_us != null)
			? cur.rx_ndp_not_for_us - prev.rx_ndp_not_for_us
			: 0;
		if (halow_diff > 0)
			flags.same_channel_detected = true;

		/* Corr2S == 7 with no NB increment → close-channel interference. */
		if (cur.corr2s_energy == CORR2S_CLOSE_CHANNEL && nb_diff == 0)
			flags.close_channel_detected = true;

		/* STF >> LTF: preambles detected but frames not decoded —
		 * suggests adjacent/overlapping HaLow channel. */
		if (cur.stf_pd_fired != null && cur.ltf_pd_fired != null &&
		    prev.stf_pd_fired != null && prev.ltf_pd_fired != null) {
			const d_stf = cur.stf_pd_fired - prev.stf_pd_fired;
			const d_ltf = cur.ltf_pd_fired - prev.ltf_pd_fired;
			if (d_stf > STF_LTF_DELTA_MIN && d_stf > STF_LTF_RATIO * d_ltf)
				adjacent_flagged_intervals++;
		}
	}

	if (total_intervals > 0 &&
	    (adjacent_flagged_intervals / total_intervals) > ADJACENT_FRACTION_GATE)
		flags.adjacent_channel_detected = true;

	return flags;
}

/* ---------------------------------------------------------------------------
 * Top-level result and wire shaping
 * --------------------------------------------------------------------------- */

/* Walk samples newest-first and return the first non-null value for field. */
function last_valid(samples, field) {
	for (let i = length(samples) - 1; i >= 0; i--) {
		if (samples[i][field] != null)
			return samples[i][field];
	}
	return null;
}

/* Compute the wireless metrics for a window of samples. Returns the
 * per-peer wire body that PeerSession embeds under the peer key. */
function build_peer_result(samples) {
	const rssi_stats = summarise(map(samples, (sample) => sample.rssi));
	const rx_power_stats = summarise(map(samples, (sample) => sample.rx_power));
	const max_noise_stats = summarise(map(samples, (sample) => sample.max_noise));
	const bw_mhz = dominant(map(samples, (sample) => sample.current_bw_mhz));
	const current_rx = last_valid(samples, "rx");
	const current_tx = last_valid(samples, "tx");
	const agc_noise_floor = compute_agc_noise_floor(samples);
	const mcs_quality = complete_link_quality(
		rssi_stats,
		max_noise_stats,
		bw_mhz,
		agc_noise_floor.overall_max_nf
	);
	const link_stability = compute_link_stability(rssi_stats, rx_power_stats, agc_noise_floor);
	const interference = compute_interference(samples);

	DBG("build_peer_result: n=%d bw=%s mcs_quality=%s impacted=%s findings=[%s%s%s%s%s]",
		length(samples),
		bw_mhz,
		mcs_quality ? mcs_quality.typical.quality : "null",
		link_stability.impacted,
		interference.cellular_suspected        ? "cellular " : "",
		interference.in_channel_detected       ? "in_channel " : "",
		interference.close_channel_detected    ? "close_channel " : "",
		interference.same_channel_detected     ? "same_channel " : "",
		interference.adjacent_channel_detected ? "adjacent_channel" : "");

	return {
		current: {
			rx: current_rx,
			tx: current_tx,
		},
		rssi: mcs_quality ? mcs_quality.rssi : null,
		noise: mcs_quality ? mcs_quality.noise : null,
		mcs_quality: mcs_quality ? {
			bw_mhz: mcs_quality.bw_mhz,
			typical: mcs_quality.typical,
			conservative: mcs_quality.conservative,
			worst_case: mcs_quality.worst_case,
		} : null,
		link_stability: {
			agc_triggered:             link_stability.agc_triggered,
			impacted:                  link_stability.impacted,
			cellular_suspected:        interference.cellular_suspected,
			in_channel_detected:       interference.in_channel_detected,
			close_channel_detected:    interference.close_channel_detected,
			same_channel_detected:     interference.same_channel_detected,
			adjacent_channel_detected: interference.adjacent_channel_detected,
		},
	};
}

/* ---------------------------------------------------------------------------
 * Link planning — predicted RSSI from propagation model + measured noise.
 * Mirrors halow_link_quality.py:run_link_planning.
 * --------------------------------------------------------------------------- */

const PLAN_FADE_MARGIN_DB  = 10;   /* fade margin for worst-case RSSI */
const PLAN_FSPL_CONST      = 32;   /* free-space path loss constant (dB) */

/* Free-space path loss in dB at distance d (metres):  FSPL = 32 + 20·log10(d).
 * The constant 32 absorbs the 915 MHz frequency term per the Python reference. */
function fspl_db(distance_m) {
	/* ucode's math module exports natural log only; derive log10. */
	return PLAN_FSPL_CONST + 20 * (ln(distance_m) / ln(10));
}

/* Compute the propagation-model output. Required inputs:
 *   tx_power_dbm, freq_mhz, bw_mhz   — read from the driver at session start
 *   distance_m or attenuation_db     — user-supplied (one or the other)
 * Optional:
 *   fade_margin_db                   — user override, defaults to 10
 * Output is settled at session creation time and never changes during the run. */
function compute_planning_estimate(p) {
	const tx_power_dbm   = p.tx_power_dbm;
	const freq_mhz       = p.freq_mhz;
	const bw_mhz         = p.bw_mhz;
	const fade_margin_db = p.fade_margin_db != null ? p.fade_margin_db : PLAN_FADE_MARGIN_DB;

	let model, distance_m, attenuation_db, path_loss_db;
	if (p.attenuation_db != null) {
		model          = "manual";
		attenuation_db = p.attenuation_db;
		path_loss_db   = p.attenuation_db;
	} else {
		model          = "fspl";
		distance_m     = p.distance_m;
		path_loss_db   = round1(fspl_db(distance_m));
	}

	const rssi_typical_dbm = round1(tx_power_dbm - path_loss_db);
	const rssi_worst_dbm   = round1(rssi_typical_dbm - fade_margin_db);

	return {
		model,
		freq_mhz,
		bw_mhz,
		distance_m,
		attenuation_db,
		tx_power_dbm,
		fade_margin_db,
		path_loss_db,
		rssi_typical_dbm,
		rssi_worst_dbm,
	};
}

/* Build a synthetic rssi_stats dict from the two predicted RSSI values, in
 * the same shape summarise() produces — so compute_mcs_quality can run
 * unchanged. Q1=worst, Q3=typical mirrors the Python reference (see
 * halow_link_quality.py:1504-1513). The three SNR scenarios then resolve to:
 *   typical      — rssi_typical vs noise.median
 *   conservative — rssi_worst   vs noise.q3
 *   worst_case   — rssi_worst   vs noise.worst */
function synthesise_rssi_stats(rssi_typical, rssi_worst) {
	return {
		count:   2,
		min:     rssi_worst,
		max:     rssi_typical,
		average: round1((rssi_typical + rssi_worst) / 2),
		median:  rssi_typical,
		q1:      rssi_worst,
		q3:      rssi_typical,
	};
}

/* Planning-mode counterpart to build_peer_result. Same noise/AGC/interference math
 * applied to the sampled window, but RSSI is synthesised from the propagation
 * estimate and bw_mhz is forced (the window's own current_bw_mhz is irrelevant
 * to a planned deployment). */
function build_planning_result(samples, estimate, bw_mhz) {
	const rssi_stats      = synthesise_rssi_stats(estimate.rssi_typical_dbm,
	                                              estimate.rssi_worst_dbm);
	const max_noise_stats = summarise(map(samples, (sample) => sample.max_noise));
	const agc_noise_floor = compute_agc_noise_floor(samples);
	const mcs_quality = complete_link_quality(
		rssi_stats,
		max_noise_stats,
		bw_mhz,
		agc_noise_floor.overall_max_nf
	);
	const link_stability = compute_link_stability(rssi_stats, null, agc_noise_floor);
	const interference   = compute_interference(samples);

	DBG("build_planning_result: n=%d model=%s bw=%s rssi_typ=%s rssi_worst=%s mcs_quality=%s",
		length(samples), estimate.model, bw_mhz,
		estimate.rssi_typical_dbm, estimate.rssi_worst_dbm,
		mcs_quality ? mcs_quality.typical.quality : "null");

	return {
		estimate,
		noise: mcs_quality ? mcs_quality.noise : null,
		mcs_quality: mcs_quality ? {
			bw_mhz: mcs_quality.bw_mhz,
			typical: mcs_quality.typical,
			conservative: mcs_quality.conservative,
			worst_case: mcs_quality.worst_case,
		} : null,
		link_stability: {
			agc_triggered:             link_stability.agc_triggered,
			impacted:                  link_stability.impacted,
			cellular_suspected:        interference.cellular_suspected,
			in_channel_detected:       interference.in_channel_detected,
			close_channel_detected:    interference.close_channel_detected,
			same_channel_detected:     interference.same_channel_detected,
			adjacent_channel_detected: interference.adjacent_channel_detected,
		},
	};
}

export {
	build_peer_result,
	compute_planning_estimate,
	build_planning_result
};
