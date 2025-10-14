'use strict';

/* globals halow view */
'require view';
'require halow';

const COLUMN_NAMES = {
	country_code: _('Country Code', 'ISO-3166 two character country code'),
	bw: _('Bandwidth', 'Radio frequency bandwidth'),
	s1g_chan: _('Channel Center Frequency Index', 'Wi-Fi radio channel index'),
	s1g_op_class: _('S1G Operating Class (802.11 Table E-5)'),
	global_op_class: _('Global Operating Class (802.11 Table E-4)'),
	centre_freq_mhz: _('Center Frequency', 'Wi-Fi radio frequency'),
	duty_cycle_ap: _('AP Duty Cycle Per Hour'),
	duty_cycle_sta: _('STA Duty Cycle Per Hour'),
	country: _('Country'),
	tx_power_max: _('Tx&nbsp;Power Max (EIRP in dBm)', 'A transmit power limit'),
	duty_cycle_omit_ctrl_resp: _('Omit control response frames from duty cycle'),
	pkt_spacing_ms: _('Pause length after transmit'),
	airtime_min_ms: _('Pause after transmit'),
	airtime_max_ms: _('Maximum transmit time'),
};

// Which columns to display in our table, in order.
const COLUMN_DISPLAY = [
	'bw', 's1g_chan', 's1g_op_class', 'global_op_class', 'centre_freq_mhz',
	'tx_power_max', 'duty_cycle_ap', 'duty_cycle_sta',
	'pkt_spacing_ms', 'airtime_min_ms', 'airtime_max_ms',
];

const COLUMN_UNITS = {
	bw: _(' MHz', 'Frequency unit'),
	centre_freq_mhz: _(' MHz', 'Frequency unit'),
	duty_cycle_ap: _('%', 'Percentage unit'),
	duty_cycle_sta: _('%', 'Percentage unit'),
	pkt_spacing_ms: _(' ms', 'Millisecond time unit'),
	airtime_min_ms: _(' ms', 'Millisecond time unit'),
	airtime_max_ms: _(' ms', 'Millisecond time unit'),
};

// Hard to display table on mobile; limit columns.
const COLUMN_MOBILE_DISPLAY = new Set(['bw', 's1g_chan', 'centre_freq_mhz']);

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load: halow.loadChannels,

	render: function (halowChannels) {
		const dropdown_options = [];
		for (const [country_code, info] of Object.entries(halowChannels.getCountryInfo())) {
			if (Object.keys(info.channelizations).length === 0) {
				dropdown_options.push({ country_code, country: info.country });
			} else {
				for (const chzn of Object.values(info.channelizations)) {
					dropdown_options.push({ country_code: `${country_code}:${chzn.codename}`, country: `${info.country} (${chzn.fullname})` });
				}
			}
		}

		dropdown_options.sort((a, b) => a.country.localeCompare(b.country));
		const country_selector = E('select', { id: 'country' }, [
			E('option', { disabled: '', selected: '', hidden: '' }, _('--- select country ---', 'A dropdown prompt for a country list filter')),
		].concat(dropdown_options.map(o => E('option', { value: o.country_code }, o.country))));

		const channel_info = E('table', { class: 'table hidden', id: 'top_10' }, [
			E('tr', { class: 'tr table-titles' }, COLUMN_DISPLAY.map(col =>
				E('th', { class: 'th center ' + (COLUMN_MOBILE_DISPLAY.has(col) ? '' : 'hide-sm') }, COLUMN_NAMES[col]),
			)),
		]);

		country_selector.addEventListener('change', (ev) => {
			channel_info.classList.remove('hidden');
			const [country_code, chzn] = ev.currentTarget.value.split(':');
			let channels = Object.values(halowChannels.getMap(country_code, chzn));
			channels.sort((a, b) => {
				if (a.bw !== b.bw) return a.bw - b.bw;
				return a.centre_freq_mhz - b.centre_freq_mhz;
			});
			cbi_update_table(channel_info,
				channels.map(channel => COLUMN_DISPLAY.map(col => `${channel[col]}${COLUMN_UNITS[col] || ''}`)));
		});

		return [
			E('h2', {}, _('Regulatory Information', '802.11ah Wi-Fi regulations')),
			E('p', {}, [
				E('label', { style: 'margin-right: 5px', for: 'country' }, _('Country')),
				country_selector,
			]),
			channel_info,
		];
	},
});
