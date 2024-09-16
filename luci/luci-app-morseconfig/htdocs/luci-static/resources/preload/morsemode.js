'use strict';
/* globals baseclass uci ui */
'require ui';
'require baseclass';
'require uci';

return baseclass.extend({
	__init__: function () {
		// We should detect if prplmesh is there via hasSystemFeatures
		// or some cleaner way (this throws a console error, and causes
		// two uci-loaded events). However, this code will probably be removed
		// as part of APP-2042.
		return Promise.all([
			uci.load('wireless'),
			uci.load('prplmesh').catch(_e => null),
		]).then(() => this.updateIndicator());
	},

	getMode: function () {
		const morseDevice = uci.sections('wireless', 'wifi-device').find(ns => ns.type === 'morse');
		if (!morseDevice) {
			return;
		}

		const morseIfaces = uci.sections('wireless', 'wifi-iface').filter(ns => ns['device'] === morseDevice['.name'] && ns['disabled'] !== '1');
		if (morseIfaces.length === 0) {
			return;
		}

		// Choose the first one that we can find.
		let iface = morseIfaces[0];
		// Prefer mesh, then ap, over other modes.
		for (const mode of ['mesh', 'ap']) {
			const betterIface = morseIfaces.find(n => n['mode'] === mode);
			if (betterIface) {
				iface = betterIface;
				break;
			}
		}

		let mode = iface['mode'];
		if (mode === 'mesh') {
			return '11s_mesh';
		} else if (uci.get('prplmesh', 'config', 'enable') === '1') {
			return `mesh ${uci.get('prplmesh', 'config', 'management_mode') === 'Multi-AP-Agent' ? 'agent' : 'controller'}`;
		} else {
			return mode;
		}
	},

	updateIndicator: function () {
		const mode = this.getMode() ?? 'none';
		ui.showIndicator('morse-mode', _('HaLow Mode: ') + mode, () => window.location = L.url('admin', 'selectwizard'), 'active');
	},
});
