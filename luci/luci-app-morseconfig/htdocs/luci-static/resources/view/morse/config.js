/**
 * This page is a simplified one page view of LuCI configuration.
 *
 * The intent is that it provides:
 *  - a starting point for seeing the current state of the system
 *  - an introduction to key LuCI concepts, with the ability to easily get to 'Advanced' settings
 *  - the ability to safely tweak key settings (e.g. IP, DHCP server) no matter
 *    the existing configuration of the device
 *
 * This means it must be:
 *  - agnostic in terms of existing configuration (i.e. can load anything)
 *  - when saving, not touch 'unexpected' parts of the system (i.e. disabling
 *    things, changing forwardings, etc.)
 *
 * This is in contrast to the 'wizard' parts of the system, which are assumed to
 * take control of many aspects of the device to ensure that the user has a working
 * configuration, and may break any existing setup.
 *
 * Areas that are too complex - i.e. where we've tried to do some magical abstraction -
 * can generally be found by looking at the preSaveHook or where .write/.load are over-written.
 * At the moment, these are:
 *  - the 'forwarding' on the networks (can produce new zones/forwards,
 *    and remove existing forwards if they're changed)
 *  - the automatic creation of bridges if necessary (and no _removal_ of bridges)
 */
'use strict';
/* globals configDiagram dom firewall form morseuci morseui network rpc uci ui view widgets */
'require dom';
'require view';
'require rpc';
'require uci';
'require ui';
'require form';
'require network';
'require firewall';
'require tools.morse.uci as morseuci';
'require tools.morse.morseui as morseui';
'require tools.widgets as widgets';
'require custom-elements.morse-config-diagram as configDiagram';

document.querySelector('head').appendChild(E('link', {
	rel: 'stylesheet',
	type: 'text/css',
	href: L.resourceCacheBusted('view/morse/css/config.css'),
}));

const DPP_QRCODE_PATH = '/dpp_qrcode.svg';

const callGetBuiltinEthernetPorts = rpc.declare({
	object: 'luci',
	method: 'getBuiltinEthernetPorts',
	expect: { result: [] },
});

// These are from LuCI's resources/network.js, but unfortunately they're buried
// in a switch statement there.
const WIFI_MODE_NAMES = {
	'ap-wds': _('Access Point (WDS)'),
	'ap': _('Access Point (no WDS)'),
	'sta-wds': _('Client (WDS)'),
	'sta': _('Client (no WDS)'),
	'mesh': _('Mesh Point'),
	'adhoc': _('Ad-Hoc'),
	'monitor': _('Monitor'),
	'none': _('None'), // TODO - APP-2533
};

// These are extracted from LuCI's view/network/wireless.js.
const ENCRYPTION_OPTIONS = {
	'psk2': 'WPA2-PSK',
	'psk-mixed': 'WPA-PSK/WPA2-PSK Mixed Mode',
	'psk': 'WPA-PSK',
	'sae': 'WPA3-SAE',
	'sae-mixed': 'WPA2-PSK/WPA3-SAE Mixed Mode',
	'wep-open': _('WEP Open System'),
	'wep-shared': _('WEP Shared Key'),
	'wpa3': 'WPA3-EAP',
	'wpa3-mixed': 'WPA2-EAP/WPA3-EAP Mixed Mode',
	'wpa2': 'WPA2-EAP',
	'wpa': 'WPA-EAP',
	'owe': 'OWE',
	'none': 'No encryption',
};

const ENCRYPTION_MODES_USING_KEYS = new Set([
	'psk',
	'psk2',
	'psk+psk2',
	'psk-mixed',
	'sae',
	'sae-mixed',
]);

const DEFAULT_ENCRYPTION_OPTIONS = ['psk2', 'psk', 'sae', 'wpa3', 'none'];
const DEFAULT_HALOW_ENCRYPTION_OPTIONS = ['sae', 'owe', 'wpa3', 'none'];

const GATEWAY_DESCRIPTION = `
<strong>${_('Do I need to set a gateway?')}</strong><br>
${_('Traffic will be forwarded to the gateway when there is no available route.')}<br>
${_('When configured as a DHCP Server, the address is sent to DHCP clients.')}<br>
${_('If this interface is not the connection to external subnets, you don\'t need to set a gateway. Leave it blank.')}<br>
`;

// This is based on widgets.NetworkSelect, but uses the zone style colouring
// rather than the attached devices icons.
const SimpleNetworkSelect = form.ListValue.extend({
	__name__: 'CBI.SimpleNetworkSelect',

	renderWidget(section_id, option_index, cfgvalue) {
		const choices = this.transformChoices();
		for (const [k, v] of Object.entries(choices)) {
			choices[k] = E('span', { class: 'zonebadge network-name', style: firewall.getZoneColorStyle(morseuci.getZoneForNetwork(v)) }, v);
		}

		var widget = new ui.Dropdown(cfgvalue, choices, {
			id: this.cbid(section_id),
			sort: true,
			optional: false,
			disabled: (this.readonly != null) ? this.readonly : this.map.readonly,
			display_items: this.display_size || this.size || 3,
			dropdown_items: this.dropdown_size || this.size || 5,
			datatype: 'uciname',
			validate: L.bind(this.validate, this, section_id),
		});

		return widget.render();
	},
});

// This is almost identical to SimpleNetworkSelect, but is used for the forwarding
// drop-down so automatically excludes the current network section
// (note that we simplify forwarding so networks are specified rather than zones).
const SimpleForwardSelect = form.ListValue.extend({
	__name__: 'CBI.SimpleForwardSelect',

	renderWidget: function (section_id, option_index, cfgvalue) {
		const choices = this.transformChoices();
		// We have to remove the current network on render
		// (we can't do this on construction, since the option can result
		// in multiple renders for different networks).
		delete choices[section_id];
		for (const [k, v] of Object.entries(choices)) {
			choices[k] = E('span', { class: 'zonebadge network-name', style: firewall.getZoneColorStyle(morseuci.getZoneForNetwork(v)) }, v);
		}

		const widget = new ui.Dropdown(cfgvalue, choices, {
			id: this.cbid(section_id),
			sort: true,
			optional: true,
			select_placeholder: E('span', { style: 'min-width: 80px' }, _('None')),
			disabled: (this.readonly != null) ? this.readonly : this.map.readonly,
			display_items: this.display_size || this.size || 3,
			dropdown_items: this.dropdown_size || this.size || 5,
			datatype: 'uciname',
			validate: L.bind(this.validate, this, section_id),
		});

		return E('span', ['⇒ ', widget.render()]);
	},
});

/* DummyValue that one can easily ask to rerender.
 *
 * Note that using renderUpdate() is a bad idea on a normal dummy value, as it
 * will try to use the formvalue when re-rendering (and since DummyValue
 * is a bit of a hack where we override cfgvalue to insert the HTML/text,
 * formvalue will not work out). NB overriding formvalue won't work
 * because LuCI will call its own isEqual on it and setting it to HTML elements
 * introduces cyclic references.
 */
const DynamicDummyValue = form.DummyValue.extend({
	__name__: 'CBI.DynamicDummyValue',

	dynamic: true,

	renderUpdate(sectionId) {
		return form.DummyValue.prototype.renderUpdate.call(this, sectionId, this.cfgvalue(sectionId));
	},
});

/* Looks at the adjacent encryption mode, and if it just requires
 * a key it presents the key, otherwise it links to the main wireless config page.
 *
 * Requires the map to call renderUpdate when appropriate
 * (i.e. when the encryption mode changes).
 */
const WifiSecurityValue = form.Value.extend({
	__name__: 'CBI.WifiSecurityValue',

	renderWidget(sectionId, optionIndex, cfgvalue) {
		const encryption = this.section.formvalue(sectionId, 'encryption');
		if (ENCRYPTION_MODES_USING_KEYS.has(encryption)) {
			return form.Value.prototype.renderWidget.call(this, sectionId, optionIndex, cfgvalue);
		} else if (!encryption || encryption === 'none') {
			return '';
		} else {
			return E('a', {
				href: L.url('admin', 'network', 'wireless'),
				title: _('Configure security on the Wireless page. You may want to Save first.'),
			}, _('Configure...'));
		}
	},
});

// In the quick config page, we only really want to deal with 'normal' looking ifaces
// to avoid confusion, so we use this to filter out things we don't care about
// (the user can use the normal luci config if they have more complex requirements).
function isNormalNetworkIface(netIface) {
	return netIface.disabled !== '1' && netIface['.name'] !== 'loopback' && ['dhcp', 'static'].includes(netIface['proto']);
}

return view.extend({
	// Because we rely on the diagram code reading from the uci.js cache layer, we can't handle resets
	// in this form normally.
	handleReset() {
		location.reload();
	},

	// The default save calls save on every map, but because we queue up changes in UCI
	// (due to trying to keep the diagram code orthogonal) the first map save will persist
	// unrelated config.
	//
	// Therefore we copy the normal map.save code but call uci.save manually only once.
	handleSave() {
		const tasks = [];
		const maps = Array.from(document.getElementById('maincontent').querySelectorAll('.cbi-map'))
			.map(m => dom.findClassInstance(m));

		const uciMaps = [];
		for (const m of maps) {
			if (m.data != uci) {
				tasks.push(() => m.save());
			} else {
				uciMaps.push(m);
			}
		}

		for (const m of uciMaps) {
			m.checkDepends();
		}

		return Promise.all(uciMaps.map(m => m.parse()))
			.then(() => this.preSaveHook())
			.then(() => uci.save())
			.then(() => Promise.all(uciMaps.map(m => m.load())))
			.catch((e) => {
				ui.showModal(_('Save error'), [
					E('p', {}, [_('An error occurred while saving the form:')]),
					E('p', {}, [E('em', { style: 'white-space:pre-wrap' }, [e.message])]),
					E('div', { class: 'right' }, [
						E('button', { class: 'cbi-button', click: ui.hideModal }, [_('Dismiss')]),
					]),
				]);

				return Promise.reject(e);
			})
			.then(() => Promise.all(uciMaps.map(m => m.renderContents())));
	},

	// Handle any we need to make a complex adjustment to uci config situations
	// that require processing multiple form elements.
	// This is called by handleSave above so we can safely interact with the uci
	// values rather than the form elements.
	preSaveHook() {
		// Use a bridge if we have more than one device.
		for (const network of uci.sections('network', 'interface')) {
			const bridge = morseuci.useBridgeIfNeeded(network['.name']);

			if (bridge) {
				for (const wifiIface of morseuci.getNetworkWifiIfaces(network['.name'])) {
					if (wifiIface.mode === 'sta' && wifiIface.wds !== '1') {
						throw new TypeError(
							_('Network "%s" has a Wi-Fi client without WDS bridged with other devices. Either remove the other devices, enable WDS, or remove it from the network.').format(network['.name']));
					}
				}
			}
		}
	},

	load() {
		return Promise.all([
			fetch(DPP_QRCODE_PATH, { method: 'HEAD' }).then(r => r.ok),
			network.getWifiDevices(),
			network.getWifiNetworks(),
			callGetBuiltinEthernetPorts(),
			configDiagram.loadTemplate(),
			uci.load(['network', 'wireless', 'dhcp', 'system']),
		]);
	},

	async render([hasQRCode, wifiDevices, wifiNetworks, ethernetPorts]) {
		this.hasQRCode = hasQRCode;
		this.ethernetPorts = ethernetPorts;
		this.wifiDevices = wifiDevices.reduce((o, d) => (o[d.getName()] = d, o), {});
		this.wifiNetworks = wifiNetworks.reduce((o, n) => (o[n.getName()] = n, o), {});

		const networkMap = new form.Map('network', [
			_('Network Interfaces'),
			E('a', {
				href: L.url('admin', 'network', 'network'),
				title: 'Advanced Configuration',
				class: 'advanced-config pull-right',
			}),
		]);
		networkMap.chain('wireless');
		networkMap.chain('firewall');
		networkMap.chain('dhcp');
		this.renderNetworkInterfaces(networkMap);

		const wirelessMap = new form.Map('wireless', [
			'Wireless',
			E('a', {
				href: L.url('admin', 'network', 'wireless'),
				title: 'Advanced Configuration',
				class: 'advanced-config pull-right',
			}),
		]);

		// Put HaLow devices first
		const uciWifiDevices = uci.sections('wireless', 'wifi-device').filter(s => s.type === 'morse');
		uciWifiDevices.push(...uci.sections('wireless', 'wifi-device').filter(s => s.type !== 'morse'));
		for (const device of uciWifiDevices) {
			if (device.disabled === '1') {
				continue;
			}

			this.renderWifiDevice(wirelessMap, device);
			this.renderWifiInterfaces(wirelessMap, device['.name']);
		}

		const diagram = E('morse-config-diagram');
		this.attachDynamicUpdateHandlers(diagram, ethernetPorts, [networkMap, wirelessMap]);
		// This is actually a promise, but we can do it along with the render.
		diagram.updateFrom(uci, ethernetPorts);

		return Promise.all([
			E('div', { class: 'cbi-section' }, [
				E('h1', 'Quick Configuration'),
				E('p', _('Change individual settings below, or use a wizard to quickly change the mode of your device.')),
				E('p', [
					E('a', { href: L.url('admin', 'morse', 'wizard') }, 'Access Point/Client'),
					' | ',
					E('a', { href: L.url('admin', 'morse', 'meshwizard') }, '802.11s Mesh'),
					' | ',
					E('a', { href: L.url('admin', 'morse', 'easymeshwizard') }, 'EasyMesh'),
				]),
			]),
			E('div', { class: 'cbi-section' }, diagram),
			networkMap.render(),
			wirelessMap.render(),
		]);
	},

	renderWifiDevice(map, device) {
		const deviceInfo = this.wifiDevices[device['.name']];
		const displayName = deviceInfo.getI18n().replace(' Wireless Controller', '');
		const section = map.section(form.NamedSection, device['.name'], 'wifi-device', displayName);
		let option;

		if (device['type'] === 'morse') {
			// Only HaLow devices have the static channel map which allows us to see
			// frequencies from other countries without setting the region of the device.
			option = section.option(widgets.WifiCountryValue, 'country', _('Country'));
			option.onchange = function (ev, sectionId, value) {
				this.map.lookupOption('_freq', sectionId)[0].toggleS1gCountry(sectionId, value);
			};
		}
		option = section.option(widgets.WifiFrequencyValue, '_freq', _('Preferred frequency'));
	},

	renderWifiInterfaces(map, deviceName) {
		const section = map.section(form.TableSection, 'wifi-iface');
		section.filter = sectionId => deviceName === uci.get('wireless', sectionId, 'device');
		section.addremove = true;
		section.anonymous = true;

		// If we don't immediately set the correct device, it won't appear in our table
		// due to the filter. So we monkey-patch handleAdd :(
		section.handleAdd = function (_ev, name) {
			const config_name = this.uciconfig || this.map.config;

			if (!name) {
				let offset = 1;
				name = `wifinet${offset}_${deviceName}`;
				while (uci.get('wireless', name)) {
					name = 'wifinet' + (++offset);
				}
			}
			this.map.data.add(config_name, this.sectiontype, name);
			this.map.data.set(config_name, name, 'device', deviceName);
			return this.map.save(null, true);
		};

		let option;

		option = section.option(morseui.Slider, 'disabled', _('Enabled'));
		option.enabled = '0';
		option.disabled = '1';
		option.default = '0';

		option = section.option(form.DummyValue, '_device', _('Device'));
		option.cfgvalue = (sectionId) => {
			return this.wifiNetworks[sectionId]?.getIfname() || '';
		};

		option = section.option(SimpleNetworkSelect, 'network', _('Network'));
		for (const networkIface of uci.sections('network', 'interface')) {
			if (isNormalNetworkIface(networkIface)) {
				option.value(networkIface['.name'], networkIface['.name']);
			}
		}

		const MODE_TOOLTIP = _(`
			Change the mode of your Wi-Fi interface. To enable Wi-Fi extenders, you should select WDS (Wireless Distribution System)
			modes for Access Points and Clients (Stations). Note that non-WDS Clients can connect to WDS Access Points, but
			WDS Clients cannot connect to non-WDS Access Points, so we recommend always using WDS for Access Points.
		`).replace(/[\t\n ]+/g, ' ');
		option = section.option(form.ListValue, 'mode', E('span', { class: 'show-info', title: MODE_TOOLTIP }, _('Mode')));
		for (const [k, v] of Object.entries(WIFI_MODE_NAMES)) {
			option.value(k, v);
		}
		option.onchange = function (ev, sectionId) {
			this.map.lookupOption('ssid', sectionId)[0].renderUpdate(sectionId);
			// Clear key on change.
			this.section.getUIElement(sectionId, '_wpa_key').setValue('');
		};
		option.write = function (sectionId, value) {
			if (this.cfgvalue(sectionId) === value) {
				// Don't do anything if config remains unchanged
				return;
			}
			switch (value) {
				case 'ap-wds':
					uci.set('wireless', sectionId, 'mode', 'ap');
					uci.set('wireless', sectionId, 'wds', '1');
					uci.unset('wireless', sectionId, 'ifname');
					break;

				case 'sta-wds':
					uci.set('wireless', sectionId, 'mode', 'sta');
					uci.set('wireless', sectionId, 'wds', '1');
					uci.unset('wireless', sectionId, 'ifname');
					break;

				case 'mesh':
					uci.set('wireless', sectionId, 'mode', 'mesh');
					uci.set('wireless', sectionId, 'ifname', 'mesh0');
					uci.unset('wireless', sectionId, 'wds');
					break;

				default:
					uci.set('wireless', sectionId, 'mode', value);
					uci.unset('wireless', sectionId, 'wds');
					uci.unset('wireless', sectionId, 'ifname');
					break;
			}
			// Unset the ifname which was set specifically for mesh
			if (uci.get('wireless', sectionId, 'ifname') === 'mesh0' && value != 'mesh') {
				uci.unset('wireless', sectionId, 'ifname');
			}
		};
		option.cfgvalue = function (section_id) {
			const mode = uci.get('wireless', section_id, 'mode');
			if (uci.get('wireless', section_id, 'wds') === '1') {
				if (mode === 'ap') {
					return 'ap-wds';
				} else if (mode === 'sta') {
					return 'sta-wds';
				}
			}

			return mode;
		};

		if (this.hasQRCode) {
			const DPP_TOOLTIP = _('This enables DPP via QRCode for clients (access points automatically support DPP).');
			option = section.option(form.Flag, 'dpp', E('span', { class: 'show-info', title: DPP_TOOLTIP }, _('DPP')));
			option.depends({ '!contains': true, 'mode': 'sta' });
		}

		option = section.option(morseui.SSIDListScan, 'ssid', _('SSID/Mesh ID'));
		if (this.hasQRCode) {
			option.depends('dpp', '0');
		}
		option.depends({ '!reverse': true, '!contains': true, 'mode': 'sta' });
		option.datatype = 'and(maxlength(32),minlength(2))';
		option.write = function (sectionId, value) {
			const mode = this.map.lookupOption('mode', sectionId)[0].formvalue(sectionId);
			switch (mode) {
				case 'mesh':
					uci.set('wireless', sectionId, 'mesh_id', value);
					break;
				default:
					uci.set('wireless', sectionId, 'ssid', value);
					break;
			}
		};

		option.cfgvalue = function (section_id) {
			const mode = uci.get('wireless', section_id, 'mode');
			switch (mode) {
				case 'mesh':
					return uci.get('wireless', section_id, 'mesh_id');
				default:
					return uci.get('wireless', section_id, 'ssid');
			}
		};

		// In LuCI's wireless.js, L.hasSystemFeature is used to decide what
		// encryption options to present. In our case, this is insufficient because
		// it doesn't know what the available encryptions are for the HaLow specific
		// hostapd/wpa_supplicant. Moreover, if we present _all_ possible encryptions
		// it's somewhat overwhelming for the user.
		// We go for the 'works in most cases' option of presenting the standard
		// modes + any extras that are currently set. Where this falls down
		// is if a scan turns up APs that require other modes.
		option = section.option(form.ListValue, 'encryption', _('Encryption'));
		option.depends({ dpp: '0' });
		option.depends({ '!reverse': true, '!contains': true, 'mode': 'sta' });
		const defaultEncryptionOptions = uci.get('wireless', deviceName, 'type') === 'morse'
			? DEFAULT_HALOW_ENCRYPTION_OPTIONS
			: DEFAULT_ENCRYPTION_OPTIONS;
		const encryptionOptions = Array.from(defaultEncryptionOptions);
		for (const wi of uci.sections('wireless', 'wifi-iface')) {
			if (wi.device === deviceName && wi.encryption && !encryptionOptions.includes(wi.encryption)) {
				encryptionOptions.push(wi.encryption);
			}
		}
		for (const encryptionOption of encryptionOptions) {
			option.value(encryptionOption, ENCRYPTION_OPTIONS[encryptionOption]);
		}
		option.default = 'none';
		option.onchange = function (ev, sectionId, _value) {
			const keyOption = this.map.lookupOption('_wpa_key', sectionId)[0];
			keyOption.renderUpdate(sectionId);
		};

		option = section.option(WifiSecurityValue, '_wpa_key', _('Key/Security'));
		option.depends({ dpp: '0' });
		option.depends({ '!reverse': true, '!contains': true, 'mode': 'sta' });
		option.datatype = 'wpakey';
		option.rmempty = true;
		option.password = true;

		// This curious code is taken from LuCI's wireless.js. Apparently,
		// in WEP mode key can be an reference specifying key1/key2/key3/key4.
		// https://openwrt.org/docs/guide-user/network/wifi/basic
		option.cfgvalue = function (section_id) {
			var key = uci.get('wireless', section_id, 'key');
			return /^[1234]$/.test(key) ? null : key;
		};
		option.write = function (section_id, value) {
			uci.set('wireless', section_id, 'key', value);
			uci.unset('wireless', section_id, 'key1');
			uci.unset('wireless', section_id, 'key2');
			uci.unset('wireless', section_id, 'key3');
			uci.unset('wireless', section_id, 'key4');
		};
	},

	renderNetworkInterfaces(map) {
		const section = map.section(form.TableSection, 'interface');
		// We set this to anonymous so we can render the name ourselves with colour.
		section.anonymous = true;
		section.modaltitle = _('Network Interface');
		section.filter = (sectionId) => {
			const iface = uci.get('network', sectionId);
			return iface.disabled !== '1' && iface['.name'] !== 'loopback' && ['dhcp', 'static'].includes(iface['proto']);
		};
		section.max_cols = 7;

		let option;

		option = section.option(form.DummyValue, '_name', _('Name'));
		option.rawhtml = true;
		option.cfgvalue = (sectionId) => {
			return E('span', { class: 'zonebadge network-name', style: firewall.getZoneColorStyle(morseuci.getZoneForNetwork(sectionId)) }, sectionId);
		};

		option = section.option(SimpleForwardSelect, '_forward', _('Forward'));
		option.titleref = L.url('admin', 'network', 'firewall');
		// We disable the uci refresh for this because otherwise, when people mess around with the element,
		// we generate spurious forwarding rules that we then have to disable.
		option.disableUciRefresh = true;
		for (const networkIface of uci.sections('network', 'interface')) {
			if (networkIface.disabled === '1' || networkIface['.name'] === 'loopback' || !['dhcp', 'static'].includes(networkIface['proto'])) {
				continue;
			}

			option.value(networkIface['.name'], networkIface['.name']);
		}
		option.load = (sectionId) => {
			for (const s of uci.sections('firewall', 'forwarding')) {
				if (s.enabled !== '0' && s.src === sectionId) {
					return s.dest;
				}
			}

			return null;
		};
		option.write = (sectionId, value) => {
			const srcZone = morseuci.getOrCreateZone(sectionId);
			const destZone = morseuci.getOrCreateZone(value);
			morseuci.getOrCreateForwarding(srcZone, destZone);
		};
		option.remove = function (sectionId) {
			const zone = morseuci.getZoneForNetwork(sectionId);
			if (!zone) {
				return;
			}
			for (const s of uci.sections('firewall', 'forwarding').filter(f => f.src === zone)) {
				uci.set('firewall', s['.name'], 'enabled', '0');
			}
		};

		option = section.option(DynamicDummyValue, '_wifi_interfaces', _('Wireless'));
		option.rawhtml = true;
		option.cfgvalue = (sectionId) => {
			const wirelessDevices = [];
			for (const wifiIface of uci.sections('wireless', 'wifi-iface')) {
				if (wifiIface.disabled !== '1' && wifiIface.network === sectionId) {
					const deviceName = this.wifiDevices[wifiIface.device]?.getI18n()?.replace(' Wireless Controller', '');
					const mode = WIFI_MODE_NAMES[wifiIface.mode] ?? _('Unknown');
					const ifname = this.wifiNetworks[wifiIface['.name']]?.getIfname();
					let tooltip;
					if (ifname) {
						tooltip = _('%s (%s) on %s').format(mode, ifname, deviceName);
					} else {
						tooltip = _('%s on %s').format(mode, deviceName);
					}
					const displayName = wifiIface.dpp === '1' ? '(DPP)' : (wifiIface.ssid ?? `${wifiIface.device}:${wifiIface.mode}`);
					wirelessDevices.push(E('span', { class: 'show-info', title: tooltip }, displayName));
					wirelessDevices.push(' ');
				}
			}

			return wirelessDevices;
		};

		option = section.option(form.MultiValue, 'device', _('Ethernet'));
		option.placeholder = _('None');
		option.load = morseuci.getNetworkDevices;
		option.write = morseuci.setNetworkDevices;
		option.remove = (sectionId) => {
			const device = uci.get('network', sectionId, 'device');
			const deviceSection = uci.sections('network', 'device')
				.find(s => s.name === device);

			if (device && deviceSection && deviceSection.type === 'bridge') {
				uci.unset('network', deviceSection['.name'], 'ports');
			} else {
				uci.unset('network', sectionId, 'device');
			}
		};

		const availableDevices = new Set(this.ethernetPorts.map(p => p.device));
		// Add any other devices that aren't in the port list to avoid
		// trashing complex config.
		for (const netIface of uci.sections('network', 'interface')) {
			if (isNormalNetworkIface(netIface)) {
				for (const dev of morseuci.getNetworkDevices(netIface['.name'])) {
					availableDevices.add(dev);
				}
			}
		}
		for (const dev of availableDevices) {
			option.value(dev, dev);
		}

		option.validate = function (sectionId, value) {
			for (const section of uci.sections('network', 'interface')) {
				if (section['.name'] === sectionId) {
					continue;
				}

				const otherDevices = new Set(this.section.formvalue(section['.name'], 'device'));

				for (const device of value.split(' ')) {
					if (otherDevices.has(device)) {
						return _('%s exists in networks %s and %s').format(device, sectionId, section['.name']);
					}
				}
			}

			return true;
		};

		option = section.option(morseui.Slider, '_dnsmasq', _('DHCP Server'));
		option.titleref = L.url('admin', 'network', 'dhcp');
		option.load = (sectionId) => {
			// We lean towards reporting as disabled.
			const dnsSection = uci.sections('dhcp', 'dnsmasq')
				.find(dnsmasq =>
					(!dnsmasq.interface || L.toArray(dnsmasq.interface).includes(sectionId))
					&& !L.toArray(dnsmasq.notinterface).includes(sectionId)
					&& dnsmasq.port !== '0');
			const dhcpSection = dnsSection && uci.sections('dhcp', 'dhcp')
				.find(dhcp =>
					dhcp.interface === sectionId && dhcp.ignore !== '1'
					&& (!dhcp.instance || dhcp.instance === dnsSection['.name']));
			return (dnsSection && dhcpSection) ? '1' : '0';
		};
		option.write = function (sectionId, value) {
			if (this.cfgvalue(sectionId) === value) {
				// If there's an existing half-enabled config (e.g. DNS but not DHCP or vice-versa),
				// we don't touch it here (on the principle of not nuking user config).
				return;
			}

			const dnsmasqName = morseuci.getOrCreateDnsmasq(sectionId);
			if (value === '1') {
				if (uci.get('dhcp', dnsmasqName, 'port')) {
					uci.unset('dhcp', dnsmasqName, 'port');
				}
			} else {
				// If there are multiple DNS servers we need to properly turn this off
				// to avoid clashing with another server. Note that if there is only
				// one - even if this is scoped for now - getOrCreateDnsmasq will pick it up
				// and enable it for this interface.
				// WARNING: This is a poorly tested code-path, and normal devices should not
				// be in this situation. It's most likely to happen after upgrading from pre-2.6.
				// This will also mean that turning on and off has the potential
				// to change the configuration.
				if (uci.sections('dhcp', 'dnsmasq').length > 1) {
					uci.set('dhcp', dnsmasqName, 'port', '0');
					uci.set('dhcp', dnsmasqName, 'localuse', '0');
					uci.unset('dhcp', dnsmasqName, 'nonwildcard');

					// Make sure we're not listening on loopback interface.
					const notinterface = L.toArray(uci.get('dhcp', dnsmasqName, 'notinterface'));
					if (!notinterface.includes('loopback')) {
						notinterface.push('loopback');
						uci.set('dhcp', dnsmasqName, 'notinterface', notinterface);
					}
				}
			}

			const onSections = uci.sections('dhcp', 'dhcp').filter(dhcp => dhcp.interface === sectionId && dhcp.ignore !== '1' && (!dhcp.instance || dhcp.instance === dnsmasqName));
			const offSection = uci.sections('dhcp', 'dhcp').find(dhcp => dhcp.interface === sectionId && dhcp.ignore === '1' && (!dhcp.instance || dhcp.instance === dnsmasqName));
			if (value === '0' && onSections.length > 0) {
				for (const dhcpSection of onSections) {
					uci.set('dhcp', dhcpSection['.name'], 'ignore', '1');
				}
			} else if (value === '1' && onSections.length === 0) {
				if (offSection) {
					uci.unset('dhcp', offSection['.name'], 'ignore');
				} else {
					morseuci.createDhcp(dnsmasqName, sectionId);
				}
			}
		};
		option.rmempty = false;

		// It's 'safe' to only list dhcp/static here because we only present networks that
		// are in this state.
		option = section.option(form.ListValue, 'proto', _('Protocol'));
		option.value('dhcp', _('DHCP Client'));
		option.value('static', _('Static IP'));
		option.onchange = function (_ev, sectionId, value) {
			// When changing, turn DHCP/DNS on by default for static and off by default for DHCP client
			// (but as always, we shouldn't do this unless the user has interacted with us to avoid
			// unexpectedly mutating a configuration).
			this.section.getUIElement(sectionId, '_dnsmasq').setValue(value === 'static' ? '1' : '0');

			// Set a reasonable netmask if moving to static and none exists.
			// We do this because by default OpenWrt will deal out a /32, which
			// isn't very useful in our case.
			if (value === 'static') {
				const netmaskElement = this.section.getUIElement(sectionId, 'netmask');

				if (netmaskElement) {
					if (!netmaskElement.getValue()) {
						netmaskElement.setValue('255.255.255.0');
					}
				} else if (!uci.get('network', sectionId, 'netmask')) {
					// Because the netmask element only appears in the '...' modal, if we can't find
					// the element we set the netmask in uci :(
					// (since the modal rerenders from uci, this will appear in the modal if it's subsequently
					// popped up!)
					uci.set('network', sectionId, 'netmask', '255.255.255.0');
				}
			}
		};

		option = section.option(form.Value, 'ipaddr', 'IPv4 address');
		option.depends('proto', 'static');
		option.datatype = 'ip4addr("nomask")';
		option.rmempty = false;
		option.retain = true;
		option.validate = function (sectionId, value) {
			const wifiNetworks = uci.sections('wireless', 'wifi-iface').filter(wi => wi.disabled !== '1').map(wi => wi.network);
			// Only check if something is actually using our network.
			if (morseuci.getNetworkDevices(sectionId).length > 0 || wifiNetworks.includes(sectionId)) {
				for (const section of uci.sections('network', 'interface')) {
					if (section['.name'] === sectionId) {
						continue;
					}

					if (morseuci.getNetworkDevices(section['.name']).length === 0 && !wifiNetworks.includes(section['.name'])) {
						// Ignore clashes if nothing in the network.
						continue;
					}

					if (value === this.section.formvalue(section['.name'], 'ipaddr')) {
						return _('IPv4 address %s is in networks %s and %s').format(value, sectionId, section['.name']);
					}
				}
			}

			return Object.getPrototypeOf(this).validate.call(this, sectionId, value);
		};

		option = section.option(form.Value, 'netmask', _('Netmask'));
		option.datatype = 'ip4addr("nomask")';
		option.depends('proto', 'static');
		option.value('255.255.255.0', '255.255.255.0');
		option.value('255.255.0.0', '255.255.0.0');
		option.value('255.0.0.0', '255.0.0.0');
		// This is marked as inactive on the main page because it's hidden by max_cols,
		// and because of this LuCI decides to remove it unless retain is set.
		// IMO this is a bug in LuCI, but for now we work around it.
		option.retain = true;

		option = section.option(form.Value, 'gateway', _('Gateway'));
		option.description = GATEWAY_DESCRIPTION;
		option.datatype = 'ip4addr("nomask")';
		option.depends('proto', 'static');
		option.validate = function (sectionId, value) {
			if (value !== '' && this.section.formvalue(sectionId, 'ipaddr') === value) {
				return _('The gateway address must not be the local IP address (usually you can leave this unset).');
			}

			return true;
		};
		// This is marked as inactive on the main page because it's hidden by max_cols,
		// and because of this LuCI decides to remove it unless retain is set.
		// IMO this is a bug in LuCI, but for now we work around it.
		option.retain = true;
	},

	/**
	 * Attach an onchange handler to _every element_ in order to update uci.js
	 * immediately, and then update the diagram and any reactive UI elements.
	 *
	 * 'reactive UI element' = one where dynamicUpdate is defined
	 * (not part of normal LuCI).
	 *
	 * Note that at the moment there are no smarts to this: we call
	 * update every time, even if there are no changes required.
	 *
	 * Why do this at all?
	 *
	 * - the diagram code is abstracted from the form, so it's nicer for it
	 *   to be able to use uci.js rather than the form values.
	 * - even for the elements on the page, their initial load needs to depend
	 *   on UCI, so it would be messy (and often complex) having subsequent
	 *   operations depends on .formvalue. Since we already have this mechanism
	 *   for the diagram...
	 *
	 * @private
	 */
	attachDynamicUpdateHandlers(diagram, ethernetPorts, maps) {
		function forEachOption(arr, cb) {
			for (const child of arr) {
				if (child instanceof form.AbstractValue) {
					cb(child);
				} else {
					forEachOption(child.children, cb);
				}
			}
		}

		const dynamicValues = [];
		forEachOption(maps, (option) => {
			if (option.dynamic) {
				dynamicValues.push(option);
			}
		});

		forEachOption(maps, (option) => {
			if (option.disableUciRefresh || option.dynamic) {
				return;
			}

			const existingHandler = option.onchange;
			option.onchange = async function (ev, sectionId, val) {
				if (existingHandler) existingHandler.apply(this, [ev, sectionId, val]);

				// Usually, a parse is followed by a save and then options are
				// reloaded. In our situation, we aren't using this mechanism,
				// so we manually repopulate the form value with the updated
				// value in UCI. This makes sure that any subsequent AbstractValue.parse
				// doesn't get confused and think that something doesn't need
				// to be persisted because it's already that value.
				// IMO this is a bug in AbstractValue - parse should call .cfgvalue
				// after calling .write.
				try {
					await this.parse(sectionId);
				} catch (e) {
					// ignore errors - if the parse failed, we can't update the diagram,
					// and user should be notified of failure by ordinary form validation errors.
					// Note that parse is a bit of a misnomer - it both parses the options
					// and writes it if necessary.
					return;
				}

				this.cfgvalue(sectionId, this.load(sectionId));

				for (const dv of dynamicValues) {
					for (const dvSectionId of dv.section.cfgsections()) {
						dv.renderUpdate(dvSectionId);
					}
				}

				await diagram.updateFrom(uci, ethernetPorts);
			};
		});

		return diagram;
	},
});
