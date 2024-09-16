'use strict';

/* globals form morseuci morseui uci widgets wizard */
'require form';
'require uci';
'require tools.widgets as widgets';
'require tools.morse.wizard as wizard';
'require tools.morse.uci as morseuci';
'require tools.morse.morseui as morseui';

const DPP_QRCODE_PATH = '/dpp_qrcode.svg';

return wizard.AbstractWizardView.extend({
	__init__(/* ... */) {
		return this.super('__init__', this.varargs(arguments, 1,
			_('WiFi HaLow Wizard'),
			_(`<p>This wizard will guide you in setting up your device as a simple <b>Client</b> or <b>Access Point</b>.
				<p>You can exit now if you prefer to complete your configuration manually.</p>`),
			'morse-config-diagram',
			new form.Map('wireless')));
	},

	/* Populate the network.wizard section with calculated values.
	 * These values are removed when saving (i.e. not persisted), but
	 * having them present makes diagram and wizard operations easier.
	 */
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

		// If we weren't an AP, force choice again.
		const getUplink = () => {
			if (uci.get('wireless', morseInterfaceName, 'mode') !== 'ap') {
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

		const getDeviceModeAp = () => {
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

		// If we weren't a sta, force choice again.
		const getDeviceModeSta = () => {
			if (uci.get('wireless', morseInterfaceName, 'mode') !== 'sta') {
				return undefined;
			} else if (ethInterfaceName === 'lan') {
				return forwardsLanToAhwlan ? 'extender' : 'none';
			} else {
				return 'bridge';
			}
		};

		uci.add('network', 'wizard', 'wizard');
		uci.set('network', 'wizard', 'device_mode_ap', getDeviceModeAp());
		uci.set('network', 'wizard', 'device_mode_sta', getDeviceModeSta());
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
			wifiApInterfaceName,
			wifiStaInterfaceName,
			lanIp,
			wlanIp,
		} = wizard.readSectionInfo();

		morseuci.ensureNetworkExists('lan');
		morseuci.ensureNetworkExists('ahwlan');

		// Extract values then remove from dummy uci section.
		const device_mode_ap = uci.get('network', 'wizard', 'device_mode_ap');
		const device_mode_sta = uci.get('network', 'wizard', 'device_mode_sta');
		const uplink = uci.get('network', 'wizard', 'uplink');

		const mode = uci.get('wireless', morseInterfaceName, 'mode');
		const isWifiAp = wifiDeviceName && uci.get('wireless', wifiApInterfaceName, 'disabled') !== '1';

		if (wifiDeviceName) {
			// We don't have an explicit option for this, but it's determined by uplink.
			// And because uplink is a complex option that's not valid for clients and is resolved here...
			uci.set('wireless', wifiStaInterfaceName, 'disabled', uplink === 'wifi' ? '0' : '1');
		}

		// Wizard only supports SAE for simplicity (less choice for user).
		uci.set('wireless', morseInterfaceName, 'encryption', 'sae');

		const bridgeMode = () => {
			morseuci.setNetworkDevices('ahwlan', this.getEthernetPorts().map(p => p.device));
			uci.set('wireless', morseInterfaceName, 'network', 'ahwlan');
			uci.set('camera-onvif-server', 'interface', 'ahwlan');

			if (isWifiAp) {
				uci.set('wireless', wifiApInterfaceName, 'network', 'ahwlan');
			}

			morseuci.useBridgeIfNeeded('ahwlan');

			return 'ahwlan';
		};

		const nonBridgeMode = () => {
			morseuci.setNetworkDevices('lan', this.getEthernetPorts().map(p => p.device));
			uci.set('wireless', morseInterfaceName, 'network', 'ahwlan');
			uci.set('camera-onvif-server', 'interface', 'ahwlan');

			if (isWifiAp) {
				uci.set('wireless', wifiApInterfaceName, 'network', 'lan');
			}

			morseuci.useBridgeIfNeeded('lan');
			morseuci.useBridgeIfNeeded('ahwlan');

			return { ethIface: 'lan', halowIface: 'ahwlan' };
		};

		this.ethIp = null;
		if (mode === 'ap') {
			// If we're an AP, we should have WDS on regardless as we can't predict
			// when a STA using WDS will connect to us.
			uci.set('wireless', morseInterfaceName, 'wds', '1');

			if (uplink === 'ethernet' && device_mode_ap === 'router') {
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
			} else if (uplink === 'ethernet' && device_mode_ap === 'bridge') {
				const iface = bridgeMode();

				uci.set('network', iface, 'proto', 'dhcp');
				this.ethIp = wlanIp;
			} else if (uplink === 'wifi') {
				// Confusingly, this is 'bridgeMode' even though
				// we forward between interfaces
				// (since we put both ethernet+halow on lan
				// but the wifi uplink is separate)
				const iface = bridgeMode();

				morseuci.ensureNetworkExists('wifi24lan');
				uci.set('network', 'wifi24lan', 'proto', 'dhcp');
				uci.set('wireless', wifiStaInterfaceName, 'network', 'wifi24lan');
				morseuci.setupNetworkWithDnsmasq(iface, wlanIp);
				morseuci.getOrCreateForwarding(iface, 'wifi24lan', 'wifi24forward');

				this.ethIp = wlanIp;
			}
		} else if (mode === 'sta') {
			if (device_mode_sta === 'extender') { // i.e. router
				const { ethIface, halowIface } = nonBridgeMode();

				uci.unset('wireless', morseInterfaceName, 'wds');
				uci.set('network', halowIface, 'proto', 'dhcp');
				morseuci.setupNetworkWithDnsmasq(ethIface, lanIp);
				morseuci.getOrCreateForwarding(ethIface, halowIface, 'mmextender');

				this.ethIp = lanIp;
			} else if (device_mode_sta === 'none') {
				const { ethIface, halowIface } = nonBridgeMode();

				uci.unset('wireless', morseInterfaceName, 'wds');
				uci.set('network', halowIface, 'proto', 'dhcp');
				morseuci.setupNetworkWithDnsmasq(ethIface, lanIp, false);

				this.ethIp = lanIp;
			} else if (device_mode_sta === 'bridge') {
				const iface = bridgeMode();

				uci.set('wireless', morseInterfaceName, 'wds', '1');
				uci.set('network', iface, 'proto', 'dhcp');
			}
		}
	},

	async loadPages() {
		const response = await fetch(DPP_QRCODE_PATH, { method: 'HEAD' });
		return [response.ok];
	},

	renderPages([hasQRCode]) {
		// The general policy here is to make as small a choice as possible on each page.
		//
		// Oddly, if you change this.uciconfig this affects the cbid
		// (BUT changing ucioption/ucisection doesn't). The implication is that you have
		// to be a bit careful specifying depends in certain situations.
		//
		// WARNING: it's important to use 'retain' a lot here, because in general
		// we don't want options from non-displayed pages wiped out.
		let page, option;

		const map = this.map;
		const {
			morseDeviceName,
			wifiDeviceName,
			morseInterfaceName,
			wifiApInterfaceName,
			wifiStaInterfaceName,
		} = wizard.readSectionInfo();

		uci.unset('wireless', morseInterfaceName, 'disabled');

		if (wifiDeviceName) {
			uci.set('wireless', wifiApInterfaceName, 'device', wifiDeviceName);
			uci.set('wireless', wifiStaInterfaceName, 'mode', 'ap');

			if (!uci.get('wireless', wifiStaInterfaceName)) {
				uci.add('wireless', 'wifi-iface', wifiStaInterfaceName);
			}
			uci.set('wireless', wifiStaInterfaceName, 'device', wifiDeviceName);
			uci.set('wireless', wifiStaInterfaceName, 'mode', 'sta');
		}

		const morseDeviceSection = map.section(form.NamedSection, morseDeviceName, 'wifi-device');
		const morseInterfaceSection = map.section(form.NamedSection, morseInterfaceName, 'wifi-interface');
		const wifiApInterfaceSection = map.section(form.NamedSection, wifiApInterfaceName, 'wifi-interface');
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

		page = this.page(morseInterfaceSection,
			'',
			_(`As with any Wi-Fi network, HaLow has <b>Clients</b> (also known as stations) which discover
				and connect to an <b>Access Point</b>. If you select client, non-HaLow devices can use
				the HaLow link by connecting to the other interfaces.`));

		var apModeText = _(`In <b>Access Point</b> mode, the device can accept connections from HaLow clients.`);
		var clientModeText = _(`In <b>Client</b> mode, the device discovers and connects to a HaLow access point (AP).`);

		page.enableDiagram({
			extras: ['AP_SELECT_FILL', 'STA_SELECT_FILL'],
			blacklist: ['AP_HALOW_INT',
			            'AP_MGMT_ETH', 'AP_UPLINK', 'AP_UPLINK_ETH', 'AP_UPLINK_WIFI24', 'AP_WIFI_24',
			            'STA_HALOW', 'STA_WIFI24', 'MESH_HALOW', 'STA_MGMT_ETH'],
		});

		option = page.option(form.ListValue, 'mode');
		option.displayname = _('Mode selection');
		option.widget = 'radio';
		option.orientation = 'vertical';
		option.value('ap', _('Access Point'));
		option.value('sta', _('Client'));
		option.rmempty = false;
		option.onchange = function (ev, sectionId, value) {
			if (value == 'ap') {
				this.page.updateInfoText(apModeText, thisWizardView);
			} else if (value == 'sta') {
				this.page.updateInfoText(clientModeText, thisWizardView);
			}
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		/*****************************************************************************/

		page = this.page(morseInterfaceSection,
			_('Setup HaLow Network - AP'),
			_(`Available <b>Bandwidths</b> and <b>Channels</b> differ greatly across regions. The higher
				your bandwidth, the greater the potential throughput of the connection.
				If you're deploying multiple HaLow access points you may want to select
				distinct channels and a lower bandwidth to reduce interference.`));
		page.enableDiagram({
			extras: ['AP_HALOW_INT_SELECT', 'AP_HALOW_INT_SELECT_FILL'],
			blacklist: ['AP_MGMT_ETH', 'AP_UPLINK', 'AP_UPLINK_ETH', 'AP_UPLINK_WIFI24', 'AP_WIFI_24',
			            'STA_HALOW_INT', 'AP_HALOW_INT:IP', 'AP_HALOW_INT:IPMethod'],
		});

		option = page.option(form.Value, 'ssid', _('<abbr title="Service Set Identifier">SSID</abbr>'));
		option.depends('mode', 'ap');
		option.datatype = 'maxlength(32)';
		option.rmempty = false;
		option.retain = true;
		option.onchange = function () {
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		option = page.option(form.Value, 'key', _('Passphrase'));
		option.depends('mode', 'ap');
		option.datatype = 'wpakey';
		option.password = true;
		option.rmempty = false;
		option.retain = true;

		option = page.option(widgets.WifiFrequencyValue, '_freq', '<br />' + _('Operating Frequency'));
		option.depends('mode', 'ap');
		option.ucisection = morseDeviceName;
		option.rmempty = false;
		option.retain = true;

		/*****************************************************************************/

		var manualCredInfo = _('Fill in the credentials to connect to a HaLow Access Point.');
		var dppCredInfo = _(`<b>DPP</b> (Device Provisioning Protocol) lets you scan a QR code to automatically
			connect to a HaLow access point.`);

		page = this.page(morseInterfaceSection,
			_('Connect to a HaLow Network'),
			manualCredInfo);

		page.enableDiagram({
			extras: ['STA_HALOW_INT_SELECT', 'STA_HALOW_INT_SELECT_FILL'],
			blacklist: ['STA_WIFI24', 'MESH_HALOW', 'STA_MGMT_ETH',
			            'STA_HALOW_INT:IP', 'STA_HALOW_INT:IPMethod'],
		});

		if (hasQRCode) {
			option = page.option(form.ListValue, 'dpp');
			option.displayname = _('Authentication method');
			option.depends('mode', 'sta');
			option.widget = 'radio';
			option.orientation = 'vertical';
			option.value('0', _('Manual credentials'));
			option.value('1', _('DPP (Device Provisioning Protocol) QR Code'));
			option.rmempty = false;
			option.retain = false;
			option.onchange = function (ev, sectionId, value) {
				if (value == '0') {
					this.page.updateInfoText(manualCredInfo, thisWizardView);
				} else if (value == '1') {
					this.page.updateInfoText(dppCredInfo, thisWizardView);
				}
				thisWizardView.onchangeOptionUpdateDiagram(this);
			};
		} else {
			option = page.option(form.HiddenValue, 'dpp');
			option.depends('mode', 'sta');
			option.load = () => '0';
			option.forcewrite = true;
		}

		// Because these options duplicate the options above, we have to
		// have distinct names.
		let ssid_option = option = page.option(morseui.EditableList, 'sta_ssid', _('<abbr title="Service Set Identifier">SSID</abbr>'));
		option.depends({ mode: 'sta', dpp: '0' });
		option.ucioption = 'ssid';
		option.btnText = _('Scan');
		option.rmempty = false;
		option.retain = true;
		option.onclick = async () => {
			let ssids = null;
			const element = ssid_option.getUIElement(ssid_option.section.section);
			if (document.getElementById('emptyScanMsg') != null)
				document.getElementById('emptyScanMsg').remove();

			for (let count = 1; count < 8; count++) {
				ssids = Object.keys(await this.doScan(morseDeviceName, 'Master', ssid_option));
				if (ssids.length > 0 || count == 7) break;
				await Promise.resolve(new Promise(resolve => window.setTimeout(resolve, count * 1000)));
			}

			if (ssids.length == 0 && document.getElementById('emptyScanMsg') == null) {
				const errorNode = element.node.closest('.cbi-value-field');
				const errorTxt = E('div', { class: 'alert-message error', id: 'emptyScanMsg', style: 'width: 275px' }, [
					E('p', {}, _('No Halow APs found.')),
				]);
				errorNode.append(errorTxt);
			}

			element.clearChoices();
			if (ssids.length > 0) {
				element.addChoices(ssids);
				element.setValue(ssids[0]);
			}
		};
		option.datatype = 'rangelength(1, 32)';
		option.onchange = function () {
			thisWizardView.onchangeOptionUpdateDiagram(this);
		};

		option = page.option(form.Value, 'sta_key', _('Passphrase'));
		option.depends({ mode: 'sta', dpp: '0' });
		option.ucioption = 'key';
		option.datatype = 'wpakey';
		option.password = true;
		option.rmempty = false;
		option.retain = true;

		/*****************************************************************************/

		// Device mode for client only.
		// i.e. if we're a router, we call it an 'extender'.
		page = this.page(networkSection,
			_('Traffic Mode'),
			_(`We recommend configuring this device as a <b>Bridge</b>.
				This allows non-HaLow devices to obtain IPs over your HaLow link.

				<p>However, if the HaLow Access Point you connect to does not have
				<abbr title="Wireless Distribution System">WDS</abbr> (aka 4 address mode) enabled,
				select <b>Extender</b> to create a separate network for the non-HaLow devices.
				<em>All HaLow access points configured via this wizard have WDS enabled.</em>
				This device will run a DHCP server on the non-HaLow interfaces, and
				it will use NAT to forward IP traffic between HaLow and non-HaLow networks.

				<p>Choose <b>None</b> to keep the HaLow and non-HaLow networks isolated,
				this is the mode the device uses after factory reset.`));
		var noneInfoSta = _(`In <b>None</b> traffic mode, non-HaLow and HaLow networks are isolated.
			This device will use a static IP address and run a DHCP server on the non-HaLow interface.`);
		var bridgeInfoSta = _('In <b>Bridged</b> traffic mode, non-HaLow devices obtain IPs from your HaLow link.');
		var extenderInfoSta = _(`In <b>Extender</b> traffic mode, non-HaLow devices obtain IPs from the DHCP server
			on this device and this device uses NAT to forward IP traffic.`);

		page.enableDiagram({
			extras: [
				'STA_HALOW_INT_SELECT', 'STA_HALOW_INT_SELECT_FILL',
				'STA_MGMT_ETH_INT_SELECT', 'STA_MGMT_ETH_INT_SELECT_FILL',
			],
			blacklist: ['MESH_HALOW', 'STA_WIFI24'],
		});

		option = page.option(form.ListValue, 'device_mode_sta');
		option.displayname = _('Traffic mode');
		option.depends(`wireless.${morseInterfaceName}.mode`, 'sta');
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
			_(`You are using this HaLow device as an access point, you should configure how it
			connects to the internet (or some other network).
			<p>
			If you choose <b>None</b>, your device will have a static IP address and run a DHCP server on all interfaces,
			the HaLow and non-HaLow networks will be isolated from each other.
			If you choose an upstream network, your HaLow and non-HaLow networks will be connected.
			<p>`));
		page.enableDiagram({
			extras: [
				'AP_MGMT_ETH_INT_SELECT', 'AP_MGMT_ETH_INT_SELECT_FILL',
				'AP_UPLINK_ETH_INT_SELECT', 'AP_UPLINK_ETH_INT_SELECT_FILL',
				'AP_UPLINK_WIFI24_INT_SELECT', 'AP_UPLINK_WIFI24_INT_SELECT_FILL',
				'AP_HALOW_INT_SELECT', 'AP_HALOW_INT_SELECT_FILL',
			],
			blacklist: ['STA_WIFI24', 'MESH_HALOW', 'STA_MGMT_ETH', 'AP_WIFI24'],
		});

		option = page.option(form.ListValue, 'uplink');
		option.displayname = _('Upstream network');
		option.depends(`wireless.${morseInterfaceName}.mode`, 'ap');
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

		option = page.option(form.ListValue, 'device_mode_ap');
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

		if (wifiDeviceName) {
			page = this.page(wifiApInterfaceSection,
				_('2.4 GHz Wi-Fi Access Point'),
				_(`This HaLow device is also capable of 2.4 GHz Wi-Fi.
				If you enable a 2.4 GHz Wi-Fi <b>Access Point</b>, you will be able to
				connect non-HaLow Wi-Fi clients to this device.`));
			page.enableDiagram({
				extras: ['STA_WIFI24_INT_SELECT', 'STA_WIFI24_INT_SELECT_FILL', 'AP_WIFI24_INT_SELECT', 'AP_WIFI24_INT_SELECT_FILL'],
				blacklist: ['MESH_HALOW'],
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
		page = this.page(morseInterfaceSection,
			_('Almost there...'),
			_('Click <b>Apply</b> to persist your configuration.'));
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
		option.depends('network.wizard.device_mode_sta', 'bridge');

		// Client steps
		//
		const html = [
			_(`Connect this device to your HaLow access point by scanning the QR code
				in the mobile application, then clicking `),
			E('strong', 'Apply.'),
			E('br'),
			E('img', { src: DPP_QRCODE_PATH }),
		];
		option = page.step(html);
		option.depends('dpp', '1');

		option = page.step(_(`
			Connect another device via <b>Ethernet</b> to use your new HaLow link.
		`));
		option.depends('mode', 'sta');

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

		option = page.step(_(`
			Connect other HaLow-enabled devices to use your new HaLow network.
		`));
		option.depends('mode', 'ap');

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
});
