'use strict';
/* globals baseclass mleUi Chart */
'require baseclass';
'require view.morselinkeval.ui as mleUi';

/* Self-contained link-quality time-series chart component.
 *
 * Both diagnostics tabs plot the same thing — a zone-filled Noise/RSSI line
 * chart over a rolling time window, with a "current values" stat strip and
 * Profile/Window (and optionally Peer) selectors. The only differences are:
 *
 *   - Peer Link tracks one buffer *per peer* and adds both the Predicted and
 *     Current MCS lines (mcsLines + currentMcs + peerSelect).
 *   - Link Planner tracks a single buffer and plots only the Predicted MCS
 *     line (mcsLines, no currentMcs): there is no live association, so a
 *     Current MCS is not applicable.
 *
 * LinkChart encapsulates the ring buffers, the windowing/padding maths, the
 * Chart.js instance and all the selector wiring, exposing a small data-in /
 * refresh API so each controller only has to feed it samples.
 */

const { MAX_SAMPLES, createSectionPanel } = mleUi;

const PROFILES = ['typical', 'conservative', 'worst_case'];

/* Internal series key used when peerSelect is off (single-series planner). */
const SINGLE = '_';

/* Map MCS index onto the dBm axis: MCS 0 → -10 dBm, MCS 9 → -70 dBm. */
function mcsToDbm(mcs) {
	if (mcs == null) return null;
	return -10 - (mcs * 60 / 9);
}

/* -------------------------------------------------------------------------
 * LinkChart — stateful time-series chart component
 *
 * opts:
 *   mcsLines    (bool)   — plot the Predicted MCS line (peer link + planner)
 *   currentMcs  (bool)   — also plot the Current MCS line (peer link only);
 *                          requires mcsLines. The planner has no live
 *                          association, so it leaves this off.
 *   peerSelect  (bool)   — show a Peer <select>; the caller manages series via
 *                          addSeries(key) / removeSeries(key). When false the
 *                          chart tracks a single implicit series.
 *   subtitle    (string) — optional section subtitle
 *   statFields  (array)  — current-values stat strip descriptors:
 *                          { key, label, unit, color } where `key` indexes the
 *                          sample ('rssi' | 'noise' | 'sinr' | 'mcs').
 *
 * Public surface:
 *   section                        // DOM element to place in the page
 *   addSeries(key) / removeSeries(key)
 *   resetBuffers()                 // clear all samples + the plot
 *   push(key, mcsQuality, extra)   // append a sample for each profile
 *   refresh(key)                   // repaint if `key` is the active series
 *   setPollInterval(seconds)       // affects how many samples fit the window
 *   destroy()
 * ------------------------------------------------------------------------- */
class LinkChart {
	/* ---- config ---- */
	#mcsLines;
	#currentMcs;
	#peerSelect;
	#statFields;
	#subtitle;

	/* ---- state ---- */
	#buffers = new Map(); /* key → { typical:[], conservative:[], worst_case:[] } */
	#chartInstance = null;
	#profile = 'worst_case';
	#windowSec = 60;
	#pollInterval = 2;
	#activeKey;

	/* ---- DOM ---- */
	#canvasElem = null;
	#statsElem = null;
	#peerSelectElem = null;

	/* DOM element to place in the page (public). */
	section = null;

	constructor(opts) {
		opts = opts || {};
		this.#mcsLines = !!opts.mcsLines;
		/* Current MCS only makes sense alongside the Predicted line. */
		this.#currentMcs = !!opts.mcsLines && !!opts.currentMcs;
		this.#peerSelect = !!opts.peerSelect;
		this.#statFields = opts.statFields || [];
		this.#subtitle = opts.subtitle || null;
		this.#activeKey = this.#peerSelect ? null : SINGLE;

		this.#buildSection();
	}

	#ensureBuffer(key) {
		if (!this.#buffers.has(key))
			this.#buffers.set(key, { typical: [], conservative: [], worst_case: [] });
		return this.#buffers.get(key);
	}

	/* ---- series management (peer link) ---- */

	addSeries(key) {
		this.#ensureBuffer(key);
		if (this.#activeKey == null) this.#activeKey = key;
		this.#updatePeerOptions();
	}

	removeSeries(key) {
		this.#buffers.delete(key);
		if (this.#activeKey === key) {
			this.#activeKey = this.#buffers.size ? [...this.#buffers.keys()][0] : null;
			this.#clearDisplay();
			if (this.#activeKey != null) this.refresh(this.#activeKey);
		}
		this.#updatePeerOptions();
	}

	resetBuffers() {
		this.#buffers.forEach((b) => {
			b.typical = [];
			b.conservative = [];
			b.worst_case = [];
		});
		this.#clearDisplay();
	}

	#updatePeerOptions() {
		if (!this.#peerSelectElem) return;
		const optionNodes = [...this.#buffers.keys()].map(mac =>
			E('option', { value: mac, selected: mac === this.#activeKey }, mac));
		if (optionNodes.length === 0)
			optionNodes.push(E('option', { value: '' }, _('— no peers —')));
		this.#peerSelectElem.replaceChildren(...optionNodes);
		if (this.#activeKey != null) this.#peerSelectElem.value = this.#activeKey;
	}

	/* ---- data in ---- */

	push(key, mcsQuality, extra) {
		if (!mcsQuality) return;
		const buf = this.#ensureBuffer(this.#peerSelect ? key : SINGLE);
		const ts = new Date().toLocaleTimeString([],
			{ hour: '2-digit', minute: '2-digit', second: '2-digit' });

		for (const p of PROFILES) {
			const s = mcsQuality[p];
			if (!s) continue;
			const arr = buf[p];
			if (arr.length >= MAX_SAMPLES) arr.shift();
			arr.push(Object.assign({
				rssi: s.rssi_dbm,
				noise: s.noise_dbm,
				sinr: s.snr_db,
				mcs: s.max_mcs,
				ts,
			}, extra || {}));
		}
	}

	/* ---- rendering ---- */

	refresh(key) {
		if (!this.#chartInstance) return;
		/* Multi-series: only repaint when the touched series is the active one. */
		if (this.#peerSelect && key != null && key !== this.#activeKey) return;
		if (this.#activeKey == null) return;

		const buf = this.#buffers.get(this.#activeKey);
		if (!buf) return;

		const windowSamples = Math.ceil(this.#windowSec / this.#pollInterval);
		const samples = (buf[this.#profile] || []).slice(-windowSamples);

		/* Pad the right side with nulls so the X axis represents the full window;
		 * the line then grows left → right as samples arrive rather than
		 * stretching the few we have across the whole width. */
		const padCount = Math.max(0, windowSamples - samples.length);
		const padNulls = new Array(padCount).fill(null);
		const padLabels = new Array(padCount).fill('');

		this.#chartInstance.data.labels = samples.map(s => s.ts).concat(padLabels);
		this.#chartInstance.data.datasets[0].data = samples.map(s => s.noise).concat(padNulls);
		this.#chartInstance.data.datasets[1].data = samples.map(s => s.rssi).concat(padNulls);
		if (this.#mcsLines) {
			this.#chartInstance.data.datasets[2].data = samples.map(s => mcsToDbm(s.mcs)).concat(padNulls);
			if (this.#currentMcs)
				this.#chartInstance.data.datasets[3].data = samples.map(s => mcsToDbm(s.cur_mcs)).concat(padNulls);
		}
		this.#chartInstance.update('none');

		const last = samples[samples.length - 1];
		if (last) this.#renderStats(last);
	}

	#clearDisplay() {
		if (!this.#chartInstance) return;
		this.#chartInstance.data.labels = [];
		this.#chartInstance.data.datasets.forEach((ds) => {
			ds.data = [];
		});
		this.#chartInstance.update('none');
		if (this.#statsElem) this.#statsElem.replaceChildren();
	}

	#renderStats(sample) {
		if (!this.#statsElem) return;
		this.#statsElem.replaceChildren(
			...this.#statFields.map(f => E('div', { class: 'mle-chart-stat' }, [
				E('div', { class: 'mle-stat-lbl' }, f.label),
				E('div', { class: 'mle-stat-val', style: `color:${f.color}` }, [
					sample[f.key] != null ? String(sample[f.key]) : '—',
					f.unit ? E('span', { class: 'mle-unit' }, ' ' + f.unit) : '',
				]),
			])),
		);
	}

	/* ---- section build ---- */

	#filterLabel(text, indent) {
		return E('span', {
			class: 'mle-chart-filter-label',
			style: indent ? 'margin-left:12px' : '',
		}, text);
	}

	#buildSection() {
		const filterRow = E('div', { class: 'mle-chart-filter-row' }, []);
		const filterKids = [];

		if (this.#peerSelect) {
			this.#peerSelectElem = E('select', {
				class: 'cbi-input-select mle-select-mono',
				change: (ev) => {
					this.#activeKey = ev.target.value || null;
					this.#clearDisplay();
					if (this.#activeKey != null) this.refresh(this.#activeKey);
				},
			}, [E('option', { value: '' }, _('— no peers —'))]);
			filterKids.push(this.#filterLabel(_('Peer:')), this.#peerSelectElem);
		}

		const profileSelectElem = E('select', {
			class: 'cbi-input-select',
			change: (ev) => {
				this.#profile = ev.target.value;
				this.#clearDisplay();
				this.refresh();
			},
		}, [
			E('option', { value: 'typical' }, _('Typical')),
			E('option', { value: 'conservative' }, _('Conservative')),
			E('option', { value: 'worst_case', selected: true }, _('Worst-case')),
		]);
		filterKids.push(this.#filterLabel(_('Profile:'), this.#peerSelect), profileSelectElem);

		const windowSelectElem = E('select', {
			class: 'cbi-input-select',
			change: (ev) => {
				this.#windowSec = parseInt(ev.target.value, 10);
				this.refresh();
			},
		}, [
			E('option', { value: '30' }, '30 s'),
			E('option', { value: '60', selected: true }, '1 min'),
			E('option', { value: '120' }, '2 min'),
			E('option', { value: '300' }, '5 min'),
		]);
		filterKids.push(this.#filterLabel(_('Window:'), true), windowSelectElem);

		filterRow.replaceChildren(...filterKids);

		this.#canvasElem = E('canvas', { class: 'mle-chart-canvas' });
		this.#statsElem = E('div', {
			class: 'mle-chart-stats' + (this.#statFields.length === 3 ? ' mle-chart-stats-3' : ''),
		});

		this.section = createSectionPanel('📈', _('Link Quality Prediction Over Time'),
			this.#subtitle,
			[filterRow, E('div', { class: 'mle-chart-wrap' }, [this.#canvasElem]), this.#statsElem],
		).boxElem;
		this.section.classList.add('mle-chart-section');

		/* Initialise the Chart.js instance once the canvas is in the DOM. */
		requestAnimationFrame(() => {
			this.#chartInstance = LinkChart.#buildQualityChart(this.#canvasElem,
				{ mcsLines: this.#mcsLines, currentMcs: this.#currentMcs });
		});
	}

	/* ---- public lifecycle ---- */

	setPollInterval(seconds) {
		this.#pollInterval = seconds;
	}

	destroy() {
		if (this.#chartInstance) {
			this.#chartInstance.destroy();
			this.#chartInstance = null;
		}
		this.#buffers.clear();
	}

	/* -------------------------------------------------------------------------
	 * Chart.js builder (zone-fill line chart)
	 *
	 * opts.mcsLines  (default false) — when true, adds the Predicted MCS dataset
	 *   and the right-hand MCS index axis. Both diagnostics tabs enable this; the
	 *   planner predicts a per-profile MCS just as the peer link does.
	 * opts.currentMcs (default false) — when true (peer link only), also adds the
	 *   Current MCS dataset (the live rx.mcs). The planner leaves this off: there
	 *   is no live association, so a Current MCS is not applicable.
	 * Returns null when Chart.js failed to load.
	 * ------------------------------------------------------------------------- */
	static #buildQualityChart(canvas, opts) {
		if (typeof Chart === 'undefined') return null;

		opts = opts || {};
		const mcsLines = !!opts.mcsLines;
		const currentMcs = mcsLines && !!opts.currentMcs;

		/* Custom plugin — paints three background zones BEFORE datasets are drawn.
		 * Using canvas paths directly avoids Chart.js fill quirks with reverse:true.
		 *
		 *   RED    — chart top  → Noise line  (noise floor)
		 *   GREEN  — Noise line → RSSI line   (SINR / signal margin zone)
		 *   PURPLE — RSSI line  → chart bottom (signal strength headroom)
		 *
		 * Dataset layout:
		 *   0 — Noise (dBm)  : red border line
		 *   1 — RSSI  (dBm)  : purple border line
		 *   2 — MCS Index    : dark line, mapped via mcsToDbm()
		 */
		const zoneFillPlugin = {
			id: 'hlZoneFill',
			beforeDatasetsDraw(chart) {
				const { ctx, scales, chartArea } = chart;
				if (!chartArea) return;
				const { top, bottom } = chartArea;
				const yScale = scales.yDbm;
				const xScale = scales.x;

				const noiseData = chart.data.datasets[0].data;
				const rssiData = chart.data.datasets[1].data;
				const n = Math.min(noiseData.length, rssiData.length);
				if (n === 0) return;

				/* Pixel-space points for each data line. */
				const noisePts = [];
				const rssiPts = [];
				for (let i = 0; i < n; i++) {
					const x = xScale.getPixelForValue(i);
					if (noiseData[i] != null)
						noisePts.push({ x, y: yScale.getPixelForValue(noiseData[i]) });
					if (rssiData[i] != null)
						rssiPts.push({ x, y: yScale.getPixelForValue(rssiData[i]) });
				}
				if (!noisePts.length || !rssiPts.length) return;

				ctx.save();
				ctx.beginPath();

				/* Zones should only extend as far as actual samples exist, so the
				 * plot grows from left → right as time advances. */
				const lastNoiseX = noisePts[noisePts.length - 1].x;
				const lastRssiX = rssiPts[rssiPts.length - 1].x;
				const firstX = Math.min(noisePts[0].x, rssiPts[0].x);

				/* Red zone: top edge → Noise polyline → back to top edge (closed). */
				ctx.moveTo(firstX, top);
				noisePts.forEach(p => ctx.lineTo(p.x, p.y));
				ctx.lineTo(lastNoiseX, top);
				ctx.closePath();
				ctx.fillStyle = 'rgba(192,57,43,0.28)';
				ctx.fill();

				/* Green zone: Noise polyline forward → RSSI polyline backward (closed). */
				ctx.beginPath();
				noisePts.forEach((p, i) => (i === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, p.x, p.y));
				for (let i = rssiPts.length - 1; i >= 0; i--)
					ctx.lineTo(rssiPts[i].x, rssiPts[i].y);
				ctx.closePath();
				ctx.fillStyle = 'rgba(45,139,78,0.28)';
				ctx.fill();

				/* Purple zone: RSSI polyline → bottom edge (closed). */
				ctx.beginPath();
				rssiPts.forEach((p, i) => (i === 0 ? ctx.moveTo : ctx.lineTo).call(ctx, p.x, p.y));
				ctx.lineTo(lastRssiX, bottom);
				ctx.lineTo(firstX, bottom);
				ctx.closePath();
				ctx.fillStyle = 'rgba(108,44,145,0.22)';
				ctx.fill();

				ctx.restore();
			},
		};

		const datasets = [
			{
				/* 0 — Noise floor */
				label: _('Noise (dBm)'),
				data: [],
				borderColor: '#c0392b',
				borderWidth: 2,
				fill: false,
				pointRadius: 0,
				pointStyle: 'rect',
				yAxisID: 'yDbm',
				tension: 0,
				order: 2,
			},
			{
				/* 1 — RSSI signal */
				label: _('RSSI (dBm)'),
				data: [],
				borderColor: '#6c2c91',
				borderWidth: 2,
				fill: false,
				pointRadius: 0,
				pointStyle: 'rect',
				yAxisID: 'yDbm',
				tension: 0,
				order: 2,
			},
		];

		if (mcsLines) {
			datasets.push({
				/* 2 — Predicted MCS: mapped via mcsToDbm() (solid line) */
				label: _('Predicted MCS'),
				data: [],
				borderColor: '#222222',
				borderWidth: 2,
				fill: false,
				pointRadius: 0,
				pointStyle: 'line',
				yAxisID: 'yDbm',
				tension: 0,
				order: 1,
			});
		}

		if (currentMcs) {
			datasets.push({
				/* 3 — Current MCS (rx.mcs): black dotted line */
				label: _('Current MCS'),
				data: [],
				borderColor: '#000000',
				borderWidth: 2,
				borderDash: [4, 4],
				fill: false,
				pointRadius: 0,
				pointStyle: 'line',
				yAxisID: 'yDbm',
				tension: 0,
				order: 1,
			});
		}

		return new Chart(canvas, {
			type: 'line',
			plugins: [zoneFillPlugin],
			data: {
				labels: [],
				datasets,
			},
			options: {
				animation: false,
				responsive: true,
				maintainAspectRatio: false,
				interaction: { mode: 'index', intersect: false },
				scales: {
					x: {
						ticks: {
							maxTicksLimit: 6,
							color: '#555',
							font: { family: 'Courier New, monospace', size: 11 },
						},
						grid: { color: '#eeeeee' },
					},
					yDbm: {
						type: 'linear',
						position: 'left',
						min: -130,
						max: 5,
						reverse: true,
						title: {
							display: true,
							text: 'dBm',
							font: { weight: '700', size: 12 },
							color: '#333',
						},
						ticks: {
							color: '#555',
							font: { family: 'Courier New, monospace', size: 11 },
						},
						grid: { color: '#eeeeee' },
					},
					/* Right axis: same scale, labelled with MCS indices.
					 * Only present when the MCS datasets are shown (peer link). */
					...(mcsLines
						? {
								yMcs: {
									type: 'linear',
									position: 'right',
									min: -130,
									max: 5,
									reverse: true,
									afterBuildTicks: (axis) => {
										axis.ticks = Array.from({ length: 10 }, (_, i) => ({ value: mcsToDbm(i) }));
									},
									ticks: {
										callback: (value) => {
											const mcs = Math.round((value + 10) * (-9 / 60));
											return (mcs >= 0 && mcs <= 9) ? `MCS ${mcs}` : null;
										},
										color: '#666',
										font: { family: 'Courier New, monospace', size: 10 },
									},
									grid: { drawOnChartArea: false },
									title: {
										display: true,
										text: 'MCS Index',
										font: { weight: '700', size: 11 },
										color: '#555',
									},
								},
							}
						: {}),
				},
				plugins: {
					legend: {
						display: true,
						position: 'top',
						labels: {
							font: { size: 12 },
							usePointStyle: true,
							pointStyleWidth: 26,
							/* Per-dataset pointStyle gives Noise/RSSI box markers and
							 * the MCS series line markers. Chart.js v4 builds point-
							 * style markers from the point element, which has no
							 * borderDash, so a dashed line would render solid; restore
							 * each marker's dash from its dataset's line borderDash so
							 * Current MCS shows dotted and Predicted solid. */
							generateLabels: (chart) => {
								const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
								items.forEach((item) => {
									const ds = chart.data.datasets[item.datasetIndex];
									if (ds) item.lineDash = ds.borderDash || [];
								});
								return items;
							},
						},
					},
					tooltip: {
						enabled: true,
						callbacks: {
							label: (ctx) => {
								if (ctx.datasetIndex === 2 || ctx.datasetIndex === 3) {
									const mcs = Math.max(0, Math.min(9,
										Math.round((ctx.parsed.y + 10) * (-9 / 60))));
									return `${ctx.dataset.label}: ${mcs}`;
								}
								return `${ctx.dataset.label}: ${ctx.parsed.y} dBm`;
							},
						},
					},
				},
			},
		});
	}
}

return baseclass.extend({ LinkChart });
