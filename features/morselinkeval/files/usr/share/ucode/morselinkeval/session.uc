'use strict';

import * as uloop from "uloop";
import { ulog, ERR, LOG_DEBUG } from "log";

import * as analytics from "morselinkeval.analytics";
import { Sampler } from "morselinkeval.collect";

function DBG(...args) { ulog(LOG_DEBUG, ...args); }

/* Seconds since the unix epoch as a float. clock(true) -> [sec, nsec]. */
function now_s() {
	const t = clock(true);
	return t[0] + t[1] / 1e9;
}

/* Grace period after warm-up completes before idle-stop is armed. Gives the
 * caller a chance to begin polling status before we start counting silence. */
const POST_WARMUP_GRACE_S = 60;

/* Session — common base for sampling-window sessions. Subclasses provide a
 * `new()` that calls `_init()` with the instance fields they need (notably
 * `settings` and `sampler`), and a `metrics_body()` to shape the wire body.
 * Optional `_on_start()` hook fires from `start()` for subclass-specific
 * startup logging. */
const Session = {
	_init: function (fields) {
		return proto({
			samples: [],
			samples_collected: 0,
			sample_timer: null,
			phase: "warming",
			running_since_ts: null,
			last_status_ts: null,
			...fields,
		}, this);
	},

	/* Called by the ubus status handler to record consumer activity. The next
	 * idle check uses this timestamp to decide whether the session is silent. */
	touch: function () {
		this.last_status_ts = now_s();
	},

	/* Idle check, run after each sample. We never kill during warm-up, and we
	 * give a fixed grace window after entering "running" before arming the
	 * timeout, so a polling consumer has a chance to show up. */
	check_idle: function () {
		if (this.phase != "running" || !this.running_since_ts)
			return;

		const now = now_s();
		const grace_end = this.running_since_ts + POST_WARMUP_GRACE_S;
		if (now < grace_end)
			return;

		/* If no status call has ever landed, count silence from grace_end. */
		const last_seen = this.last_status_ts > grace_end ? this.last_status_ts : grace_end;
		if (now - last_seen <= this.settings.idle_timeout_s)
			return;

		DBG("session %s: idle for %.1fs (threshold %ss), auto-stopping",
			this.sampler.ifname, now - last_seen, this.settings.idle_timeout_s);

		if (this.on_idle) this.on_idle(this.sampler.peer_mac);
	},

	start: function () {
		const that = this;
		this.sample_timer = uloop.interval(
			int(this.settings.interval_s * 1000),
			() => that.tick_sample()
		);
		if (this._on_start) this._on_start();
	},

	stop: function () {
		if (this.sample_timer) { this.sample_timer.cancel(); this.sample_timer = null; }
	},

	window_full: function () {
		return length(this.samples) >= this.settings.window_samples;
	},

	tick_sample: function () {
		try {
			const sample = this.sampler.collect();

			push(this.samples, sample);
			if (length(this.samples) > this.settings.window_samples)
				shift(this.samples);

			this.samples_collected++;
			const was_warming = (this.phase == "warming");
			this.phase = this.window_full() ? "running" : "warming";

			if (was_warming && this.phase == "running") {
				this.running_since_ts = now_s();
				DBG("session %s: window full (%d samples)",
					this.sampler.ifname, length(this.samples));
			}

			this.check_idle();
		} catch (e) {
			ERR("tick_sample on %s threw: %s\n%s",
				this.sampler.ifname, e.message, e.stacktrace);
		}
	},
};

/* PeerSession — long-running live peer-link estimation.
 * Keyed by peer_mac within Service.peer_link_sessions. */
const PeerSession = proto({
	new: function (settings, ifname, peer_mac, on_idle) {
		return this._init({
			settings,
			sampler: Sampler.new(ifname, peer_mac, int(settings.interval_s * 1000)),
			on_idle,
		});
	},

	/* Live wire body. Keyed under the peer MAC.
	 *   { status: "warming"|"ok", "<peer_mac>": {...} } */
	metrics_body: function () {
		const body = { status: "warming" };
		if (this.window_full()) {
			body.status = "ok";
			body[this.sampler.peer_mac] = analytics.build_peer_result(this.samples);
		}
		return body;
	},
}, Session);

/* PlannerSession — propagation-model based deployment estimate. Runs until
 * explicitly stopped via ubus. */
const PlannerSession = proto({
	new: function (settings, ifname, planning_params, on_idle) {
		return this._init({
			settings,
			sampler: Sampler.new(ifname, null, int(settings.interval_s * 1000)),
			planning: planning_params,
			estimate: analytics.compute_planning_estimate(planning_params),
			on_idle,
		});
	},

	_on_start: function () {
		DBG("session %s: planning started", this.sampler.ifname);
	},

	/* Planning wire body. Always carries the estimate (which is settled at
	 * session creation), and includes the noise-derived metrics once a window
	 * is available. Status follows the lifecycle: warming → ok.
	 *   { status: "warming", estimate }
	 *   { status: "ok",      estimate, noise, mcs_quality, link_stability } */
	metrics_body: function () {
		if (!this.window_full())
			return { status: "warming", estimate: this.estimate };

		const result = analytics.build_planning_result(this.samples, this.estimate, this.planning.bw_mhz);
		return {
			status:         "ok",
			estimate:       result.estimate,
			noise:          result.noise,
			mcs_quality:    result.mcs_quality,
			link_stability: result.link_stability,
		};
	},
}, Session);

export {
	PeerSession,
	PlannerSession
};
