'use strict';
/* globals baseclass rpc */
'require baseclass';
'require rpc';

/* Helpers to interact with actual device info.
 * (cf uci.js, which is purely UCI config manipulation).
 */

const MORSE_OUI = '0c:bf:74';

const callGetNetworkDevices = rpc.declare({
	object: 'luci-rpc',
	method: 'getNetworkDevices',
});

/**
 * Find the Morse device physical interface name (not the uci name)
 * by checking for the MorseMicro OUI.
 *
 * @returns {Promise<String>} interface name (e.g. wlan0)
 */
async function getMorseDeviceInterface() {
	const devices = Object.values(await callGetNetworkDevices());
	const morseDevice = devices.find(d => d.devtype == 'wlan' && d.mac.toLowerCase().startsWith(MORSE_OUI));

	return morseDevice?.name;
}

return baseclass.extend({
	getMorseDeviceInterface,
});
