/**
 * Manage DPP LED states.
 *
 * DPP LEDs are flashing, and they temporarily supplant existing LEDs.
 * LEDs must be restored on DPP completion on an iface.
 */
"use strict";

const DPP_STARTED_LED_INTERVAL = 1000;
const DPP_FAILED_LED_INTERVAL = 100;
const IFACE_LED_STATE = {};  // iface -> { name, initial_trigger, initial_state }
const IFACE_TO_PHY = {};  // e.g. wlan0 -> phyX; useful for ifaces that are removed

// Importing this way makes it possible to mock out individual functions.
const fs = require("fs");


function write_led(led_name, key, val) {
	fs.writefile(`/sys/class/leds/${led_name}/${key}`, val);
}


function read_led(led_name, key) {
	return trim(fs.readfile(`/sys/class/leds/${led_name}/${key}`));
}


function read_led_keys(led_name, keys) {
	const output = {};
	for (let key in keys) {
		output[key] = read_led(led_name, key);
	}
	return output;
}


export function force_ifaces_for_phy(phy) {
	const ls_ifaces = fs.lsdir(`/sys/class/ieee80211/${phy}/device/net`);
	for (let iface in (ls_ifaces ?? [])) {
		IFACE_TO_PHY[iface] = phy;
	}
};


function get_phy(ifname) {
	const ls_phy = fs.lsdir(`/sys/class/net/${ifname}/device/ieee80211`);
	if (ls_phy && ls_phy[0]) {
		return ls_phy[0];
	} else {
		return IFACE_TO_PHY[ifname];
	}
}


/**
 * Extract the current trigger
 *
 * Sysfs will give a list of all possible triggers, with the selected one
 * having [] around it. This will give only that trigger.
 */
function get_trigger(led_name) {
	const m = match(read_led(led_name, "trigger"), /\[([^]]*)\]/);
	return m && m[1];
}


/**
 * Return LED(s) related to iface that can be used for DPP.
 *
 * Currently, this only support the LEDs we expect to see:
 *	- netdev (with device_name/link)
 *	- phyXassoc
 */
function find_iface_leds(iface) {
	const existing_leds = IFACE_LED_STATE[iface];
	if (existing_leds) {
		return existing_leds;
	}

	const phy = get_phy(iface);
	if (!phy) {
		return;
	}

	let netdev_leds = [];
	let assoc_leds = [];
	let netdev_other_iface_leds = [];
	for (let name in fs.lsdir('/sys/class/leds')) {
		const initial_trigger = get_trigger(name);
		switch (initial_trigger) {
		case 'netdev':
			const initial_state = read_led_keys(name, ["device_name", "link", "rx", "tx", "invert"]);
			if (initial_state.link === "1") {
				if (initial_state.device_name === iface) {
					push(netdev_leds, {name, initial_trigger, initial_state});
				} else if (phy === get_phy(initial_state.device_name)) {
					// This captures the 2.4 AP LED which we want to reassign
					// to our temporary interface.
					push(netdev_other_iface_leds, {name, initial_trigger, initial_state});
				}
			}
			break;
		case `${phy}assoc`:
			push(assoc_leds, {name, initial_trigger, initial_state: {}});
			break;
		}
	}

	if (length(netdev_leds) > 0) {
		IFACE_LED_STATE[iface] = netdev_leds;
	} else if (length(assoc_leds) > 0) {
		IFACE_LED_STATE[iface] = assoc_leds;
	} else if (length(netdev_other_iface_leds) > 0) {
		IFACE_LED_STATE[iface] = netdev_other_iface_leds;
	} else {
		return [];
	}

	return IFACE_LED_STATE[iface];
}


function set_dpp_flash(iface, interval) {
	for (let led in find_iface_leds(iface)) {
		// This trickiness helps us handle the LED on the EKH03/04, which
		// is an RGB led with the three LEDs wired separately.
		// The Green LED is used on an invert trigger here so that
		// when the link is _not_ up, it shows green (for booted),
		// vs purple for HaLow connected. However, we need to disable this
		// inverted LED to avoid a green/white flash instead of an off/purple
		// flash.
		if (led.initial_trigger === "netdev" && led.initial_state.invert === "1") {
			write_led(led.name, "trigger", "none");
		} else {
			write_led(led.name, "trigger", "timer");
			write_led(led.name, "delay_off", interval);
			write_led(led.name, "delay_on", interval);
		}
	}
}


export function set_dpp_started_led(iface) {
	set_dpp_flash(iface, DPP_STARTED_LED_INTERVAL);
};


export function set_dpp_failed_led(iface) {
	set_dpp_flash(iface, DPP_FAILED_LED_INTERVAL);
};


export function restore_dpp_led(iface) {
	const existing_leds = IFACE_LED_STATE[iface] ?? [];
	for (let led in find_iface_leds(iface)) {
		write_led(led.name, "trigger", led.initial_trigger);
		for (let key, val in led.initial_state) {
			if (val) {
				write_led(led.name, key, val);
			}
		}
	}

	delete IFACE_LED_STATE[iface];
};
