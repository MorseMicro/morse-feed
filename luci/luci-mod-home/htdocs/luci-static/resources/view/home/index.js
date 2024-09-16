/* Simplified user homepage for LuCI.
 *
 * Copyright 2024 Morse Micro
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Developed referring to patterns in luci-mod-status and luci-mod-dashboard,
 * which are part of:
 *
 * LuCI - Lua Configuration Interface
 * Copyright 2008 Steven Barth <steven@midlink.org>
 * Copyright 2008 Jo-Philipp Wich <jow@openwrt.org>
 * Licensed under the Apache License, Version 2.0.
 *
 * Idea is similar to luci-mod-dashboard, but we instead try to focus more on
 * distinct interfaces, limit information a bit more, and prevent
 * over-large cards by only showing an arbitrary amount of data on request
 * (e.g. '5 devices' rather than a list).
 */

'use strict';

/* globals configDiagram dom firewall form fs morseui network poll prplmeshTopology rpc ui uci view */
'require dom';
'require firewall';
'require form';
'require fs';
'require network';
'require rpc';
'require uci';
'require ui';
'require view';
'require poll';
'require view.home.prplmesh-topology as prplmeshTopology';
'require custom-elements.morse-config-diagram as configDiagram';
'require tools.morse.morseui as morseui';
'require view.morse.wpsbuttonelement';

const DPP_QRCODE_PATH = '/dpp_qrcode.svg';

const callLuciDHCPLeases = rpc.declare({
	object: 'luci-rpc',
	method: 'getDHCPLeases',
	expect: { '': {} },
});

const callGetBuiltinEthernetPorts = rpc.declare({
	object: 'luci',
	method: 'getBuiltinEthernetPorts',
	expect: { result: [] },
});

const callSystemBoard = rpc.declare({
	object: 'system',
	method: 'board',
});

const callSessionAccess = rpc.declare({
	object: 'session',
	method: 'access',
	params: ['scope', 'object', 'function'],
	expect: { access: false },
});

// Sadly, we add our own call to apply, because:
//  - the ui.changes.apply call (see ui.js) tries to do a bunch of vaguely annoying
//    things to the user interface
//  - uci.apply doesn't properly wait for the 'confirm' after applying changes
//  - the overridden .apply on localDevice swallows the res error code
//    and I'm scared to touch it
const callUciApply = rpc.declare({
	object: 'uci',
	method: 'apply',
	params: ['timeout', 'rollback'],
	reject: false, // So we can handle the 'nothing to do' case (returns 5).
});

async function applyUciChangesImmediately() {
	const res = await callUciApply(0, false);
	// 5 is no data - i.e. nothing to apply.
	if (![0, 5].includes(res)) {
		L.raise('RPCError', 'RPC call to uci/apply failed with ubus code %d: %s',
			res, rpc.getStatusText(res));
	}
}

function tr(tag, items) {
	return E('tr', { class: tag === 'th' ? 'tr cbi-section-table-titles' : 'tr' },
		items.map(item => E(tag, { class: `${tag} cbi-section-table-cell` }, item)));
}

function makeClass(n) {
	return n.getName().replace(/[^\w-]/g, '-');
}

function isHaLow(wifiNetwork) {
	return wifiNetwork.ubus('dev', 'iwinfo', 'hwmodes')?.includes('ah');
}

// This is a shorter/more informative name than we get from hwmodes_text
// which prioritises the frequency for 'normal' wifi.
function getWifiName(wifiNetwork) {
	const hwmodes = wifiNetwork.ubus('dev', 'iwinfo', 'hwmodes');
	if (hwmodes?.includes('ah')) {
		return _('HaLow');
	}

	const frequency = wifiNetwork.ubus('dev', 'iwinfo', 'frequency');
	if (frequency) {
		if (frequency > 4000) {
			return '%.0f GHz'.format(frequency / 1000);
		} else {
			return '%.1f GHz'.format(frequency / 1000);
		}
	}

	return wifiNetwork.ubus('dev', 'iwinfo', 'hwmodes_text') ?? _('WiFi');
}

function getL2Devices(netIface) {
	// Like netIface.getL2Device, but converts bridge into its associated sub-devices.

	const device = netIface.getL2Device();
	if (!device) {
		return [];
	} else if (device.isBridge() && device.getPorts()) {
		return device.getPorts();
	} else {
		return [device];
	}
}

function getBestDevice(netIface) {
	// Determine best possible device for 'Uplink'
	// (in a bridge, hard to determine which device we actually want for DHCP client,
	// so preference wifi stations over ethernet over AP).
	const devices = getL2Devices(netIface);

	if (devices.length === 0) {
		return null;
	}

	// Find the device on bridge most likely to represent the 'upstream'.
	const scoreDevice = (wifiNetwork) => {
		if (!wifiNetwork) {
			return 2;
		} else if (wifiNetwork.isDisabled()) {
			return 0;
		} else if (wifiNetwork.getMode() === 'ap') {
			// It would be surprising if the device was configured with an
			// AP for the 'upstream'.
			return 1;
		} else {
			return 3;
		}
	};

	return devices.reduce((best, current) =>
		scoreDevice(current.getWifiNetwork()) > scoreDevice(best.getWifiNetwork()) ? current : best);
}

function getHaLowMode(wifiNetworks) {
	// Confusingly, if 'mode' is unset getMode() reports it's an AP
	// (normal default?) but a HaLow iface without a mode doesn't come
	// up properly at all.
	const haLowWifiNetworks = wifiNetworks.filter(n => !n.isDisabled() && isHaLow(n) && n.get('mode'));
	if (haLowWifiNetworks.length === 0) {
		return _('No HaLow enabled');
	}

	// Choose the first one that we can find.
	let haLowWifiNetwork = haLowWifiNetworks[0];
	// Prefer mesh, then ap, over other modes.
	for (const mode of ['mesh', 'ap']) {
		const betterWifiNetwork = haLowWifiNetworks.find(n => n.get('mode') === mode);
		if (betterWifiNetwork) {
			haLowWifiNetwork = betterWifiNetwork;
			break;
		}
	}

	if (haLowWifiNetwork.getMode() === 'mesh') {
		return uci.get('mesh11sd', 'mesh_params', 'mesh_gate_announcements') === '1'
			? _('802.11s Mesh Gate')
			: _('802.11s Mesh Point');
	} else if (uci.get('prplmesh', 'config', 'enable') === '1') {
		return uci.get('prplmesh', 'config', 'management_mode') === 'Multi-AP-Agent'
			? _('EasyMesh Agent')
			: _('EasyMesh Controller/Agent');
	} else {
		return _('HaLow') + ` ${haLowWifiNetwork.getActiveModeI18n()}`;
	}
}

function createSystemCard(boardinfo) {
	// Currently no nice way to get this.
	const morseVersion = boardinfo.release.description.split(' ').pop().replace('Morse-', '');

	return new Card('system', {
		heading: _('System'),
		link: { href: L.url('admin', 'system', 'system'), title: _('System Configuration') },
		contents: [
			E('dl', [
				E('dt', _('Model')),
				E('dd', boardinfo.model),
				E('dt', _('Hostname')),
				E('dd', uci.get_first('system', 'system', 'hostname')),
				E('dt', _('Linux Kernel')),
				E('dd', boardinfo.kernel),
				E('dt', _('OpenWrt')),
				E('dd', {}, boardinfo.release.version),
			]),
			E('div', { class: 'main-counter' }, [
				E('div', { class: 'medium-number' }, morseVersion),
				E('div', { class: 'big-text' }, _('Version')),
			]),
		],
	});
}

// Bunch up the logic to connect to wifi networks.
// In general, this front page is simply rendering the current state, which lets us
// get away with a simple 'just rerender everything on refresh' loop.
// However, to support establishing wifi connections (including credential setting),
// we have a persistent state here. Unfortunately, this means that we need to messily
// update parts of the DOM at arbitrary times. Probably should be using templates.
async function renderUplinkWifiConnectMethods(id, hasQRCode, wifiNetwork) {
	const netIface = wifiNetwork.getNetwork();
	const map = new form.Map('wireless');
	const s = map.section(form.NamedSection, wifiNetwork.getName());
	s.option(morseui.SSIDListScan, 'ssid', _('SSID'));
	s.option(form.Value, 'key', _('Key/Password'));
	// We put this hidden value in so that SSIDListScan understands it's a STA.
	s.option(form.HiddenValue, 'mode');

	const dppQRCodeSlider = new morseui.UISlider('0', ['0', '1'], {});
	const dppQRCodeSliderElement = dppQRCodeSlider.render();
	const isPrplmeshAgent = (uci.get('prplmesh', 'config', 'enable') === '1'
		&& uci.get('prplmesh', 'config', 'management_mode') === 'Multi-AP-Agent');

	async function updateAfterUciChange() {
		try {
			await updateUplinkWifiConnectMethods(hasQRCode, element);
			await uci.save();
			await applyUciChangesImmediately();
			await map.load();
		} catch (e) {
			console.error(e);

			// TODO
			alert('Unable to save changes.');
		}
	}

	let element;
	element = E('details', {
		id,
		'open': netIface.isUp() ? null : '', // Show by default if we're not connected.
		'data-isup': netIface.isUp(),
		'data-wifinetworkname': wifiNetwork.getName(),
	}, [
		E('summary', _('Connect to Access Point')),
		isPrplmeshAgent
			? E('p', _('Use the "Start WPS (client)" button on the EasyMesh Agent card to connect to an EasyMesh Controller.'))
			: E('dl', [
				E('dt', _('Credentials')),
				E('dd', {}, [
					await map.render(),
					E('button', {
						class: 'cbi-button cbi-button-action cbi-button-inline',
						style: 'margin-top: 0.3rem',
						click: ui.createHandlerFn(this, async () => {
							// disable qrcode DPP - we're doing normal creds.
							wifiNetwork.set('dpp', null);
							map.checkDepends();
							await map.parse();
							await updateAfterUciChange();
						}),
					}, _('Save & Apply')),
				]),
				// Currently, we only support DPP on HaLow.
				hasQRCode && isHaLow(wifiNetwork) && E('dt', _('DPP QR Code')),
				hasQRCode && isHaLow(wifiNetwork) && E('dd', { class: 'dpp-qrcode' }, [
					E('div', _('Scan the QR Code in the app to connect this device to your Access Point.')),
					E('div', { style: 'padding: 0.2rem; height: 32px; width: 32px;' }, [
						dppQRCodeSliderElement,
						E('div', { class: 'spinning', hidden: '', style: 'height: 100%; width: 100%' }),
					]),
					E('img', {
						style: 'cursor: help',
						title: _('Scan this QR Code in the app to connect this device to your Access Point.'),
						src: DPP_QRCODE_PATH,
					}),
				]),
				isHaLow(wifiNetwork) && E('dt', _('DPP Push button')),
				isHaLow(wifiNetwork) && E('dd', [
					_('Start DPP push button on the Access Point, then '),
					E('button', {
						class: 'cbi-button cbi-button-action cbi-button-inline',
						click: ui.createHandlerFn(this, async () => {
							if (wifiNetwork.get('dpp') === '1') {
								// disable qrcode DPP - we're doing pushbutton.
								wifiNetwork.set('dpp', null);
								await updateAfterUciChange();
								// TODO hack - sleep so we have time for config to reload before triggering DPP.
								await new Promise(resolveFn => window.setTimeout(resolveFn, 3 * 1000));
							}
							await fs.exec('/morse/scripts/dpp_start.sh');
							// We currently have no good feedback mechanism, so just wait 100 secs.
							await new Promise(resolveFn => window.setTimeout(resolveFn, 100 * 1000));
							await updateUplinkWifiConnectMethods(hasQRCode, element);
						}),
					}, _('Start DPP push button')),
					_(' here.'),
				]),
			].filter(e => e)),
	]);

	dppQRCodeSlider.setValue(wifiNetwork.get('dpp'));
	dppQRCodeSliderElement.addEventListener('widget-change', async (event) => {
		const spinner = element.querySelector('.dpp-qrcode .spinning');
		spinner.removeAttribute('hidden');
		dppQRCodeSliderElement.setAttribute('hidden', '');
		const dppQRCodeSlider = dom.findClassInstance(event.target);
		wifiNetwork.set('dpp', dppQRCodeSlider.getValue() === '1' ? '1' : null);
		try {
			await updateUplinkWifiConnectMethods(hasQRCode, element);
			await uci.save();
			await applyUciChangesImmediately();
		} catch (e) {
			alert('Unable to save changes to device');
			console.error(e);
		}
		dppQRCodeSliderElement.removeAttribute('hidden', '');
		spinner.setAttribute('hidden', '');
	});

	return element;
}

// This is the 'messily update the existing JS to obey the current state'.
// TODO: I have seen wifiNetwork be in a bad state where it hasn't loaded
// data properly, and netIface is empty. Hence the guards. Bug in network.js?
async function updateUplinkWifiConnectMethods(hasQRCode, connectMethods) {
	if (hasQRCode) {
		const dppQRCodeSlider = dom.findClassInstance(connectMethods.querySelector('.dpp-qrcode .cbi-checkbox'));
		const dppQRCodeImage = connectMethods.querySelector('.dpp-qrcode img');
		if (dppQRCodeSlider.getValue() === '1') {
			dppQRCodeImage.removeAttribute('hidden');
		} else {
			dppQRCodeImage.setAttribute('hidden', '');
		}
	}

	const wifiNetwork = await network.getWifiNetwork(connectMethods.dataset.wifinetworkname);
	const netIface = wifiNetwork.getNetwork();
	if (netIface) {
		if (connectMethods.dataset.isup === 'false' && netIface.isUp()) {
			// Close if we move from unconnected to connected as a cheap way to
			// show people that the state has changed.
			connectMethods.removeAttribute('open');
		} else if (connectMethods.dataset.isup === 'true' && !netIface.isUp()) {
			// Show if we do the reverse.
			connectMethods.setAttribute('open', '');
		}

		connectMethods.dataset.isup = netIface.isUp();
	}
}

async function createUplinkCard(netIface, hasQRCode) {
	const device = getBestDevice(netIface);
	const wifiNetwork = device.getWifiNetwork();

	let method, speed, ssid, meshId;
	if (wifiNetwork) {
		method = getWifiName(wifiNetwork);
		ssid = wifiNetwork.getSSID();
		meshId = wifiNetwork.getMeshID();
		speed = wifiNetwork.getBitRate();
	} else {
		method = 'Ethernet';
		speed = device.getSpeed();
	}

	const ips = [netIface.getIPAddr(), netIface.getIP6Addr()].filter(e => e);
	const qrcodeDppMode = hasQRCode && wifiNetwork && isHaLow(wifiNetwork) && wifiNetwork.get('dpp') === '1';

	let connectMethods;
	if (wifiNetwork && wifiNetwork.getMode() === 'sta') {
		// This bit of trickery is to avoid the refresh on the add-device-info,
		// since we have three bits of state to persist:
		// - whether we've expanded the section
		// - whether we're in the middle of DPP (though this is just a timeout now)
		// - whether we've revealed the password
		const id = `client-connect-methods-${wifiNetwork.getDevice().getName()}`;
		connectMethods = document.getElementById(id) || await renderUplinkWifiConnectMethods(id, hasQRCode, wifiNetwork);
		updateUplinkWifiConnectMethods(hasQRCode, connectMethods);
	}

	return new Card(`uplink-${netIface.getName()}`, {
		heading: _('Uplink') + ` (${method})`,
		highlights: [device, netIface],
		contents: [
			E('dl', [
				ssid && E('dt', _('SSID')),
				ssid && E('dd', ssid),
				meshId && E('dt', _('SSID')),
				meshId && E('dd', meshId),
				E('dt', _('Device')),
				E('dd', device.getName()),
				ips.length && E('dt', _('IP')),
				ips.length && E('dd', ips.join(' / ')),
				speed > 0 && E('dt', _('Speed')),
				speed > 0 && E('dd', `${speed} Mbps`),
				qrcodeDppMode && E('dt', _('DPP')),
				qrcodeDppMode && E('dd', _('Looking for Access Point...')),
			].filter(e => e)),
			qrcodeDppMode
				? E('div', { class: 'main-image' }, [
					E('img', {
						style: 'cursor: help',
						title: _('Scan this QR Code in the app to connect this device to your HaLow Point'),
						src: DPP_QRCODE_PATH,
					}),
				])
				: E('div', { class: 'main-counter' }, [
					E('div', { class: 'big-number' }, netIface.isUp() ? '✔' : '✘'),
					E('div', { class: 'big-text' }, netIface.isUp() ? _('Connected') : _('Disconnected')),
				]),
		],
		maxContents: wifiNetwork && [
			E('dl', [
				ssid && E('dt', _('SSID')),
				ssid && E('dd', ssid),
				meshId && E('dt', _('SSID')),
				meshId && E('dd', meshId),
				E('dt', _('Device')),
				E('dd', device.getName()),
				ips.length && E('dt', _('IP')),
				ips.length && E('dd', ips.join(' / ')),
				speed > 0 && E('dt', _('Speed')),
				speed > 0 && E('dd', `${speed} Mbps`),
				E('dt', _('Connected')),
				E('dd', {
					style: `color: ${netIface.isUp() ? 'green' : 'red'}`,
				}, netIface.isUp() ? _('yes') : _('no')),
			].filter(e => e)),
			// Currently, we only support DPP on HaLow (custom script).
			connectMethods,
		].filter(e => e),
	});
}

function createModeCard(ethernetPorts, wifiNetworks) {
	const mode = getHaLowMode(wifiNetworks);
	const diagramMini = E('morse-config-diagram');
	diagramMini.updateFrom(uci, ethernetPorts);
	const diagramMax = E('morse-config-diagram');
	// Ideally, we'd clone the above to avoid having to recalculate, but there appears
	// to be some issue with that (maybe something to do with not cloning the shadow dom
	// properly?).
	diagramMax.updateFrom(uci, ethernetPorts);

	return new Card('mode', {
		heading: _('Mode'),
		link: { href: L.url('admin', 'selectwizard'), title: _('Change mode via wizard') },
		contents: [
			E('h4', mode),
			E('div', { class: 'click-to-expand' }, diagramMini),
		],
		maxContents: [
			E('h4', mode),
			E('div', {}, diagramMax),
		],
	});
}

function createNetworkInterfacesCard(networks, wifiDevices) {
	// For now we exclude dhcpv6 to reduce noise.
	networks = networks.filter(n =>
		n.getL2Device()
		&& n.getL2Device().getName() != 'lo'
		&& ['dhcp', 'static'].includes(n.getProtocol()));

	function getZoneForNetwork(network) {
		const zoneSection = uci.sections('firewall', 'zone').find(z => L.toArray(z.network).includes(network));
		return zoneSection?.['.name'];
	}

	// Hover on an interface highlights other cards.
	function addHover(elem) {
		elem.addEventListener('mouseenter', (e) => {
			for (const hElem of document.querySelectorAll(`.highlight-${e.target.dataset.highlight}`)) {
				hElem.classList.add('highlight');
			}
		});
		elem.addEventListener('mouseleave', (e) => {
			for (const hElem of document.querySelectorAll(`.highlight-${e.target.dataset.highlight}`)) {
				hElem.classList.remove('highlight');
			}
		});

		return elem;
	}

	function getNetworkTitle(n) {
		return `${n.getProtocol()}: ${n.getIPAddr()}`;
	}

	function getDeviceTitle(d) {
		const wifiNetwork = d.getWifiNetwork();
		if (wifiNetwork) {
			const displayName = wifiDevices[wifiNetwork.getWifiDeviceName()]
				.getI18n().replace(' Wireless Controller', '');
			return `${displayName}\nSSID: ${wifiNetwork.getSSID()}`;
		} else {
			return 'Ethernet';
		}
	}

	function renderNetworkIfaceBadge(n) {
		return addHover(E('div', {
			'class': 'zonebadge network-name',
			'data-highlight': makeClass(n),
			'title': getNetworkTitle(n),
			'style': firewall.getZoneColorStyle(getZoneForNetwork(n.getName())),
		}, n.getName()));
	}

	function renderNetworkDevices(n) {
		return getL2Devices(n).map(d => addHover(E('div', {
			'class': 'ifacebox',
			'data-highlight': makeClass(d),
			'title': getDeviceTitle(d),
		}, [
			E('div', { class: 'ifacebox-head' }, d.getName()),
			E('div', { class: 'ifacebox-body' }, [
				// From render_iface in luci-mod-network
				E('img', { src: L.resource('icons/%s%s.png').format(d.getType() || 'ethernet', d.isUp() ? '' : '_disabled') }),
			]),
		])));
	}

	return new Card('networks', {
		heading: _('Network Interfaces'),
		link: { href: L.url('admin', 'network', 'network'), title: _('Network Interfaces') },
		contents: E('div', { class: 'network-interfaces' }, networks.flatMap(n => [
			E('div', {}, renderNetworkIfaceBadge(n)),
			E('div', '→'),
			E('div', {}, E('div', { class: 'devices-box' }, renderNetworkDevices(n))),
		])),
		maxContents: [
			E('table', { class: 'table cbi-section-table' }, [
				tr('th', [_('Network'), _('Devices'), _('Configuration')]),
				...networks.map(n => tr('td', [
					renderNetworkIfaceBadge(n),

					E('div', {}, renderNetworkDevices(n)),

					E('dl', [
						E('dt', _('Protocol')),
						E('dd', n.getI18n()),
						E('dt', _('IPv4')),
						E('dd', n.getIPAddr() ?? _('None')),
						E('dt', _('IPv6')),
						E('dd', n.getIP6Addr() ?? _('None')),
					]),
				])),
			]),
		],
	});
}

function createLocalNetworksCard(networks, dhcpLeases, hostHints) {
	const ipv4addrs = [];
	const ipv6addrs = [];
	const names = [];

	for (const netIface of networks) {
		names.push(netIface.getName());
		ipv4addrs.push(...netIface.getIPAddrs());
		ipv6addrs.push(...netIface.getIP6Addrs());
	}

	function expiry(timeInSecs) {
		if (!timeInSecs) {
			return '';
		} else if (timeInSecs === 0) {
			return _('Never');
		} else {
			return Math.round(timeInSecs / 60) + _(' min(s)');
		}
	}

	return new Card('localnetworks', {
		heading: _('Local Network'),
		highlights: networks.flatMap(netIface => [netIface, ...getL2Devices(netIface)]),
		contents: [
			E('dl', [
				E('dt', _('Name(s)')),
				E('dd', names.join(', ')),
				E('dt', _('IPv4')),
				E('dd', ipv4addrs.length > 0 ? ipv4addrs.join(', ') : _('None')),
				E('dt', _('IPv6')),
				E('dd', ipv6addrs.length > 0 ? ipv6addrs.join(', ') : _('None')),
			]),
			E('div', { class: 'main-counter' }, [
				E('button', { class: 'big-number click-to-expand' }, dhcpLeases.length),
				E('button', { class: 'big-text click-to-expand' }, _('DHCP Leases')),
			]),
		],
		maxContents: [
			E('dl', [
				E('dt', _('IPv4')),
				E('dd', ipv4addrs.length > 0 ? ipv4addrs.join(', ') : _('None')),
				E('dt', _('IPv6')),
				E('dd', ipv6addrs.length > 0 ? ipv6addrs.join(', ') : _('None')),
			]),
			dhcpLeases.length > 0
				? E('table', { class: 'table cbi-section-table' }, [
					tr('th', [_('MAC Address'), _('Hostname'), _('IPv4'), _('Expiry'), _('IPv6'), _('IPv6 Expiry')]),
					...dhcpLeases.map(lease =>
						tr('td', [lease.macaddr, hostHints.getHostnameByMACAddr(lease.macaddr), lease.ipaddr, expiry(lease.expires), lease.ip6addrs?.join(', '), expiry(lease.ip6expires)])),
				])
				: E('em', _('No active leases')),
		],
	});
}

function createAccessPointCard(wifiNetwork, hostHints) {
	const netIface = wifiNetwork.getNetwork();
	const bitrate = wifiNetwork.getBitRate();
	const wifiName = getWifiName(wifiNetwork);

	const associatedDevices = wifiNetwork.assoclist.map(d => ({
		mac: d.mac,
		hostname: hostHints.getHostnameByMACAddr(d.mac),
		ip: hostHints.getIPAddrByMACAddr(d.mac),
		ip6: hostHints.getIP6AddrByMACAddr(d.mac),
		connected_time: Math.round(d.connected_time / 60),
		noise: d.noise,
		signal: d.signal,
	}));
	const hasHostname = associatedDevices.some(d => d.hostname);
	const hasIp = associatedDevices.some(d => d.ip);
	const hasIp6 = associatedDevices.some(d => d.ip6);
	const authentication = wifiNetwork.ubus('net', 'iwinfo', 'encryption').authentication || [];
	const wifiPassword = (authentication.includes('sae') || authentication.includes('psk')) && wifiNetwork.get('key');

	let connectMethods;
	if (wifiPassword) {
		// This bit of trickery is to avoid the refresh on the add-device-info,
		// since we have three bits of state to persist:
		// - whether we've expanded the section
		// - whether we're in the middle of DPP (though this is just a timeout now)
		// - whether we've revealed the password
		const id = `ap-connect-methods-${wifiNetwork.getDevice().getName()}`;
		connectMethods = document.getElementById(id) || E('details', { id }, [
			E('summary', _('Connect a new device')),
			E('dl', [
				E('dt', _('Credentials')),
				E('dd', {}, E('dl', [
					E('dt', _('SSID')),
					E('dd', wifiNetwork.getSSID()),
					E('dt', _('Key/Password')),
					E('dd', { class: 'password-field' }, [
						E('span', {
							style: 'display: none',
							class: 'password-reveal',
							click: (e) => {
								e.target.style.display = 'none';
								e.target.parentElement.querySelector('.password-hide').style.display = 'initial';
							},
						}, wifiPassword),
						E('span', {
							class: 'password-hide',
							title: _('Reveal password'),
							click: (e) => {
								e.target.style.display = 'none';
								e.target.parentElement.querySelector('.password-reveal').style.display = 'initial';
							},
						}, '●●●●●●●●'),
					]),
				].filter(e => e))),
				// Currently, we only support DPP on HaLow.
				isHaLow(wifiNetwork) && E('dt', _('DPP QR Code')),
				isHaLow(wifiNetwork) && E('dd', _('Scan the Client QR Code in the app.')),
				isHaLow(wifiNetwork) && E('dt', _('DPP Push button')),
				isHaLow(wifiNetwork) && E('dd', [
					E('button', {
						class: 'cbi-button cbi-button-action cbi-button-inline',
						click: ui.createHandlerFn(this, async () => {
							await fs.exec('/morse/scripts/dpp_start.sh');
							// We currently have no good feedback mechanism, so just wait 100 secs.
							await new Promise(resolveFn => window.setTimeout(resolveFn, 100 * 1000));
						}),
					}, _('Start DPP push button')),
					_(' here, and then on the Client.'),
				]),
			].filter(e => e)),
		]);
	}

	return new Card(`wifi-${wifiName}`, {
		heading: _('Access Point') + ` (${wifiName})`,
		link: { href: L.url('admin', 'network', 'wireless'), title: _('Wireless Configuration') },
		highlights: [wifiNetwork.getDevice(), netIface],
		contents: [
			E('dl', [
				E('dt', _('SSID')),
				E('dd', wifiNetwork.getSSID()),
				E('dt', _('Device')),
				E('dd', wifiNetwork.getDevice().getName()),
				bitrate && E('dt', _('Speed (avg)')),
				bitrate && E('dd', `${wifiNetwork.getBitRate()} Mbps`),
			].filter(e => e)),
			E('div', { class: 'main-counter' }, [
				E('button', { class: 'big-number click-to-expand' }, wifiNetwork.assoclist.length),
				E('button', { class: 'big-text click-to-expand' }, _('Connected Devices')),
			]),
		],
		maxContents: [
			E('dl', [
				E('dt', _('SSID')),
				E('dd', wifiNetwork.getSSID()),
				E('dt', _('Device')),
				E('dd', wifiNetwork.getDevice().getName()),
				E('dt', _('IPv4')),
				E('dd', netIface.getIPAddr() ?? _('None')),
				E('dt', _('IPv6')),
				E('dd', netIface.getIP6Addr() ?? _('None')),
				E('dt', _('Encryption')),
				E('dd', wifiNetwork.getActiveEncryption()),
			].filter(e => e)),
			E('h2', { style: 'margin: 0' }, _('Associated devices')),
			connectMethods,
			associatedDevices.length > 0
				? E('table', { class: 'table cbi-section-table' }, [
					tr('th', [_('MAC Address'), hasHostname && _('Hostname'), hasIp && _('IPv4'), hasIp6 && _('IPv6'), _('Time connected'), _('Noise'), _('Signal')].filter(t => t)),
					...associatedDevices.map(d => tr('td', [d.mac, hasHostname && d.hostname, hasIp && d.ip, hasIp6 && d.ip6, d.connected_time + _(' min(s)'), d.noise + _(' dBm'), d.signal + _(' dBm')].filter(t => t))),
				])
				: E('em', _('No active devices')),
		].filter(e => e),
	});
}

function renderPrplmeshTopology(agentOperational, prplmeshData) {
	const graph = prplmeshData.buildGraph();

	// Re-rendering is painful, as it will mean that any existing zoom is lost.
	// Therefore we only rerender if something we care about has changed.
	const newState = Array.from(graph.getStateInfo()).join(' ') + ` agentOperational:${agentOperational}`;

	// This is a bit tricky. We search the DOM for a previous instance of our topology diagram,
	// then yank it out and re-use it if the state hasn't actually changed. This is how, at the moment,
	// we get away with having a stupidly simple top-level that blows all the cards away each
	// time while still keeping this one separate (since the topology render is one of the heaviest
	// actions, and if it's live we want to keep the current zoom status/layout).
	const existingTopology = document.getElementById('prplmesh-topology');
	if (existingTopology && newState === existingTopology.dataset.state) {
		return existingTopology;
	}

	const topology = E('div', { 'id': 'prplmesh-topology', 'data-state': newState }, [
		E('div', { class: 'graphbuttons pull-right' }, [
			E('button', { class: 'zoomin cbi-button cbi-button-action' }, _('Zoom in')),
			E('button', { class: 'zoomout cbi-button cbi-button-action' }, _('Zoom out')),
			E('button', { class: 'reset cbi-button cbi-button-action' }, _('Reset')),
		]),
		E('div', { class: 'graphcontainer', style: 'height: 600px;' }),
	]);

	// We only want to render the graph when it becomes visible
	// (as rendering when it's not visible causes it to render in the wrong place).
	// This also saves unnecessary graph calculations on initial load
	// (in particular, we run 1000 PRERENDER_ITERATIONS to have an initially mostly sane layout).
	new IntersectionObserver((entries, observer) => {
		entries.forEach((entry) => {
			if (entry.intersectionRatio > 0) {
				const renderer = graph.renderTo(topology.querySelector('.graphcontainer'));
				topology.querySelector('.graphbuttons .zoomin').addEventListener('click', () => renderer.zoomIn());
				topology.querySelector('.graphbuttons .zoomout').addEventListener('click', () => renderer.zoomOut());
				topology.querySelector('.graphbuttons .reset').addEventListener('click', () => renderer.reset());
				observer.disconnect();
			}
		});
	}, { root: document.documentElement }).observe(topology);

	return topology;
}

async function createPrplmeshControllerCard() {
	const managementMode = uci.get('prplmesh', 'config', 'management_mode');
	const operatingMode = uci.get('prplmesh', 'config', 'operating_mode');

	// Because this is a dependent operation anyway (we need to know the uci config
	// to understand whether it's necessary), and eventually we hope to move this
	// logic into a separate module (so not everyone is carrying vivagraph/prplmesh)
	// we do the load here.
	await callSessionAccess('access-group', 'luci-mod-home-index-prplmesh', 'read');
	let prplmeshData;
	try {
		prplmeshData = await prplmeshTopology.load();
	} catch (e) {
		console.error(e);
	}

	// Ideally we would call fs.exec('/opt/prplmesh/bin/beerocks_cli', ['-c', 'bml_get_agent_status']),
	// but this is horrifically slow.
	const agentOperational = uci.get('prplmesh', 'config', 'operational') === '1';

	const colorStyle = `color: ${agentOperational ? 'green' : 'red'}`;

	const agentCount = prplmeshData?.countAgents() || 0;
	const expandClass = agentCount > 0 ? 'click-to-expand' : '';

	return new Card('prplmesh-controller', {
		heading: 'EasyMesh Controller',
		contents: [
			E('div', { style: 'display: flex; justify-content: space-between; align-items: center;' }, [
				E('dl', [
					E('dt', _('Agent status')),
					E('dd', { style: colorStyle }, agentOperational ? _('active') : _('inactive')),
				]),
				// This bit of trickiness is because the WPS button has state (and its own internal polling mechanism),
				// so we keep the old wps button from a previous render if it exists.
				document.querySelector('cli-wps-button[service=hostapd]') || E('cli-wps-button', { service: 'hostapd', state: 'available' }),
			]),
			E('div', { class: 'main-counter' }, [
				E('button', { class: 'big-number ' + expandClass }, agentCount),
				E('button', { class: 'big-text ' + expandClass }, _('Connected Agents')),
			]),
		],
		maxContents: agentCount > 0 && [
			E('dl', [
				E('dt', _('Management mode')),
				E('dd', managementMode),
				E('dt', _('Operating mode')),
				E('dd', operatingMode),
				E('dt', _('Agent status')),
				E('dd', { style: colorStyle }, agentOperational ? _('active') : _('inactive')),
			]),
			renderPrplmeshTopology(agentOperational, prplmeshData),
		],
	});
}

function createPrplmeshAgentCard() {
	// On the agent (i.e. not Controller/Agent), there's no easy way to get the
	// operational state. This odd UCI config is actually set by the prplmesh
	// init script currently for other reasons.
	const operational = uci.get('prplmesh', 'config', 'operational') === '1';

	return new Card('prplmesh-agent', {
		heading: 'EasyMesh Agent',
		contents: [
			E('div', { style: 'display: flex; justify-content: space-between;' }, [
				// This bit of trickiness is because the WPS button has state (and its own internal polling mechanism),
				// so we keep the old wps button from a previous render if it exists. This is particularly
				// important for wps_supplicant because wpa_cli_s1g has no way to query the current
				// PBC state so it just has a timer.
				document.querySelector('cli-wps-button[service=wpa_supplicant]') || E('cli-wps-button', { service: 'wpa_supplicant', state: 'available' }),
				document.querySelector('cli-wps-button[service=hostapd]') || E('cli-wps-button', { service: 'hostapd', state: 'available' }),
			]),
			E('div', { class: 'main-counter' }, [
				E('div', { class: 'big-number' }, operational ? '✔' : '✘'),
				E('div', { class: 'big-text' }, operational ? _('Active') : _('Inactive')),
			]),
		],
	});
}

class Card {
	constructor(id, { heading, contents, maxContents, highlights, link }) {
		this.id = id;
		this.heading = heading;
		this.contents = contents;
		this.maxContents = maxContents;
		this.highlights = highlights;
		this.link = link;
	}

	expand() {
		const modalOverlay = document.getElementById('homepage-modal-overlay');
		const modal = modalOverlay.querySelector('div.modal');
		modal.replaceChildren(this.renderMaxCard());
		modalOverlay.classList.add('active');

		if (modal.getBoundingClientRect().bottom > window.innerHeight) {
			modal.scrollIntoView(false);
		}

		if (modal.getBoundingClientRect().top < 0) {
			modal.scrollIntoView();
		}
	}

	static collapse() {
		const modalOverlay = document.getElementById('homepage-modal-overlay');
		const modal = modalOverlay.querySelector('div.modal');
		modalOverlay.classList.remove('active');
		modal.replaceChildren();
	}

	renderCard() {
		const smallContents = E('div', { class: 'small-contents' }, this.contents);
		for (const e of smallContents.querySelectorAll('.click-to-expand')) {
			e.onclick = () => this.expand();
		}

		return E('section', {
			id: this.id,
			class: 'card ' + (this.highlights ?? []).map(h => `highlight-${makeClass(h)}`).join(' '),
		}, [
			E('div', { class: 'header' }, [
				E('h2', this.heading),
				this.link && E('a', {
					href: this.link.href,
					title: this.link.title,
					class: 'bs-icon bs-icon-settings-cog advanced-config',
				}),
				this.maxContents && E('div', { class: 'expand bs-icon bs-icon-arrows-angle-expand', title: _('Expand'), click: () => this.expand() }),
			].filter(e => e)),
			smallContents,
		]);
	}

	renderMaxCard() {
		return E('section', {
			id: `${this.id}-max`,
			class: 'card ' + (this.highlights ?? []).map(h => `highlight-${makeClass(h)}`).join(' '),
		}, [
			E('div', { class: 'header' }, [
				E('h1', this.heading),
				this.link && E('a', {
					href: this.link.href,
					title: this.link.title,
					class: 'bs-icon bs-icon-settings-cog',
				}),
				E('div', { class: 'collapse bs-icon bs-icon-x-lg', title: _('Restore'), click: () => Card.collapse() }),
			].filter(e => e)),
			E('div', { class: 'max-contents' }, this.maxContents),
		]);
	}
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	load() {
		return Promise.all([this.onceLoad(), this.repeatLoad()]);
	},

	async onceLoad() {
		const [hasQRCode, ..._] = await Promise.all([
			fetch(DPP_QRCODE_PATH, { method: 'HEAD' }).then(r => r.ok),
			configDiagram.loadTemplate(),
		]);

		return { hasQRCode };
	},

	async repeatLoad() {
		const [boardinfo, ethernetPorts, dhcpLeases] = await Promise.all([
			callSystemBoard(),
			callGetBuiltinEthernetPorts(),
			callLuciDHCPLeases().then((result) => {
				// Compress IPv6 and IPv4 so we can try to show in one table.
				// Possibly ill-advised; some info loss.
				const leases = [];
				const leasesByHostname = {};
				for (const lease of result.dhcp_leases) {
					if (lease.hostname) {
						leasesByHostname[lease.hostname] = lease;
					} else {
						leases.push(lease);
					}
				}

				for (const lease of result.dhcp6_leases) {
					if (lease.hostname) {
						leasesByHostname[lease.hostname] ??= { hostname: lease.hostname };

						Object.assign(leasesByHostname[lease.hostname], {
							ip6expires: lease.expires,
							ip6addrs: lease.ip6addrs,
						});
					} else {
						lease['ip6expires'] = lease.expires;
						delete lease.expires;
						leases.push(lease);
					}
				}

				leases.push(...Object.values(leasesByHostname));
				return leases;
			}),
			uci.load('prplmesh').catch(() => null),
			uci.load(['wireless', 'network', 'firewall', 'dhcp', 'luci', 'system']),
			uci.load('mesh11sd').catch(() => null),
			network.flushCache(true),
		]);

		return { boardinfo, ethernetPorts, dhcpLeases };
	},

	async render([onceLoadData, repeatLoadData]) {
		// This keeps our normal loading spinner until the first poll has resolved.
		// The poller has the annoying behaviour of doing the poll immediately.
		// I can't see a straightforward way to workaround this, so we just have
		// some janky logic around the initial data load.
		// Note that the LuCI status page just does the data load twice.

		poll.add(async () => {
			if (!repeatLoadData) {
				uci.unload(['wireless', 'network', 'firewall', 'dhcp', 'luci', 'system', 'prplmesh', 'mesh11sd']);
				repeatLoadData = await this.repeatLoad();
			}
			const cards = await this.createCards({ ...onceLoadData, ...repeatLoadData });
			// i.e. force us to regen next time through the poll.
			repeatLoadData = null;

			// If we have an expanded card, let us continue having an expanded card.
			const modalOverlay = document.getElementById('homepage-modal-overlay');
			if (modalOverlay?.classList.contains('active')) {
				const id = modalOverlay.querySelector('section').id.replace(/-max$/, '');
				const maxCard = cards.find(c => c.id === id);
				if (maxCard) {
					modalOverlay.querySelector('.modal').replaceChildren(maxCard.renderMaxCard());
				}
			}

			const view = document.getElementById('view');
			view.replaceChildren(E('div', { class: 'cards' }, cards.map(c => c.renderCard())));
		});

		document.getElementById('maincontent').append(
			E('div', {
				id: 'homepage-modal-overlay',
				tabindex: -1,
				click: () => Card.collapse(),
				// keydown: this.cancelModal,
			}, [
				this.modal = E('div', {
					'class': 'modal',
					'role': 'dialog',
					'click': e => e.stopPropagation(),
					'aria-modal': true,
				}),
			]),
		);

		return E('div');
	},

	async createCards({ hasQRCode, boardinfo, ethernetPorts, dhcpLeases }) {
		// Turn list into obj with getName() as keys.
		function makeObj(l) {
			return l.reduce((o, d) => (o[d.getName()] = d, o), {});
		}

		// NB All of these awaits are not going to cause actual network requests,
		// because (confusingly) network.flushCache(true) not only flushes the cache
		// but makes all these requests again.
		const hostHints = await network.getHostHints();
		const networks = await network.getNetworks();
		const wifiDevices = makeObj(await network.getWifiDevices());
		const wanNetworks = makeObj(await network.getWANNetworks());
		const wan6Networks = makeObj(await network.getWAN6Networks());
		const wifiNetworks = await network.getWifiNetworks().then(
			networks => Promise.all(networks.map(async (network) => {
				// Patch assoclist into wifi networks.
				// Ugly, but this is what status page and dashboard do...
				const assoclist = await network.getAssocList();
				network.assoclist = assoclist.toSorted((a, b) => a.mac > b.mac);
				return network;
			})));

		const cards = [
			createSystemCard(boardinfo),
			createModeCard(ethernetPorts, Object.values(wifiNetworks)),
		];

		if (uci.get('prplmesh', 'config', 'enable') === '1') {
			cards.push(
				uci.get('prplmesh', 'config', 'management_mode') === 'Multi-AP-Controller-and-Agent'
					? await createPrplmeshControllerCard()
					: createPrplmeshAgentCard());
		}

		const localNetworks = [];
		for (const netIface of networks) {
			const device = netIface.getL2Device();
			if (!device || (device.isBridge() && !device.getPorts())) {
				// This device is never going to be anything useful; it's
				// a bridge with nothing on it.
				continue;
			}

			const name = netIface.getName();
			if (wanNetworks[name] || wan6Networks[name] || netIface.getProtocol() === 'dhcp') {
				cards.push(await createUplinkCard(netIface, hasQRCode));
			} else if (netIface.getProtocol() === 'static' && netIface.getDevice()?.getName() !== 'lo') {
				localNetworks.push(netIface);
			}
		}

		// List access points separately
		// (STAs should generally be captured by 'upstream' above).
		for (const wifiNetwork of wifiNetworks) {
			if (!wifiNetwork.isDisabled() && wifiNetwork.isUp() && wifiNetwork.getMode() === 'ap' && wifiNetwork.getNetwork()) {
				cards.push(createAccessPointCard(wifiNetwork, hostHints));
			}
		}

		if (localNetworks.length > 0) {
			cards.push(createLocalNetworksCard(localNetworks, dhcpLeases, hostHints));
		}

		cards.push(createNetworkInterfacesCard(networks, wifiDevices));

		return cards;
	},
});
