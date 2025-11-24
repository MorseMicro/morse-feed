"use strict";

import * as wizard from "../files/usr/share/ucode/dpp/wizard.uc";


const MockUCICursor = {
	new: function (data) {
		return proto({data}, this);
	},

	set: function (config, section, option, value) {
		if (!this.data[config]) {
			return;
		}

		// set() API is a little weird; "" removes, and null
		// lets you construct a new section.
		if (value === "") {
			delete this.data[config][section][value];
		} else if (value === null) {
			assert(!this.data[config][section]);
			this.data[config][section] = {
				".type": option,
			};
		} else {
			if (!this.data[config]?.[section]) {
				return;
			}

			this.data[config][section][option] = value;
		}
	},

	delete: function (config, section, option) {
		if (this.data[config] && this.data[config][section]) {
			delete this.data[config][section][option];
		}
	},

	get: function (config, section, option) {
		return this.data[config]?.[section]?.[option];
	},

	get_all: function (config) {
		return this.data[config];
	},

	// Simulate UCI load: returns true if the config namespace exists
	load: function (config) {
		return !!this.data[config];
	},
};

function mock_ap_uci_data() {
	return {
		wireless: {
			radio0: {
				".type": "wifi-device",
				type: "mac80211",
			},
			radio1: {
				".type": "wifi-device",
				type: "morse",
				country: "AU",
				channel: "44",
				s1g_chzn: "80211_2020",
			},
			default_radio0: {
				".type": "wifi-iface",
				device: "radio0",
				mode: "ap",
				ssid: "mockaltssid",
				key: "mockaltpass",
				encryption: "psk2",
				network: "lan",
			},
			default_radio1: {
				".type": "wifi-iface",
				device: "radio1",
				mode: "ap",
				ssid: "mockssid",
				key: "mockpass",
				encryption: "sae",
				network: "lan",
			},
			mesh_radio1: {
				".type": "wifi-iface",
				device: "radio1",
				mode: "mesh",
				mesh_id: "mockmeshid",
				key: "mockpass",
				encryption: "sae",
				network: "lan",
				disabled: "1",
			},
		},
		prplmesh: {
			config: {
			},
		},
	};
}

function mock_extender_uci_data() {
	return {
		wireless: {
			radio0: {
				".type": "wifi-device",
				type: "mac80211",
			},
			radio1: {
				".type": "wifi-device",
				type: "morse",
			},
			default_radio1: {
				".type": "wifi-iface",
				device: "radio1",
				mode: "sta",
				network: "lan",
			},
		},
		network: {
			lan: {
				proto: "static",
				device: "br-lan",
			},
			"br-lan": {
				name: "br-lan",
				type: "bridge",
			},
		},
		prplmesh: {
			config: {
			},
		},
		dhcp: {
			lan: {},
		},
		uhttpd: {
			main: {
				home:  "/www-client-config",
			},
		},
		luci: {
			main: {
				homepage:  "admin/morse/morseaplanding",
			},
		},
	};
}

function unpack_dpp_command(command) {
	const result = {};
	for (let part in split(command, " ")) {
		const k_v = split(part, "=");
		let val = k_v[1];
		if (k_v[0] in ["ssid", "pass", "conf_extra_value"]) {
			val = hexdec(k_v[1]);
		}
		result[k_v[0]] = val;
	}
	return result;
}

function assert_initial_config_removed(uci) {
	assert(uci.get("network", "lan", "proto") === "dhcp");
	assert(uci.get("dhcp", "lan", "ignore") === "1");
	assert(uci.get("uhttpd", "main", "home") === "/www");
	assert(!uci.get("luci", "main", "homepage"));
}

return {
	generate_dpp_command_halow_standard: function () {
		const uci = MockUCICursor.new(mock_ap_uci_data());
		const dpp_command = wizard.generate_dpp_command(uci, "default_radio1");
		assert(dpp_command);
		const result = unpack_dpp_command(dpp_command);
		assert(result.conf === "sta-sae");
		assert(result.pass === "mockpass");
		assert(result.ssid === "mockssid");
		assert(result.conf_extra_name === "com.morsemicro.wizard");
		const conf_extra = json(result.conf_extra_value);
		assert(conf_extra.mode === "standard");
		assert(conf_extra.ssid === "mockssid");
		assert(conf_extra.key === "mockpass");
		assert(conf_extra.encryption === "sae");
		assert(conf_extra.country === "AU");
		assert(conf_extra.channel === "44");
		assert(conf_extra.s1g_chzn === "80211_2020");
	},

	generate_dpp_command_other_standard: function () {
		const uci = MockUCICursor.new(mock_ap_uci_data());
		const dpp_command = wizard.generate_dpp_command(uci, "default_radio0");
		assert(dpp_command);
		const result = unpack_dpp_command(dpp_command);
		assert(result.conf === "sta-psk");
		assert(result.pass === "mockaltpass");
		assert(result.ssid === "mockaltssid");
		assert(result.conf_extra_name === "com.morsemicro.wizard");

		// Extra conf stays on normal halow conf.
		const conf_extra = json(result.conf_extra_value);
		assert(conf_extra.mode === "standard");
		assert(conf_extra.ssid === "mockssid");
		assert(conf_extra.key === "mockpass");
		assert(conf_extra.encryption === "sae");
		assert(conf_extra.country === "AU");
		assert(conf_extra.channel === "44");
		assert(conf_extra.s1g_chzn === "80211_2020");
	},

	generate_dpp_command_prplmesh: function () {
		const uci = MockUCICursor.new(mock_ap_uci_data());
		uci.set("prplmesh", "config", "enable", "1");
		const dpp_command = wizard.generate_dpp_command(uci, "default_radio1");
		assert(dpp_command);
		const result = unpack_dpp_command(dpp_command);
		assert(result.conf === "sta-sae");
		assert(result.pass === "mockpass");
		assert(result.ssid === "mockssid");
		assert(result.conf_extra_name === "com.morsemicro.wizard");

		const conf_extra = json(result.conf_extra_value);
		assert(conf_extra.mode === "prplmesh");
		assert(conf_extra.ssid === "mockssid");
		assert(conf_extra.key === "mockpass");
		assert(conf_extra.encryption === "sae");
		assert(conf_extra.country === "AU");
		assert(conf_extra.channel === "44");
		assert(conf_extra.s1g_chzn === "80211_2020");
	},

	generate_dpp_command_mesh11s: function () {
		const uci = MockUCICursor.new(mock_ap_uci_data());
		uci.set("wireless", "mesh_radio1", "disabled", "0");
		const dpp_command = wizard.generate_dpp_command(uci, "default_radio1");
		assert(dpp_command);
		const result = unpack_dpp_command(dpp_command);
		assert(result.conf === "sta-sae");
		assert(result.pass === "mockpass");
		assert(result.ssid === "mockssid");
		assert(result.conf_extra_name === "com.morsemicro.wizard");

		const conf_extra = json(result.conf_extra_value);
		assert(conf_extra.mode === "mesh11s");
		assert(conf_extra.mesh_id === "mockmeshid");
		assert(conf_extra.key === "mockpass");
		assert(conf_extra.encryption === "sae");
		assert(conf_extra.country === "AU");
		assert(conf_extra.channel === "44");
		assert(conf_extra.s1g_chzn === "80211_2020");
	},

	generate_dpp_command_unsupported_encryption_returns_null: function () {
		const uci = MockUCICursor.new(mock_ap_uci_data());
		uci.set("wireless", "default_radio1", "encryption", "wep");
		const dpp_command = wizard.generate_dpp_command(uci, "default_radio1");
		assert(dpp_command === null);
	},

	generate_dpp_command_no_dppable_ifaces_returns_null: function () {
		const uci = MockUCICursor.new(mock_ap_uci_data());
		uci.set("prplmesh", "config", "enable", "0");
		uci.set("wireless", "default_radio1", "mode", "sta");
		const dpp_command = wizard.generate_dpp_command(uci, "default_radio1");
		assert(dpp_command === null);
	},

	apply_config_no_custom: function () {
		const uci = MockUCICursor.new(mock_extender_uci_data());
		uci.set("wireless", "default_radio1", "dpp", "1");

		const dpp_conf = {
			cred: {
				akm: "sae",
				pass: "mockpass",
			},
			discovery: {
				ssid: "mockssid",
			},
		};
		assert(wizard.apply_config(uci, dpp_conf, "default_radio1"));

		assert(uci.get("wireless", "default_radio1", "ssid") === "mockssid");
		assert(uci.get("wireless", "default_radio1", "key") === "mockpass");
		assert(uci.get("wireless", "default_radio1", "encryption") === "sae");
		assert(uci.get("wireless", "default_radio1", "dpp") === null);

		assert_initial_config_removed(uci);
	},

	apply_config_custom_standard: function () {
		const uci = MockUCICursor.new(mock_extender_uci_data());
		uci.set("wireless", "default_radio1", "dpp", "1");

		const dpp_conf = {
			cred: {
				akm: "sae",
				pass: "mockpass",
			},
			discovery: {
				ssid: "mockssid",
			},
			"com.morsemicro.wizard": {
				mode: "standard",
				ssid: "mockssid",
				key: "mockpass",
				encryption: "sae",
				country: "AU",
				channel: "44",
				s1g_chzn: "80211_2020",
			},
		};
		assert(wizard.apply_config(uci, dpp_conf, "default_radio1"));

		assert(uci.get("wireless", "default_radio1", "ssid") === "mockssid");
		assert(uci.get("wireless", "default_radio1", "key") === "mockpass");
		assert(uci.get("wireless", "default_radio1", "encryption") === "sae");
		assert(uci.get("wireless", "default_radio1", "dpp") === null);
		assert(uci.get("wireless", "radio1", "country") === "AU");
		assert(uci.get("wireless", "radio1", "s1g_chzn") === "80211_2020");

		assert_initial_config_removed(uci);
	},

	apply_config_custom_standard_without_s1g_chzn: function () {
		const uci = MockUCICursor.new(mock_extender_uci_data());
		uci.set("wireless", "default_radio1", "dpp", "1");

		const dpp_conf = {
			cred: {
				akm: "sae",
				pass: "mockpass",
			},
			discovery: {
				ssid: "mockssid",
			},
			"com.morsemicro.wizard": {
				mode: "standard",
				ssid: "mockssid",
				key: "mockpass",
				encryption: "sae",
				country: "AU",
				channel: "43",
			},
		};
		assert(wizard.apply_config(uci, dpp_conf, "default_radio1"));

		assert(uci.get("wireless", "default_radio1", "ssid") === "mockssid");
		assert(uci.get("wireless", "default_radio1", "key") === "mockpass");
		assert(uci.get("wireless", "default_radio1", "encryption") === "sae");
		assert(uci.get("wireless", "default_radio1", "dpp") === null);
		assert(uci.get("wireless", "radio1", "country") === "AU");
		assert(uci.get("wireless", "radio1", "s1g_chzn") === null);

		assert_initial_config_removed(uci);
	},

	apply_config_prplmesh_success: function () {
		const uci = MockUCICursor.new(mock_extender_uci_data());
		// Ensure prplmesh namespace exists so uci.load("prplmesh") succeeds
		uci.set("prplmesh", "config", "enable", "0");

		const conf = {
			"com.morsemicro.wizard": {
				mode: "prplmesh",
				country: "AU",
				channel: "44",
				ssid: "mockssid",
				key: "mockpass",
				encryption: "sae",
			},
		};
		assert(wizard.apply_config(uci, conf, null));

		// radio settings
		assert(uci.get("wireless", "radio1", "country") === "AU");
		assert(uci.get("wireless", "radio1", "channel") === "44");
		// AP on morse iface
		assert(uci.get("wireless", "default_radio1", "mode") === "ap");
		assert(uci.get("wireless", "default_radio1", "ssid") === "mockssid");
		assert(uci.get("wireless", "default_radio1", "key") === "mockpass");
		// backhaul STA created
		const bh = "default_bh_radio1";
		assert(uci.get("wireless", bh, "mode") === "sta");
		assert(uci.get("wireless", bh, "ssid") === "mockssid");
		assert(uci.get("wireless", bh, "key") === "mockpass");
		assert(uci.get("wireless", bh, "encryption") === "sae");
		assert(uci.get("wireless", bh, "ifname") === "wlan-prpl-1");
		assert(uci.get("wireless", bh, "multi_ap") === "1");
		assert(uci.get("wireless", bh, "wds") === "1");
		// network bridge and prplmesh enabled
		assert(uci.get("network", "lan", "device") === "br-prpl");
		assert(uci.get("network", "br-lan", "name") === "br-prpl");
		assert(uci.get("prplmesh", "config", "enable") === "1");

		assert_initial_config_removed(uci);
	},

	apply_config_mesh11s_success: function () {
		const uci = MockUCICursor.new(mock_extender_uci_data());
		const conf = {
			"com.morsemicro.wizard": {
				mode: "mesh11s",
				country: "AU",
				channel: "44",
				mesh_id: "mockmeshid",
				key: "mockpass",
				encryption: "sae",
			},
		};
		assert(wizard.apply_config(uci, conf, null));
		// Device settings applied
		assert(uci.get("wireless", "radio1", "country") === "AU");
		assert(uci.get("wireless", "radio1", "channel") === "44");
		// The selected morse iface should be converted to mesh
		assert(uci.get("wireless", "default_radio1", "mode") === "mesh");
		assert(uci.get("wireless", "default_radio1", "mesh_id") === "mockmeshid");
		assert(uci.get("wireless", "default_radio1", "ssid") === null);
		assert(uci.get("wireless", "default_radio1", "key") === "mockpass");
		assert(uci.get("wireless", "default_radio1", "encryption") === "sae");

		assert_initial_config_removed(uci);
	},

	apply_config_custom_fail_without_section_returns_false: function () {
		const uci = MockUCICursor.new(mock_extender_uci_data());
		const bad_conf = { "com.morsemicro.wizard": { mode: "prplmesh" } }; // missing required fields
		assert(!wizard.apply_config(uci, bad_conf, null));
	},

	apply_config_custom_fail_with_section_fallback_to_dpp: function () {
		const uci = MockUCICursor.new(mock_extender_uci_data());
		const conf = {
			cred: { akm: "sae", pass: "mockpass" },
			discovery: { ssid: "mockssid" },
			"com.morsemicro.wizard": { mode: "prplmesh" }, // invalid custom -> should fall back
		};
		assert(wizard.apply_config(uci, conf, "default_radio1"));
		assert(uci.get("wireless", "default_radio1", "ssid") === "mockssid");
		assert(uci.get("wireless", "default_radio1", "key") === "mockpass");
		assert(uci.get("wireless", "default_radio1", "encryption") === "sae");

		assert_initial_config_removed(uci);
	},

	apply_config_no_conf_returns_false: function () {
		const uci = MockUCICursor.new(mock_ap_uci_data());
		assert(!wizard.apply_config(uci, null, "default_radio1"));
	},

	apply_config_missing_fields_returns_false: function () {
		const uci = MockUCICursor.new(mock_ap_uci_data());
		// missing cred.pass and cred.akm
		const conf = { discovery: { ssid: "mockssid" } };
		assert(!wizard.apply_config(uci, conf, "default_radio1"));
	},

	has_custom_target_true: function () {
		const uci = MockUCICursor.new(mock_extender_uci_data());
		assert(wizard.has_custom_target(uci));
	},

	has_custom_target_false_if_no_sta: function () {
		const uci = MockUCICursor.new(mock_extender_uci_data());
		uci.set("wireless", "default_radio1", "mode", "mesh");
		assert(!wizard.has_custom_target(uci));
	},

	has_custom_target_false_if_prplmesh: function () {
		const uci = MockUCICursor.new(mock_extender_uci_data());
		uci.set("prplmesh", "config", "enable", "1");
		assert(!wizard.has_custom_target(uci));
	},
};
