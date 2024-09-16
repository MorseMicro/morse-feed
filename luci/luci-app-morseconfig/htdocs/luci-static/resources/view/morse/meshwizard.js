'use strict';

/* globals form morseuci morseui uci widgets wizard */
'require form';
'require uci';
'require tools.widgets as widgets';
'require tools.morse.wizard as wizard';
'require tools.morse.morseui as morseui';
'require tools.morse.uci as morseuci';

return wizard.AbstractWizardView.extend({
	__init__(/* ... */) {
		return this.super('__init__', this.varargs(arguments, 1,
			_('802.11s Mesh Wizard'),
			_(`<p>This wizard will guide you in setting up this device as part of an 802.11s mesh.
				<p>You can exit now if you prefer to complete your configuration manually.</p>`),
			'morse-config-diagram',
			new form.Map('wireless')));
	},

	getExtraConfigFiles() {
		return ['mesh11sd'];
	},

	loadWizardOptions() {
		const {
			wifiDeviceName,
			morseInterfaceName,
			wifiStaInterfaceName,
			ethInterfaceName,
		} = wizard.readSectionInfo();

		const ahwlanZone = morseuci.getZoneForNetwork('ahwlan');
		const lanZone = morseuci.getZoneForNetwork('lan');
		const forwardsLanToAhwlan = uci.sections('firewall', 'forwarding').some(f => f.src === lanZone && f.dest === ahwlanZone && f.enabled !== '0');
		const forwardsAhwlanToLan = uci.sections('firewall', 'forwarding').some(f => f.src === ahwlanZone && f.dest === lanZone && f.enabled !== '0');

		// If we weren't a mesh gate, force choice again.
		const getUplink = () => {
			if (uci.get('wireless', morseInterfaceName, 'mode') !== 'mesh') {
				return undefined;
			} else if (uci.get('mesh11sd', 'mesh_params', 'mesh_gate_announcements') !== '1') {
				return undefined;
			} else if (wifiDeviceName && uci.get('wireless', wifiStaInterfaceName, 'disabled') !== '1') {
				return 'wifi';
			} else if (
				ethInterfaceName === 'lan' && uci.get('wireless', morseInterfaceName, 'network') === 'ahwlan'
				&& uci.get('network', 'lan', 'proto') === 'static'
				&& forwardsAhwlanToLan
			) {
				return 'ethernet';
			} else if (ethInterfaceName === uci.get('wireless', morseInterfaceName, 'network')) {
				return 'ethernet';
			} else {
				return 'none';
			}
		};

		// If we weren't a mesh gate or our uplink wasn't ethernet, force choice again.
		const getDeviceModeMeshGate = () => {
			if (getUplink() === 'ethernet') {
				if (ethInterfaceName === uci.get('wireless', morseInterfaceName, 'network')) {
					return 'bridge';
				} else {
					return 'router';
				}
			} else {
				return undefined;
			}
		};

		// If we weren't a mesh point, force choice again.
		const getDeviceModeMeshPoint = () => {
			if (uci.get('wireless', morseInterfaceName, 'mode') !== 'mesh') {
				return undefined;
			} else if (uci.get('mesh11sd', 'mesh_params', 'mesh_gate_announcements') !== '0') {
				return undefined;
			} else if (ethInterfaceName === 'lan') {
				return forwardsLanToAhwlan ? 'extender' : 'none';
			} else {
				return 'bridge';
			}
		};

		uci.add('network', 'wizard', 'wizard');
		uci.set('network', 'wizard', 'device_mode_meshgate', getDeviceModeMeshGate());
		uci.set('network', 'wizard', 'device_mode_meshpoint', getDeviceModeMeshPoint());
		uci.set('network', 'wizard', 'uplink', getUplink());
	},

	/* Handle complex config here. Basic wifi setup is covered by the usual UCI actions.
	 * We pass this through to morseconf.js so our 'complex' setup is shared.
	 * Like the standard OpenWrt parse, this _also_ does uci.set
	 * (but does not uci.save).
	 */
	parseWizardOptions() {
		// Clear out any network stuff we've created from alternative sets of options
		// so we don't have to consider as many alternative cases.
		wizard.resetUciNetworkTopology();

		const {
			wifiDeviceName,
			morseInterfaceName,
			morseMeshApInterfaceName,
			wifiApInterfaceName,
			wifiStaInterfaceName,
			lanIp,
			wlanIp,
		} = wizard.readSectionInfo();

		morseuci.ensureNetworkExists('lan');
		morseuci.ensureNetworkExists('ahwlan');

		// Extract values then remove from dummy uci section.
		const device_mode_meshgate = uci.get('network', 'wizard', 'device_mode_meshgate');
		const device_mode_meshpoint = uci.get('network', 'wizard', 'device_mode_meshpoint');
		const uplink = uci.get('network', 'wizard', 'uplink');

		const isWifiAp = wifiDeviceName && uci.get('wireless', wifiApInterfaceName, 'disabled') !== '1';

		let isMeshGate = uci.get('mesh11sd', 'mesh_params', 'mesh_gate_announcements') === '1';
		let isMeshAp = uci.get('wireless', morseMeshApInterfaceName, 'disabled') !== '1';

		if (wifiDeviceName) {
			// We don't have an explicit option for this, but it's determined by uplink.
			// And because uplink is a complex option that's not valid for clients and is resolved here...
			uci.set('wireless', wifiStaInterfaceName, 'disabled', uplink === 'wifi' ? '0' : '1');
		}

		uci.set('wireless', morseInterfaceName, 'mode', 'mesh');
		uci.set('wireless', morseInterfaceName, 'encryption', 'sae');
		uci.set('wireless', morseInterfaceName, 'beacon_int', '1000');

		const bridgeMode = () => {
			morseuci.setNetworkDevices('ahwlan', this.getEthernetPorts().map(p => p.device));
			uci.set('wireless', morseInterfaceName, 'network', 'ahwlan');
			uci.set('wireless', morseInterfaceName, 'wds', '1');
			uci.set('camera-onvif-server', 'interface', 'ahwlan');

			if (isMeshAp) {
				uci.set('wireless', morseMeshApInterfaceName, 'network', 'ahwlan');
				uci.set('wireless', morseMeshApInterfaceName, 'wds', '1');
			}

			if (isWifiAp) {
				uci.set('wireless', wifiApInterfaceName, 'network', 'ahwlan');
			}

			morseuci.useBridgeIfNeeded('ahwlan');

			return 'ahwlan';
		};

		// i.e. lan = eth, ahwlan = halow
		const nonBridgeMode = () => {
			morseuci.setNetworkDevices('lan', this.getEthernetPorts().map(p => p.device));
			uci.set('wireless', morseInterfaceName, 'network', 'ahwlan');
			uci.set('camera-onvif-server', 'interface', 'ahwlan');

			// Unlike the 'normal' wizard, if we're a mesh gate
			// NOT bridging ethernet/mesh we still bridge the APs.
			if (isMeshAp) {
				uci.set('wireless', morseMeshApInterfaceName, 'network', 'ahwlan');
				uci.set('wireless', morseMeshApInterfaceName, 'wds', '1');
			}

			if (isWifiAp) {
				// TODO: IMO this should be ahwlan.
				uci.set('wireless', wifiApInterfaceName, 'network', 'lan');
			}

			morseuci.useBridgeIfNeeded('lan');
			morseuci.useBridgeIfNeeded('ahwlan');

			return { ethIface: 'lan', halowIface: 'ahwlan' };
		};

		// Set 'bridge/ip/gateway' etc. via uci,
		// based on the selected uplink and traffic mode
		this.ethIp = null;
		if (isMeshGate) {
			if (uplink === 'ethernet' && device_mode_meshgate === 'router') {
				const { ethIface, halowIface } = nonBridgeMode();

				uci.set('network', ethIface, 'proto', 'dhcp');
				morseuci.setupNetworkWithDnsmasq(halowIface, wlanIp);
				morseuci.getOrCreateForwarding(halowIface, ethIface, 'mmrouter');
			} else if (uplink === 'none') {
				const { ethIface, halowIface } = nonBridgeMode();

				// This is a weird overload of the var name
				morseuci.setupNetworkWithDnsmasq(ethIface, lanIp, false);
				morseuci.setupNetworkWithDnsmasq(halowIface, wlanIp, false);

				this.ethIp = lanIp;
			} else if (uplink === 'ethernet' && device_mode_meshgate === 'bridge') {
				const iface = bridgeMode();

				uci.set('network', iface, 'proto', 'dhcp');

				this.ethIp = wlanIp;
			} else if (uplink === 'wifi') {
				const iface = bridgeMode();

				morseuci.ensureNetworkExists('wifi24lan');
				uci.set('network', 'wifi24lan', 'proto', 'dhcp');
				uci.set('wireless', wifiStaInterfaceName, 'network', 'wifi24lan');
				morseuci.setupNetworkWithDnsmasq(iface, wlanIp);
				morseuci.getOrCreateForwarding(iface, 'wifi24lan', 'wifi24forward');

				this.ethIp = wlanIp;
			}
		} else {
			if (device_mode_meshpoint === 'extender') { // i.e. router
				const { ethIface, halowIface } = nonBridgeMode();

				uci.set('network', halowIface, 'proto', 'dhcp');
				morseuci.setupNetworkWithDnsmasq(ethIface, lanIp);
				morseuci.getOrCreateForwarding(ethIface, halowIface, 'mmextender');

				this.ethIp = lanIp;
			} else if (device_mode_meshpoint === 'none') {
				const { ethIface, halowIface } = nonBridgeMode();

				uci.set('network', halowIface, 'proto', 'dhcp');
				morseuci.setupNetworkWithDnsmasq(ethIface, lanIp, false);

				this.ethIp = lanIp;
			} else if (device_mode_meshpoint === 'bridge') {
				uci.set('wireless', morseInterfaceName, 'wds', '1');
				const iface = bridgeMode();

				uci.set('network', iface, 'proto', 'dhcp');
			}
		}
	},

	renderPages() {
		let page, option;

		const map = this.map;
		const {
			morseDeviceName,
			wifiDeviceName,
			morseInterfaceName,
			morseMeshApInterfaceName,
			wifiApInterfaceName,
			wifiStaInterfaceName,
		} = wizard.readSectionInfo();

		uci.unset('wireless', morseInterfaceName, 'disabled');

		if (wifiDeviceName) {
			uci.set('wireless', wifiApInterfaceName, 'device', wifiDeviceName);
			uci.set('wireless', wifiApInterfaceName, 'mode', 'ap');

			if (!uci.get('wireless', wifiStaInterfaceName)) {
				uci.add('wireless', 'wifi-iface', wifiStaInterfaceName);
			}
			uci.set('wireless', wifiStaInterfaceName, 'device', wifiDeviceName);
			uci.set('wireless', wifiStaInterfaceName, 'mode', 'sta');
		}

		// Create a morse AP config section for mesh gate configuration
		if (!uci.get('wireless', morseMeshApInterfaceName)) {
			uci.add('wireless', 'wifi-iface', morseMeshApInterfaceName);
		}
		uci.set('wireless', morseMeshApInterfaceName, 'device', morseDeviceName);
		uci.set('wireless', morseMeshApInterfaceName, 'mode', 'ap');
		uci.set('wireless', morseMeshApInterfaceName, 'disabled', '1');

		// Set morseinterface mode to mesh
		uci.set('wireless', morseInterfaceName, 'mode', 'mesh');
		// Set interface name to mesh0 as mesh11sd expects mesh iface name to be mesh*
		uci.set('wireless', morseInterfaceName, 'ifname', 'mesh0');

		const morseDeviceSection = map.section(form.NamedSection, morseDeviceName, 'wifi-device');
		const morseMeshInterfaceSection = map.section(form.NamedSection, morseInterfaceName, 'wifi-interface');
		const morseApInterfaceSection = map.section(form.NamedSection, morseMeshApInterfaceName, 'wifi-interface');
		const wifiApInterfaceSection = map.section(form.NamedSection, wifiApInterfaceName, 'wifi-interface');
		const meshParamsConfigSection = map.section(form.NamedSection, 'mesh_params', 'mesh11sd');
		meshParamsConfigSection.uciconfig = 'mesh11sd';
		// We put the network configuration in its own dummy section inside wireless.
		//
		// This means:
		//  - our dependencies work properly
		//  - the different map doesn't constrain our ui order
		//
		// All .load functions are overridden to figure it out based on the underlying
		// option values. In handleSave, we remove this section and only persist the related
		// options.
		const networkSection = map.section(form.NamedSection, 'wizard', 'wizard');
		networkSection.uciconfig = 'network';

		// Keeping a reference to the current AbstractWizardView for use in callbacks
		const thisWizardView = this;

		/*****************************************************************************/

		page = this.page(meshParamsConfigSection,
			'', _(`You can configure your device as a <b>Mesh Point</b> or a <b>Mesh Gate</b>, which is a Mesh Point with a co-located non-mesh network (e.g. an AP, an upstream Ethernet connection, etc.).`));

		const meshGateModeText = _(`An 802.11s <b>Mesh Gate</b> provides both a Mesh Point and a co-located non-mesh network (e.g. an AP, an upstream Ethernet connection, etc.). It broadcasts mesh gate announcements to help align the mesh nodes, making it easier for traffic to reach the non-mesh network.`);
		const meshStaModeText = _(`An 802.11s <b>Mesh Point</b> is a node in an 802.11s mesh network.`);

		page.enableDiagram({
			extras: ['GATE_SELECT_FILL', 'POINT_SELECT_FILL'],
			blacklist: [
				'GATE_UPLINK', 'GATE_UPLINK_WIFI24', 'GATE_MGMT_ETH', 'GATE_UPLINK_ETH', 'GATE_WIFI24', 'GATE_HALOW_MESH_INT', 'GATE_HALOW_AP',
				'POINT_HALOW_INT', 'POINT_MGMT_ETH', 'POINT_WIFI24',
			],
		});

		option = page.option(form.ListValue, 'mesh_gate_announcements');
		option.displayname = _('Mesh Mode');
		option.widget = 'radio';
		option.orientation = 'vertical';
		option.value('0', _('Mesh Point'));
		option.value('1', _('Mesh Gate (Mesh Point with collocated network)'));
		option.rmempty = false;
		option.onchange = function (ev, sectionId, value) {
			if (value == '1') {
				this.page.updateInfoText(meshGateModeText, thisWizardView);
			} else if (value == '0') {
				this.page.updateInfoText(meshStaModeText, thisWizardView);
			}
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		/*****************************************************************************/

		page = this.page(morseMeshInterfaceSection,
			_('Setup Mesh Network'),
			_(`All devices in the mesh must have the same <b>Mesh ID</b>, which is a arbitrary string that identifies the mesh similar to an SSID.`));
		page.enableDiagram({
			extras: ['POINT_HALOW_INT_SELECT', 'GATE_HALOW_MESH_INT_SELECT', 'POINT_HALOW_INT_SELECT_FILL', 'GATE_HALOW_MESH_INT_SELECT_FILL'],
			blacklist: [
				'GATE_UPLINK', 'GATE_UPLINK_WIFI24', 'GATE_MGMT_ETH', 'GATE_UPLINK_ETH', 'GATE_WIFI24', 'GATE_HALOW_AP',
				'POINT_MGMT_ETH', 'POINT_WIFI24',
				'POINT_HALOW_INT:SSID', 'POINT_HALOW_INT:IP', 'POINT_HALOW_INT:IPMethod',
				'GATE_HALOW_MESH_INT:SSID', 'GATE_HALOW_MESH_INT:IP', 'GATE_HALOW_MESH_INT:IPMethod',
			],
		});

		option = page.option(form.Value, 'mesh_id', _('Mesh ID'));
		option.datatype = 'maxlength(32)';
		option.rmempty = false;
		option.retain = true;
		option.onchange = function () {
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		option = page.option(form.Value, 'key', _('Mesh Passphrase'));
		option.datatype = 'wpakey';
		option.write = function (sectionId, value) {
			this.map.data.set(this.map.config, sectionId, 'encryption', 'sae');
			this.super('write', [sectionId, value]);
		};
		option.password = true;
		option.rmempty = false;
		option.retain = true;

		option = page.option(widgets.WifiFrequencyValue, '_freq', '<br />' + _('Operating Frequency'));
		option.ucisection = morseDeviceName;
		option.rmempty = false;
		option.retain = true;

		/*****************************************************************************/

		// Device mode for Mesh Point only.
		// i.e. if we're a Mesh Point, we call it an 'extender'.
		// This echoes the usual AP/STA terminology.
		page = this.page(networkSection,
			_('Traffic Mode'),
			_(`We recommend configuring this device as a <b>Bridge</b>.
				This allows non-HaLow devices to obtain IPs over your HaLow link.

				<p>To create a separate network for the HaLow and the non-HaLow devices select <b>Extender</b>.
				In which case, this device will run a DHCP server on the non-HaLow interfaces, and
				it will use NAT to forward IP traffic between HaLow and non-HaLow networks.

				<p>Choose <b>None</b> to keep the HaLow and non-HaLow networks isolated,
				this is the mode the device uses after factory reset.`));
		var noneInfoSta = _(`In <b>None</b> traffic mode, non-HaLow and HaLow networks are isolated.
			This device will use a static IP address and run a DHCP server on the non-HaLow interface.`);
		var bridgeInfoSta = _(`In <b>Bridged</b> traffic mode, non-HaLow devices obtain IPs from your HaLow link.`);
		var extenderInfoSta = _(`In <b>Extender</b> traffic mode, non-HaLow devices obtain IPs from the DHCP server
			on this device and this device uses NAT to forward IP traffic.`);

		page.enableDiagram({
			extras: [
				'POINT_HALOW_INT_SELECT', 'POINT_HALOW_INT_SELECT_FILL',
				'POINT_MGMT_ETH_INT_SELECT', 'POINT_MGMT_ETH_INT_SELECT_FILL',
			],
			blacklist: [
				'POINT_WIFI24',
			],
		});

		option = page.option(form.ListValue, 'device_mode_meshpoint');
		option.displayname = _('Traffic mode');
		option.depends(`mesh11sd.mesh_params.mesh_gate_announcements`, '0');
		option.rmempty = false;
		option.retain = true;
		option.widget = 'radio';
		option.orientation = 'vertical';
		option.value('none', _('None'));
		option.value('bridge', _('Bridge'));
		option.value('extender', _('Extender'));
		option.onchange = function (ev, sectionId, value) {
			if (value == 'bridge') {
				this.page.updateInfoText(bridgeInfoSta, thisWizardView);
			} else if (value == 'extender') {
				this.page.updateInfoText(extenderInfoSta, thisWizardView);
			} else if (value == 'none') {
				this.page.updateInfoText(noneInfoSta, thisWizardView);
			}
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		/*****************************************************************************/

		var ethInfoAp = _(`If you use an <b>Ethernet</b> upstream, we recommend choosing <b>Bridge</b>.
			This allows HaLow connected devices to obtain IPs from your Ethernet network.`);
		var wifiInfoAp = _(`If you use a <b>Wi-Fi</b> upstream, fill in the Wi-Fi AP credentials.
			The HaLow connected devices obtain IP addresses from the DHCP server on this device,
			and this device uses NAT to forward IP traffic.`);
		var noneInfoAp = _(`In <b>None</b> mode, your device will have a static IP address and run a
			DHCP server on all interfaces, the HaLow and non-HaLow networks will be isolated from each other.`);
		var bridgeInfoAp = _(`In <b>Bridge</b> mode this device and the HaLow connected devices obtain IP addresses from
			your current upstream network.`);
		var routerInfoAp = _(`In <b>Router</b> mode the HaLow connected devices obtain IP addresses from
			the DHCP server on this device, and this device uses NAT to forward IP traffic.`);

		page = this.page(networkSection,
			_('Upstream Network'),
			_(`You are using this HaLow device as a mesh gate, you should configure how it
			connects to the internet (or some other network).
			<p>
			If you choose <b>None</b>, your device will have a static IP address and run a DHCP server on all interfaces,
			the HaLow and non-HaLow networks will be isolated from each other.
			If you choose an upstream network, your HaLow and non-HaLow networks will be connected.
			</p>`));
		page.enableDiagram({
			extras: [
				'GATE_MGMT_ETH_INT_SELECT', 'GATE_MGMT_ETH_INT_SELECT_FILL',
				'GATE_UPLINK_ETH_INT_SELECT', 'GATE_UPLINK_ETH_INT_SELECT_FILL',
				'GATE_HALOW_MESH_INT_SELECT', 'GATE_HALOW_MESH_INT_SELECT_FILL',
				'GATE_UPLINK_WIFI24_INT_SELECT', 'GATE_UPLINK_WIFI24_INT_SELECT_FILL'],
			blacklist: ['GATE_WIFI24', 'GATE_HALOW_AP'],
		});

		option = page.option(form.ListValue, 'uplink');
		option.displayname = _('Upstream network');
		option.depends(`mesh11sd.mesh_params.mesh_gate_announcements`, '1');
		option.rmempty = false;
		option.widget = 'radio';
		option.orientation = 'vertical';
		option.value('none', _('None'));
		option.value('ethernet', _('Ethernet'));
		if (wifiDeviceName) {
			option.value('wifi', _('Wi-Fi (2.4 GHz)'));
		}
		option.onchange = function (ev, sectionId, value) {
			if (value == 'ethernet') {
				this.page.updateInfoText(ethInfoAp, thisWizardView);
			} else if (value == 'wifi') {
				this.page.updateInfoText(wifiInfoAp, thisWizardView);
			} else if (value == 'none') {
				this.page.updateInfoText(noneInfoAp, thisWizardView);
			}
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		if (wifiDeviceName) {
			let encryptionBySSID = {};
			const uplink_ssid = option = page.option(morseui.EditableList, 'uplink_ssid', _('<abbr title="Service Set Identifier">SSID</abbr>'));
			// Have to be explicit here because we change uciconfig/section/option.
			option.depends('network.wizard.uplink', 'wifi');
			option.uciconfig = 'wireless';
			option.ucisection = wifiStaInterfaceName;
			option.ucioption = 'ssid';
			option.datatype = 'maxlength(32)';
			option.retain = true;
			option.rmempty = false;
			option.btnText = _('Scan');
			option.onclick = async () => {
				encryptionBySSID = await this.doScan(wifiDeviceName, 'Master', uplink_ssid);
				const ssids = Object.keys(encryptionBySSID);

				const element = uplink_ssid.getUIElement(uplink_ssid.section.section);
				element.clearChoices();
				if (ssids.length > 0) {
					element.addChoices(ssids);
					element.setValue(ssids[0]);
				}
			};
			option.onchange = function (ev, sectionId, value) {
				thisWizardView.onchangeOptionUpdateDiagram(this);
				if (encryptionBySSID[value]) {
					encryption.getUIElement(sectionId).setValue(encryptionBySSID[value]);
				}
			};

			// 2.4 Credentials are one of the few things we don't want to retain,
			// as users might be putting more sensitive creds here
			// (i.e. if you disable, this should disappear).
			const encryption = option = page.option(form.ListValue, 'uplink_encryption', _('Encryption'));
			option.uciconfig = 'wireless';
			option.ucisection = wifiStaInterfaceName;
			option.ucioption = 'encryption';
			option.depends('network.wizard.uplink', 'wifi');
			option.value('psk2', _('WPA2-PSK'));
			option.value('psk', _('WPA-PSK'));
			option.value('sae', _('WPA3-SAE'));
			option.value('none', _('None'));

			option = page.option(form.Value, 'uplink_key', _('Passphrase'));
			// Have to be explicit here because we change uciconfig/section/option.
			option.depends('wireless.wizard.uplink_encryption', 'psk');
			option.depends('wireless.wizard.uplink_encryption', 'psk2');
			option.depends('wireless.wizard.uplink_encryption', 'sae');
			option.uciconfig = 'wireless';
			option.ucisection = wifiStaInterfaceName;
			option.ucioption = 'key';
			option.datatype = 'wpakey';
			option.password = true;
		}

		option = page.heading(_('Traffic Mode'));
		option.depends({ uplink: 'ethernet' });

		option = page.option(form.ListValue, 'device_mode_meshgate');
		option.displayname = _('Bridge/Router');
		option.depends({ uplink: 'ethernet' });
		option.rmempty = false;
		option.retain = true;
		option.widget = 'radio';
		option.orientation = 'vertical';
		option.value('bridge', _('Bridge'));
		option.value('router', _('Router'));
		option.onchange = function (ev, sectionId, value) {
			if (value == 'bridge') {
				this.page.updateInfoText(bridgeInfoAp, thisWizardView);
			} else if (value == 'router') {
				this.page.updateInfoText(routerInfoAp, thisWizardView);
			}
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		/*****************************************************************************/

		page = this.page(morseApInterfaceSection,
			_('HaLow Wi-Fi Access Point'),
			_(`Enable an <b>Access Point</b> (AP) to let non-mesh HaLow devices connect to the network.
			This interface will be bridged with the mesh interface.`));
		page.enableDiagram({
			extras: ['GATE_HALOW_AP_INT_SELECT', 'GATE_HALOW_AP_INT_SELECT_FILL', 'POINT_HALOW_AP_INT_SELECT', 'POINT_HALOW_AP_INT_SELECT_FILL'],
			blacklist: ['GATE_WIFI24', 'POINT_WIFI24'],
		});

		option = page.option(morseui.Slider, 'disabled', _('Enable Access Point'));
		option.enabled = '0';
		option.disabled = '1';
		option.default = '1';
		option.rmempty = false;
		option.retain = true;
		option.onchange = function () {
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		option = page.option(form.Value, 'ssid', _('SSID'));
		option.rmempty = false;
		option.retain = true;
		option.depends('disabled', '0');
		option.datatype = 'maxlength(32)';
		option.onchange = function () {
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		option = page.option(form.Value, 'key', _('Passphrase'));
		option.depends('disabled', '0');
		option.datatype = 'wpakey';
		option.password = true;
		option.rmempty = false;
		option.retain = true;
		option.write = function (sectionId, value) {
			this.map.data.set(this.map.config, sectionId, 'encryption', 'sae');
			this.super('write', [sectionId, value]);
		};

		/*****************************************************************************/

		if (wifiDeviceName) {
			page = this.page(wifiApInterfaceSection,
				_('2.4 GHz Wi-Fi Access Point'),
				_(`This HaLow device is also capable of 2.4 GHz Wi-Fi.
				If you enable a 2.4 GHz Wi-Fi <b>Access Point</b>, you will be able to
				connect non-HaLow Wi-Fi clients to this device.`));
			page.enableDiagram({
				extras: ['GATE_WIFI24_INT_SELECT', 'GATE_WIFI24_INT_SELECT_FILL',
				         'POINT_WIFI24_INT_SELECT', 'POINT_WIFI24_INT_SELECT_FILL'],
			});

			option = page.option(morseui.Slider, 'disabled', _('Enable Access Point'));
			option.enabled = '0';
			option.disabled = '1';
			option.default = '0';
			option.onchange = function () {
				thisWizardView.onchangeOptionUpdateDiagram(this);
			};

			option = page.option(form.Value, 'ssid', _('<abbr title="Service Set Identifier">SSID</abbr>'));
			option.datatype = 'maxlength(32)';
			option.retain = true;
			option.rmempty = false;
			option.depends('disabled', '0');
			option.onchange = function () {
				thisWizardView.onchangeOptionUpdateDiagram(this);
			};

			option = page.option(form.Value, 'key', _('Passphrase'));
			option.datatype = 'wpakey';
			option.password = true;
			option.retain = true;
			option.rmempty = false;
			option.depends('disabled', '0');

			option = page.option(form.ListValue, 'encryption', _('Encryption'));
			option.value('psk2', _('WPA2-PSK'));
			option.value('psk', _('WPA-PSK'));
			option.value('sae', _('WPA3-SAE'));
			option.depends('disabled', '0');
		}

		/*****************************************************************************/

		// We don't actually modify morseInterfaceSection here, but it makes it easier
		// to get to our most common dependencies.
		page = this.page(morseMeshInterfaceSection,
			_('Almost there...'),
			_(`Click <b>Apply</b> to persist your configuration.`));
		// This last page should always be active, as otherwise when initial config is happening
		// none of the options are visible and it's treated as inactive.
		page.isActive = () => true;
		page.enableDiagram();

		// Warn users if ethernet is not going to work (mostly trying to catch initial setup via 10.42.0.1,
		// though if they're connected in some other way this is still accurate).
		option = page.message(_(`
			To access this admin interface after clicking <b>Apply</b>, you will need to find
			the IP address allocated by your network's DHCP server. If you lose access,
			see the <a target="_blank" href="%s">User Guide</a> for reset instructions.
		`).format(L.url('admin', 'help', 'guide')));
		option.depends('network.wizard.uplink', 'ethernet');
		option.depends('network.wizard.device_mode_meshpoint', 'bridge');

		if (wifiDeviceName) {
			option = page.step(_(`
				Connect another device via <b>2.4 GHz Wi-Fi</b> to use your new HaLow link.
			`));
			option.depends({ mode: 'sta', [`wireless.${wifiApInterfaceName}.disabled`]: '0' });
		}

		// AP steps
		//
		option = page.step(_(`
			Connect this device to your existing network via an Ethernet cable.
		`));
		option.depends('network.wizard.uplink', 'ethernet');

		if (wifiDeviceName) {
			option = page.step(_(`
				Connect 2.4 GHz devices to your network.
			`));
			option.depends({ mode: 'ap', [`wireless.${wifiApInterfaceName}.disabled`]: '0' });
		}

		option = page.step(_(`
			Connect Ethernet devices to your network.
		`));
		option.depends('network.wizard.uplink', 'wifi');
		option.depends('network.wizard.uplink', 'none');

		option = page.step(_(`For advanced 802.11s mesh settings, you can navigate to Network->Wireless page once you exit the wizard`));
		option = page.step(_(`You can enable B.A.T.M.A.N for 802.11s mesh from the advanced 802.11s mesh settings`));

		/*****************************************************************************/

		page = this.page(morseDeviceSection, '');

		// This last page should always be active, as otherwise when initial config is happening
		// none of the options are visible and it's treated as inactive.
		page.isActive = () => true;
		const completion
			= E('span', { class: 'completion' }, [
				E('h1', _('Wizard Complete')),
				E('p', _('Click below to exit the wizard')),
			]);

		option = page.html(completion);

		return map.render();
	},

	updateChannelOptions(country, bandwidth) {
		this.channelOption.clear();
		for (const channel of this.countryChannels[country][bandwidth]) {
			this.channelOption.value(channel.s1g_chan, `${channel.s1g_chan} (${channel.centre_freq_mhz} MHz)`);
		}
	},
});
