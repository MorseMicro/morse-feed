'use strict';
/* globals baseclass */
'require baseclass';

/* Diagnostics / alerts panel.
 *
 * createAlertsPanel() builds the alerts box and returns both the root element
 * and a small API (addAlert / clearAlerts) that owns its own DOM + counts. */
function createAlertsPanel() {
	const countElem = E('span', { class: 'mle-alerts-count' }, '0');
	const cntErrElem = E('span', { class: 'mle-alerts-cnt mle-alerts-cnt-error' }, '0 ' + _('errors'));
	const cntWarnElem = E('span', { class: 'mle-alerts-cnt mle-alerts-cnt-warn' }, '0 ' + _('warnings'));
	const cntInfoElem = E('span', { class: 'mle-alerts-cnt mle-alerts-cnt-info' }, '0 ' + _('info'));
	const listElem = E('div', { class: 'mle-alerts-list' });

	const clearBtn = E('button', { class: 'mle-alerts-clear-btn' }, _('Clear all'));
	const headerElem = E('div', { class: 'mle-alerts-header' }, [
		E('span', {}, [
			'⚠ ', _('Diagnostics'), ' · ', countElem, ' ', _('notifications'),
		]),
		E('div', { class: 'mle-alerts-header-right' }, [
			E('div', { class: 'mle-alerts-counts' }, [cntErrElem, cntWarnElem, cntInfoElem]),
			clearBtn,
		]),
	]);
	const boxElem = E('div', { class: 'mle-alerts-box' }, [headerElem, listElem]);

	function refreshCounts() {
		const rows = listElem.querySelectorAll('.mle-alert-row');
		const counts = { error: 0, warn: 0, info: 0 };
		rows.forEach((r) => {
			counts[r.dataset.kind] = (counts[r.dataset.kind] || 0) + 1;
		});

		countElem.textContent = String(rows.length);
		cntErrElem.textContent = counts.error + ' ' + (counts.error === 1 ? _('error') : _('errors'));
		cntWarnElem.textContent = counts.warn + ' ' + (counts.warn === 1 ? _('warning') : _('warnings'));
		cntInfoElem.textContent = counts.info + ' ' + _('info');

		const empty = listElem.querySelector('.mle-alerts-empty');
		if (rows.length === 0) {
			if (!empty) {
				listElem.appendChild(E('div', { class: 'mle-placeholder mle-alerts-empty' }, null));
			}

			boxElem.classList.remove('mle-alerts-error', 'mle-alerts-warn', 'mle-alerts-info');
			boxElem.classList.add('mle-alerts-empty-state');
		} else {
			if (empty) empty.remove();
			boxElem.classList.remove('mle-alerts-empty-state');
			boxElem.classList.toggle('mle-alerts-error', counts.error > 0);
			boxElem.classList.toggle('mle-alerts-warn', counts.error === 0 && counts.warn > 0);
			boxElem.classList.toggle('mle-alerts-info', counts.error === 0 && counts.warn === 0);
		}
	}

	function dismissAlert(row) {
		if (!row || !row.parentNode) return;
		row.classList.add('mle-alert-removing');
		setTimeout(() => {
			if (row.parentNode) row.parentNode.removeChild(row);
			refreshCounts();
		}, 160);
	}

	function clearAlerts() {
		listElem.querySelectorAll('.mle-alert-row').forEach(r => r.remove());
		refreshCounts();
	}

	function addAlert(kind, title, detail) {
		const empty = listElem.querySelector('.mle-alerts-empty');
		if (empty) empty.remove();

		const iconChar = kind === 'error' ? '!' : kind === 'warn' ? '⚠' : 'i';
		const dismissBtn = E('span', {
			class: 'mle-x-btn mle-alert-dismiss',
			title: _('Dismiss'),
		}, '×');
		const row = E('div', {
			'class': `mle-alert-row mle-alert-${kind}`,
			'data-kind': kind,
		}, [
			E('div', { class: `mle-alert-icon mle-alert-icon-${kind}` }, iconChar),
			E('div', { class: 'mle-alert-body' }, [
				E('div', { class: 'mle-alert-title' }, title),
				detail ? E('div', { class: 'mle-alert-detail' }, detail) : '',
			]),
			dismissBtn,
		]);
		dismissBtn.addEventListener('click', () => dismissAlert(row));

		listElem.appendChild(row);
		refreshCounts();
	}

	clearBtn.addEventListener('click', clearAlerts);
	refreshCounts();

	return { boxElem, addAlert, clearAlerts };
}

return baseclass.extend({ createAlertsPanel });
