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

/* --- Statistical helpers: pure functions over arrays of numbers. Stateless
 * and chip-agnostic; the analytics domains lean on these to summarise a sample
 * window. --- */

/* Most frequent non-null value. Ties resolve to the LARGER value so the result
 * is independent of sample order — matching the Python reference, whose
 * max(set(values), key=count) breaks count-ties toward the value that leads
 * set iteration (the larger, for the small-integer bandwidths in play). A
 * first-seen tie-break would make the selected bandwidth depend on arrival
 * order and diverge from Python on a genuine tie. */
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

		if (counts[value] > best_count ||
		    (counts[value] == best_count && value > best_value)) {
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

	/* Force float division: both middle values are integer dBm, and ucode
	 * integer-divides int/int (truncating toward zero) before round1 could
	 * recover the half. Mirror Python statistics.median's exact mean. */
	return round1((sorted_values[mid - 1] + sorted_values[mid]) / 2.0);
}

/* Five-number summary (+ count and average) over the non-null values. */
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
		average: round1(sum / (n * 1.0)),
		median: median(sorted_values),
		q1: sorted_values[int(n * 0.25)],
		q3: sorted_values[int(n * 0.75)],
	};
}

export {
	value_or,
	positive_number,
	round1,
	normalize_mac,
	dominant,
	summarise
};
