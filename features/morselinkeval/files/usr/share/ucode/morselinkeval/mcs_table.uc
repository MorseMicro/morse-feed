'use strict';

const MCS_SNR_TABLE = {
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

function required_snr(mcs, bw_mhz) {
	const row = MCS_SNR_TABLE[mcs];
	if (!row)
		return null;

	const value = row[bw_mhz];
	return value != null ? value : null;
}

function mcs0_required_snr(bw_mhz) {
	return required_snr(0, bw_mhz);
}

export {
	required_snr,
	mcs0_required_snr
};
