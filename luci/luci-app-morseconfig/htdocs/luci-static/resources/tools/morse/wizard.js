'use strict';
/* globals baseclass configDiagram form morseuci rpc uci ui view */
'require baseclass';
'require view';
'require form';
'require uci';
'require ui';
'require rpc';
'require tools.morse.uci as morseuci';
'require custom-elements.morse-config-diagram as configDiagram';

const DEFAULT_LAN_IP = '10.42.0.1';
const DEFAULT_WLAN_IP = '192.168.1.1';
const ALTERNATE_WLAN_IP = '192.168.2.1';

const callIwinfoScan = rpc.declare({
	object: 'iwinfo',
	method: 'scan',
	params: ['device'],
	nobatch: true,
	expect: { results: [] },
});

const callUciCommit = rpc.declare({
	object: 'uci',
	method: 'commit',
	params: ['config'],
	reject: true,
});

const callUciDelete = rpc.declare({
	object: 'uci',
	method: 'delete',
	params: ['config', 'section', 'option'],
	reject: true,
});

const callGetBuiltinEthernetPorts = rpc.declare({
	object: 'luci',
	method: 'getBuiltinEthernetPorts',
	expect: { result: [] },
});

// Sadly, we add our own call to apply, because:
//  - the ui.changes.apply call (see ui.js) tries to do a bunch of vaguely annoying
//    things to the user interface
//  - uci.apply always uses rollback, and we can't rely on the user
//    finding us again
//  - the overridden .apply on localDevice swallows the res error code
//    and I'm scared to touch it
const callUciApply = rpc.declare({
	object: 'uci',
	method: 'apply',
	params: ['timeout', 'rollback'],
	reject: false, // So we can handle the 'nothing to do' case (returns 5).
});

const directUciRpc = {
	delete: callUciDelete,
	commit: callUciCommit,
	apply: callUciApply,
};

/**
 * @class HTMLValue
 * @memberof LuCI.form
 * @augments LuCI.form.Value
 * @hideconstructor
 * @classdesc
 *
 * The `HTMLValue` widget lets you use an html element as an option.
 * This makes it easy to insert miscellaneous information between other
 * options, including information with dependencies.
 *
 * Note that it doesn't work to simply append additional children to a section
 * element because an AbstractSection assumes all children are options.
 *
 * @param {LuCI.form.Map|LuCI.form.JSONMap} form
 * The configuration form this section is added to. It is automatically passed
 * by [option()]{@link LuCI.form.AbstractSection#option} or
 * [taboption()]{@link LuCI.form.AbstractSection#taboption} when adding the
 * option to the section.
 *
 * @param {LuCI.form.AbstractSection} section
 * The configuration section this option is added to. It is automatically passed
 * by [option()]{@link LuCI.form.AbstractSection#option} or
 * [taboption()]{@link LuCI.form.AbstractSection#taboption} when adding the
 * option to the section.
 *
 * @param {string} option
 * The internal name of the option element holding the section. Since a section
 * container element does not read or write any configuration itself, the name
 * is only used internally and does not need to relate to any underlying UCI
 * option name.
 *
 * @param {HTMLElement} element
 * The element you wish to insert as a fake option.
 *
 * @param {...*} [class_args]
 * All further arguments are passed as-is to the subclass constructor. Refer
 * to the corresponding class constructor documentations for details.
 */
var HTMLValue = form.Value.extend(/** @lends LuCI.form.Value.prototype */ {
	__init__: function (map, section, option, element /* , ... */) {
		this.super('__init__', this.varargs(arguments, 4, map, section, option));

		this.element = element;
	},

	render: async function (..._args) {
		const el = await this.super('render', arguments);
		el.classList.add('cbi-message-value');
		return el;
	},

	renderWidget: function (section_id) {
		const el = this.element.cloneNode(true);
		el.id = this.cbid(section_id);
		return el;
	},

	/** Disable option behaviour relating to actual values (which we don't have). */

	/** @override */
	load: function (_section_id) { },

	/** @override */
	parse: async function (_section_id) { },

	/** @override */
	value: function () { },

	/** @override */
	write: function () { },

	/** @override */
	remove: function () { },

	/** @override */
	cfgvalue: function () { return null; },

	/** @override */
	formvalue: function () { return null; },
});

class WizardConfigError extends Error { }

/* Extract the most important information from UCI that we tend to use.
 *
 * This is somewhat similar to missingSections in morseconf.js, except that
 * it both validates the existence of and extracts the relevant sections.
 * It exists becausethe wizard was originally written independently,
 * and has significant overlap with the logic in missing sections
 * (and things like mmGetMorseDevice). We should refactor it as part of APP-2033.
 */
function readSectionInfo() {
	const morseDevice = uci.sections('wireless', 'wifi-device').find(s => s.type === 'morse');
	const wifiDevice = uci.sections('wireless', 'wifi-device').find(s => s.type === 'mac80211');
	const morseDeviceName = morseDevice?.['.name'];
	const wifiDeviceName = wifiDevice?.['.name'];
	const morseInterfaceName = `default_${morseDeviceName}`;
	const morseBackhaulStaName = `default_bh_${morseDeviceName}`;
	const morseMeshApInterfaceName = `meshap_${morseDeviceName}`;
	const wifiApInterfaceName = `default_${wifiDeviceName}`;
	const wifiStaInterfaceName = `sta_${wifiDeviceName}`;

	// privlan has been removed from all the configs, but for those upgrading we should prefer the IP address
	// in privlan (i.e. likely 10.42.0.1) to that in lan (likely 192.168.1.1).
	const lanIp = uci.get('network', 'privlan', 'ipaddr') || uci.get('network', 'lan', 'ipaddr') || DEFAULT_LAN_IP;
	let wlanIp;
	// Likewise, we use the IP in lan here in case we got the previous ip from privlan (it's an old config).
	for (wlanIp of [uci.get('network', 'lan', 'ipaddr'), uci.get('network', 'ahwlan', 'ipaddr'), DEFAULT_WLAN_IP, ALTERNATE_WLAN_IP]) {
		if (wlanIp && wlanIp != lanIp) {
			break;
		}
	}
	const ethInterfaceName = morseuci.getEthNetwork();

	if (!morseDevice) {
		throw new WizardConfigError('No HaLow radio found');
	}

	if (morseDevice && !uci.get('wireless', morseInterfaceName)) {
		throw new WizardConfigError('No default wifi-interface for HaLow radio');
	}

	if (wifiDevice && !uci.get('wireless', wifiApInterfaceName)) {
		throw new WizardConfigError('No default wifi-interface for 2.4 GHz radio');
	}

	return {
		ethInterfaceName,
		morseDevice,
		morseDeviceName,
		wifiDevice,
		wifiDeviceName,
		morseInterfaceName,
		morseBackhaulStaName,
		morseMeshApInterfaceName,
		wifiApInterfaceName,
		wifiStaInterfaceName,
		lanIp,
		wlanIp,
	};
}

function whitelistFields(conf, section, whitelist) {
	whitelist = new Set(whitelist);

	for (const field of Object.keys(section)) {
		if (!whitelist.has(field)) {
			uci.unset(conf, section['.name'], field);
		}
	}
}

/* When we first load the wizard, we attempt a partial reset of the uci config.
 *
 * However, we only reset what we think we understand, primarily making sure:
 *  - every wifi device is enabled, and a whitelist is applied based on type
 *    (i.e. to only include fields we want to persist, like country/channel/bcf;
 *    primarily, whatever hotplug sets up)
 *  - all wifi ifaces are disabled (wizard should control any enablement)
 *  - any proto batadv network is disabled
 *  - prplmesh is disabled
 *  - all forwarding rules are disabled (enabled 0)
 *  - all dnsmasq instances are disabled
 */
function resetUci() {
	for (const device of uci.sections('wireless', 'wifi-device')) {
		// NB leaving 'disabled' out of the whitelist ensures the device is enabled.
		whitelistFields('wireless', device, [
			'type', 'path', 'band', 'hwmode', 'htmode', 'reconf', 'bcf', 'country', 'channel',
			'cell_density', 'txpower',
		]);
	}

	// Remove all dnsmasqs that are limited to particular interfaces
	// (this makes the configuration complicated for us to deal with).
	for (const dnsmasq of uci.sections('dhcp', 'dnsmasq')) {
		if (dnsmasq['interface'] || L.toArray(dnsmasq['notinterface']).find(iface => iface != 'loopback')) {
			uci.remove('dhcp', dnsmasq['.name']);
		}
	}

	if (uci.sections('dhcp', 'dnsmasq').length > 1) {
		// Even after we've removed all the scoped ones, we still have multiple. This
		// is probably a broken configuration, so let's just remove everything.
		for (const dnsmasq of uci.sections('dhcp', 'dnsmasq')) {
			uci.remove('dhcp', dnsmasq['.name']);
		}
	}

	const remainingDnsmasq = uci.sections('dhcp', 'dnsmasq');
	if (remainingDnsmasq.length === 1) {
		// The dubious rationale for this whitelist is 'fields that are set in the default
		// OpenWrt conf that are different from the default dnsmasq conf'.
		// Basically, this prevents us arbitrarily mutating config without having
		// to know these defaults.
		whitelistFields('dhcp', remainingDnsmasq[0], [
			'authoritative', 'domainneeded', 'localise_queries', 'readethers',
			'local', 'domain', 'expandhosts', 'localservice', 'cachesize',
			'ednspacket_max', 'rebind_localhost',
		]);
	}

	// If it's a known interface that the wizard likes to use, clean out anything that
	// could interfere. We can leave the other interfaces alone after disabling them
	// (which will allow people to keep non-wizard interfaces around safely).
	const { morseMeshApInterfaceName, morseInterfaceName, wifiApInterfaceName, wifiStaInterfaceName } = readSectionInfo();
	const knownInterfaces = new Set([morseMeshApInterfaceName, morseInterfaceName, wifiApInterfaceName, wifiStaInterfaceName]);

	for (const iface of uci.sections('wireless', 'wifi-iface')) {
		if (knownInterfaces.has(iface['.name'])) {
			whitelistFields('wireless', iface, ['network', 'device', 'key', 'encryption', 'mode', 'ssid', 'mesh_id']);
		}

		// Set all interfaces to disabled. This has to occur after white-listing,
		// since white-listing might try to remove 'disabled'.
		uci.set('wireless', iface['.name'], 'disabled', '1');
	}

	uci.set('prplmesh', 'config', 'enable', '0');

	resetUciNetworkTopology();
}

/**
 * This function resets only the parts of UCI that are touched by the complex wizard options.
 *
 * It's currently called every time an option changes so that parseWizardOptions is easier
 * to reason about, not having to consider interference from previous settings
 * OR interference from its own behaviour as different options are selected
 * (since it's frequently re-evaluated as the diagram is rerendered before the end
 * of the wizard).
 *
 * WARNING: one should never have an option that's directly part of the normal form here unless
 * using .forcewrite, as resetting may change the value underneath and cause it to
 * not write a 'new' value since it thinks it's unnecessary (isEqual check).
 *
 * (remembering that both AbstractValue and uci.js have a caching layer over
 * the actual data)
 */
function resetUciNetworkTopology() {
	// Disable all forwarding.
	for (const forwarding of uci.sections('firewall', 'forwarding')) {
		uci.set('firewall', forwarding['.name'], 'enabled', '0');
	}

	// Ignore all dhcp range sections (effectively disabling dhcp on all interfaces).
	for (const dhcp of uci.sections('dhcp', 'dhcp')) {
		// We keep the basic ip ranges, though. This means that wizards
		// are less likely to mess with custom configured ranges, at
		// the risk of persisting broken ranges.
		whitelistFields('dhcp', dhcp, [
			'start', 'leasetime', 'limit', 'interface',
		]);
		uci.set('dhcp', dhcp['.name'], 'ignore', '1');
	}

	const bridgeDevices = new Set();
	for (const device of uci.sections('network', 'device')) {
		if (device.type === 'bridge') {
			bridgeDevices.add(device.name);
			if (device['ports']) {
				uci.unset('network', device['.name'], 'ports');
			}
		}
	}

	for (const iface of uci.sections('network', 'interface')) {
		// Do not mess with the loopback device.
		if (iface['device'] === 'lo') {
			continue;
		}

		// Remove any ad-hoc things.
		if (iface['proto'] == 'batadv') {
			uci.set('network', iface['.name'], 'disabled', '1');
		}

		uci.unset('network', iface['.name'], 'gateway');
		// Leave bridge devices in (their ports are already removed)
		// so that custom named bridges remain with their networks.
		// If the bridge is empty, it won't be instantiated.
		if (!bridgeDevices.has(iface.device)) {
			uci.unset('network', iface['.name'], 'device');
		}
	}
}

/**
 * Represents a page in the wizard.
 *
 * Add options to the page in the same way you would with a section,
 * calling `.option`.
 *
 * Usage:
 *
 *   page = new WizardPage(section, 'Blah', 'Some useful info')
 *   page.option(...);
 *
 * Currently only supports NamedSections, as we rely on an explicit
 * section_id. Could be relatively trivially extending to support
 * multiple sections in the same page, but for now we don't need this.
 */
let wpId = 0;
class WizardPage {
	constructor(section, title, infobox) {
		this.title = title;
		this.infobox = infobox;
		this.options = [];
		this.section = section;
		this.wpId = ++wpId;
		this.diagramArgs = null;
	}

	enableDiagram(args = {}) {
		this.diagramArgs = args;
	}

	updateInfoText(infoText, wizardView) {
		// Update both the page and the currently displayed element
		wizardView.infoboxEl.innerHTML = infoText;
		this.infobox = infoText;
	}

	setNavActive(active) {
		for (const option of this.options) {
			const el = document.getElementById(option.cbid(option.section.section));
			if (el) {
				el.closest('.cbi-value').classList[active ? 'remove' : 'add']('hidden-nav');
			} else {
				console.error('Internal error - missing cbid:', option.cbid(option.section.section));
			}
		}
	}

	// Page is active if any options on the page are active.
	isActive() {
		for (const option of this.options) {
			if (option.isActive(option.section.section)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Add an option; passes through to the current section.
	 *
	 * Warning: this pretends that it will display options in the order
	 * added, but because the Section actually renders the options
	 * the actual order will be determined by the section order.
	 */
	option(...args) {
		const option = this.section.option(...args);
		option.page = this;
		this.options.push(option);

		return option;
	}

	html(html) {
		return this.option(HTMLValue, `__dummy_${this.wpId}-${this.options.length}`, html);
	}

	message(contents, messageType = 'warning') {
		return this.html(E('div', { class: `alert-message ${messageType}` }, contents));
	}

	step(contents) {
		return this.html(E('ul', {}, E('li', {}, contents)));
	}

	heading(contents) {
		return this.html(E('h3', {}, contents));
	}
}

/**
 * View which provides a 'wizard' view of a map.
 *
 * This works by pushing the actions into a buttom navbar and
 * showing only one page at a time.
 *
 * How to use:
 *  - create an ordinary map and sections in that map
 *  - call .page with a section (different pages can refer to the same section)
 *  - rather than calling section.option, call page.option which will
 *    attach options to both the section and the page
 *
 * Pages are only visible if an option in the page is visible
 * (i.e. they can be hidden if all included options are failing dependency checks).
 */
const AbstractWizardView = view.extend({
	__init__(title, description, diagramName, map /* , ... */) {
		this.pages = [];
		this.title = title;
		this.description = description;
		this.finished = false;
		this.diagramName = diagramName;
		this.diagram = null;
		this.map = map;

		// We need the close button ASAP, because otherwise users will have no way
		// of escaping the wizard if we blow up during load.
		// It's safe to do this here without waiting for the render since luci loads the
		// view separately from the header.
		this.closeButton = document.querySelector('body header button.close');
		this.closeButton.onclick = () => this.exit();

		return this.super('__init__', this.varargs(arguments, 3));
	},

	/* Override if you're doing something more complicated.
	 * Note that returning 'null' will mean that the exit
	 * buttons will be disabled.
	 */
	getRedirectPage() {
		return L.url();
	},

	/* When an option relevant to the diagram changes, call this
	 * from the onchange handler.
	 *
	 * If anything fails here (i.e. usually an option parse)
	 * we want to ignore it, as we can't sensibly update the diagram
	 * and if the option is bad the standard form elements will
	 * give feedback to the user.
	 */
	onchangeOptionUpdateDiagram(option) {
		if (!option.page.diagramArgs) {
			// i.e. if page doesn't have diagram enabled, nothing to do here.
			return;
		}

		const sectionId = option.section.section;
		option.parse(sectionId)
			.then(() => {
				// Unfortunately, after parsing we have to redo the load to ensure
				// the cached value in AbstractValue is correct.
				option.cfgvalue(sectionId, option.load(sectionId));
				this.updateDiagram(option.page);
			})
			// ignore errors - if the parse failed, we can't update the diagram,
			// and user should be notified of failure by ordinary form validation errors.
			// Note that parse is a bit of a misnomer - it both parses the options
			// and writes it if necessary.
			.catch(e => e);
	},

	/* Returns the result of getBuiltinEthernetPorts.
	 */
	getEthernetPorts() {
		return this.ethernetPorts;
	},

	updateDiagram(page) {
		if (!page.diagramArgs) {
			// i.e. if page doesn't have diagram enabled, nothing to do here.
			return;
		}

		this.parseWizardOptions();
		this.diagram.updateFrom(uci, this.ethernetPorts, page.diagramArgs);
	},

	/**
	 * Adds a WizardPage to our view.
	 *
	 * Arguments are passed through to WizardPage.
	 *
	 * @param  {...any} args
	 * @returns {WizardPage}
	 */
	page(...args) {
		const page = new WizardPage(...args);
		this.pages.push(page);
		return page;
	},

	exit() {
		if (this.finished) {
			// If we're finished, we should have reset the homepage.
			const redirectPage = this.getRedirectPage();
			if (redirectPage) {
				window.location = redirectPage;
			} else {
				const message = this.ethIp === null
					? _(`It looks like the device has been configured as a DHCP client. Cannot redirect!`)
					: _(`Oops, the URL <a href=http://%s>%s</a> doesn't appear to be reachable. Please check your network configuration and try again.`).format(this.ethIp);
				ui.showModal(_('Network changes detected!'), [
					E('p', message),
					E('div', { class: 'right' }, [
						E('button', {
							class: 'btn',
							click: ui.hideModal,
						}, _('Close', 'User action to close a dialog box')), ' ',
					]),
				]);
			}
			return;
		}

		if (this.currentPageIndex !== 0) {
			ui.showModal(_('Abort HaLow Configuration Wizard'), [
				E('p', _(`Leaving the wizard will discard any selections you've made.
					  You can return to the wizard by going to the 'Morse' menu.`)),
				E('div', { class: 'right' }, [
					E('button', {
						class: 'btn',
						click: ui.hideModal,
					}, _('Cancel')), ' ',
					E('button', {
						class: 'btn cbi-button cbi-button-negative important',
						click: ui.createHandlerFn(this, 'abort'),
					}, _('Proceed')),
				]),
			]);
		} else {
			this.abort();
		}
	},

	async abort() {
		if ([L.env.requestpath.join('/'), 'admin/selectwizard'].includes(uci.get('luci', 'main', 'homepage'))) {
			await directUciRpc.delete('luci', 'main', 'homepage');
			await directUciRpc.commit('luci');
		}
		window.location.href = L.url();
	},

	renderBadConfigError(errorMessage) {
		return E('div', { id: 'wizard-bad-config', class: 'alert-message warning' }, _(`
			Configuration incompatible with config wizard detected (%s). If you wish
			to use the wizard, you should <a href="%s">reset or reflash your device</a>.
		`).format(errorMessage, L.url('admin', 'system', 'flash')));
	},

	async render(loadPagesResults) {
		if (this.configLoadError) {
			return this.renderBadConfigError(this.configLoadError);
		}

		const {
			morseDevice,
			wifiDevice,
		} = readSectionInfo();

		// If our wifi devices aren't enabled/configured, force the user
		// back to the landing page (which will do this for us).
		if (morseDevice.disabled === '1' || !morseDevice.country || (wifiDevice && wifiDevice.disabled === '1')) {
			window.location = L.url('admin', 'morse', 'landing');
			return;
		}

		// Clean out anything interesting looking from UCI so the wizard has a clean-ish run
		// at the config. Note that this does preserve some user set data
		// (e.g. IPs, SSIDs, keys) but generally removes any networking topology
		// or complex wifi options.
		//
		// It will also disable all wifi-ifaces.
		resetUci();

		// Construct our diagram.
		this.diagram = E(this.diagramName);

		let pages;
		try {
			pages = await this.renderPages(loadPagesResults);
		} catch (e) {
			if (!(e instanceof WizardConfigError)) {
				throw e;
			}

			return this.renderBadConfigError(e.message);
		}

		if (!pages) {
			return;
		}

		const html = E('div', { class: 'wizard-contents' }, [
			E('div', { class: 'header-section' }, [
				this.titleEl = E('h1', {}, this.title),
				this.descriptionEl = E('div', {}, this.description),
				this.pageTitleEl = E('h2'),
				this.diagram,
			]),
			pages,
			this.infoboxEl = E('div', { class: 'wizard-infobox alert-message notice' }),
		]);

		return html;
	},

	async load() {
		this.configLoadError = false;
		const criticalConfig = ['wireless', 'network', 'firewall', 'dhcp', 'system'];
		criticalConfig.push(...this.getExtraConfigFiles());

		await Promise.all([
			callGetBuiltinEthernetPorts().then(ports => this.ethernetPorts = ports),
			uci.load(['luci']).catch((e) => {
				// If we don't even have luci, we won't be able to remove our homepage override!
				// We load this one separately so other breakages don't interfere with this,
				// since we want to try to persist the new homepage on abort().
				console.error(e);
				this.configLoadError = _('Missing critical configuration file');
			}),
			uci.load(criticalConfig).catch((e) => {
				console.error(e);
				this.configLoadError = _('Missing critical configuration file');
			}),
			// We need this so if prplmesh is enabled we can disable in the reset.
			uci.load('prplmesh').catch(() => null),
			// This allows us to switch the broadcast interface for camera-onvif-server
			// (again, if enabled).
			uci.load('camera-onvif-server').catch(() => null),
			configDiagram.loadTemplate(),
		]);

		const result = await this.loadPages();
		try {
			this.loadWizardOptions();
		} catch (e) {
			this.configLoadError = e;
		}

		return result;
	},

	getExtraConfigFiles() {
		return [];
	},

	loadPages() {
		return Promise.resolve();
	},

	renderPages(_loadPagesResult) {
		L.error('InternalError', 'Not implemented');
	},

	/* This parses the 'fake' multi-options which are primarily about
	 * setting the network topology.
	 *
	 * This is called quite frequently to update the diagram, so it must
	 * take care that it can handle varying options (i.e. perform its
	 * own resets of its own options if necessary).
	 */
	parseWizardOptions() {
		L.error('InternalError', 'Not implemented');
	},

	loadWizardOptions() {
		L.error('InternalError', 'Not implemented');
	},

	/**
	 * Usually, addFooter deals with handleSave etc.
	 *
	 * In our case, we want the progress bar and nav controls in the footer,
	 * and want to turn the footer into a fixed navbar type thing (see wizard.css).
	 *
	 * It would be possible to reinstate the normal actions here
	 * by copying them from the existing addFooter, but for now we keep
	 * it simple (YAGNI?).
	 *
	 * @override
	 */
	addFooter() {
		if (document.getElementById('wizard-bad-config')) {
			return E('div');
		}

		const footer = E('div', { class: 'cbi-page-actions' }, [
			E('div', { class: 'container' }, [
				this.progressBarContainer = E('div', { class: 'cbi-progressbar' }, this.progressBar = E('div', { style: 'width: 50%' })),
				E('div', { class: 'cbi-page-actions-flex' }, [
					this.backButton = E('button', {
						class: 'cbi-button',
						click: classes.ui.createHandlerFn(this, 'handleBack'),
					}, [_('Back', 'Navigate backwards through a process')]),
					E('div', { style: 'flex-grow: 1' }),
					this.nextButton = E('button', {
						class: 'cbi-button cbi-button-action',
						click: classes.ui.createHandlerFn(this, 'handleNext'),
					}, [_('Next', 'Navigate forwards through a process')]),
					// This button should only be visible when next is not visible.
					this.applyButton = E('button', {
						class: 'cbi-button cbi-button-apply',
						click: classes.ui.createHandlerFn(this, 'handleApply'),
					}, [_('Apply')]),
					this.exitButton = E('button', {
						class: 'cbi-button cbi-button-action hidden',
						click: classes.ui.createHandlerFn(this, 'exit'),
					}, [_('Leave wizard', 'Exit a configuration wizard')]),
				]),
			]),
		]);

		for (const page of this.pages) {
			page.setNavActive(false);
		}

		this.gotoPage(this.getActivePages(), 0);

		return footer;
	},

	/** @private */
	getActivePages() {
		return this.pages.filter(page => page.isActive());
	},

	/** @private */
	gotoPage(pages, i) {
		if (i < 0 || i >= pages.length) {
			return;
		}

		const first = i === 0;

		// Creating a last page in the configuration as a second to last from
		// the exit page, which is to show up after Apply.
		const last = i === pages.length - 2;
		const exit = i === pages.length - 1;

		if (this.currentPage) {
			this.currentPage.setNavActive(false);
		}

		this.currentPage = pages[i];
		this.currentPage.setNavActive(true);
		this.currentPageIndex = i;
		// Silly hack to make sure we have progress at the start (when most pages
		// are not visible due to options not being selected).
		const perc = (i === 1 && pages.length === 3) ? 30 : i / (pages.length - 1) * 100;
		this.progressBar.style.width = `${perc}%`;

		this.titleEl.classList[first ? 'remove' : 'add']('hidden');
		this.descriptionEl.classList[first ? 'remove' : 'add']('hidden');
		this.diagram.classList[exit ? 'add' : 'remove']('hidden-nav');

		this.backButton.classList[first || exit ? 'add' : 'remove']('hidden');
		this.nextButton.classList[last || exit ? 'add' : 'remove']('hidden');
		this.applyButton.classList[last ? 'remove' : 'add']('hidden');
		this.exitButton.classList[exit ? 'remove' : 'add']('hidden');
		this.closeButton.classList[exit ? 'add' : 'remove']('hidden');

		if (this.currentPage.title) {
			this.pageTitleEl.innerHTML = this.currentPage.title;
			this.pageTitleEl.style.display = 'block';
		} else {
			this.pageTitleEl.style.display = 'none';
		}
		this.infoboxEl.innerHTML = this.currentPage.infobox;

		this.updateDiagram(this.currentPage);
	},

	async handleNext() {
		const pages = this.getActivePages();
		const i = pages.indexOf(this.currentPage);
		if (i === -1 || i === pages.length - 1) {
			return;
		}

		const errs = [];
		await Promise.allSettled(this.currentPage.options.map(async (option) => {
			const sectionId = option.section.section;
			try {
				// Note that parse is a bit of a misnomer - it both
				// checks/reads the form value and writes it if necessary.
				await option.parse(sectionId);
			} catch (e) {
				errs.push(e.message);
				return;
			}

			// Usually, a parse is followed by a save and then options are
			// reloaded. In our situation, we aren't using this mechanism,
			// so we manually repopulate the form value with the updated
			// value in UCI. This makes sure that any subsequent AbstractValue.parse
			// doesn't get confused and think that something doesn't need
			// to be persisted because it's already that value.
			// IMO this is a bug in AbstractValue - parse should call .cfgvalue
			// after calling .write.
			option.cfgvalue(sectionId, option.load(sectionId));
		}));

		if (errs.length === 0) {
			this.gotoPage(pages, i + 1);
		} else {
			// Initially, I disabled the Next button if parse failed. This has a couple of problems:
			// - it's messy hooking into into LuCI, as there's no clean way to
			//   list to all widget-changes in the section (unless we modify upstream).
			//   A quick hack would be to override checkDepends in the map and then
			//   add an onchange callback to this, but we still end up with a lot of unnecessary
			//   parse() and it's pretty ugly.
			// - disabled buttons currently don't show tooltips.
			ui.showModal(_('Selections not completed'), [
				E('div', {}, errs.map(err => E('p', {}, [E('em', { style: 'white-space:pre-wrap' }, err)]))),
				E('div', { class: 'right' }, [
					E('button', { class: 'cbi-button', click: ui.hideModal }, [_('Dismiss')]),
				]),
			]);
		}
	},

	/**
	 * Save and immediately commit/apply the changes.
	 *
	 * Unlike the standard handleSaveApply, this does _not_ attempt any rollbacks.
	 * Because of the way we reconfigure the device in the wizard, either the user
	 * is likely be able to use the existing IP or it's hard to predict the IP
	 * (DHCP). We could attempt to use the hostname (i.e. myhostname.privlan
	 * or myhostname.lan), but for now we don't attempt anything fancy.
	 *
	 * @param {Event} ev
	 */
	async handleApply(_ev) {
		try {
			// Start of the this.map.save logic, but we don't load/renderContents afterwards.
			this.map.checkDepends();

			await this.map.parse();
			await this.save();

			if (!(new URL(document.location).searchParams.get('debug'))) {
				const res = await callUciApply(0, false);
				// 5 is no data - i.e. nothing to apply.
				// It's hard to detect this otherwise with the existing calls
				// (changes will return all the changes, which we don't need).
				if (![0, 5].includes(res)) {
					L.raise('RPCError', 'RPC call to uci/apply failed with ubus code %d: %s',
						res, rpc.getStatusText(res));
				}
			}
		} catch (e) {
			ui.showModal(_('Save error'), [
				E('p', {}, [_('An error occurred while saving the form:')]),
				E('p', {}, [E('em', { style: 'white-space:pre-wrap' }, [e.message])]),
				E('div', { class: 'right' }, [
					E('button', { class: 'cbi-button', click: () => window.location = window.location.href }, [_('Reload')]),
				]),
			]);
			console.error(e);
			return;
		}

		this.finished = true;

		// Remove the apply and infobox instruction and start fake timer.
		this.nextButton.classList.add('hidden');
		this.backButton.classList.add('hidden');
		this.applyButton.classList.add('hidden');
		this.progressBarContainer.classList.add('hidden');
		this.infoboxEl.classList.add('hidden');

		ui.changes.displayStatus('notice spinning', E('p', _('Applying configuration changes…')));

		// A usual LuCI apply waits for apply_holdoff (default 4 secs) then starts checking
		// whether the device is live. Since we _don't_ check whether the device is live,
		// as there's a decent chance that network reconfigurations will make us lose the
		// connection, we cross our fingers and wait for twice apply_holdoff.
		setTimeout(() => {
			const pages = this.getActivePages();
			document.dispatchEvent(new CustomEvent('uci-applied'));

			ui.changes.setIndicator(0);
			ui.changes.displayStatus(false);

			this.gotoPage(pages, pages.length - 1);
		}, L.env.apply_holdoff * 2 * 1000);
	},

	handleBack() {
		const pages = this.getActivePages();
		const i = pages.indexOf(this.currentPage);
		if (i === -1 || i === 0) {
			return;
		}

		this.gotoPage(pages, i - 1);
	},

	async save() {
		// Parse/uci.set our fake wizard section...
		this.parseWizardOptions();
		// And now we can remove it.
		uci.remove('network', 'wizard', 'wizard');

		// Wipe out custom homepage.
		// We don't want this in parseWizardOptions because it shouldn't be done
		// every time for the diagram, only when we actually go to save
		// (otherwise it will mess up the .abort logic).
		if ([L.env.requestpath.join('/'), 'admin/selectwizard'].includes(uci.get('luci', 'main', 'homepage'))) {
			uci.set('luci', 'main', 'homepage', null);
		}

		if (!uci.get('luci', 'wizard')) {
			uci.add('luci', 'wizard', 'wizard');
		}

		uci.set('luci', 'wizard', 'used', '1');

		await uci.save();
	},

	async doScan(iface, mode) {
		const scanResult = (await callIwinfoScan(iface)).filter(result => result.mode == mode);

		function getBestEncryption(enc) {
			// From wireless.js
			const is_psk = (enc && Array.isArray(enc.wpa) && L.toArray(enc.authentication).filter(function (a) {
				return a == 'psk';
			}).length > 0);
			const is_sae = (enc && Array.isArray(enc.wpa) && L.toArray(enc.authentication).filter(function (a) {
				return a == 'sae';
			}).length > 0);

			if (is_sae) {
				return 'sae';
			} else if (is_psk) {
				if (enc.wpa.includes(2)) {
					return 'psk2';
				} else {
					return 'psk';
				}
			} else {
				return 'none';
			}
		}

		const result = {};
		for (const res of scanResult) {
			if (res['ssid'] && !result[res['ssid']]) {
				result[res['ssid']] = getBestEncryption(res.encryption);
			}
		}

		return result;
	},
});

return baseclass.extend({
	AbstractWizardView,
	readSectionInfo,
	directUciRpc,
	resetUci,
	resetUciNetworkTopology,
	WizardConfigError,
});
