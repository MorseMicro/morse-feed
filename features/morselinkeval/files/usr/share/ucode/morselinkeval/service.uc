'use strict';

import * as libubus from "ubus";
import * as uloop from "uloop";
import {
	ulog_open, ulog_threshold, ulog,
	ULOG_SYSLOG, LOG_DAEMON, LOG_INFO, LOG_DEBUG,
	INFO, WARN, ERR
} from "log";

import * as collect from "morselinkeval.collect";
import { normalize_mac } from "morselinkeval.util";
import { Config } from "morselinkeval.config";
import { PeerSession, PlannerSession } from "morselinkeval.session";

/* Three ubus objects under the morse.eval.* namespace:
 *   morse.eval               admin     — daemon-wide methods (reload)
 *   morse.eval.peer_link     live      — long-running estimation of an associated link
 *   morse.eval.link_planner  one-shot  — propagation-model based deployment estimation */
const UBUS_ADMIN     = "morse.eval";
const UBUS_PEER_LINK = "morse.eval.peer_link";
const UBUS_PLANNER   = "morse.eval.link_planner";
const LOG_TAG        = "morselinkeval";

const DEBUG = true;
ulog_open(ULOG_SYSLOG, LOG_DAEMON, LOG_TAG);
ulog_threshold(DEBUG ? LOG_DEBUG : LOG_INFO);

function DBG(...args) { ulog(LOG_DEBUG, ...args); }

const Service = {
	new: function (argv) {
		const svc = proto({
			ubus: null,
			argv: argv || [],
			config: Config.new(),
			peer_link_sessions: {},
			planner_session: null,
			admin_handle: null,
			peer_link_handle: null,
			planner_handle: null,
		}, this);

		svc.config.parse(svc.argv);
		return svc;
	},

	/* Tear down a single peer_link session, identified by peer MAC. */
	end_peer_link_session: function (peer) {
		const s = this.peer_link_sessions[peer];
		if (!s)
			return;

		INFO("peer_link session stopped: ifname=%s peer=%s",
			s.sampler.ifname, s.sampler.peer_mac);
		s.stop();
		delete this.peer_link_sessions[peer];
		gc();
		DBG("end_peer_link_session: gc done, object count=%d", gc("count"));
	},

	/* Tear down every active peer_link session. */
	end_all_peer_link_sessions: function () {
		for (let peer in this.peer_link_sessions) {
			const s = this.peer_link_sessions[peer];
			INFO("peer_link session stopped: ifname=%s peer=%s",
				s.sampler.ifname, s.sampler.peer_mac);
			s.stop();
		}
		this.peer_link_sessions = {};
		gc();
		DBG("end_all_peer_link_sessions: gc done, object count=%d", gc("count"));
	},

	/* Tear down the active planner session and disable medium_eval. */
	end_planner_session: function () {
		if (this.planner_session) {
			const ifname = this.planner_session.sampler.ifname;
			INFO("planner session stopped: ifname=%s", ifname);
			this.planner_session.stop();
			this.planner_session = null;
			collect.set_medium_eval(ifname, false);
			gc();
			DBG("end_planner_session: gc done, object count=%d", gc("count"));
		}
	},

	/* Resolve the peer for an estimate request. In STA mode the connected
	 * BSSID is used and peer_arg is ignored; in AP mode peer_arg is required
	 * and must name an associated station. Returns { peer, iftype } on
	 * success or { error } on failure. */
	resolve_peer: function (ifname, peer_arg) {
		const info = collect.get_interface_info(ifname);
		if (!info)
			return { error: `Interface ${ifname} not found or unsupported` };

		const iftype = info.iftype;

		if (iftype == "sta") {
			const peer = collect.get_connected_bssid(this.ubus, ifname);
			if (!peer)
				return { error: `Station not connected with AP ${ifname}` };
			return { peer, iftype };
		}

		if(iftype == "ap") {
			if (!peer_arg)
				return { error: "AP mode requires peer MAC" };

			const peer = normalize_mac(peer_arg);
			if (!peer)
				return { error: "Invalid peer MAC address" };

			if (!collect.get_station_info(ifname, peer))
				return { error: "Station %s is not connected with %s ", peer, ifname };

			return { peer, iftype };
		}

		return { error: "Invalid interface type(%s) : %s ", iftype, ifname };
	},

	validate_plan_args: function (args) {
		const attenuation_db = args.attenuation_db;
		const distance_m     = args.distance_m;

		if (attenuation_db == null && distance_m == null)
			return { error: "Provide one of 'distance_m' or 'attenuation_db'" };

		const params = {};

		if (attenuation_db != null) {
			const a = +attenuation_db;
			if (!(a >= 0))
				return { error: `Invalid attenuation_db '${attenuation_db}'` };
			params.attenuation_db = a;
		} else {
			const d = +distance_m;
			if (!(d > 0))
				return { error: `Invalid distance_m '${distance_m}'` };
			params.distance_m = d;
		}

		/* Optional propagation-model override (the only one users may still set). */
		if (args.fade_margin_db != null) params.fade_margin_db = +args.fade_margin_db;

		return { params };
	},

	/* ----------------------------------------------------------------
	 * peer_link methods
	 * ---------------------------------------------------------------- */

	peer_link_estimate: function (ifname_arg, peer_arg) {
		if (this.planner_session) {
			WARN("peer_link estimate rejected: link_planner session active");
			return { status: "failed", error: "link_planner session active" };
		}

		if (!ifname_arg) {
			WARN("peer_link estimate rejected: missing 'interface' arg");
			return { status: "failed", error: "Missing required 'interface' arg" };
		}

		if (this.config.error) {
			ERR("peer_link estimate rejected: config error: %s", this.config.error);
			return { status: "failed", error: this.config.error };
		}

		const r = this.resolve_peer(ifname_arg, peer_arg);
		if (r.error) {
			WARN("peer_link estimate rejected on %s: %s", ifname_arg, r.error);
			return { status: "failed", error: r.error };
		}

		const settings = this.config.snapshot();

		if (this.peer_link_sessions[r.peer]) {
			WARN("peer_link estimate accepted: session already running for peer=%s", r.peer);
			return { status: "started"};
		}

		if (length(this.peer_link_sessions) >= settings.max_peer_link_sessions) {
			WARN("peer_link estimate rejected: max sessions (%d) reached",
				settings.max_peer_link_sessions);
			return { status: "failed", error: "max sessions reached" };
		}

		const that = this;
		const session = PeerSession.new(settings, ifname_arg, r.peer,
			(peer) => {
				INFO("peer_link auto-stopped: peer=%s no status calls within %ss",
					peer, settings.idle_timeout_s);
				that.end_peer_link_session(peer);
			});
		this.peer_link_sessions[r.peer] = session;
		INFO("peer_link session started: ifname=%s peer=%s iftype=%s active=%d",
			ifname_arg, r.peer, r.iftype, length(this.peer_link_sessions));

		session.start();

		return { status: "started" };
	},

	peer_link_stop: function (ifname_arg, peer_arg) {
		if (!ifname_arg)
			return { status: "failed", error: "Missing required 'interface' arg" };

		if (!peer_arg)
			return { status: "failed", error: "Missing required 'peer' arg" };

		const peer = normalize_mac(peer_arg);
		if (!peer)
			return { status: "failed", error: "Invalid peer MAC address" };

		const s = this.peer_link_sessions[peer];
		if (!s || s.sampler.ifname != ifname_arg)
			return { status: "no active session" };

		this.end_peer_link_session(peer);

		return { status: "stopped" };
	},

	peer_link_status: function (ifname_arg, peer_arg) {
		if (!ifname_arg)
			return { status: "failed", error: "Missing required 'interface' arg" };

		if (!peer_arg)
			return { status: "failed", error: "Missing required 'peer' arg" };

		const peer = normalize_mac(peer_arg);
		if (!peer)
			return { status: "failed", error: "Invalid peer MAC address" };

		const s = this.peer_link_sessions[peer];
		if (!s || s.sampler.ifname != ifname_arg)
			return { status: "no active session" };

		s.touch();

		return s.metrics_body();
	},

	/* ----------------------------------------------------------------
	 * link_planner methods
	 * ---------------------------------------------------------------- */

	/* Begin a one-shot planning estimate. Non-blocking — returns immediately.
	 * Caller polls link_planner.status to retrieve the result. */
	link_planner_estimate: function (args) {
		args = args || {};

		const ifname_arg = args.interface;
		if (!ifname_arg) {
			WARN("link_planner estimate rejected: missing 'interface' arg");
			return { status: "failed", error: "Missing required 'interface' arg" };
		}

		if (this.config.error) {
			ERR("link_planner estimate rejected: config error: %s", this.config.error);
			return { status: "failed", error: this.config.error };
		}

		if (length(this.peer_link_sessions) > 0) {
			WARN("Terminating all active peer_link sessions (%d)",
				length(this.peer_link_sessions));
			this.end_all_peer_link_sessions();
		}

		const info = collect.get_interface_info(ifname_arg);
		if (!info) {
			WARN("link_planner estimate rejected: interface %s not found or unsupported", ifname_arg);
			return { status: "failed", error: `Interface ${ifname_arg} not found or unsupported` };
		}
		if (info.tx_power_dbm == null) {
			WARN("link_planner estimate rejected on %s: tx_power not reported by driver", ifname_arg);
			return { status: "failed", error: "tx_power not reported by driver" };
		}

		const chan = collect.get_channel_info(ifname_arg);
		if (!chan) {
			WARN("link_planner estimate rejected on %s: channel info unavailable", ifname_arg);
			return { status: "failed", error: "channel info unavailable" };
		}
		if (!(chan.bw_mhz > 0)) {
			WARN("link_planner estimate rejected on %s: invalid bw_mhz from driver (%s)",
				ifname_arg, chan.bw_mhz);
			return { status: "failed", error: "driver returned invalid bw_mhz" };
		}

		const validated = this.validate_plan_args(args);
		if (validated.error) {
			WARN("link_planner estimate rejected on %s: %s", ifname_arg, validated.error);
			return { status: "failed", error: validated.error };
		}

		const params = validated.params;
		params.tx_power_dbm = info.tx_power_dbm;
		params.freq_mhz     = chan.freq_mhz;
		params.bw_mhz       = chan.bw_mhz;

		/* New estimate replaces any existing planner session (and clears the
		 * stale result + drops medium_eval). */
		this.end_planner_session();

		/* Enable medium_eval before sampling. If this fails, abort cleanly. */
		if (!collect.set_medium_eval(ifname_arg, true)) {
			ERR("link_planner estimate rejected on %s: medium_eval enable failed", ifname_arg);
			return { status: "failed", error: "medium_eval enable failed" };
		}

		const settings = this.config.snapshot();
		const that = this;
		this.planner_session = PlannerSession.new(settings, ifname_arg, params,
			() => {
				INFO("link_planner auto-stopped: no status calls within %ss",
					settings.idle_timeout_s);
				that.end_planner_session();
			});
		INFO("link_planner session started: ifname=%s model=%s bw_mhz=%d freq_mhz=%d tx_power_dbm=%s",
			ifname_arg,
			params.attenuation_db != null ? "manual" : "fspl",
			params.bw_mhz, params.freq_mhz, params.tx_power_dbm);

		this.planner_session.start();

		return { status: "started" };
	},

	link_planner_stop: function () {
		if (!this.planner_session)
			return { status: "no active session" };

		this.end_planner_session();
		return { status: "stopped" };
	},

	link_planner_status: function () {
		const t0 = clock(true);
		if (this.planner_session) this.planner_session.touch();
		const body = this.planner_session
			? this.planner_session.metrics_body()
			: { status: "no active session" };
		const t1 = clock(true);
		const ms = (t1[0] - t0[0]) * 1000 + (t1[1] - t0[1]) / 1000000;
		INFO("link_planner_status: %.2fms samples=%d gc=%d",
			ms,
			this.planner_session ? length(this.planner_session.samples) : 0,
			gc("count"));
		return body;
	},

	/* ----------------------------------------------------------------
	 * admin methods
	 * ---------------------------------------------------------------- */

	reload: function () {
		INFO("reload requested");
		/* Reload kills both kinds of sessions unconditionally. */
		this.end_all_peer_link_sessions();
		this.end_planner_session();

		/* Configuration is fixed at launch from the command line, so reload
		 * only re-validates the current arguments and resets sessions. Picking
		 * up new UCI values requires a service restart (see init script). */
		this.config.parse(this.argv);

		if (this.config.error) {
			ERR("reload failed: %s", this.config.error);
			return { status: "failed", error: this.config.error };
		}

		INFO("reload complete");
		return { status: "reloaded" };
	},

	publish: function () {
		const that = this;

		this.admin_handle = this.ubus.publish(UBUS_ADMIN, {
			reload: {
				args: { ubus_rpc_session: "" },
				call: () => that.reload(),
			},
		});

		this.peer_link_handle = this.ubus.publish(UBUS_PEER_LINK, {
			estimate: {
				args: { interface: "", peer: "", ubus_rpc_session: "" },
				call: (req) => that.peer_link_estimate(
					req && req.args ? req.args.interface : null,
					req && req.args ? req.args.peer : null
				),
			},
			stop: {
				args: { interface: "", peer: "", ubus_rpc_session: "" },
				call: (req) => that.peer_link_stop(
					req && req.args ? req.args.interface : null,
					req && req.args ? req.args.peer : null
				),
			},
			status: {
				args: { interface: "", peer: "", ubus_rpc_session: "" },
				call: (req) => that.peer_link_status(
					req && req.args ? req.args.interface : null,
					req && req.args ? req.args.peer : null
				),
			},
		});

		/* Link-planner object — one-shot deployment-planning estimation. */
		this.planner_handle = this.ubus.publish(UBUS_PLANNER, {
			estimate: {
				args: {
					interface:      "",
					distance_m:     0,
					attenuation_db: 0,
					fade_margin_db: 0,
					ubus_rpc_session: "",
				},
				call: (req) => that.link_planner_estimate(req && req.args ? req.args : null),
			},
			stop: {
				args: { ubus_rpc_session: "" },
				call: () => that.link_planner_stop(),
			},
			status: {
				args: { ubus_rpc_session: "" },
				call: () => that.link_planner_status(),
			},
		});

		if (!this.admin_handle || !this.peer_link_handle || !this.planner_handle) {
			ERR("ubus rpc publish failed !");
			return false
		}

		INFO("ubus rpc object published: %s", UBUS_PLANNER);
		INFO("ubus rpc object published: %s", UBUS_PEER_LINK);
		INFO("ubus rpc object published: %s", UBUS_ADMIN);

		return true;
	},

	terminate: function () {
		INFO("terminate signal received; shutting down");

		for (let peer in this.peer_link_sessions)
			this.peer_link_sessions[peer].stop();
		this.peer_link_sessions = {};

		if (this.planner_session) {
			const ifname = this.planner_session.sampler.ifname;
			this.planner_session.stop();
			collect.set_medium_eval(ifname, false);
		}

		uloop.end();
	},

	run: function () {
		INFO("morselinkeval starting (debug=%s)", DEBUG);

		uloop.init();

		this.ubus = libubus.connect();
		if (!this.ubus) {
			ERR("ubus connect failed; aborting");
			uloop.end();
			return;
		}

		if(!this.publish()) {
			ERR("ubus publish failed; aborting");
			uloop.end();
			return;
		}

		const that = this;

		signal("int", () => that.terminate());
		signal("term", () => that.terminate());

		uloop.run();
	},
};

export {
	Service
};
