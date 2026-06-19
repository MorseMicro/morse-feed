'use strict';
/* globals baseclass network rpc */
'require baseclass';
'require network';
'require rpc';

/* Data-access layer for the HaLow Link Diagnostics app.
 *
 * Two concerns live here, kept together because both are "talk to the device":
 *
 *   § Interface discovery — wraps the LuCI `network` model + iwinfo to find and
 *     describe the HaLow (802.11ah / S1G) AP and STA interfaces.
 *   § ubus RPC            — `rpc.declare` bindings for the two backend objects:
 *       morse.eval.peer_link    — live long-running per-peer estimation
 *       morse.eval.link_planner — one-shot propagation-model planning
 */

/* =========================================================================
 * § Interface discovery
 * ========================================================================= */

/* Returns true when the wifi network is operating in the HaLow (802.11ah)
 * sub-1 GHz band. Mirrors the same check used in luci-mod-home. */
function isHaLow(wifiNetwork) {
	return wifiNetwork.ubus('dev', 'iwinfo', 'hwmodes')?.includes('ah');
}

/* Load all HaLow AP/STA interfaces with their assoclists pre-fetched.
 *
 * Filters out:
 *   - Non-HaLow (non-S1G) wifi networks
 *   - Modes other than 'ap' and 'sta'
 *   - Interfaces without an ifname (unapplied config)
 *
 * Returns: Array of { ifname, mode, network }
 *   where network is the LuCI WifiNetwork object with .assoclist patched in.
 */
async function getS1GInterfaces() {
	const wifiNetworks = await network.getWifiNetworks();

	const patched = await Promise.all(wifiNetworks.map(async (net) => {
		const assoclist = await net.getAssocList();
		net.assoclist = assoclist || [];
		return net;
	}));

	return patched
		.filter((net) => {
			const mode = net.getMode();
			return (mode === 'ap' || mode === 'sta')
				&& isHaLow(net)
				&& !net.isDisabled()
				&& net.isUp()
				&& net.getNetwork();
		})
		.map(net => ({
			ifname: net.getDevice().getName(),
			mode: net.getMode(),
			network: net,
		}));
}

/* Return the list of peer MACs relevant for a given interface entry.
 *
 * AP mode  — all currently associated station MACs from the assoclist.
 * STA mode — the upstream AP's BSSID (from assoclist[0] or getBSSID()).
 *            Returns an empty array when the STA is not connected.
 */
function getPeersForInterface(iface) {
	if (iface.mode === 'ap') {
		return (iface.network.assoclist || []).map(e => e.mac).filter(Boolean);
	}

	/* STA mode: assoclist[0] carries the upstream AP association info when
	 * connected. Fall back to getBSSID() if assoclist is unavailable. */
	const assoc = iface.network.assoclist;
	if (assoc && assoc.length > 0 && assoc[0].mac) {
		return [assoc[0].mac];
	}

	const bssid = iface.network.getBSSID();
	return bssid ? [bssid] : [];
}

/* Structured channel descriptor — returns the individual pieces so the UI
 * can present them as separate chips (Channel / Center Frequency / Bandwidth).
 *
 * Any field may be null when the underlying iwinfo data is unavailable. */
function getChanInfoParts(wifiNetwork) {
	if (!wifiNetwork) return { channel: null, frequency: null, bandwidth: null };

	const freq = wifiNetwork.getFrequency();
	const channel = wifiNetwork.getChannel();
	const frequency = freq ? `${freq} ${wifiNetwork.getFrequencyUnit()}` : null;
	let bandwidth = null;
	if (freq && isHaLow(wifiNetwork)) {
		const bw = wifiNetwork.ubus('dev', 'iwinfo', 'center_width');
		if (bw != null) bandwidth = `${bw} MHz`;
	}
	return { channel, frequency, bandwidth };
}

/* =========================================================================
 * § ubus RPC
 * ========================================================================= */

const peerLinkEstimate = rpc.declare({
	object: 'morse.eval.peer_link',
	method: 'estimate',
	params: ['interface', 'peer'],
});

const peerLinkStop = rpc.declare({
	object: 'morse.eval.peer_link',
	method: 'stop',
	params: ['interface', 'peer'],
});

const peerLinkStatus = rpc.declare({
	object: 'morse.eval.peer_link',
	method: 'status',
	params: ['interface', 'peer'],
});

const linkPlannerEstimate = rpc.declare({
	object: 'morse.eval.link_planner',
	method: 'estimate',
	params: ['interface', 'distance_m', 'attenuation_db', 'fade_margin_db'],
});

const linkPlannerStop = rpc.declare({
	object: 'morse.eval.link_planner',
	method: 'stop',
	params: [],
});

const linkPlannerStatus = rpc.declare({
	object: 'morse.eval.link_planner',
	method: 'status',
	params: [],
});

return baseclass.extend({
	/* § Interface discovery */
	getS1GInterfaces,
	getPeersForInterface,
	isHaLow,
	getChanInfoParts,

	/* § ubus RPC */
	peerLinkEstimate,
	peerLinkStop,
	peerLinkStatus,
	linkPlannerEstimate,
	linkPlannerStop,
	linkPlannerStatus,
});
