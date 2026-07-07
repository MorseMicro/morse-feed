'use strict';

import { ulog, WARN, LOG_DEBUG } from "log";
import { log as ln } from "math";

import * as mcs_table from "morselinkeval.mcs_table";
import { round1, dominant, summarise } from "morselinkeval.util";

function DBG(...args) { ulog(LOG_DEBUG, ...args); }

/* ---------------------------------------------------------------------------
 * The analytics layer is three chip-bound domain objects over a stateful base
 * and two flavour subclasses. The domains are pure — bound to a chip once and
 * fed a summary bundle (see Analytics._summary):
 *
 *   Quality      — MCS lookup + link-quality classification
 *   Stability    — AGC-derived thermal noise floor + link stability
 *   Interference — pairwise interference characterisation
 *
 *   Analytics        — base: owns the sample window, the domains and the shared
 *                      analysis + wire-block builders. Not exported.
 *   PeerAnalytics    — live peer-link flavour: peer_result().
 *   PlannerAnalytics — propagation-model flavour: planning_estimate() /
 *                      planning_result(). Owns the propagation math.
 *
 * Mirrors halow_link_quality.py.
 * --------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * Quality — MCS lookup and link-quality classification. Bound to a chip.
 * --------------------------------------------------------------------------- */

const Quality = {
	new: function (chip) {
		return proto({ chip }, this);
	},

	_max_operable_mcs: function (snr_db, bw_mhz) {
		/* Check standard MCS values first and only consider MCS10 as a
		 * last-resort fallback below MCS0. On MM6108 the 8/9 rows are absent from
		 * the table, so required_snr returns null and they are skipped naturally. */
		for (let mcs in [ 9, 8, 7, 6, 5, 4, 3, 2, 1, 0 ]) {
			const required = mcs_table.required_snr(mcs, bw_mhz, this.chip);
			if (required != null && snr_db >= required)
				return { mcs, req_snr: required };
		}

		const required = mcs_table.required_snr(10, bw_mhz, this.chip);
		if (required != null && snr_db >= required)
			return { mcs: 10, req_snr: required };

		return { mcs: null, req_snr: null };
	},

	_classify: function (mcs) {
		if (mcs == null || mcs == 10)
			return "Very Poor";
		if (mcs > 6)
			return "Excellent";
		if (mcs >= 4)
			return "Good";
		if (mcs >= 2)
			return "Moderate";
		return "Low";
	},

	_snr_scenario: function (rssi_dbm, noise_dbm, bw_mhz) {
		const snr_db = rssi_dbm - noise_dbm;
		const res = this._max_operable_mcs(snr_db, bw_mhz);

		return {
			rssi_dbm,
			noise_dbm,
			snr_db: round1(snr_db),
			max_mcs: res.mcs != null ? res.mcs : 0,
			req_snr: res.req_snr,
			quality: this._classify(res.mcs),
		};
	},

	/* Full link-quality block: rssi/noise summaries plus the three SNR
	 * scenarios (typical / conservative / worst-case). Reads its inputs off the
	 * shared summary bundle `s`. Returns null when a required input is missing. */
	complete: function (s) {
		const rssi_stats = s.rssi_stats;
		const max_noise_stats = s.max_noise_stats;
		const bw_mhz = s.bw_mhz;

		if (!rssi_stats || !max_noise_stats || !bw_mhz) {
			WARN("mcs_quality unavailable: rssi=%s noise=%s bw_mhz=%s",
				rssi_stats ? "ok" : "null",
				max_noise_stats ? "ok" : "null",
				bw_mhz);
			return null;
		}

		const overall_max_nf = s.agc_noise_floor ? s.agc_noise_floor.overall_max_nf : null;
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
			typical: this._snr_scenario(rssi_stats.median, max_noise_stats.median, bw_mhz),
			conservative: this._snr_scenario(rssi_stats.q1, max_noise_stats.q3, bw_mhz),
			worst_case: this._snr_scenario(rssi_stats.min, worst_noise, bw_mhz),
		};
	},
};

/* ---------------------------------------------------------------------------
 * Stability — AGC-derived thermal noise floor and link stability. Per chip.
 * --------------------------------------------------------------------------- */

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

const Stability = {
	new: function (chip) {
		return proto({ chip }, this);
	},

	/* AGC-derived thermal noise floor. Uses each sample's detected_bw_hz at the
	 * AGC trigger event — the thermal NF base table is keyed by the actual RX
	 * passband, which can differ packet-to-packet from the operating bandwidth.
	 * max_noise_stats.max supplies the window's max_noise floor. */
	noise_floor: function (samples, max_noise_stats) {
		const intervals = [];
		const max_noise_dbm = max_noise_stats ? max_noise_stats.max : null;

		/* MM6108 has no AGC gain code to derive a thermal NF from, so the noise
		 * floor is just max(max_noise). Its link-stability trigger comes from
		 * spikes in the cumulative 'AGC interference detected' counter (the
		 * MM6108 equivalent of MM8108's 'AGC false trigger'); this feeds
		 * `triggered` only, never the noise floor. */
		if (this.chip == "MM6108") {
			const intf_values = filter(map(samples, (s) => s.agc_intrf_detected), (v) => v != null);
			let intf_intervals = 0;
			for (let i = 1; i < length(intf_values); i++) {
				if (intf_values[i] - intf_values[i - 1] > AGC_DIFF_THRESHOLD)
					intf_intervals++;
			}

			const bw_hz_values = filter(map(samples, (s) => s.detected_bw_hz), (v) => v > 0);
			const dominant_bw_hz = dominant(bw_hz_values);

			DBG("agc_noise_floor[MM6108]: intf_intervals=%d max_noise=%sdBm",
				intf_intervals, max_noise_dbm != null ? max_noise_dbm : "n/a");

			return {
				triggered: intf_intervals > 0,
				intervals: [],
				max_noise_dbm,
				detected_bw_mhz: dominant_bw_hz ? int(dominant_bw_hz / 1000000) : null,
				overall_max_nf: max_noise_dbm,
			};
		}

		/* Collapse to only fully-populated snapshots (AGC counter, gain code and
		 * detected BW all present) BEFORE diffing, then diff consecutive
		 * survivors — mirroring the Python reference's `snapshots` filter. A
		 * partial sample (AGC counter present but gain code / BW missing) must
		 * not serve as a diff baseline; diffing raw adjacent samples instead
		 * would pair a different AGC baseline and flip the >threshold trigger. */
		const snapshots = filter(samples, (s) =>
			s.agc_false_trigger != null &&
			s.agc_false_trigger_gc != null &&
			s.detected_bw_hz != null);

		for (let i = 1; i < length(snapshots); i++) {
			const prev = snapshots[i - 1];
			const cur = snapshots[i];

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
				/* index = position of this sample in the filtered snapshot list;
				 * a display-only label identifying which snapshot spiked. */
				index: i,
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
	},

	/* Link-stability assessment. Reads rssi_stats / rx_power_stats /
	 * agc_noise_floor off the shared summary bundle `s` (see Analytics._summary). */
	assess: function (s) {
		const rssi_stats = s.rssi_stats;
		const rx_power_stats = s.rx_power_stats;
		const agc_noise_floor = s.agc_noise_floor;

		/* Label for the interference trigger, by chip: MM6108 watches the
		 * 'AGC interference detected' counter, MM8108 the 'AGC false trigger'. */
		const trigger_label = this.chip == "MM6108" ? "AGC interference" : "AGC false trigger spikes";

		/* No trigger spikes = no interference concern = report stable immediately */
		if (!agc_noise_floor || !agc_noise_floor.triggered) {
			return {
				agc_triggered: false,
				impacted: false,
				trigger_label,
				reason: `No ${trigger_label} detected`,
			};
		}

		/* A trigger with no noise floor to reference (MM6108 only: an
		 * interference-counter spike across a window with zero valid noise
		 * readings). Without a noise_ref there is no SNR to compute — null
		 * would coerce to 0 in the min_snr2 subtraction below and yield a
		 * spurious "impacted" verdict, so bail out honestly instead. */
		const noise_ref = agc_noise_floor.overall_max_nf;
		if (noise_ref == null) {
			return {
				agc_triggered: true,
				impacted: false,
				trigger_label,
				noise_ref: null,
				reason: `${trigger_label} detected but no valid noise floor — insufficient noise data`,
			};
		}

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
				trigger_label,
				noise_ref,
				bw_mhz,
				reason: "Missing RSSI and Received Power samples",
			};
		}

		let mcs0_snr = mcs_table.mcs0_required_snr(bw_mhz, this.chip);
		if (mcs0_snr == null)
			mcs0_snr = mcs_table.mcs0_required_snr(8, this.chip);

		const min_snr2 = min_signal - noise_ref;
		const threshold = mcs0_snr + STABILITY_MARGIN_DB;
		const impacted = min_snr2 < threshold;

		return {
			agc_triggered: true,
			trigger_label,
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
	},
};

/* ---------------------------------------------------------------------------
 * Interference — pairwise scan over the window detecting five interference
 * categories from per-sample counters and corr2s energy. Per chip.
 * Mirrors halow_link_quality.py:parse_interference_characteristics.
 * --------------------------------------------------------------------------- */

const CORR2S_CELLULAR        = 2;     /* very high-power OOB (cellular) */
const CORR2S_CLOSE_CHANNEL   = 7;     /* high power close to channel */
/* Note: corr2s == 255 is a firmware sentinel for "no reading"; the explicit
 * equality checks below filter it out naturally. */
const STF_LTF_RATIO          = 1.5;   /* total ΔSTF/ΔLTF gate for adjacent-channel */

const Interference = {
	new: function (chip) {
		return proto({ chip }, this);
	},

	scan: function (samples) {
		const flags = {
			cellular_suspected:        false,
			in_channel_detected:       false,
			close_channel_detected:    false,
			same_channel_detected:     false,
			adjacent_channel_detected: false,
		};

		if (length(samples) < 2)
			return flags;

		/* Cellular and close-channel detection are Corr2S-energy based and only
		 * available on MM8108. MM6108 cannot detect these types, so they are never
		 * flagged for it. (Unknown chip behaves as MM8108.) */
		const corr2s_supported = (this.chip != "MM6108");

		for (let i = 0; i < length(samples); i++) {
			const cur = samples[i];

			/* Per-sample: cellular detection (any sample) — MM8108 only. */
			if (corr2s_supported && cur.corr2s_energy == CORR2S_CELLULAR)
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

			/* Corr2S == 7 with no NB increment → close-channel interference.
			 * MM8108 only (Corr2S-energy based). */
			if (corr2s_supported && cur.corr2s_energy == CORR2S_CLOSE_CHANNEL && nb_diff == 0)
				flags.close_channel_detected = true;
		}

		/* STF >> LTF over the whole window suggests an adjacent/overlapping
		 * channel: preambles detected but frames not decoded. The STF/LTF PD-fired
		 * counters are cumulative, so total fires are (last - first). Flag when
		 * total ΔSTF > 0 and total ΔSTF > 1.5 × total ΔLTF. */
		const stf_series = filter(map(samples, (s) => s.stf_pd_fired), (v) => v != null);
		const ltf_series = filter(map(samples, (s) => s.ltf_pd_fired), (v) => v != null);
		if (length(stf_series) >= 2 && length(ltf_series) >= 2) {
			const d_stf_total = stf_series[length(stf_series) - 1] - stf_series[0];
			const d_ltf_total = ltf_series[length(ltf_series) - 1] - ltf_series[0];
			if (d_stf_total > 0 && d_stf_total > STF_LTF_RATIO * d_ltf_total)
				flags.adjacent_channel_detected = true;
		}

		return flags;
	},
};

/* ---------------------------------------------------------------------------
 * Analytics — stateful base. Owns the rolling sample window, the chip-bound
 * domains, the shared summary bundle and the shared analysis + wire-block
 * builders. Never instantiated directly: PeerAnalytics / PlannerAnalytics
 * extend it and supply the flavour-specific result builders. Not exported.
 * --------------------------------------------------------------------------- */

const Analytics = {
	/* Build a fully-formed base instance. Subclass `new()` methods call this via
	 * `this._new_base(...)` so `proto(..., this)` links the instance to the
	 * subclass prototype — the result builders then dispatch to the subclass. */
	_new_base: function (chip, window_size) {
		return proto({
			chip,
			window_size,
			samples: [],
			quality:      Quality.new(chip),
			stability:    Stability.new(chip),
			interference: Interference.new(chip),
		}, this);
	},

	/* Append a sample, dropping the oldest once the window is full. */
	push: function (sample) {
		push(this.samples, sample);
		if (length(this.samples) > this.window_size)
			shift(this.samples);
	},

	/* True once the window holds a full set of samples. */
	ready: function () {
		return length(this.samples) >= this.window_size;
	},

	/* Walk samples newest-first and return the first non-null value for field. */
	_last_valid: function (field) {
		for (let i = length(this.samples) - 1; i >= 0; i--) {
			if (this.samples[i][field] != null)
				return this.samples[i][field];
		}
		return null;
	},

	/* Shared link_stability wire block: assessment flags + interference flags. */
	_link_stability_body: function (stability, interference) {
		return {
			agc_triggered:             stability.agc_triggered,
			impacted:                  stability.impacted,
			trigger_label:             stability.trigger_label,
			cellular_suspected:        interference.cellular_suspected,
			in_channel_detected:       interference.in_channel_detected,
			close_channel_detected:    interference.close_channel_detected,
			same_channel_detected:     interference.same_channel_detected,
			adjacent_channel_detected: interference.adjacent_channel_detected,
		};
	},

	/* Shared mcs_quality wire block (or null when quality was unavailable). */
	_mcs_quality_body: function (mcs_quality) {
		return mcs_quality ? {
			bw_mhz: mcs_quality.bw_mhz,
			typical: mcs_quality.typical,
			conservative: mcs_quality.conservative,
			worst_case: mcs_quality.worst_case,
		} : null;
	},

	_summary: function () {
		const samples = this.samples;
		const max_noise_stats = summarise(map(samples, (sample) => sample.max_noise));
		/* Fall back to per-packet detected BW when current_bw_mhz is missing. */
		let bw_mhz = dominant(map(samples, (sample) => sample.current_bw_mhz));
		if (bw_mhz == null)
			bw_mhz = dominant(map(samples, (sample) =>
				sample.detected_bw_hz ? int(sample.detected_bw_hz / 1000000) : null));

		return {
			rssi_stats:      summarise(map(samples, (sample) => sample.rssi)),
			rx_power_stats:  summarise(map(samples, (sample) => sample.rx_power)),
			max_noise_stats,
			bw_mhz,
			agc_noise_floor: this.stability.noise_floor(samples, max_noise_stats),
		};
	},

	/* Run the three chip-bound domains against a summary bundle. Shared by both
	 * result builders; they differ only in how `s` is sourced. */
	_analyse: function (s) {
		return {
			mcs_quality:    this.quality.complete(s),
			link_stability: this.stability.assess(s),
			interference:   this.interference.scan(this.samples),
		};
	},
};

/* ---------------------------------------------------------------------------
 * PeerAnalytics — live peer-link flavour. Uses the window's own measured
 * summary as-is and adds the current-rate / rssi blocks.
 * --------------------------------------------------------------------------- */

const PeerAnalytics = proto({
	new: function (chip, window_size) {
		return this._new_base(chip, window_size);
	},

	/* Wireless metrics for the current window — the per-peer wire body that
	 * PeerSession embeds under the peer key. */
	peer_result: function () {
		const s = this._summary();
		const a = this._analyse(s);
		const mcs_quality = a.mcs_quality;

		DBG("peer_result: n=%d bw=%s mcs_quality=%s impacted=%s findings=[%s%s%s%s%s]",
			length(this.samples),
			s.bw_mhz,
			mcs_quality ? mcs_quality.typical.quality : "null",
			a.link_stability.impacted,
			a.interference.cellular_suspected        ? "cellular " : "",
			a.interference.in_channel_detected       ? "in_channel " : "",
			a.interference.close_channel_detected    ? "close_channel " : "",
			a.interference.same_channel_detected     ? "same_channel " : "",
			a.interference.adjacent_channel_detected ? "adjacent_channel" : "");

		return {
			current: {
				rx: this._last_valid("rx"),
				tx: this._last_valid("tx"),
			},
			rssi: mcs_quality ? mcs_quality.rssi : null,
			noise: mcs_quality ? mcs_quality.noise : null,
			mcs_quality: this._mcs_quality_body(mcs_quality),
			link_stability: this._link_stability_body(a.link_stability, a.interference),
		};
	},
}, Analytics);

/* ---------------------------------------------------------------------------
 * PlannerAnalytics — propagation-model flavour. Owns the propagation math. The
 * same noise/AGC/interference analysis runs over the current window, but RSSI
 * is synthesised from the estimate and bw_mhz is forced by the caller.
 * Mirrors halow_link_quality.py:run_link_planning.
 * --------------------------------------------------------------------------- */

const PLAN_FADE_MARGIN_DB  = 10;   /* fade margin for worst-case RSSI */
const PLAN_FSPL_CONST      = 32;   /* free-space path loss constant (dB) */

const PlannerAnalytics = proto({
	new: function (chip, window_size) {
		return this._new_base(chip, window_size);
	},

	/* Free-space path loss in dB at distance d (metres):  FSPL = 32 + 20·log10(d).
	 * The constant 32 absorbs the 915 MHz frequency term per the Python reference. */
	_fspl_db: function (distance_m) {
		/* ucode's math module exports natural log only; derive log10. */
		return PLAN_FSPL_CONST + 20 * (ln(distance_m) / ln(10));
	},

	/* Build a synthetic rssi_stats dict from the two predicted RSSI values, in
	 * the same shape summarise() produces — so Quality.complete can run
	 * unchanged. Q1=worst, Q3=typical mirrors the Python reference (see
	 * halow_link_quality.py:1504-1513). The three SNR scenarios then resolve to:
	 *   typical      — rssi_typical vs noise.median
	 *   conservative — rssi_worst   vs noise.q3
	 *   worst_case   — rssi_worst   vs noise.worst */
	_synthesise_rssi: function (rssi_typical, rssi_worst) {
		return {
			count:   2,
			min:     rssi_worst,
			max:     rssi_typical,
			average: round1((rssi_typical + rssi_worst) / 2),
			median:  rssi_typical,
			q1:      rssi_worst,
			q3:      rssi_typical,
		};
	},

	/* Propagation-model estimate. Required inputs:
	 *   tx_power_dbm, freq_mhz, bw_mhz   — read from the driver at session start
	 *   distance_m or attenuation_db     — user-supplied (one or the other)
	 * Optional:
	 *   fade_margin_db                   — user override, defaults to 10
	 * Settled at session creation time and never changes during the run. */
	planning_estimate: function (p) {
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
			path_loss_db   = round1(this._fspl_db(distance_m));
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
	},

	/* Planning-mode counterpart to peer_result. Same noise/AGC/interference math
	 * applied to the current window, but RSSI is synthesised from the propagation
	 * estimate and bw_mhz is forced (the window's own current_bw_mhz is irrelevant
	 * to a planned deployment). */
	planning_result: function (estimate, bw_mhz) {
		const s = this._summary();
		/* Planning overrides: RSSI is synthesised from the estimate, bw_mhz is
		 * forced by the caller and there is no measured received-power to fall back
		 * on. max_noise_stats / agc_noise_floor stay as measured from the window. */
		s.rssi_stats     = this._synthesise_rssi(estimate.rssi_typical_dbm, estimate.rssi_worst_dbm);
		s.bw_mhz         = bw_mhz;
		s.rx_power_stats = null;

		const a = this._analyse(s);
		const mcs_quality = a.mcs_quality;

		DBG("planning_result: n=%d model=%s bw=%s rssi_typ=%s rssi_worst=%s mcs_quality=%s",
			length(this.samples), estimate.model, bw_mhz,
			estimate.rssi_typical_dbm, estimate.rssi_worst_dbm,
			mcs_quality ? mcs_quality.typical.quality : "null");

		return {
			estimate,
			noise: mcs_quality ? mcs_quality.noise : null,
			mcs_quality: this._mcs_quality_body(mcs_quality),
			link_stability: this._link_stability_body(a.link_stability, a.interference),
		};
	},
}, Analytics);

export {
	PeerAnalytics,
	PlannerAnalytics
};
