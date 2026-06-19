'use strict';
/* globals baseclass */
'require baseclass';

/* Link-quality and interference rendering shared by both tabs: the per-profile
 * quality cells (Link Quality Prediction) and the interference / link-stability
 * panel (Interference Live). Kept together so the two views stay visually and
 * behaviourally identical. */

/* Maps backend quality strings to CSS class suffixes used in the UI. */
const QUALITY_CLASS = {
	'Excellent': 'excellent',
	'Good': 'good',
	'Moderate': 'fair',
	'Low': 'fair',
	'Very Poor': 'poor',
};

/* The five interference characteristics (display_interference_characteristics
 * in the Python reference). Each carries a short chip name plus a verbose
 * description explaining what the pattern means to the user. `agc_triggered`
 * and `impacted` are NOT here — they describe link stability (Metric 2) and
 * are rendered as a separate verdict banner. */
const INTERFERENCE_TYPES = [
	{
		key: 'cellular_suspected',
		name: _('Cellular'),
		desc: _('Very high-power out-of-band interference — suspected source: cellular tower.'),
	},
	{
		key: 'in_channel_detected',
		name: _('In-channel'),
		desc: _('Narrowband interference detected inside the operating channel.'),
	},
	{
		key: 'close_channel_detected',
		name: _('Close-channel'),
		desc: _('High-power interference observed close to the operating channel.'),
	},
	{
		key: 'same_channel_detected',
		name: _('Same-channel'),
		desc: _('Other Wi-Fi HaLow networks detected on the same channel.'),
	},
	{
		key: 'adjacent_channel_detected',
		name: _('Adjacent-channel'),
		desc: _('Wi-Fi HaLow network(s) may be present on an adjacent or overlapping channel.'),
	},
];

/* -------------------------------------------------------------------------
 * Quality cells
 * ------------------------------------------------------------------------- */

function fmt(val, unit) {
	if (val == null) return E('span', { class: 'mle-dim' }, '—');
	return E('span', {}, [String(val), E('span', { class: 'mle-unit' }, ' ' + unit)]);
}

function buildLiveDirContent(dirLabel, dir) {
	const rateMbps = dir.rate != null ? `${(dir.rate / 1000).toFixed(1)} Mbps` : null;
	const nodes = [
		E('span', { class: 'mle-live-dir' }, dirLabel + ' '),
		dir.mcs != null
			? E('span', { class: 'mle-live-val-sm' }, `MCS ${dir.mcs}`)
			: E('span', { class: 'mle-dim' }, '—'),
	];
	if (dir.sgi) nodes.push(E('span', { class: 'mle-live-sgi' }, 'SGI'));
	if (rateMbps) nodes.push(E('span', { class: 'mle-live-rate' }, rateMbps));
	return nodes;
}

function qualityBadge(quality) {
	const cls = QUALITY_CLASS[quality] || 'poor';
	return E('span', { class: `mle-badge mle-q-${cls}` }, quality || '—');
}

function metricRow(label, valueNode) {
	return E('div', { class: 'mle-metric' }, [
		E('span', { class: 'mle-metric-lbl' }, label),
		E('span', { class: 'mle-metric-val' }, [valueNode]),
	]);
}

/* Animated "Collecting…" placeholder shown in a prediction cell while the
 * backend is still warming up (no profile data yet). The pulsing dot matches
 * the warming indicator in the Interference Live panel. */
function warmingCell() {
	return E('div', { class: 'mle-cell-q mle-warming' }, [
		E('span', { class: 'mle-collecting-dot' }),
		_('Collecting…'),
	]);
}

/* Render a single mcs_quality profile cell (Typical / Conservative / Worst-case). */
function qualityCell(profile) {
	if (!profile) return warmingCell();
	return E('div', { class: `mle-cell-q mle-q-${QUALITY_CLASS[profile.quality] || 'poor'}-bg` }, [
		qualityBadge(profile.quality),
		metricRow(_('RSSI'), fmt(profile.rssi_dbm, 'dBm')),
		metricRow(_('Noise & Interf.'), fmt(profile.noise_dbm, 'dBm')),
		metricRow(_('SINR'), fmt(profile.snr_db, 'dB')),
		metricRow(_('MCS'), fmt(profile.max_mcs, '')),
	]);
}

/* -------------------------------------------------------------------------
 * Interference panel
 *
 * Renders the shared interference / link-stability chips from a
 * `link_stability` object. Used identically by both tabs.
 * ------------------------------------------------------------------------- */

/* Link & Rate Stability verdict banner (Metric 2 — display_link_instability).
 * Driven by the two booleans the backend puts on the wire; three states.
 *
 * The verdict (notably `impacted`) is per-peer, so an optional `peer`
 * ({ mac, color }) prefixes the banner with the same station dot used in the
 * MAC cell plus the peer MAC, tagging the banner with `data-mac` so callers
 * can update it in place. */
function stabilityBanner(stab, peer) {
	let cls, icon, text;
	if (!stab.agc_triggered) {
		cls = 'mle-stab-ok';
		icon = '✓';
		text = _('Link is stable.');
	} else if (!stab.impacted) {
		cls = 'mle-stab-ok mle-stab-spikes';
		icon = '✓';
		text = _('Interference trigger spikes seen, but the link remains stable.');
	} else {
		cls = 'mle-stab-warn';
		icon = '⚠';
		text = _('Interference can introduce link instabilities.');
	}
	const children = [
		E('span', { class: 'mle-stab-icon' }, icon),
		E('span', {}, text),
	];
	if (peer) {
		children.unshift(
			E('span', { class: 'mle-station-dot', style: `background:${peer.color}` }),
			E('span', { class: 'mle-stab-mac' }, peer.mac),
		);
	}
	return E('div', {
		'class': `mle-stab-banner ${cls}`,
		'data-mac': peer ? peer.mac : null,
	}, children);
}

/* Interference Characteristics block (Block B) from a `link_stability`
 * object: verbose cards (active highlighted, inactive dimmed) with an
 * anomaly-count summary. The detected characteristics are common to the
 * channel, not per-peer. */
function interferenceCharacteristics(stab) {
	const cards = INTERFERENCE_TYPES.map(({ key, name, desc }) => {
		const active = !!stab[key];
		return E('div', {
			class: `mle-intf-chip ${active ? 'mle-intf-chip-active' : 'mle-intf-chip-clear mle-intf-chip-muted'}`,
		}, [
			E('div', { class: 'mle-intf-chip-head' }, [
				E('span', { class: 'mle-intf-chip-icon' }, active ? '⚠' : '✓'),
				E('span', { class: 'mle-intf-chip-name' }, name),
				E('span', { class: 'mle-intf-chip-state' }, active ? _('detected') : _('clear')),
			]),
			E('div', { class: 'mle-intf-chip-desc' }, desc),
		]);
	});

	const anomalies = INTERFERENCE_TYPES.filter(({ key }) => stab[key]).length;
	return E('div', { class: 'mle-intf-block' }, [
		E('div', { class: 'mle-intf-block-title' }, _('Interference Characteristics')),
		E('div', { class: 'mle-intf-summary' }, [
			E('span', {
				class: `mle-intf-summary-badge ${anomalies > 0 ? 'mle-intf-summary-warn' : 'mle-intf-summary-ok'}`,
			}, anomalies > 0
				? `${anomalies} ${anomalies === 1 ? _('anomaly detected') : _('anomalies detected')}`
				: _('All clear')),
		]),
		E('div', { class: 'mle-intf-grid' }, cards),
	]);
}

/* Renders two labelled blocks into `elem` from a `link_stability` object:
 *   A — Link & Rate Stability  (verdict banner)
 *   B — Interference Characteristics  (verbose cards; active highlighted,
 *       inactive dimmed). Used by the single-link Link Planner tab; the Peer
 *       Link tab composes per-peer banners itself (see peerlink.js). */
function renderInterferencePanel(elem, stab) {
	if (!elem || !stab) return;

	/* Block A — Link & Rate Stability */
	const stabBlock = E('div', { class: 'mle-intf-block' }, [
		E('div', { class: 'mle-intf-block-title' }, _('Link Stability')),
		stabilityBanner(stab),
	]);

	elem.replaceChildren(stabBlock, interferenceCharacteristics(stab));
}

/* Verbose legend for the Link Quality Prediction table (Metric 1 —
 * display_link_quality_metric1): explains the three SINR estimates and the
 * quality scale. Appended under the table by both tabs. */
function qualityLegend() {
	/* Quality scale, worst → best. Each tier gets a coloured station-dot. */
	const SCALE = [
		[_('Very Poor'), 'poor'],
		[_('Low'), 'low'],
		[_('Moderate'), 'moderate'],
		[_('Good'), 'good'],
		[_('Excellent'), 'excellent'],
	];

	function scaleItem(label, tier) {
		return E('span', { class: 'mle-q-legend-scale-item' }, [
			E('span', { class: 'mle-station-dot mle-q-scale-dot-' + tier }),
			label,
		]);
	}

	return E('div', { class: 'mle-q-legend' }, [
		E('div', { class: 'mle-q-legend-scale' }, [
			E('span', { class: 'mle-q-legend-scale-label' }, _('Scale')),
			...SCALE.map(s => scaleItem(s[0], s[1])),
		]),
	]);
}

/* Idle / warming placeholders for the interference panel. */
function intfEmpty(text) {
	return E('div', { class: 'mle-placeholder mle-intf-empty' }, text);
}

function intfWarming() {
	return E('div', { class: 'mle-placeholder mle-intf-warming' }, [
		E('span', { class: 'mle-collecting-dot' }), _('Collecting…'),
	]);
}

return baseclass.extend({
	fmt,
	buildLiveDirContent,
	qualityCell,
	warmingCell,
	qualityLegend,
	stabilityBanner,
	interferenceCharacteristics,
	renderInterferencePanel,
	intfEmpty,
	intfWarming,
});
