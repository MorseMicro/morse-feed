'use strict';

// ---------------------------------------------------------------------------
// ucode side of the analytics cross-check.
//
// Reads the shared fixtures JSON and runs each scenario through the SAME public
// analytics entry points the on-device service uses (PeerAnalytics /
// PlannerAnalytics from morselinkeval.analytics) — collection, ubus and the
// service shell are all bypassed. Prints { scenario_name: wire_body } as JSON on
// stdout for run_tests.py to compare against the Python source of truth.
//
// Invoked by run_tests.py as:
//   ucode -R -L <test/src/stubs> -L <pkg ucode root> run_uc.uc <fixtures.json>
//
// The two -L dirs make `import "log"` resolve to the local stub (the native x86
// ucode lacks ubox ulog) and `import "morselinkeval.*"` resolve to the package
// modules (dotted import -> path). `math`/`fs` fall through to native modules.
// ---------------------------------------------------------------------------

import { PeerAnalytics, PlannerAnalytics } from "morselinkeval.analytics";
import { readfile } from "fs";

const fixtures_path = ARGV[0];
if (!fixtures_path) {
	warn("usage: run_uc.uc <fixtures.json>\n");
	exit(2);
}

const data = json(readfile(fixtures_path));
const results = {};

for (let sc in data.scenarios) {
	const samples = sc.samples;
	// Window = number of samples so the whole fixture is the window (nothing is
	// shifted out); mirrors the Python side, which summarises the full list.
	const window = length(samples);

	if (sc.kind == "peer") {
		const pa = PeerAnalytics.new(sc.chip, window);
		for (let smp in samples)
			pa.push(smp);
		results[sc.name] = pa.peer_result();
	}
	else if (sc.kind == "planner") {
		const pa = PlannerAnalytics.new(sc.chip, window);
		for (let smp in samples)
			pa.push(smp);
		const p = sc.planner;
		const estimate = pa.planning_estimate({
			tx_power_dbm:   p.tx_power_dbm,
			freq_mhz:       p.freq_mhz,
			bw_mhz:         sc.bw_mhz,
			distance_m:     p.distance_m,
			attenuation_db: p.attenuation_db,
			fade_margin_db: p.fade_margin_db,
		});
		results[sc.name] = pa.planning_result(estimate, sc.bw_mhz);
	}
	else {
		warn(sprintf("unknown scenario kind '%s' for '%s'\n", sc.kind, sc.name));
		exit(2);
	}
}

printf("%J\n", results);
