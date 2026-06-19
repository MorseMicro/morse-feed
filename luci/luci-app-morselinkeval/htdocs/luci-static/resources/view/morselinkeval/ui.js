'use strict';
/* globals baseclass */
'require baseclass';

/* Shared form/layout scaffold and ubus-response helpers used by both the Peer
 * Link and Link Planner tabs. The quality/interference rendering lives in
 * interference.js, the alerts panel in alerts.js, the poll timer in
 * polltimer.js and the chart in chart.js. */

/* -------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

const MAX_SAMPLES = 300; /* 5 min at 1 s poll (minimum interval) */

/* -------------------------------------------------------------------------
 * ubus response helpers
 * ------------------------------------------------------------------------- */

/* True if a ubus response represents an error. The backend uses
 * `{ status: "failed", error: "..." }` for hard failures and
 * `{ status: "no active session" }` when no session exists. */
function isErrorResponse(res) {
	if (!res) return true;
	if (res.error) return true;
	if (res.status === 'failed') return true;
	if (res.status === 'no active session') return true;
	return false;
}

function describeError(res, fallback) {
	if (!res) return fallback;
	if (res.error) return res.error;
	if (res.status) return res.status;
	return fallback;
}

/* Await a ubus RPC, turning a rejection into an error string so callers can
 * branch on [res, err] instead of repeating try/catch. */
async function rpcCall(promise) {
	try {
		return [await promise, null];
	} catch (e) {
		return [null, e && e.message ? e.message : String(e)];
	}
}

/* -------------------------------------------------------------------------
 * Section panel
 * ------------------------------------------------------------------------- */

/* Bordered panel with a header bar, giving the major sections a consistent
 * look. Body children are placed under the header. */
function createSectionPanel(icon, title, subtitle, bodyChildren) {
	const header = E('div', { class: 'mle-section-header' }, [
		E('span', { class: 'mle-section-header-title' }, [
			icon ? E('span', { class: 'mle-section-header-icon' }, icon) : '',
			title,
		]),
	]);

	const body = E('div', { class: 'mle-section-body' },
		(subtitle ? [E('div', { class: 'mle-section-sub' }, subtitle)] : [])
			.concat(bodyChildren || []));

	const boxElem = E('div', { class: 'mle-section-panel' }, [header, body]);
	return { boxElem, header, body };
}

/* -------------------------------------------------------------------------
 * Shared form / layout builders
 *
 * Identical scaffolding for the two tabs — the interface selector, channel-info
 * chips, scenario/refresh filters and the status-bar prefix. Centralised here
 * so the tabs stay in lock-step.
 * ------------------------------------------------------------------------- */

/* Placeholder shown when no HaLow interfaces exist (both tabs + the view). */
function noInterfacesNotice() {
	return E('div', { class: 'cbi-section' }, [
		E('p', { class: 'mle-dim' },
			_('No HaLow AP or STA interfaces found.')),
	]);
}

/* Interface <select> + mode badge. Returns both so the caller can cache the
 * badge for later updateModeBadge() calls. */
function createInterfaceSelector(ifaces, currentIface, onChange) {
	const select = E('select', {
		class: 'cbi-input-select',
		change: ev => onChange(ev.target.value),
	}, ifaces.map(i =>
		E('option', { value: i.ifname }, `${i.ifname} (${i.mode.toUpperCase()})`)));

	const badge = E('span', {
		class: `mle-mode-badge mle-mode-${currentIface.mode}`,
	}, currentIface.mode.toUpperCase() + ' ' + _('MODE'));

	return { select, badge };
}

function updateModeBadge(badge, iface) {
	if (!badge || !iface) return;
	badge.textContent = iface.mode.toUpperCase() + ' ' + _('MODE');
	badge.className = `mle-mode-badge mle-mode-${iface.mode}`;
}

/* A labelled value chip (label + value). `valueNode` may be a string or an
 * element. Shared by the channel-info row and the planner propagation summary. */
function infoChip(label, valueNode) {
	return E('span', { class: 'mle-chip mle-info-chip' }, [
		E('span', { class: 'mle-info-chip-lbl' }, label),
		E('span', { class: 'mle-info-chip-val' }, [valueNode]),
	]);
}

/* Render the Channel / Center Frequency / Bandwidth chip row into `elem` from a
 * getChanInfoParts() result. */
function renderChannelInfo(elem, parts) {
	if (!elem) return;
	parts = parts || { channel: null, frequency: null, bandwidth: null };

	const val = v => (v != null && v !== '' ? String(v) : '—');
	elem.replaceChildren(
		E('span', { class: 'mle-chip-label' }, _('Channel Info:')),
		infoChip(_('Channel'), val(parts.channel)),
		infoChip(_('Center Frequency'), val(parts.frequency)),
		infoChip(_('Bandwidth'), val(parts.bandwidth)),
	);
}

/* "Show profiles:" filter row. onChange receives the selected filter value
 * ('all' | 'typical' | 'conservative' | 'worst'); worst-case is preselected. */
function createScenarioFilter(onChange) {
	return E('div', { class: 'mle-scenario-filter-row' }, [
		E('label', {}, _('Show profiles:')),
		E('select', {
			class: 'cbi-input-select',
			change: ev => onChange(ev.target.value),
		}, [
			E('option', { value: 'all' }, _('All')),
			E('option', { value: 'typical' }, _('Typical')),
			E('option', { value: 'conservative' }, _('Conservative')),
			E('option', { value: 'worst', selected: true }, _('Worst-case')),
		]),
	]);
}

/* Toggle the per-profile column-hiding classes on a quality table. */
function applyScenarioFilter(tableElem, filter) {
	if (!tableElem) return;
	tableElem.classList.toggle('mle-hide-typical', filter !== 'all' && filter !== 'typical');
	tableElem.classList.toggle('mle-hide-conservative', filter !== 'all' && filter !== 'conservative');
	tableElem.classList.toggle('mle-hide-worst', filter !== 'all' && filter !== 'worst');
}

/* Refresh-interval <select> (1/2/5/10 s; 2 s preselected). onChange receives the
 * chosen interval in seconds. */
function createIntervalSelect(onChange) {
	return E('select', {
		class: 'cbi-input-select',
		change: ev => onChange(parseInt(ev.target.value, 10)),
	}, [
		E('option', { value: '1' }, '1 s'),
		E('option', { value: '2', selected: true }, '2 s'),
		E('option', { value: '5' }, '5 s'),
		E('option', { value: '10' }, '10 s'),
	]);
}

/* Leading status-bar nodes shared by both tabs: a live/idle indicator and the
 * current interface. Callers append their own trailing nodes (peer count /
 * model). `activeLabel` is the running-state word ('Collecting' / 'Estimating'). */
function statusBase(running, ifname, activeLabel) {
	return [
		running
			? E('span', {}, [E('span', { class: 'mle-live-dot' }), activeLabel])
			: E('span', { class: 'mle-dim' }, _('Idle')),
		E('span', {}, [_('Interface:'), ' ', E('b', {}, ifname || '—')]),
	];
}

return baseclass.extend({
	MAX_SAMPLES,
	isErrorResponse,
	describeError,
	rpcCall,
	createSectionPanel,
	noInterfacesNotice,
	createInterfaceSelector,
	updateModeBadge,
	infoChip,
	renderChannelInfo,
	createScenarioFilter,
	createIntervalSelect,
	applyScenarioFilter,
	statusBase,
});
