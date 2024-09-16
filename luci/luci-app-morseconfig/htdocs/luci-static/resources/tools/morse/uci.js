'use strict';
/* globals baseclass uci */
'require baseclass';
'require uci';

/* Various helpers so we can interact more easily with uci.
 *
 * e.g.
 * - getting values through levels of indirection
 * - creating sections if they don't exist
 */

function getZoneForNetwork(network) {
	const zoneSection = uci.sections('firewall', 'zone').find(z => L.toArray(z.network).includes(network));
	return zoneSection?.['.name'];
}

function getOrCreateForwarding(srcZone, destZone, name = undefined) {
	// The code subsequent to this messes with firewall rules. However, if the
	// user hasn't changed what's in uci at all, we want to be able to issue
	// a 'save' on this page without destroying their firewall config
	// (i.e. if they have multiple forwards from a network in some way).
	// Therefore we detect this situation and do nothing.
	let existingForwarding = uci.sections('firewall', 'forwarding').find(f => f.src === srcZone && f.dest === destZone && f.enabled !== '0');
	if (existingForwarding) {
		return existingForwarding['.name'];
	}

	// Now it seems like the user has mutated something.
	// Disable any other forwarding from this src (our dropdown only allows one).
	// Ideally we would like to delete here, but for now to avoid destroying
	// the default mmrouter/mmextender forwarding rules, we set enabled=0
	// (unfortunately, the LuCI pages at the moment don't understand enabled).
	for (const s of uci.sections('firewall', 'forwarding').filter(f => f.src === srcZone)) {
		uci.set('firewall', s['.name'], 'enabled', '0');
	}

	let existingDisabledForwarding = uci.sections('firewall', 'forwarding').find(f => f.src === srcZone && f.dest === destZone);
	if (existingDisabledForwarding) {
		uci.set('firewall', existingDisabledForwarding['.name'], 'enabled', '1');
		return existingDisabledForwarding['.name'];
	}

	// Finally, create a forwarding rule if necessary.
	const forwardingId = uci.add('firewall', 'forwarding', name);
	uci.set('firewall', forwardingId, 'src', srcZone);
	uci.set('firewall', forwardingId, 'dest', destZone);
	return forwardingId;
}

function getOrCreateZone(networkSectionId) {
	const zone = getZoneForNetwork(networkSectionId);
	if (zone) {
		return zone;
	}

	let proposedName = networkSectionId, i = 0;
	while (uci.sections('firewall').some(s => [s['.name'], s.name].includes(proposedName))) {
		proposedName = `${networkSectionId}${++i}`;
	}

	uci.add('firewall', 'zone', proposedName);
	uci.set('firewall', proposedName, 'name', proposedName);
	uci.set('firewall', proposedName, 'network', networkSectionId);
	uci.set('firewall', proposedName, 'input', 'ACCEPT');
	uci.set('firewall', proposedName, 'output', 'ACCEPT');
	uci.set('firewall', proposedName, 'forward', 'ACCEPT');
	uci.set('firewall', proposedName, 'masq', '1');

	return proposedName;
}

function createDhcp(dnsmasqName, networkSectionId) {
	let proposedName = `${networkSectionId}`, i = 0;
	while (uci.sections('dhcp').some(s => s['.name'] === proposedName)) {
		proposedName = `${networkSectionId}${++i}`;
	}

	uci.add('dhcp', 'dhcp', proposedName);
	uci.set('dhcp', proposedName, 'start', '100');
	uci.set('dhcp', proposedName, 'limit', '150');
	uci.set('dhcp', proposedName, 'leasetime', '12h');
	uci.set('dhcp', proposedName, 'interface', networkSectionId);
	if (!uci.get('dhcp', dnsmasqName)['.anonymous']) {
		uci.set('dhcp', proposedName, 'instance', dnsmasqName);
	}

	return proposedName;
}

function getOrCreateDhcp(dnsmasqName, networkSectionId) {
	const onSections = uci.sections('dhcp', 'dhcp').filter(dhcp => dhcp.interface === networkSectionId && dhcp.ignore !== '1' && (!dhcp.instance || dhcp.instance === dnsmasqName));
	const offSection = uci.sections('dhcp', 'dhcp').find(dhcp => dhcp.interface === networkSectionId && dhcp.ignore === '1' && (!dhcp.instance || dhcp.instance === dnsmasqName));
	if (onSections.length > 0) {
		return onSections[0]['.name'];
	} else if (offSection) {
		uci.unset('dhcp', offSection['.name'], 'ignore');
		return offSection['.name'];
	} else {
		return createDhcp(dnsmasqName, networkSectionId);
	}
}

function setupDnsmasq(dnsmasqName, networkSectionId) {
	// This is based on the necessary part of package/network/service/dnsmasq/file/dhcp.conf
	// (where necessary is overriding the default behaviour).
	uci.set('dhcp', dnsmasqName, 'domainneeded', '1');
	uci.set('dhcp', dnsmasqName, 'localise_queries', '1');
	uci.set('dhcp', dnsmasqName, 'rebind_localhost', '1');
	uci.set('dhcp', dnsmasqName, 'local', `/${networkSectionId}/`);
	uci.set('dhcp', dnsmasqName, 'domain', networkSectionId);
	uci.set('dhcp', dnsmasqName, 'expandhosts', '1');
	uci.set('dhcp', dnsmasqName, 'cachesize', '1000');
	uci.set('dhcp', dnsmasqName, 'authoritative', '1');
	uci.set('dhcp', dnsmasqName, 'readethers', '1');
	uci.set('dhcp', dnsmasqName, 'localservice', '1');
	uci.set('dhcp', dnsmasqName, 'ednspacket_max', '1232');
}

function getOrCreateDnsmasq(networkSectionId) {
	const dnsSections = uci.sections('dhcp', 'dnsmasq');
	const genericDnsSections = dnsSections.filter(dnsmasq => !dnsmasq.interface && !L.toArray(dnsmasq.notinterface).includes(networkSectionId));
	const interfaceDnsSections = dnsSections.filter(dnsmasq => L.toArray(dnsmasq.interface).includes(networkSectionId));

	if (genericDnsSections.length + interfaceDnsSections.length > 1) {
		console.error('More than one applicable dnsmasq for interface - probably broken config.');
	}

	if (genericDnsSections.length > 0) {
		return genericDnsSections[0]['.name'];
	} else if (interfaceDnsSections.length > 0) {
		return interfaceDnsSections[0]['.name'];
	} else if (dnsSections.length === 0) {
		const name = uci.add('dhcp', 'dnsmasq');
		setupDnsmasq(name, networkSectionId);

		return name;
	} else if (dnsSections.length === 1) {
		// There's exactly one dnsSection, but it's not available for our interface.
		// Let's just extend it to cover this interface.
		const dnsSection = dnsSections[0];
		if (dnsSection.interface) {
			uci.unset('dhcp', dnsSection['.name'], 'interface');
		}
		if (L.toArray(dnsSection.notinterface).includes(networkSectionId)) {
			uci.set('dhcp', dnsSection['.name'], 'notinterface', dnsSection.notinterface.filter(iface => iface === networkSectionId));
		}

		return dnsSection['.name'];
	} else {
		// There are multiple existing dnsSections, so we need to avoid clashes,
		// both in naming and in interfering with other sections.
		let proposedName = `${networkSectionId}_dns`, i = 0;
		while (uci.sections('dhcp').some(s => s['.name'] === proposedName)) {
			proposedName = `${networkSectionId}_dns${++i}`;
		}

		uci.add('dhcp', 'dnsmasq', proposedName);
		setupDnsmasq(proposedName, networkSectionId);
		uci.set('dhcp', proposedName, 'interface', [networkSectionId]);
		uci.set('dhcp', proposedName, 'localuse', '0');
		uci.set('dhcp', proposedName, 'notinterface', ['loopback']);

		return proposedName;
	}
}

/* Report if multiple devices are likely to appear on a network interface (i.e. bridge required).
 *
 * Unlike 'getNetworkDevices', this includes wireless ifaces (and double counts
 * wifi-ifaces that will generate multiple devices - e.g. WDS APs).
 */
function hasMultipleDevices(networkSectionId) {
	let count = getNetworkDevices(networkSectionId).length;

	for (const wifiIface of getNetworkWifiIfaces(networkSectionId)) {
		// TODO (APP-2823) I don't think wifiIface.mode 'mesh' is an appropriate trigger for this
		// (some confusion with prplmesh or +AP?), but for consistency with the old behaviour...
		count += (wifiIface.mode === 'ap' && wifiIface.wds === '1') || wifiIface.mode === 'mesh' ? 2 : 1;
	}

	return count > 1;
}

function forceBridge(networkSectionId, bridgeName, bridgeMAC = null) {
	const currentDevice = uci.get('network', networkSectionId, 'device');
	let bridge = uci.sections('network', 'device').find(s => s.type == 'bridge' && s.name == bridgeName);
	// Create a bridge device with the bridgeName if it doesn't exist
	if (!bridge) {
		bridge = uci.add('network', 'device');
		uci.set('network', bridge, 'name', bridgeName);
		uci.set('network', bridge, 'type', 'bridge');
		if (bridgeMAC)
			uci.set('network', bridge, 'macaddr', bridgeMAC);
	} else {
		// If bridge is mapped to any other network unset it
		for (const network of uci.sections('network', 'interface')) {
			if (network.device === bridgeName && network['.name'] !== networkSectionId) {
				uci.unset('network', network['.name'], 'device');
			}
		}
		if (bridgeMAC) {
			uci.set('network', bridge['.name'], 'macaddr', bridgeMAC);
		}
	}
	// Do nothing if the network is already on the expected bridge
	if (currentDevice != bridgeName) {
		// Remove any bridge attached to the network
		const existingBridge = uci.sections('network', 'device').find(s => s.type == 'bridge' && s.name == currentDevice);
		if (existingBridge) {
			uci.unset('network', networkSectionId, 'device');
			if (existingBridge.ports && existingBridge.ports.length > 0) {
				uci.set('network', bridge, 'ports', existingBridge.ports);
			}
			uci.unset('network', existingBridge, 'ports');
		}

		uci.set('network', networkSectionId, 'device', bridgeName);
	}
}

function useBridgeIfNeeded(networkSectionId) {
	const currentDevice = uci.get('network', networkSectionId, 'device');
	const bridge = uci.sections('network', 'device').find(s => s.type == 'bridge' && s.name == currentDevice);

	if (bridge) {
		// Do we need to remove this bridge because our wifi iface can't be bridged? (i.e. it's a sta?)
		if (!hasMultipleDevices(networkSectionId)) {
			// We're conservative here about removing the bridge: only if necessary.
			// (i.e. if STA without WDS). This reduces the number of changes when interacting
			// with the config page.
			const wifiIfaces = getNetworkWifiIfaces(networkSectionId);
			if (wifiIfaces.length === 1 && wifiIfaces[0].mode === 'sta' && wifiIfaces[0].wds !== '1') {
				uci.unset('network', networkSectionId, 'device');
			}
			return false;
		} else {
			return true;
		}
	} else {
		// Do we need to add a bridge because there are too many potential devices?
		if (hasMultipleDevices(networkSectionId)) {
			setBridgeWithPorts(networkSectionId, currentDevice ? [currentDevice] : []);
			return true;
		} else {
			return false;
		}
	}
}

function setBridgeWithPorts(networkSectionId, ports) {
	const currentDevice = uci.get('network', networkSectionId, 'device');
	const existing = currentDevice && uci.sections('network', 'device').find(s => s.type == 'bridge' && s.name == currentDevice);
	if (existing) {
		if (ports.length > 0) {
			uci.set('network', existing['.name'], 'ports', ports);
		}

		return existing['name'];
	}

	const namePrefix = `br-${networkSectionId}`;
	let proposedName = namePrefix, i = 0;
	let bridgeSectionId;

	for (; ;) {
		const existingBridge = uci.sections('network', 'device').find(s => s.name === proposedName);
		if (!existingBridge) {
			bridgeSectionId = uci.add('network', 'device');
			uci.set('network', bridgeSectionId, 'name', proposedName);
			uci.set('network', bridgeSectionId, 'type', 'bridge');
			break;
		} else if (!uci.sections('network', 'interface').some(s => s.device === proposedName)) {
			// If it's currently unused, let's re-use.
			bridgeSectionId = existingBridge['.name'];
			break;
		}

		proposedName = `${namePrefix}${++i}`;
	}

	if (ports.length > 0) {
		uci.set('network', bridgeSectionId, 'ports', ports);
	}

	uci.set('network', networkSectionId, 'device', proposedName);
}

function getEthNetwork() {
	for (const network of uci.sections('network', 'interface')) {
		if (getNetworkDevices(network['.name']).some(d => d.startsWith('eth') || d.startsWith('lan'))) {
			return network['.name'];
		}
	}
}

function getNetworkWifiIfaces(networkSectionId) {
	return uci.sections('wireless', 'wifi-iface')
		.filter(wifiIface => wifiIface.disabled !== '1' && wifiIface.network === networkSectionId);
}

function getNetworkDevices(sectionId) {
	const device = uci.get('network', sectionId, 'device');
	const bridge = uci.sections('network', 'device').find(s => s.name === device && s.type === 'bridge');
	if (bridge) {
		return bridge.ports ?? [];
	} else {
		return device ? [device] : [];
	}
}

function setNetworkDevices(sectionId, devices) {
	const device = uci.get('network', sectionId, 'device');
	const deviceSection = uci.sections('network', 'device')
		.find(s => s.name === device);

	if (device && deviceSection && deviceSection.type === 'bridge') {
		uci.set('network', deviceSection['.name'], 'ports', devices);
	} else if (devices.length === 1) {
		uci.set('network', sectionId, 'device', devices[0]);
	} else if (devices.length > 1) {
		setBridgeWithPorts(sectionId, devices);
	}
}

function setupNetworkWithDnsmasq(sectionId, ip, uplink = true) {
	const dnsmasq = getOrCreateDnsmasq(sectionId);
	const dhcp = getOrCreateDhcp(dnsmasq, sectionId);
	uci.set('network', sectionId, 'proto', 'static');
	uci.set('network', sectionId, 'ipaddr', ip);
	uci.set('network', sectionId, 'netmask', '255.255.255.0');

	if (!uplink) {
		uci.set('dhcp', dhcp, 'dhcp_option', ['3', '6']);
	} else {
		uci.unset('dhcp', dnsmasq, 'notinterface');
		uci.unset('dhcp', dhcp, 'dhcp_option');
	}
}

function ensureNetworkExists(sectionId) {
	if (!uci.sections('network', 'interface').find(s => s['.name'] === sectionId)) {
		uci.add('network', 'interface', sectionId);
	}

	getOrCreateZone(sectionId);
}

return baseclass.extend({
	getZoneForNetwork,
	getOrCreateZone,
	createDhcp,
	getOrCreateDnsmasq,
	getOrCreateDhcp,
	useBridgeIfNeeded,
	forceBridge,
	getEthNetwork,
	getNetworkDevices,
	setNetworkDevices,
	getNetworkWifiIfaces,
	getOrCreateForwarding,
	setupNetworkWithDnsmasq,
	ensureNetworkExists,
});
