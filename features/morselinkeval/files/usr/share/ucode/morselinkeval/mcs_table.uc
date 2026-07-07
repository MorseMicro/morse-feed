'use strict';

/* MCS vs SNR mapping tables, kept per chip (SNR in dB required for each MCS and
 * bandwidth). Format: MCS -> { bandwidth_MHz: min_SNR_dB }; null = MCS
 * unsupported at BW.
 *   - MM8108 supports MCS 0-9 (plus the MCS 10 low-rate fallback).
 *   - MM6108 supports MCS 0-7 only (no MCS 8/9) plus the MCS 10 fallback. */
const MCS_SNR_TABLE_MM8108 = {
	"10": { "1": 2, "2": null, "4": null, "8": null },
	"0": { "1": 4, "2": 2.7, "4": 3.8, "8": 2.9 },
	"1": { "1": 6.7, "2": 5.7, "4": 5.2, "8": 6.2 },
	"2": { "1": 9.7, "2": 8.5, "4": 7.7, "8": 7.8 },
	"3": { "1": 12.2, "2": 11.3, "4": 10.8, "8": 11.2 },
	"4": { "1": 15.6, "2": 15.4, "4": 13.9, "8": 14.5 },
	"5": { "1": 19.3, "2": 19.1, "4": 18.3, "8": 18.5 },
	"6": { "1": 20.5, "2": 21, "4": 19.3, "8": 19.8 },
	"7": { "1": 22, "2": 21.8, "4": 21, "8": 21.3 },
	"8": { "1": 26, "2": 25.8, "4": 25, "8": 25 },
	"9": { "1": 27.7, "2": null, "4": 27.4, "8": 26.9 },
};

/* MM6108 - max MCS is 7 (no MCS 8/9). Calibrated thresholds for Banff. */
const MCS_SNR_TABLE_MM6108 = {
	"10": { "1": 0.5, "2": null, "4": null, "8": null },
	"0": { "1": 1, "2": 2, "4": 1.5, "8": 2.6 },
	"1": { "1": 3.9, "2": 3.8, "4": 4.3, "8": 5.8 },
	"2": { "1": 7.8, "2": 6.9, "4": 7.1, "8": 8.6 },
	"3": { "1": 10.6, "2": 9.8, "4": 10.3, "8": 11.6 },
	"4": { "1": 13.8, "2": 13.2, "4": 13.7, "8": 15 },
	"5": { "1": 17.4, "2": 17.7, "4": 17.8, "8": 19.4 },
	"6": { "1": 19.2, "2": 19, "4": 19.3, "8": 21.1 },
	"7": { "1": 20.4, "2": 21, "4": 21, "8": 23 },
};

/* Resolve the MCS->BW->min-SNR table for a chip family. MM6108 uses its own
 * (max MCS 7) table; everything else - including a null/undetected chip - uses
 * the MM8108 superset. */
function table_for(chip) {
	return chip == "MM6108" ? MCS_SNR_TABLE_MM6108 : MCS_SNR_TABLE_MM8108;
}

function required_snr(mcs, bw_mhz, chip) {
	const row = table_for(chip)[mcs];
	if (!row)
		return null;

	const value = row[bw_mhz];
	return value != null ? value : null;
}

function mcs0_required_snr(bw_mhz, chip) {
	return required_snr(0, bw_mhz, chip);
}

export {
	required_snr,
	mcs0_required_snr
};
