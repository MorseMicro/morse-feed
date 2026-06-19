'use strict';
/* globals baseclass mleApi mleUi mleIntf mleAlerts mlePoll mleChart */
'require baseclass';
'require view.morselinkeval.api as mleApi';
'require view.morselinkeval.ui as mleUi';
'require view.morselinkeval.interference as mleIntf';
'require view.morselinkeval.alerts as mleAlerts';
'require view.morselinkeval.polltimer as mlePoll';
'require view.morselinkeval.chart as mleChart';

/* Shared helpers split across modules. */
const {
	isErrorResponse, describeError, rpcCall, createSectionPanel,
	noInterfacesNotice, createInterfaceSelector, updateModeBadge,
	infoChip, renderChannelInfo, createScenarioFilter, createIntervalSelect, applyScenarioFilter,
	statusBase,
} = mleUi;
const {
	fmt, qualityCell, warmingCell, qualityLegend,
	renderInterferencePanel, intfEmpty, intfWarming,
} = mleIntf;
const { createAlertsPanel } = mleAlerts;
const { PollTimer } = mlePoll;
const { LinkChart } = mleChart;

/* -------------------------------------------------------------------------
 * Defaults
 * ------------------------------------------------------------------------- */

const DISTANCE_DEFAULT = 1000; /* metres */
const ATTEN_DEFAULT = 0; /* dB */
const FADE_DEFAULT = 10; /* dB */

const IDLE_MSG = _('Start the session to monitor link quality.');

/* -------------------------------------------------------------------------
 * LinkPlannerController
 *
 * Drives the one-shot morse.eval.link_planner ubus object. Unlike the Peer
 * Link tab, the planner is not peer-specific: the user supplies a propagation
 * input (distance OR attenuation) plus a fade margin, and the backend returns
 * a single predicted-link estimate refined with the measured local noise floor.
 *
 * opts.onBusy() — optional callback invoked when this tab starts an estimate,
 * so the host can pause the (mutually exclusive) Peer Link tab.
 * ------------------------------------------------------------------------- */

class LinkPlannerController {
	/* ---- mutable state ---- */
	#ifaces;
	#opts;
	#currentIface;
	#inputMode = 'distance'; /* 'distance' | 'attenuation' */
	#pollInterval = 2;
	#running = false;
	#timer = null; /* private PollTimer; null when not polling */

	/* ---- chart component (created during render) ---- */
	#chart = null;

	/* ---- cached DOM roots ---- */
	#ifaceBadgeElem = null;
	#distanceInput = null;
	#attenInput = null;
	#fadeInput = null;
	#distanceRadio = null;
	#attenRadio = null;
	#actionBtnElem = null;
	#statusTextElem = null;
	#channelInfoElem = null;
	#summaryElem = null;
	#tableElem = null;
	#typicalTd = null;
	#conservativeTd = null;
	#worstTd = null;
	#intfPanelElem = null;
	#alerts = null;

	constructor(ifaces, opts) {
		this.#ifaces = ifaces;
		this.#opts = opts || {};
		this.#currentIface = ifaces[0] || null;
	}

	/* ---- status / summary helpers ---- */

	#updateStatusBar(model) {
		if (!this.#statusTextElem) return;
		const ifname = this.#currentIface ? this.#currentIface.ifname : null;
		const nodes = statusBase(this.#running, ifname, _('Estimating'));
		if (model) {
			nodes.push(E('span', {}, [
				_('Model:'), ' ',
				E('b', {}, model === 'manual' ? _('Manual attenuation') : _('Free-space (FSPL)')),
			]));
		}
		this.#statusTextElem.replaceChildren(...nodes);
	}

	#updateChannelInfo() {
		const parts = this.#currentIface ? mleApi.getChanInfoParts(this.#currentIface.network) : null;
		renderChannelInfo(this.#channelInfoElem, parts);
	}

	/* Render the (static) propagation-model estimate summary. */
	#renderSummary(est) {
		if (!this.#summaryElem) return;
		if (!est) {
			this.#summaryElem.replaceChildren(
				E('div', { class: 'mle-placeholder' }, _('No estimate yet — set inputs and click Estimate.')));
			return;
		}

		const pathInput = est.attenuation_db != null
			? infoChip(_('Attenuation'), fmt(est.attenuation_db, 'dB'))
			: infoChip(_('Distance'), fmt(est.distance_m, 'm'));

		this.#summaryElem.replaceChildren(
			E('div', { class: 'mle-plan-chips' }, [
				infoChip(_('Model'),
					E('span', {}, est.model === 'manual' ? _('Manual') : _('FSPL'))),
				pathInput,
				infoChip(_('Path loss'), fmt(est.path_loss_db, 'dB')),
				infoChip(_('Tx power'), fmt(est.tx_power_dbm, 'dBm')),
				infoChip(_('Fade margin'), fmt(est.fade_margin_db, 'dB')),
				infoChip(_('Frequency'), fmt(est.freq_mhz, 'MHz')),
				infoChip(_('Bandwidth'), fmt(est.bw_mhz, 'MHz')),
			]),
			E('div', { class: 'mle-plan-rssi' }, [
				E('div', { class: 'mle-plan-stat' }, [
					E('div', { class: 'mle-stat-lbl' }, _('Predicted RSSI · typical')),
					E('div', { class: 'mle-stat-val mle-plan-stat-val' }, [fmt(est.rssi_typical_dbm, 'dBm')]),
				]),
				E('div', { class: 'mle-plan-stat' }, [
					E('div', { class: 'mle-stat-lbl' }, _('Predicted RSSI · worst-case')),
					E('div', { class: 'mle-stat-val mle-plan-stat-val' }, [fmt(est.rssi_worst_dbm, 'dBm')]),
				]),
			]),
		);
	}

	#renderQuality(mcsQ) {
		if (!mcsQ) return;
		if (this.#typicalTd) this.#typicalTd.replaceChildren(qualityCell(mcsQ.typical));
		if (this.#conservativeTd) this.#conservativeTd.replaceChildren(qualityCell(mcsQ.conservative));
		if (this.#worstTd) this.#worstTd.replaceChildren(qualityCell(mcsQ.worst_case));
	}

	/* ---- input mode toggle ---- */

	/* Switching mode enables the chosen input and resets + disables the other,
	 * enforcing "one of distance / attenuation" (last selection wins). */
	#setInputMode(mode) {
		this.#inputMode = mode;
		if (this.#distanceRadio) this.#distanceRadio.checked = (mode === 'distance');
		if (this.#attenRadio) this.#attenRadio.checked = (mode === 'attenuation');

		if (mode === 'distance') {
			if (this.#distanceInput) this.#distanceInput.disabled = false;
			if (this.#attenInput) {
				this.#attenInput.disabled = true;
				this.#attenInput.value = String(ATTEN_DEFAULT);
			}
		} else {
			if (this.#attenInput) this.#attenInput.disabled = false;
			if (this.#distanceInput) {
				this.#distanceInput.disabled = true;
				this.#distanceInput.value = String(DISTANCE_DEFAULT);
			}
		}
	}

	/* ---- estimate lifecycle ---- */

	/* Idle placeholder for a prediction cell — shown before any estimate runs.
	 * Uses the shared .mle-placeholder style so it matches the Interference Live
	 * idle text exactly. */
	#idleCell() {
		return E('div', { class: 'mle-placeholder' }, IDLE_MSG);
	}

	/* Idle state: nothing running — prompt the user to start an estimate. */
	#showIdle() {
		if (this.#typicalTd) this.#typicalTd.replaceChildren(this.#idleCell());
		if (this.#conservativeTd) this.#conservativeTd.replaceChildren(this.#idleCell());
		if (this.#worstTd) this.#worstTd.replaceChildren(this.#idleCell());
		if (this.#intfPanelElem) this.#intfPanelElem.replaceChildren(intfEmpty(IDLE_MSG));
		if (this.#chart) this.#chart.resetBuffers();
	}

	/* Warming state: an estimate has started but no data has arrived yet. */
	#showWarming() {
		if (this.#typicalTd) this.#typicalTd.replaceChildren(warmingCell());
		if (this.#conservativeTd) this.#conservativeTd.replaceChildren(warmingCell());
		if (this.#worstTd) this.#worstTd.replaceChildren(warmingCell());
		if (this.#intfPanelElem) this.#intfPanelElem.replaceChildren(intfWarming());
		if (this.#chart) this.#chart.resetBuffers();
	}

	async #startEstimate() {
		if (!this.#currentIface) return;

		/* Resolve the single propagation input. The inactive field must be left
		 * undefined so LuCI omits it from the ubus call entirely:
		 *   - ubus rejects an explicit null for a numerically-typed arg
		 *     (INVALID_ARGUMENT), which would silently abort the estimate;
		 *   - the backend treats attenuation_db: 0 as a valid manual value, so
		 *     sending 0 there would mask a distance request.
		 * The backend's `args.<field> == null` check handles the missing key. */
		let distance_m;
		let attenuation_db;
		const fade_margin_db = parseFloat(this.#fadeInput.value);

		if (this.#inputMode === 'distance') {
			distance_m = parseFloat(this.#distanceInput.value);
			if (!(distance_m > 0)) {
				this.#alerts.addAlert('error', _('Invalid distance'),
					_('Distance must be greater than 0 metres.'));
				return;
			}
		} else {
			attenuation_db = parseFloat(this.#attenInput.value);
			if (!(attenuation_db >= 0)) {
				this.#alerts.addAlert('error', _('Invalid attenuation'),
					_('Attenuation must be 0 dB or greater.'));
				return;
			}
		}

		if (!(fade_margin_db >= 0)) {
			this.#alerts.addAlert('error', _('Invalid fade margin'),
				_('Fade margin must be 0 dB or greater.'));
			return;
		}

		/* Heads-up: an estimate runs a medium eval on the firmware that shares
		 * airtime with live traffic, so warn before starting. */
		this.#alerts.addAlert('info', _('Link planner started'),
			_('Runs a medium eval on the firmware; may impact throughput on connected stations.'));

		/* The planner and Peer Link sessions are mutually exclusive on the
		 * backend — let the host pause the other tab. */
		if (typeof this.#opts.onBusy === 'function') this.#opts.onBusy();

		this.#showWarming();
		/* Spin immediately so the button reflects the in-flight start request,
		 * just like the ping page. Reverted below if the start request fails. */
		this.#setButtonBusy(true);

		const [res, rpcErr] = await rpcCall(mleApi.linkPlannerEstimate(
			this.#currentIface.ifname, distance_m, attenuation_db, fade_margin_db));

		/* Require an explicit "started" — anything else (error body, or an empty
		 * response from a rejected ubus call) must not fall through to polling,
		 * which would surface a misleading "no active session". */
		if (rpcErr || isErrorResponse(res) || !res || res.status !== 'started') {
			const detail = rpcErr || describeError(res, _('Failed to start link planning estimate'));
			this.#alerts.addAlert('error', _('Link planning estimate failed'), detail);
			this.#setButtonBusy(false);
			return;
		}

		this.#startPolling();
	}

	async #doPoll() {
		if (!this.#running) return;

		const [res, rpcErr] = await rpcCall(mleApi.linkPlannerStatus());

		if (rpcErr || isErrorResponse(res)) {
			const detail = rpcErr || describeError(res, _('Link planning session ended unexpectedly'));
			this.#alerts.addAlert('error', _('Lost link planning session'), detail);
			this.#stopPolling();
			return;
		}

		/* estimate is present in both warming and ok bodies. */
		if (res.estimate) {
			this.#renderSummary(res.estimate);
			this.#updateStatusBar(res.estimate.model);
		}

		if (res.status === 'ok') {
			this.#renderQuality(res.mcs_quality);
			if (res.link_stability) renderInterferencePanel(this.#intfPanelElem, res.link_stability);
			this.#chart.push(null, res.mcs_quality);
			this.#chart.refresh();
		}
		/* status === 'warming' is normal — keep polling. */
	}

	/* Toggle the single action button between its idle ("Estimate") and busy
	 * ("Stop") states. The busy state mirrors the ping diagnostics page: the
	 * `spinning` themed class renders a spinning wheel on the button (no icon
	 * glyph), and the label becomes "Stop". */
	#setButtonBusy(busy) {
		const btn = this.#actionBtnElem;
		if (!btn) return;
		if (busy) {
			btn.classList.add('spinning');
			btn.textContent = _('Stop');
		} else {
			btn.classList.remove('spinning');
			btn.textContent = _('Estimate');
		}
	}

	#startPolling() {
		if (this.#running) return;
		this.#running = true;

		/* Own a private timer rather than the global poll loop, so this tab's
		 * refresh state stays local (no shared header toggle). Recreated on each
		 * start so a changed #pollInterval is picked up. */
		this.#timer = new PollTimer(() => this.#doPoll(), this.#pollInterval);
		this.#timer.start();

		this.#setButtonBusy(true);
		this.#updateStatusBar();
	}

	async #stopPolling() {
		if (!this.#running) return;
		this.#running = false;

		if (this.#timer) {
			this.#timer.stop();
			this.#timer = null;
		}

		await rpcCall(mleApi.linkPlannerStop()); /* best-effort */

		this.#setButtonBusy(false);
		this.#updateStatusBar();
	}

	#onIfaceChange(ifname) {
		this.#stopPolling();
		this.#currentIface = this.#ifaces.find(i => i.ifname === ifname) || null;

		updateModeBadge(this.#ifaceBadgeElem, this.#currentIface);

		this.#renderSummary(null);
		this.#showIdle();
		this.#updateChannelInfo();
		this.#updateStatusBar();
	}

	/* ---- initial render ---- */

	render() {
		if (!this.#currentIface) return noInterfacesNotice();

		const { select: ifaceSelectElem, badge }
			= createInterfaceSelector(this.#ifaces, this.#currentIface, ifname => this.#onIfaceChange(ifname));
		this.#ifaceBadgeElem = badge;

		/* Input-mode radio toggle: Distance | Attenuation */
		this.#distanceRadio = E('input', {
			type: 'radio', name: 'mle-plan-mode', value: 'distance', checked: true,
			change: () => this.#setInputMode('distance'),
		});
		this.#attenRadio = E('input', {
			type: 'radio', name: 'mle-plan-mode', value: 'attenuation',
			change: () => this.#setInputMode('attenuation'),
		});

		this.#distanceInput = E('input', {
			type: 'number', class: 'mle-input-num', min: '1', step: '1',
			value: String(DISTANCE_DEFAULT),
			/* Typing in distance also makes it the active mode. */
			focus: () => { if (this.#inputMode !== 'distance') this.#setInputMode('distance'); },
		});
		this.#attenInput = E('input', {
			type: 'number', class: 'mle-input-num', min: '0', step: '0.1',
			value: String(ATTEN_DEFAULT), disabled: true,
			focus: () => { if (this.#inputMode !== 'attenuation') this.#setInputMode('attenuation'); },
		});
		this.#fadeInput = E('input', {
			type: 'number', class: 'mle-input-num', min: '0', step: '0.5',
			value: String(FADE_DEFAULT),
		});

		/* Each propagation mode is a self-contained segment (radio + label +
		 * value + unit) so the radio, text and input box all share one
		 * baseline — avoids the misalignment of a flat row of mixed controls. */
		const inputToggle = E('div', { class: 'mle-input-toggle' }, [
			E('label', { class: 'mle-plan-seg' }, [
				this.#distanceRadio,
				E('span', { class: 'mle-plan-seg-lbl' }, _('Distance')),
				this.#distanceInput,
				E('span', { class: 'mle-unit' }, 'm'),
			]),
			E('label', { class: 'mle-plan-seg' }, [
				this.#attenRadio,
				E('span', { class: 'mle-plan-seg-lbl' }, _('Attenuation')),
				this.#attenInput,
				E('span', { class: 'mle-unit' }, 'dB'),
			]),
		]);

		/* Single action button: starts an estimate when idle, stops the running
		 * session when busy. While busy it shows a spinning wheel (the themed
		 * `spinning` class) and the label "Stop" — see #setButtonBusy. */
		this.#actionBtnElem = E('button', {
			class: 'cbi-button cbi-button-action',
			click: () => {
				if (this.#running) this.#stopPolling();
				else this.#startEstimate();
			},
		}, _('Estimate'));

		const intervalSelect = createIntervalSelect((sec) => {
			this.#pollInterval = sec;
			if (this.#chart) this.#chart.setPollInterval(sec);
			if (this.#running) {
				this.#stopPolling().then(() => this.#startPolling());
			}
		});

		const formRow = E('div', { class: 'mle-form-row' }, [
			E('label', {}, _('Interface')),
			ifaceSelectElem,
			this.#ifaceBadgeElem,
			E('label', { style: 'margin-left:12px' }, _('Plan by')),
			inputToggle,
			E('label', { style: 'margin-left:12px' }, _('Fade margin')),
			this.#fadeInput,
			E('span', { class: 'mle-unit' }, 'dB'),
			E('div', { style: 'flex:1' }),
			E('label', {}, _('Refresh')),
			intervalSelect,
			this.#actionBtnElem,
		]);

		this.#statusTextElem = E('div', { class: 'mle-status-bar' }, []);
		this.#updateStatusBar();

		this.#alerts = createAlertsPanel();

		this.#summaryElem = E('div', { class: 'mle-plan-summary' });
		this.#renderSummary(null);

		const summarySection = createSectionPanel('📐', _('Propagation Estimate'),
			_('Predicted RSSI from the propagation model, using the interface Tx power and channel read from the driver.'),
			[this.#summaryElem],
		).boxElem;

		/* Quality table — single row, three operating profiles.
		 * Idle until an estimate is started. */
		this.#typicalTd = E('td', { class: 'mle-col-typical' }, [this.#idleCell()]);
		this.#conservativeTd = E('td', { class: 'mle-col-conservative' }, [this.#idleCell()]);
		this.#worstTd = E('td', { class: 'mle-col-worst' }, [this.#idleCell()]);

		this.#tableElem = E('table', { class: 'mle-lq-table' }, [
			E('thead', {}, [
				E('tr', {}, [
					E('th', { class: 'mle-col-q mle-col-typical' }, _('Typical')),
					E('th', { class: 'mle-col-q mle-col-conservative' }, _('Conservative')),
					E('th', { class: 'mle-col-q mle-col-worst' }, _('Worst-case')),
				]),
			]),
			E('tbody', {}, [E('tr', {}, [this.#typicalTd, this.#conservativeTd, this.#worstTd])]),
		]);

		const scenarioFilterRow = createScenarioFilter(f => applyScenarioFilter(this.#tableElem, f));

		const tableSection = createSectionPanel('📊', _('Link Quality Prediction'),
			_('Predicted link quality under three operating profiles for the planned link.'),
			[scenarioFilterRow, this.#tableElem, qualityLegend()],
		).boxElem;

		applyScenarioFilter(this.#tableElem, 'worst');

		/* Interference live panel — idle until an estimate is started. */
		this.#intfPanelElem = E('div', { class: 'mle-intf-panel' }, [intfEmpty(IDLE_MSG)]);
		this.#channelInfoElem = E('div', { class: 'mle-intf-chan' });
		this.#updateChannelInfo();

		const intfSection = createSectionPanel('📡', _('Interference Live'),
			_('Channel interference measured locally on this interface during the estimate.'),
			[this.#channelInfoElem, this.#intfPanelElem],
		).boxElem;
		intfSection.classList.add('mle-intf-section');

		/* ---- Chart section ----
		 * Single series with the Predicted MCS line. Current MCS is not
		 * applicable in a planning session — there is no live association — so
		 * currentMcs stays off. Predicted RSSI is constant; the measured noise
		 * floor and resulting SINR (and hence the predicted MCS) vary as the
		 * local channel is sampled. */
		this.#chart = new LinkChart({
			mcsLines: true,
			currentMcs: false,
			peerSelect: false,
			subtitle: _('Predicted RSSI is constant; the measured noise floor, resulting SINR and predicted MCS vary as the current channel is sampled.'),
			statFields: [
				{ key: 'rssi', label: _('Predicted RSSI'), unit: 'dBm', color: '#6c2c91' },
				{ key: 'noise', label: _('Measured Noise'), unit: 'dBm', color: '#c0392b' },
				{ key: 'sinr', label: _('SINR'), unit: 'dB', color: '#2d8b4e' },
				{ key: 'mcs', label: _('Predicted MCS'), unit: '', color: '#222222' },
			],
		});
		this.#chart.setPollInterval(this.#pollInterval);

		return E('div', { class: 'mle-peerlink-wrapper' }, [
			formRow,
			this.#statusTextElem,
			this.#alerts.boxElem,
			summarySection,
			tableSection,
			intfSection,
			this.#chart.section,
		]);
	}

	/* ---- public lifecycle ---- */

	pause() {
		this.#stopPolling();
	}

	destroy() {
		this.#stopPolling();
		if (this.#chart) {
			this.#chart.destroy();
			this.#chart = null;
		}
	}
}

return baseclass.extend({ LinkPlannerController });
