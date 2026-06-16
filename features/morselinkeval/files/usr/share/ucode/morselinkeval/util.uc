'use strict';

function value_or(value, fallback) {
	return value != null ? value : fallback;
}

function positive_number(value) {
	return value && match(value, /^(\d+(\.\d+)?|\.\d+)$/) && +value > 0 ? +value : null;
}

function round1(value) {
	return value == null ? null : +sprintf("%.1f", value);
}

function normalize_mac(mac) {
	if (!mac || !match(mac, /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/))
		return null;

	return uc(mac);
}

export {
	value_or,
	positive_number,
	round1,
	normalize_mac
};
