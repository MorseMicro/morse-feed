"use strict";

import * as leds from "../files/usr/lib/dpp-handler/leds.uc";
const fs = require("fs");


function mock_fs(cb) {
	const old = {
		readfile: fs.readfile,
		writefile: fs.writefile,
		lsdir: fs.lsdir,
	};
	const data = {};
	modules.fs.readfile = (filename) => data[filename];
	modules.fs.writefile = (filename, contents) => { data[filename] = "" + contents; };
	modules.fs.lsdir = function (dir) {
		const result = {};
		for (let filename in data) {
			const m = match(filename, regexp(`${dir}/([^/]*)`));
			if (m) {
				result[m[1]] = true;
			}
		}
		return keys(result);
	};

	try {
		return cb();
	} catch (e) {
		for (let fn_name, fn in old) {
			modules.fs[old] = fn;
		}
		warn(e, "\n");
		warn(e.stacktrace[0].context, "\n");
		assert(false);
	}
};


return {
	set_dpp_started_led_assoc: () => mock_fs(function() {
		fs.writefile("/sys/class/net/wlan0/device/ieee80211/phy0", "");
		fs.writefile("/sys/class/leds/myled/trigger", "none x [phy0assoc] y");
		fs.writefile("/sys/class/leds/otherled/trigger", "[none] x phy0assoc y");
		leds.set_dpp_started_led("wlan0");
		assert(fs.readfile("/sys/class/leds/myled/trigger") === "timer");
		assert(fs.readfile("/sys/class/leds/myled/delay_off") === "1000");
		assert(fs.readfile("/sys/class/leds/myled/delay_on") === "1000");
		assert(fs.readfile("/sys/class/leds/otherled/trigger") === "[none] x phy0assoc y");
		leds.restore_dpp_led("wlan0");
	}),

	set_dpp_failed_led_assoc: () => mock_fs(function() {
		fs.writefile("/sys/class/net/wlan0/device/ieee80211/phy0", "");
		fs.writefile("/sys/class/leds/myled/trigger", "none x [phy0assoc] y");
		fs.writefile("/sys/class/leds/otherled/trigger", "[none] x phy0assoc y");
		leds.set_dpp_failed_led("wlan0");
		assert(fs.readfile("/sys/class/leds/myled/trigger") === "timer");
		assert(fs.readfile("/sys/class/leds/myled/delay_off") === "100");
		assert(fs.readfile("/sys/class/leds/myled/delay_on") === "100");
		assert(fs.readfile("/sys/class/leds/otherled/trigger") === "[none] x phy0assoc y");
		leds.restore_dpp_led("wlan0");
	}),

	set_restore_dpp_led_assoc: () => mock_fs(function() {
		fs.writefile("/sys/class/net/wlan0/device/ieee80211/phy0", "");
		fs.writefile("/sys/class/leds/myled/trigger", "none x [phy0assoc] y");
		fs.writefile("/sys/class/leds/otherled/trigger", "[none] x phy0assoc y");
		leds.set_dpp_started_led("wlan0");
		leds.set_dpp_failed_led("wlan0");
		leds.restore_dpp_led("wlan0");
		assert(fs.readfile("/sys/class/leds/myled/trigger") === "phy0assoc");
		assert(fs.readfile("/sys/class/leds/otherled/trigger") === "[none] x phy0assoc y");
		assert(fs.readfile("/sys/class/leds/myled/brightness") === "255");
	}),

	netdev_multi_led_sequence: () => mock_fs(function() {
		fs.writefile("/sys/class/net/wlan0/device/ieee80211/phy0", "");
		fs.writefile("/sys/class/leds/myled/trigger", "none x [netdev] y");
		fs.writefile("/sys/class/leds/myled/device_name", "wlan0");
		fs.writefile("/sys/class/leds/myled/link", "1");
		fs.writefile("/sys/class/leds/myled/rx", "1");
		fs.writefile("/sys/class/leds/myled/tx", "1");
		fs.writefile("/sys/class/leds/myled/invert", "0");
		fs.writefile("/sys/class/leds/otherled/trigger", "none x [netdev] y");
		fs.writefile("/sys/class/leds/otherled/device_name", "wlan0");
		fs.writefile("/sys/class/leds/otherled/link", "1");
		fs.writefile("/sys/class/leds/otherled/rx", "1");
		fs.writefile("/sys/class/leds/otherled/tx", "1");
		fs.writefile("/sys/class/leds/otherled/invert", "1");

		leds.set_dpp_started_led("wlan0");
		assert(fs.readfile("/sys/class/leds/otherled/trigger") === "none");
		assert(fs.readfile("/sys/class/leds/myled/trigger") === "timer");
		assert(fs.readfile("/sys/class/leds/myled/delay_off") === "1000");
		assert(fs.readfile("/sys/class/leds/myled/delay_on") === "1000");

		leds.set_dpp_failed_led("wlan0");
		assert(fs.readfile("/sys/class/leds/otherled/trigger") === "none");
		assert(fs.readfile("/sys/class/leds/myled/trigger") === "timer");
		assert(fs.readfile("/sys/class/leds/myled/delay_off") === "100");
		assert(fs.readfile("/sys/class/leds/myled/delay_on") === "100");

		// Need to explicitly remove params (as won't be removed automatically)
		// so we can check restore works.
		for (let led in ["myled", "otherled"]) {
			for (let param in ["device_name", "link", "rx", "tx", "invert"]) {
				fs.writefile(`/sys/class/leds/${led}/${param}`, "");
			}
		}
		leds.restore_dpp_led("wlan0");
		assert(fs.readfile("/sys/class/leds/myled/trigger") === "netdev");
		assert(fs.readfile("/sys/class/leds/myled/device_name") === "wlan0");
		assert(fs.readfile("/sys/class/leds/myled/link") === "1");
		assert(fs.readfile("/sys/class/leds/myled/rx") === "1");
		assert(fs.readfile("/sys/class/leds/myled/tx") === "1");
		assert(fs.readfile("/sys/class/leds/myled/invert") === "0");
		assert(fs.readfile("/sys/class/leds/otherled/trigger") === "netdev");
		assert(fs.readfile("/sys/class/leds/otherled/device_name") === "wlan0");
		assert(fs.readfile("/sys/class/leds/otherled/link") === "1");
		assert(fs.readfile("/sys/class/leds/otherled/rx") === "1");
		assert(fs.readfile("/sys/class/leds/otherled/tx") === "1");
		assert(fs.readfile("/sys/class/leds/otherled/invert") === "1");

		assert(fs.readfile("/sys/class/leds/otherled/brightness") === "255");
	}),
};
