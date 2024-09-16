/* Prplmesh topology viewer.
 *
 * Copyright 2024 Morse Micro
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

/* globals baseclass rpc Viva */
'require baseclass';
'require rpc';

const callDeviceWiFiDataElementsNetworkGet = rpc.declare({
	object: 'Device.WiFi.DataElements.Network',
	method: '_get',
	params: ['depth'],
});

const PRERENDER_ITERATIONS = 1000;

/**
 * Unpack flattened ubus style data model into deeply nested data.
 *
 * i.e. something like:
 *      "Device.WiFi.DataElements.Network.Device.3.Interface.1.": {
 *          "NeighborNumberOfEntries": 0,
 *          "MediaType": 265,
 *          "Name": "0c:bf:74:68:08:69",
 *          "Status": "Up",
 *          "MACAddress": "0c:bf:74:68:08:69"
 *      },
 *
 * becomes:
 *
 * {"Device": "WiFi": {"DataElements": {"Network": {"Device": [
 *     null,
 *     null,
 *     {"Interface": [{
 *         "NeighborNumberOfEntries": 0,
 *         "MediaType": 265,
 *         "Name": "0c:bf:74:68:08:69",
 *         "Status": "Up",
 *         "MACAddress": "0c:bf:74:68:08:69"
 *     }]}
 * }
 */
function unpackDataModel(data) {
	function unpackKey(d, k, v) {
		let firstKey = k.split('.', 1)[0];
		const remainingKey = k.slice(firstKey.length + 1);
		const isNumber = /^\d+$/.test(firstKey);
		if (isNumber) {
			firstKey = Number(firstKey) - 1;
		}

		if (isNumber != Array.isArray(d)) {
			console.error('Unexpected data when parsing Device.Wifi.DataElements.Network:', d, k, v);
			return;
		}

		if (!remainingKey) {
			if (typeof v === 'string') {
				if (d[firstKey]) {
					throw new Error(`overwriting - invalid structure ${firstKey} - ${k}`);
				}
				d[firstKey] = v;
			} else {
				Object.assign(d[firstKey] ??= {}, v);
			}
		} else {
			if (!d[firstKey]) {
				// NB this fails if the final key is empty; it's impossible
				// to tell if it should be an array or an empty object,
				// So whatever interprets this needs to be smart enough to
				// treat an empty object as an empty array (if it should be).
				d[firstKey] = /^\d+\./.test(remainingKey) ? [] : {};
			}
			unpackKey(d[firstKey], remainingKey, v);
		}
	}

	const outputData = {};
	// We sort the input by the length of the string because the longer
	// strings give us more insight into whether we should store arrays
	// or objects in a particular location.
	const inputData = [...Object.entries(data)].sort((a, b) => b[0].length - a[0].length);

	for (const [k, v] of inputData) {
		if (!v) {
			continue;
		}
		unpackKey(outputData, k, v);
	}

	return outputData;
}

// Because of the creative flattened structure of the data, we can't easily distinguish
// empty arrays from empty objects, AND many of the arrays are sparse.
// When we expect an array, we used this to 'cast' it to an iterable.
function *validItems(arr) {
	if (!Array.isArray(arr)) {
		return;
	}

	for (const x of arr) {
		if (x) {
			yield x;
		}
	}
}

class PrplmeshTopologyGraph {
	constructor(topoData, interactive = true, nodeWidth = 240, nodeHeight = 100) {
		this.interactive = interactive;
		this.nodeHeight = nodeHeight;
		this.nodeWidth = nodeWidth;
		this.stateInfo = this.buildGraph(topoData);
	}

	/**
	 * Returns a set representing the current state of the topology.
	 *
	 * Basically a unstructured bucket where we can throw information
	 * about nodes, and if we compare these can easily detects interesting changes.
	 */
	getStateInfo() {
		return this.stateInfo;
	}

	/**
	 * Build a vivagraphjs graph from the destructured ubus data.
	 *
	 * Usually this is just called from the constructor.
	 * Because my understanding of this data format was reverse engineered and
	 * not based on a particular schema, we attempt to just ignore anything
	 * that doesn't match the expected types.
	 */
	buildGraph(topoData) {
		const graph = this.graph = Viva.Graph.graph();
		const stateInfo = new Set();
		const network = topoData?.Device?.WiFi?.DataElements?.Network;
		if (!network) {
			return graph;
		}

		const controllerId = network.ControllerID;

		// Map any of the associated identifiers to a single identifier
		// (pref radio MAC address for clarity).
		const idMap = {};
		for (const device of validItems(network.Device)) {
			let myID = validItems(device.Radio).next().value?.ID || device.ID;

			idMap[device.ID] = myID;

			for (const radio of validItems(device.Radio)) {
				idMap[radio.ID] = myID;
			}

			for (const iface of validItems(device.Interface)) {
				idMap[iface.MACAddress] = myID;
				idMap[iface.Name] = myID;
			}
		}

		// Add devices that are mesh agents.
		// Construct this before we try to add graph links,
		// as when we process the radio data we also addNodes
		// that are missing (and assume they're clients).
		for (const device of validItems(network.Device)) {
			// Check the status of both the HaLow radio and the interface
			// to determine the status of the Agent, because at times (after reboot)
			// the radio state is not updated in the data model
			const halowIfaceEnabled = Array.from(validItems(device.Interface))
				.some(iface => iface.MediaType === 'IEEE_802_11AH' && iface.Status === 'Up');
			const radio = validItems(device.Radio).next().value;
			const radioEnabled = !!(radio?.Enabled) || halowIfaceEnabled;

			graph.addNode(idMap[device.ID], {
				controller: device.ID === controllerId,
				agent: true,
				macAddress: idMap[device.ID],
				backhaulMacAddress: device.MultiAPDevice?.Backhaul?.BackhaulMACAddress,
				enabled: radioEnabled,
				channel: radio?.CurrentOperatingClasses?.['1']?.Channel,
				model: device.ManufacturerModel, // This (and serialnumber) are hard-coded atm...
			});
			stateInfo.add(`node:${idMap[device.ID]}:${radioEnabled}`);
		}

		// Add links based on AP connections
		for (const device of validItems(network.Device)) {
			for (const radio of validItems(device.Radio)) {
				for (const bss of validItems(radio.BSS)) {
					for (const sta of validItems(bss.STA)) {
						const id = idMap[sta.MACAddress] || sta.MACAddress;
						if (!graph.hasNode(id)) {
							stateInfo.add(`node:${id}:true`);
							graph.addNode(id, { controller: false, agent: false, enabled: true, macAddress: sta.MACAddress });
						}

						graph.addLink(idMap[device.ID], id, {
							signalStrength: sta.SignalStrength,
						});
					}
				}
			}
		}

		// Add links that don't exist based on mesh topology.
		for (const device of validItems(network.Device)) {
			for (const iface of validItems(device.Interface)) {
				if (!iface.Neighbor) {
					continue;
				}

				for (const neighbor of Object.values(iface.Neighbor)) {
					if (!graph.hasLink(idMap[device.ID], idMap[neighbor.ID])) {
						graph.addLink(idMap[device.ID], idMap[neighbor.ID], {
							signalStrength: 'unknown',
						});
					}
				}
			}
		}

		return stateInfo;
	}

	findRoleDisplay(data) {
		if (data.controller && data.agent) {
			return 'Controller/Agent';
		} else if (data.controller) {
			return 'Controller';
		} else if (data.agent) {
			return 'Agent';
		} else {
			return 'Client';
		}
	}

	renderNode(node) {
		return `
			<div
				class="
					node
					${node.data.agent ? 'node-agent' : ''}
					${node.data.controller ? 'node-controller' : ''}
					${node.data.enabled ? '' : 'node-disabled'}
				"
				style="
					width: ${this.nodeWidth - 8}px;
					height: ${this.nodeHeight - 8}px;
				"
				xmlns="http://www.w3.org/1999/xhtml"
				title="${node.data.enabled ? 'active' : 'offline'}"
			>
				<div>
				${node.data.model ? `<strong>${node.data.model}</strong><br>` : ''}
				${this.findRoleDisplay(node.data)} ${node.data.channel ? `(Ch: ${node.data.channel})` : ''}<br>
				<strong><code>${node.data.macAddress}</code></strong><br>
				${node.data.backhaulMacAddress ? `<div><small><strong>Backhaul:</strong> <code>${node.data.backhaulMacAddress}</code></small><br>` : ''}
				</div>
			</div>
		`;
	}

	renderTo(container) {
		const graphics = Viva.Graph.View.svgGraphics()
			.node((node) => {
				const foreignObject = Viva.Graph.svg('foreignObject').attr('width', this.nodeWidth).attr('height', this.nodeHeight);
				foreignObject.insertAdjacentHTML('beforeend', this.renderNode(node));
				return foreignObject;
			})
			.placeNode((nodeUI, pos) => {
				// Shift so that boxes are centered.
				nodeUI.attr('x', pos.x - this.nodeWidth / 2).attr('y', pos.y - this.nodeHeight / 2);
			})
			.link((link) => {
				const titleLine = Viva.Graph.svg('line').attr('stroke-width', 20).attr('stroke', 'black').attr('stroke-opacity', 0);
				const title = Viva.Graph.svg('title');
				title.textContent = `Signal strength: ${link.data?.signalStrength}`;
				titleLine.append(title);
				const g = Viva.Graph.svg('g');
				g.append(Viva.Graph.svg('line').attr('stroke', 'black').attr('stroke-width', 2));
				g.append(titleLine);
				return g;
			})
			.placeLink((link, from, to) => {
				for (const line of link.querySelectorAll('line')) {
					line.attr('x1', from.x);
					line.attr('y1', from.y);
					line.attr('x2', to.x);
					line.attr('y2', to.y);
				}
				return link;
			});

		const layout = Viva.Graph.Layout.forceDirected(this.graph, {
			springLength: Math.max(this.nodeHeight, this.nodeWidth) * 1.2,
			gravity: -3, // Need to increase gravity as nodes are large.
		});

		// specify where it should be rendered:
		const renderer = Viva.Graph.View.renderer(this.graph, {
			graphics,
			layout,
			container,
			interactive: this.interactive, // whether the user can move nodes around
			prerender: PRERENDER_ITERATIONS, // Avoids jumpiness at start
		});

		renderer.run();

		// Hack: Render needs to reset after the div has been inserted in the DOM
		// as the VivaGraph code calculates offsets based on the current container.
		setTimeout(() => renderer.reset(), 0);

		return renderer;
	}
}

/**
 * PrplmeshTopologyData provides helpers to interact with Device.WiFi.DataElements.Network
 * (which, despite its naming, it coming from prplmesh/beerocks).
 */
class PrplmeshTopologyData {
	constructor(topoData) {
		this.topoData = topoData;
	}

	buildGraph() {
		return new PrplmeshTopologyGraph(this.topoData);
	}

	countAgents() {
		const network = this.topoData?.Device?.WiFi?.DataElements?.Network;
		if (!network) {
			return 0;
		}

		const controllerId = network.ControllerID;

		let count = 0;
		for (const device of validItems(network.Device)) {
			// Don't count agent that's running on controller
			// to avoid user confusion.
			if (device.ID === controllerId) {
				continue;
			}

			// Check the status of both the HaLow radio and the interface
			// to determine the status of the Agent, because at times (after reboot)
			// the radio state is not updated in the data model
			const halowIfaceEnabled = Array.from(validItems(device.Interface))
				.some(iface => iface.MediaType === 'IEEE_802_11AH' && iface.Status === 'Up');
			const radio = validItems(device.Radio).next().value;
			const radioEnabled = !!(radio?.Enabled) || halowIfaceEnabled;
			if (radioEnabled) {
				count += 1;
			}
		}

		return count;
	}
}

return baseclass.extend({
	async load() {
		const [data] = await Promise.all([
			unpackDataModel(await callDeviceWiFiDataElementsNetworkGet(10)),
			import('./vivagraph.min.js'),
		]);
		return new PrplmeshTopologyData(data);
	},
});
