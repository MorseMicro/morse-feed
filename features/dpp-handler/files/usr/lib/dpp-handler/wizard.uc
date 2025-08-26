/**
 * DPP Configuration generation/applications.
 *
 * The two public functions are two sides of the coin:
 *  - generate_dpp_command generates the config on the AP side
 *    (in a form appropriate for consumption by hostapd)
 *  - apply_config applies received dpp config on the STA side
 */
"use strict";

import { readfile } from "fs";
import { rand } from "math";

const EXTRA_CONF_NAMESPACE = "com.morsemicro.wizard";
const DEFAULT_NETWORK = "lan";


/**
 * Finds the UCI section name of the morse wifi-device.
 * @param {object} uci - UCI cursor.
 * @returns {string|null} - Name of the wifi-device section.
 */
function find_morse_device(uci) {
	const w = uci.get_all("wireless");
	return filter(keys(w),
		s => w[s][".type"] === "wifi-device" && w[s]["type"] === "morse" && w[s]["disabled"] !== "1")[0];
}


/**
 * Finds the UCI section name of a non-morse wifi-device.
 * @param {object} uci - UCI cursor.
 * @returns {string|null} - Name of the wifi-device section.
 */
function find_wifi_devices(uci) {
	const w = uci.get_all("wireless");
	return filter(keys(w),
		s => w[s][".type"] === "wifi-device" && w[s]["type"] === "mac80211" && w[s]["disabled"] !== "1");
}


/**
 * Returns all iface sections associated with a given device.
 * @param {object} uci - UCI cursor.
 * @param {string} device - Name of the wifi-device section.
 * @returns {array} - Array of iface section names.
 */
function find_ifaces(uci, device) {
	const w = uci.get_all("wireless");
	return filter(keys(w),
		s => w[s][".type"] === "wifi-iface" && w[s]["device"] === device && w[s]["disabled"] !== "1");
}


/**
 * Checks config object against required parameters.
 * @param {object} config - Configuration object.
 * @param {array} params - List of required string parameters.
 * @returns {boolean} - True if all params are present and strings.
 */
function check_config(config, params) {
	let has_error = false;
	for (let param in params) {
		if (type(config[param]) !== "string") {
			warn("Missing valid config param: ", param, type(config[param]), "\n");
			has_error = true;
		}
	}

	return !has_error;
}


/**
 * Find a valid HaLow device/iface to target for custom config.
 *
 * @param {object} uci - UCI cursor.
 * @returns {object|null} - Details of target (iface/device/bridge) if found.
 */
function get_custom_target(uci) {
	const t = {};
	t.device = find_morse_device(uci);
	if (!t.device) {
		warn("Unable to find morse wifi-device in UCI wireless config.\n");
		return null;
	}

	const sta_ifaces = filter(find_ifaces(uci, t.device), s => uci.get("wireless", s, "mode") === 'sta');
	if (length(sta_ifaces) !== 1) {
		warn("Unable to find exactly one STA wifi-iface in UCI wireless config.\n");
		return null;
	}

	t.iface = sta_ifaces[0];
	if (uci.get("wireless", t.iface, "network") !== DEFAULT_NETWORK) {
		warn(`Morse iface not on ${DEFAULT_NETWORK} network.\n`);
		return null;
	}

	const bridge_device = uci.get("network", DEFAULT_NETWORK, "device");
	if (!bridge_device) {
		warn(`Network ${DEFAULT_NETWORK} has no device, so likely not bridged.\n`);
		return false;
	}

	const networks = uci.get_all("network");
	t.bridge = filter(keys(networks),
		s => networks[s]["type"] === "bridge" && networks[s]["name"] === bridge_device)[0];
	if (!t.bridge) {
		warn(`Unable to find bridge ${bridge_device} in config.\n`);
		return false;
	}

	return t;
}


/**
 * Determine if there's a valid iface for HaLow custom config.
 *
 * If this is not true, we should not initiate a 2.4 DPP, since any
 * custom config wouldn't be applicable anyway.
 *
 * @param {object} uci - UCI cursor.
 * @returns {boolean} - Details of target (iface/device/bridge) if found.
 */
export function has_custom_target(uci) {
	return !!get_custom_target(uci);
};


/**
 * Applies custom DPP configuration from extra_conf.
 *
 * Interpret a custom (EXTRA_CONF_NAMESPACE) conf object.
 * This always targets the S1G interface even if it's come in over 2.4,
 * and may reconfigure the device for mesh modes.
 *
 * This will _only_ work in restricted situations:
 *  - enabled morse device/iface
 *  - iface network is lan
 *  - the iface/device doesn't have config which would prevent
 *    it working (NB currently not tested for!)
 *
 * This is also not as flexible as the wizards in general; e.g.
 * if it's faced with an existing prplmesh configuration, it will
 * currently just abort (more than one iface), and it will not
 * aggressively reset wifi/network configuration.
 * Potentially this should change!
 *
 * Note that custom_config objects are created by generate_custom_config
 * below.
 *
 * @param {object} uci - UCI cursor.
 * @param {object} config - Custom config object.
 * @returns {boolean} - True on successful config.
 */
function apply_custom_config(uci, config) {
	const target = get_custom_target(uci);
	if (!target) {
		return false;
	}

	switch (config.mode) {
	case 'standard':
		if (!check_config(config, ["country", "ssid", "key", "encryption"])) {
			return false;
		}
		uci.set("wireless", target.device, "country", config.country);

		uci.set("wireless", target.iface, "mode", "sta");
		// Disable powersave since this is only used for Extenders where
		// power is not a concern (powersave causes higher latency).
		uci.set("wireless", target.iface, "powersave", "0");
		uci.set("wireless", target.iface, "ssid", config.ssid);
		uci.delete("wireless", target.iface, "mesh_id");
		uci.set("wireless", target.iface, "key", config.key);
		uci.set("wireless", target.iface, "encryption", config.encryption);
		uci.delete("wireless", target.iface, "dpp");
		break;

	case 'mesh11s':
		if (!check_config(config, ["country", "channel", "mesh_id", "key", "encryption"])) {
			return false;
		}
		uci.set("wireless", target.device, "country", config.country);
		uci.set("wireless", target.device, "channel", config.channel);

		uci.set("wireless", target.iface, "mode", "mesh");
		uci.set("wireless", target.iface, "mesh_id", config.mesh_id);
		uci.delete("wireless", target.iface, "ssid");
		uci.set("wireless", target.iface, "key", config.key);
		uci.set("wireless", target.iface, "encryption", config.encryption);
		uci.delete("wireless", target.iface, "dpp");
		break;

	case 'prplmesh':
		if (!check_config(config, ["country", "channel", "ssid", "key", "encryption"])) {
			return false;
		}
		if (!uci.load("prplmesh")) {
			warn("Configurator requests prplmesh but prplmesh is not installed.");
			return false;
		}
		uci.set("wireless", target.device, "country", config.country);
		// prplmesh shouldn't require a channel, but currently does due to
		// a bug with bringing up a HaLow AP and STA at the same time.
		uci.set("wireless", target.device, "channel", config.channel);

		uci.set("wireless", target.iface, "mode", "ap");
		uci.set("wireless", target.iface, "ssid", config.ssid);
		uci.delete("wireless", target.iface, "mesh_id");
		uci.set("wireless", target.iface, "key", config.key);
		uci.set("wireless", target.iface, "encryption", config.encryption);
		uci.set("wireless", target.iface, "bss_transition", "1");
		uci.set("wireless", target.iface, "multi_ap", "3");
		uci.set("wireless", target.iface, "ieee80211k", "1");
		uci.set("wireless", target.iface, "ieee80211w", "2");
		uci.set("wireless", target.iface, "ifname", "wlan-prpl");
		uci.delete("wireless", target.iface, "dpp");

		const backhaul_sta = "default_bh_" + target.device;
		uci.set("wireless", backhaul_sta, "wifi-iface");
		uci.set("wireless", backhaul_sta, "device", target.device);
		uci.set("wireless", backhaul_sta, "network", DEFAULT_NETWORK);
		uci.set("wireless", backhaul_sta, "mode", "sta");
		// Disable powersave since this is only used for Extenders where
		// power is not a concern (powersave causes higher latency).
		uci.set("wireless", backhaul_sta, "powersave", "0");
		uci.set("wireless", backhaul_sta, "ssid", config.ssid);
		uci.set("wireless", backhaul_sta, "key", config.key);
		uci.set("wireless", backhaul_sta, "multi_ap", "1");
		uci.set("wireless", backhaul_sta, "wds", "1");
		uci.set("wireless", backhaul_sta, "encryption", config.encryption);
		uci.set("wireless", backhaul_sta, "ifname", "wlan-prpl-1");
		// Use backhaul link for showing halow info, since that's the one
		// most likely to indicate that it's working (and traffic from AP
		// will generally show on the backhaul link anyway).
		uci.set("system", "led_halow", "dev", "wlan-prpl-1");

		uci.set("prplmesh", "config", "enable", "1");
		uci.set("prplmesh", "config", "management_mode", "Multi-AP-Agent");
		uci.set("prplmesh", "config", "master", "0");
		uci.set("prplmesh", "config", "gateway", "0");
		uci.set("prplmesh", "config", "wired_backhaul", "0");
		uci.set("prplmesh", "config", "operating_mode", "WDS-Repeater");

		// prplmesh demands that its target.bridge is named br-prpl. How annoying.
		uci.set("network", target.bridge, "name", "br-prpl");
		const morse_macaddr = readfile("/sys/class/net/wlan0/address");
		const suffix = morse_macaddr
			? substr(rtrim(morse_macaddr), 3)
			: join(':', map([rand(), rand(), rand(), rand(), rand()], (n) => hexenc(chr(n % 256))));
		uci.set("network", target.bridge, "macaddr", `f2:${suffix}`);
		uci.set("network", DEFAULT_NETWORK, "device", "br-prpl");

		uci.set("prplmesh", target.device, "wifi-device");
		uci.set("prplmesh", target.device, "hostap_iface", "wlan-prpl");
		uci.set("prplmesh", target.device, "sta_iface", "wlan-prpl-1");

		// Configure the other radios to be managed via prplmesh.
		// prplmesh handles the synchronisation of network credentials from the Halow Base controller.
		let iface_num = 0;
		let set_led_2g = false;
		for (let wifi_device in find_wifi_devices(uci)) {
			for (let wifi_iface in find_ifaces(uci, wifi_device)) {
				if (uci.get("wireless", wifi_iface, "mode") !== "ap") {
					continue;
				}

				const iface_name = `wl${iface_num++}-prpl`;

				uci.set("prplmesh", wifi_device, "wifi-device");
				uci.set("prplmesh", wifi_device, "hostap_iface", iface_name);
				uci.set("wireless", wifi_iface, "ifname", iface_name);
				uci.set("wireless", wifi_iface, "encryption", "sae-mixed");
				uci.set("wireless", wifi_iface, "bss_transition", "1");
				uci.set("wireless", wifi_iface, "multi_ap", "2");

				if (!set_led_2g && uci.get("wireless", wifi_device, "band") === "2g") {
					uci.set("system", "led_80211n_ap", "dev", iface_name);
					set_led_2g = true;
				}

				break; // Only change the first AP we find on a device.
			}
		}
		break;

	default:
		warn(`Mode not understood: ${config.mode}\n`);
		return false;
	}

	return true;
}


/**
 * Reads current config and generates a matching custom config object.
 * @param {object} uci - UCI cursor.
 * @returns {object|null} - Morse-specific config for serialization.
 */
function generate_custom_config(uci) {
	const prplmesh_enabled = uci.get("prplmesh", "config", "enable") === "1";

	const morse_device = find_morse_device(uci);
	if (!morse_device) {
		warn("Unable to find morse wifi-device in UCI wireless config.\n");
		return null;
	}

	const morse_ifaces = find_ifaces(uci, morse_device);

	// Prefer 802.11s Mesh Point config if available.
	for (let iface in morse_ifaces) {
		if (uci.get("wireless", iface, "mode") === "mesh") {
			return {
				mode: "mesh11s",
				country: uci.get("wireless", morse_device, "country"),
				channel: uci.get("wireless", morse_device, "channel"),
				mesh_id: uci.get("wireless", iface, "mesh_id"),
				key: uci.get("wireless", iface, "key"),
				encryption: uci.get("wireless", iface, "encryption"),
			};
		}
	}

	for (let iface in morse_ifaces) {
		if (uci.get("wireless", iface, "mode") === "ap") {
			return {
				mode: prplmesh_enabled ? "prplmesh" : "standard",
				country: uci.get("wireless", morse_device, "country"),
				channel: uci.get("wireless", morse_device, "channel"),
				ssid: uci.get("wireless", iface, "ssid"),
				key: uci.get("wireless", iface, "key"),
				encryption: uci.get("wireless", iface, "encryption"),
			};
		}
	}

	warn("Unable to find any DPP-able ifaces.\n");
	return null;
}


/**
 * Creates a formatted DPP provisioning string for hostapd.
 *
 * Generate a DPP 'command' (really, a config) in the form required by hostapd
 * for its inbuilt configurator (field=var field=var field=var). This config
 * is then used for provisioning.
 *
 * For example:
 *   conf=sta-sae pass=6e6f7461676f6f64736563726574 ssid=71656d752d33343536
 *   conf_extra_name=com.morsemicro.wizard conf_extra_value=7b2278223a20317d0a
 * (note that complex/user defined strings are hex encoded)
 *
 * Internally, this will end up as a JSON blob anyway, but it would require
 * too much hackery to make the ubus interface accept that directly.
 *
 * Note that the custom conf is always related to the halow/whole system,
 * whereas the 'normal' conf is related to the current wifi-iface.
 * In practice, for 2.4, this conf is currently ignored by dpp-handler
 * (as all 2.4 STA interactions are temporary).
 *
 * @param {object} uci - UCI cursor.
 * @param {object} section - UCI section name for wifi-iface.
 * @returns {string|null} - DPP conf string or null if unsupported.
 */
export function generate_dpp_command(uci, section) {
	const fields = {
		conf_extra_name: EXTRA_CONF_NAMESPACE,
	};

	const custom_config = generate_custom_config(uci);
	if (!custom_config) {
		return null;
	}

	const encryption = uci.get("wireless", section, "encryption");
	const dpp_encryption = {
		"sae": "sae",
		"sae-mixed": "psk+sae",
		"psk2": "psk",
	}[encryption];
	if (!dpp_encryption) {
		warn(`Encryption ${encryption} not supported for DPP (only sae/sae-mixed/psk2).\n`);
		return null;
	}
	fields.conf = `sta-${dpp_encryption}`;
	fields.ssid = hexenc(uci.get("wireless", section, "ssid"));
	fields.pass = hexenc(uci.get("wireless", section, "key"));

	fields.conf_extra_value = hexenc(custom_config);

	return join(" ", map(keys(fields), field => `${field}=${fields[field]}`));
};


/**
 * Interpret a normal DPP conf object, and apply it to the target.
 *
 * @param {object} uci - UCI cursor.
 * @param {object} conf - DPP config object.
 * @param {string} section_name - Name of iface section.
 * @returns {boolean} - True on successful application.
 */
function apply_dpp_config(uci, conf, section_name) {
	let good_config = true;

	if (!conf.cred?.akm) {
		warn("DPP config missing akm (encryption).\n");
		good_config = false;
	}
	if (!conf.discovery?.ssid) {
		warn("DPP config missing ssid.\n");
		good_config = false;
	}
	if (!conf.cred?.pass) {
		warn("DPP config missing pass.\n");
		good_config = false;
	}

	let encryption = null;
	if (index(conf.cred?.akm, "sae") !== -1) {
		encryption = "sae";
	} else if (index(conf.cred?.akm, "psk") !== -1) {
		encryption = "psk2";
	} else {
		warn(`DPP config has unknown encryption: ${conf.cred.akm}.\n`);
		good_config = false;
	}

	if (!good_config) {
		return false;
	}

	uci.set("wireless", section_name, "encryption", encryption);
	uci.set("wireless", section_name, "ssid", conf.discovery.ssid);
	uci.set("wireless", section_name, "key", conf.cred.pass);
	// If we've come in because of dpp chirping (i.e. qrcode dpp), it needs to be disabled
	// (or even if we've done a dpp PB while chirping is happening).
	uci.delete("wireless", section_name, "dpp");

	return true;
}


/**
 * Applies a DPP config object to the current device.
 *
 * This is designed for STAs, and if the EXTRA_CONF is provided
 * will use that in preference to the ordinary config.
 *
 * @param {uci.cursor} uci - UCI cursor object.
 * @param {object} conf - Received configuration object.
 * @param {object|null} section - Target uci section (null if temporary).
 * @param {boolean} custom_only - Only apply custom conf object.
 * @returns {boolean} - True on success.
 */
export function apply_config(uci, conf, section) {
	if (!conf) {
		warn("No DPP config provided after success.\n");
		return false;
	}

	if (!section && !conf[EXTRA_CONF_NAMESPACE]) {
		warn("Cannot apply config without custom configuration.\n");
		return false;
	}

	if (conf[EXTRA_CONF_NAMESPACE]) {
		if (apply_custom_config(uci, conf[EXTRA_CONF_NAMESPACE])) {
			return true;
		} else {
			warn("Cannot apply custom config.\n");
			if (!section) {
				return false;
			}
		}
	}

	return apply_dpp_config(uci, conf, section);
};
