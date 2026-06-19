'use strict';
/* globals baseclass mleApi mleUi mleIntf mleAlerts mlePoll mleChart */
'require baseclass';
'require view.morselinkeval.api as mleApi';
'require view.morselinkeval.ui as mleUi';
'require view.morselinkeval.interference as mleIntf';
'require view.morselinkeval.alerts as mleAlerts';
'require view.morselinkeval.polltimer as mlePoll';
'require view.morselinkeval.chart as mleChart';

/* Shared helpers split across modules; these are pure functions — safe to
 * alias at module scope. */
const {
	isErrorResponse, describeError, rpcCall, createSectionPanel,
	noInterfacesNotice, createInterfaceSelector, updateModeBadge,
	renderChannelInfo, createScenarioFilter, createIntervalSelect, applyScenarioFilter,
	statusBase,
} = mleUi;
const {
	buildLiveDirContent, qualityCell, warmingCell, qualityLegend,
	stabilityBanner, interferenceCharacteristics, intfEmpty, intfWarming,
} = mleIntf;
const { createAlertsPanel } = mleAlerts;
const { PollTimer } = mlePoll;
const { LinkChart } = mleChart;

/* -------------------------------------------------------------------------
 * Constants (peer-link specific)
 * ------------------------------------------------------------------------- */

const PEER_COLORS = ['#6c2c91', '#1f7a3d', '#d97706', '#2874a6'];

function macSlug(mac) {
	return mac.replace(/:/g, '-');
}

/* -------------------------------------------------------------------------
 * PeerLinkController
 *
 * Owns all state for the Peer Link tab. Construct one with the available
 * interfaces, then call render() to build the DOM element.
 * ------------------------------------------------------------------------- */

class PeerLinkController {
	/* ---- mutable state ---- */
	#ifaces;
	#opts;
	#currentIface;
	#pollInterval = 2;
	#running = false;
	#timer = null; /* private PollTimer; null when not polling */
	#colorIndex = 0;

	/* peerMap: mac -> { color, rowElem, started } */
	#peerMap = new Map();

	/* ---- chart component (created during render) ----
	 * Owns the per-peer ring buffers, the plot and the Peer/Profile/Window
	 * selectors; this controller only feeds it samples via push()/refresh(). */
	#chart = null;

	/* ---- cached DOM roots (set during render, used for in-place updates) ---- */
	#peerSelectElem = null;
	#chipBarElem = null;
	#statusTextElem = null;
	#tableBodyElem = null;
	#tableElem = null;
	#emptyHintElem = null;
	#addBtnElem = null;
	#ifaceBadgeElem = null;
	#peerHintElem = null;
	#intfPanelElem = null;
	#stabBannersElem = null;
	#intfCharElem = null;
	#channelInfoElem = null;

	/* ---- diagnostics / alerts panel ---- */
	#alerts = null;

	constructor(ifaces, opts) {
		this.#ifaces = ifaces;
		this.#opts = opts || {};
		this.#currentIface = ifaces[0] || null;
	}

	/* ---- helpers ---- */

	#nextColor() {
		return PEER_COLORS[this.#colorIndex++ % PEER_COLORS.length];
	}

	#updateStatusBar() {
		if (!this.#statusTextElem) return;
		const count = this.#peerMap.size;
		const ifname = this.#currentIface ? this.#currentIface.ifname : null;
		this.#statusTextElem.replaceChildren(
			...statusBase(this.#running, ifname, _('Collecting')),
			E('span', {}, [
				E('b', {}, String(count)),
				' ',
				count === 1 ? _('active peer') : _('active peers'),
			]),
		);
	}

	#updateEmptyHint() {
		if (!this.#emptyHintElem) return;
		this.#emptyHintElem.hidden = this.#peerMap.size > 0;
	}

	/* Rebuild the chip bar from peerMap. */
	#updateChips() {
		if (!this.#chipBarElem) return;

		const label = E('span', { class: 'mle-chip-label' }, _('Monitoring:'));
		const chips = [...this.#peerMap.entries()].map(([mac, state]) => {
			const chip = E('span', { 'class': 'mle-chip mle-peer-chip', 'data-mac': mac }, [
				E('span', { class: 'mle-chip-dot', style: `background:${state.color}` }),
				E('span', { class: 'mle-chip-mac' }, mac),
				E('span', {
					class: 'mle-x-btn mle-chip-x',
					title: _('Remove peer'),
					click: () => this.#removePeer(mac),
				}, '×'),
			]);
			return chip;
		});

		if (chips.length === 0) {
			chips.push(E('span', { class: 'mle-chip-empty' }, _('No peers selected')));
		}

		this.#chipBarElem.replaceChildren(label, ...chips);
	}

	/* Refresh the AP peer dropdown to reflect the current interface assoclist. */
	#updatePeerSelector() {
		if (!this.#peerSelectElem || !this.#currentIface) return;

		const peers = mleApi.getPeersForInterface(this.#currentIface);

		if (this.#currentIface.mode === 'ap') {
			const opts = [E('option', { value: '' }, _('— select a station —'))];
			peers.forEach((mac) => {
				opts.push(E('option', { value: mac }, mac));
			});
			this.#peerSelectElem.replaceChildren(...opts);

			if (this.#peerHintElem) {
				this.#peerHintElem.textContent = `(${peers.length} ${_('connected')})`;
			}
			if (this.#addBtnElem) this.#addBtnElem.hidden = false;
		} else {
			this.#peerSelectElem.value = peers[0] || '';
			if (this.#addBtnElem) this.#addBtnElem.hidden = false;
		}
	}

	/* ---- peer lifecycle ---- */

	/* Local-only cleanup: removes a peer from state, DOM and chart without
	 * touching the backend. Use on error paths where the backend session is
	 * already gone (or never started). */
	#detachPeer(mac) {
		const entry = this.#peerMap.get(mac);
		if (!entry) return;

		if (entry.rowElem && entry.rowElem.parentNode) {
			entry.rowElem.parentNode.removeChild(entry.rowElem);
		}

		/* Drop this peer's stability banner (the common Interference
		 * Characteristics block stays — it is channel-wide). */
		if (this.#stabBannersElem) {
			const banner = this.#stabBannersElem.querySelector(`[data-mac="${mac}"]`);
			if (banner) banner.remove();
		}

		this.#peerMap.delete(mac);
		if (this.#chart) this.#chart.removeSeries(mac);

		this.#updateChips();
		this.#updateEmptyHint();
		this.#updateStatusBar();

		if (this.#peerMap.size === 0) {
			this.#stopPolling();
			this.#renderIntfPanelEmpty();
		}
	}

	async #addPeer(mac) {
		if (!mac || !this.#currentIface) return;
		mac = mac.toUpperCase();

		if (this.#peerMap.has(mac)) {
			return;
		}

		const color = this.#nextColor();
		const tbody = this.#tableBodyElem;

		/* Build table row — cells will be populated on first poll. */
		const row = E('tr', { 'id': `mle-row-${macSlug(mac)}`, 'data-mac': mac }, [
			E('td', {}, [
				E('div', { class: 'mle-cell-mac' }, [
					E('span', { class: 'mle-station-dot', style: `background:${color}` }),
					E('span', { class: 'mle-mac-addr' }, mac),
					E('div', { class: 'mle-live-readout' }, [
						E('div', { class: 'mle-live-label' }, _('Live · now')),
						E('div', { id: `mle-live-tx-${macSlug(mac)}`, class: 'mle-live-row' }, '—'),
						E('div', { id: `mle-live-rx-${macSlug(mac)}`, class: 'mle-live-row' }, '—'),
					]),
				]),
			]),
			E('td', { id: `mle-typical-${macSlug(mac)}`, class: 'mle-col-typical' }, [warmingCell()]),
			E('td', { id: `mle-conservative-${macSlug(mac)}`, class: 'mle-col-conservative' }, [warmingCell()]),
			E('td', { id: `mle-worst-${macSlug(mac)}`, class: 'mle-col-worst' }, [warmingCell()]),
		]);

		if (tbody) tbody.appendChild(row);

		this.#peerMap.set(mac, { color, rowElem: row, started: false });
		/* Register the peer's chart series (auto-selects the first one). */
		if (this.#chart) this.#chart.addSeries(mac);

		/* First peer added: swap the "add peers" hint for a warming indicator
		 * until live interference data arrives. */
		if (this.#peerMap.size === 1) this.#renderIntfPanelWarming();

		this.#updateChips();
		this.#updateEmptyHint();
		this.#updateStatusBar();

		/* Start the backend session. */
		const [estimateRes, estimateErr] = await rpcCall(
			mleApi.peerLinkEstimate(this.#currentIface.ifname, mac));

		if (estimateErr || isErrorResponse(estimateRes)) {
			const detail = estimateErr || describeError(estimateRes, _('Failed to start estimation session'));
			this.#alerts.addAlert('error',
				_('Failed to start link estimation for peer') + ' ' + mac,
				detail);
			this.#detachPeer(mac);
			return;
		}

		const entry = this.#peerMap.get(mac);
		if (entry) entry.started = true;

		if (!this.#running) await this.#startPolling();
	}

	async #removePeer(mac) {
		const entry = this.#peerMap.get(mac);
		if (!entry) return;

		/* Stop the backend session. Whether it succeeds or fails, the peer is
		 * removed from local state — the user has asked to drop it. */
		await rpcCall(mleApi.peerLinkStop(this.#currentIface.ifname, mac));
		this.#detachPeer(mac);
	}

	/* ---- poll loop ---- */

	async #doPoll() {
		if (!this.#currentIface || this.#peerMap.size === 0) return;

		/* Snapshot the keys — detachPeer() may mutate peerMap mid-iteration. */
		const macs = [...this.#peerMap.keys()];
		for (const mac of macs) {
			const [res, rpcErr] = await rpcCall(
				mleApi.peerLinkStatus(this.#currentIface.ifname, mac));

			if (rpcErr || isErrorResponse(res)) {
				/* Backend lost the session (or never had one). Drop this peer
				 * and notify the user — the row and any chart for this peer
				 * are no longer backed by live data. */
				const detail = rpcErr || describeError(res, _('Link estimation session ended unexpectedly'));
				this.#alerts.addAlert('error',
					_('Lost link estimation session for peer') + ' ' + mac,
					detail);
				this.#detachPeer(mac);
				continue;
			}

			if (res.status === 'ok') {
				const data = res[mac] || res[mac.toUpperCase()];
				if (data) this.#updatePeerRow(mac, data);
			}
			/* status === 'warming' is normal — wait for next poll. */
		}
		this.#updateStatusBar();
	}

	async #startPolling() {
		if (this.#running) return;
		this.#running = true;

		/* Peer Link and Link Planner sessions are mutually exclusive on the
		 * backend — let the host pause the other tab. */
		if (typeof this.#opts.onBusy === 'function') this.#opts.onBusy();

		/* Own a private timer rather than the global poll loop, so this tab's
		 * refresh state stays local (no shared header toggle). Recreated on each
		 * start so a changed #pollInterval is picked up. */
		this.#timer = new PollTimer(() => this.#doPoll(), this.#pollInterval);
		this.#timer.start();

		this.#updateStatusBar();
	}

	#stopPolling() {
		if (!this.#running) return;
		this.#running = false;

		if (this.#timer) {
			this.#timer.stop();
			this.#timer = null;
		}

		this.#updateStatusBar();
	}

	/* ---- in-place table row update ---- */

	#updatePeerRow(mac, data) {
		const slug = macSlug(mac);
		const mcsQ = data.mcs_quality;
		const stab = data.link_stability;

		const typicalTd = document.getElementById(`mle-typical-${slug}`);
		const conservativeTd = document.getElementById(`mle-conservative-${slug}`);
		const worstTd = document.getElementById(`mle-worst-${slug}`);

		if (typicalTd && mcsQ)
			typicalTd.replaceChildren(qualityCell(mcsQ.typical));

		if (conservativeTd && mcsQ)
			conservativeTd.replaceChildren(qualityCell(mcsQ.conservative));

		if (worstTd && mcsQ)
			worstTd.replaceChildren(qualityCell(mcsQ.worst_case));

		/* Link stability is per-peer (one banner per peer MAC); the
		 * Interference Characteristics are common to the channel and refreshed
		 * by every peer update. */
		if (stab) {
			this.#ensureIntfPanel();
			this.#updateStabBanner(mac, stab);
			if (this.#intfCharElem)
				this.#intfCharElem.replaceChildren(interferenceCharacteristics(stab));
		}

		/* Live TX/RX rate, MCS, and SGI readout in the MAC cell */
		const liveTx = document.getElementById(`mle-live-tx-${slug}`);
		const liveRx = document.getElementById(`mle-live-rx-${slug}`);
		const cur = data.current;

		if (liveTx && cur?.tx) liveTx.replaceChildren(...buildLiveDirContent('TX', cur.tx));
		if (liveRx && cur?.rx) liveRx.replaceChildren(...buildLiveDirContent('RX', cur.rx));

		/* Feed the chart; it repaints only if this peer is the one on display. */
		if (this.#chart) {
			this.#chart.push(mac, data.mcs_quality, { cur_mcs: data.current?.rx?.mcs ?? null });
			this.#chart.refresh(mac);
		}
	}

	/* Build the populated interference panel scaffold the first time live data
	 * arrives: a Link Stability block holding one banner per peer, plus the
	 * common Interference Characteristics block. Subsequent updates patch the
	 * banners / characteristics in place. */
	#ensureIntfPanel() {
		if (!this.#intfPanelElem || this.#stabBannersElem) return;

		this.#stabBannersElem = E('div', { class: 'mle-stab-banners' }, []);
		const stabBlock = E('div', { class: 'mle-intf-block' }, [
			E('div', { class: 'mle-intf-block-title' }, _('Link Stability')),
			this.#stabBannersElem,
		]);

		this.#intfCharElem = E('div', { class: 'mle-intf-block' }, []);

		this.#intfPanelElem.replaceChildren(stabBlock, this.#intfCharElem);
	}

	/* Create or refresh the per-peer stability banner, keyed by MAC and tinted
	 * with the peer's chart color. */
	#updateStabBanner(mac, stab) {
		if (!this.#stabBannersElem) return;
		const entry = this.#peerMap.get(mac);
		if (!entry) return;

		const banner = stabilityBanner(stab, { mac, color: entry.color });
		const existing = this.#stabBannersElem.querySelector(`[data-mac="${mac}"]`);
		if (existing) existing.replaceWith(banner);
		else this.#stabBannersElem.appendChild(banner);
	}

	/* Show the "add peers" hint in the interference panel when no peers exist. */
	#renderIntfPanelEmpty() {
		if (!this.#intfPanelElem) return;
		this.#stabBannersElem = null;
		this.#intfCharElem = null;
		this.#intfPanelElem.replaceChildren(
			intfEmpty(_('Add peers above to start monitoring link quality.')));
	}

	/* Show "Collecting…" in the interference panel while peers exist but no
	 * live interference data has arrived yet (warming period), matching the
	 * Link Quality Prediction table cells. */
	#renderIntfPanelWarming() {
		if (!this.#intfPanelElem) return;
		this.#stabBannersElem = null;
		this.#intfCharElem = null;
		this.#intfPanelElem.replaceChildren(intfWarming());
	}

	/* ---- interface change handler ---- */

	async #onIfaceChange(ifname) {
		if (this.#running) this.#stopPolling();
		for (const mac of [...this.#peerMap.keys()]) {
			await this.#removePeer(mac);
		}
		this.#colorIndex = 0;

		this.#currentIface = this.#ifaces.find(i => i.ifname === ifname) || null;

		this.#renderIntfPanelEmpty();
		updateModeBadge(this.#ifaceBadgeElem, this.#currentIface);

		this.#updateChannelInfo();
		this.#updatePeerSelector();
		this.#updateStatusBar();
	}

	#updateChannelInfo() {
		const parts = this.#currentIface ? mleApi.getChanInfoParts(this.#currentIface.network) : null;
		renderChannelInfo(this.#channelInfoElem, parts);
	}

	/* ---- initial render ---- */

	render() {
		if (!this.#currentIface) return noInterfacesNotice();

		const { select: ifaceSelectElem, badge }
			= createInterfaceSelector(this.#ifaces, this.#currentIface, ifname => this.#onIfaceChange(ifname));
		this.#ifaceBadgeElem = badge;

		/* Peer input — AP: dropdown from assoclist; STA: read-only text */
		const initPeers = mleApi.getPeersForInterface(this.#currentIface);

		if (this.#currentIface.mode === 'ap') {
			const opts = [E('option', { value: '' }, _('— select a station —'))];
			initPeers.forEach(mac => opts.push(E('option', { value: mac }, mac)));
			this.#peerSelectElem = E('select', { class: 'cbi-input-select mle-select-mono' }, opts);
		} else {
			this.#peerSelectElem = E('input', {
				type: 'text',
				class: 'mle-input-mac',
				value: initPeers[0] || '',
				readonly: true,
				title: _('STA mode: peer is auto-detected from the connected AP'),
			});
		}

		this.#peerHintElem = E('span', { class: 'mle-hint' },
			this.#currentIface.mode === 'ap'
				? `(${initPeers.length} ${_('connected')})`
				: (initPeers[0] ? _('connected') : _('not connected')));

		this.#addBtnElem = E('button', {
			class: 'cbi-button cbi-button-add',
			click: () => {
				const mac = this.#peerSelectElem.value;
				if (mac) this.#addPeer(mac);
			},
		}, _('+ Add'));

		const intervalSelect = createIntervalSelect((sec) => {
			this.#pollInterval = sec;
			if (this.#chart) this.#chart.setPollInterval(sec);
			if (this.#running) {
				this.#stopPolling();
				this.#startPolling();
			}
		});

		const formRow = E('div', { class: 'mle-form-row' }, [
			E('label', {}, _('Interface')),
			ifaceSelectElem,
			this.#ifaceBadgeElem,
			E('label', { style: 'margin-left:12px' }, _('Add Peer')),
			this.#peerSelectElem,
			this.#addBtnElem,
			this.#peerHintElem,
			E('div', { style: 'flex:1' }),
			E('label', {}, _('Refresh')),
			intervalSelect,
		]);

		this.#chipBarElem = E('div', { class: 'mle-chip-bar' }, [
			E('span', { class: 'mle-chip-label' }, _('Monitoring:')),
			E('span', { class: 'mle-chip-empty' }, _('No peers selected')),
		]);

		this.#statusTextElem = E('div', { class: 'mle-status-bar' }, []);
		this.#updateStatusBar();

		this.#alerts = createAlertsPanel();

		this.#tableBodyElem = E('tbody');
		this.#emptyHintElem = E('tr', { class: 'mle-empty-row' }, [
			E('td', { colspan: '4' }, [
				E('div', { class: 'mle-placeholder' },
					_('Add peers above to start monitoring link quality.')),
			]),
		]);
		this.#tableBodyElem.appendChild(this.#emptyHintElem);

		this.#tableElem = E('table', { class: 'mle-lq-table' }, [
			E('thead', {}, [
				E('tr', {}, [
					E('th', { class: 'mle-col-mac' }, _('Peer MAC')),
					E('th', { class: 'mle-col-q mle-col-typical' }, _('Typical')),
					E('th', { class: 'mle-col-q mle-col-conservative' }, _('Conservative')),
					E('th', { class: 'mle-col-q mle-col-worst' }, _('Worst-case')),
				]),
			]),
			this.#tableBodyElem,
		]);

		const scenarioFilterRow = createScenarioFilter(f => applyScenarioFilter(this.#tableElem, f));

		this.#intfPanelElem = E('div', { class: 'mle-intf-panel' }, []);
		this.#renderIntfPanelEmpty();

		this.#channelInfoElem = E('div', { class: 'mle-intf-chan' });
		this.#updateChannelInfo();

		const intfSection = createSectionPanel('📡', _('Interference Live'),
			null, [this.#channelInfoElem, this.#intfPanelElem],
		).boxElem;
		intfSection.classList.add('mle-intf-section');

		const tableSection = createSectionPanel('📊', _('Link Quality Prediction'),
			_('Predicted link quality per peer under three operating profiles.'),
			[scenarioFilterRow, this.#tableElem, qualityLegend()],
		).boxElem;

		applyScenarioFilter(this.#tableElem, 'worst');

		/* ---- Chart section ----
		 * Per-peer series (peerSelect) with the Predicted and Current MCS lines. */
		this.#chart = new LinkChart({
			mcsLines: true,
			currentMcs: true,
			peerSelect: true,
			statFields: [
				{ key: 'rssi', label: _('Current RSSI'), unit: 'dBm', color: '#6c2c91' },
				{ key: 'noise', label: _('Current Noise'), unit: 'dBm', color: '#c0392b' },
				{ key: 'sinr', label: _('Current SINR'), unit: 'dB', color: '#2d8b4e' },
				{ key: 'mcs', label: _('Predicted MCS'), unit: '', color: '#222222' },
			],
		});
		this.#chart.setPollInterval(this.#pollInterval);

		return E('div', { class: 'mle-peerlink-wrapper' }, [
			formRow,
			this.#chipBarElem,
			this.#statusTextElem,
			this.#alerts.boxElem,
			intfSection,
			tableSection,
			this.#chart.section,
		]);
	}

	/* ---- public lifecycle ---- */

	pause() {
		this.#stopPolling();
	}

	destroy() {
		if (this.#running) this.#stopPolling();
		if (this.#chart) {
			this.#chart.destroy();
			this.#chart = null;
		}
	}
}

return baseclass.extend({ PeerLinkController });
