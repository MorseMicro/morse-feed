'use strict';

/* globals baseclass rpc */
'require baseclass';
'require rpc';

var remoteRequest = rpc.declare({
	object: 'rangetest-remote-rpc',
	method: 'request',
	params: ['uri', 'body'],
	nobatch: true, // If one batched request hangs, all others will hang too.
});

var RemoteRpcClass = rpc.constructor.extend({
	remoteRpcRequestId: 1,
	remoteRpcBaseUrl: null,
	remoteRpcSessionId: '00000000000000000000000000000000',

	expires: 0,
	message: {
		jsonrpc: '2.0',
		id: 0,
		method: 'call',
		params: [
			'00000000000000000000000000000000',
			'session',
			'login',
			{
				username: 'root',
				password: '',
			},
		],
	},

	__currentTime: () => Math.floor(Date.now() / 1000),

	__login: function () {
		return remoteRequest(this.remoteRpcBaseUrl, this.message);
	},

	__checkLogin: function () {
		if (this.__currentTime() > this.expires) {
			return this.__login()
				.then((response) => {
					const result = this.__parseCallReply(response, true);
					this.remoteRpcSessionId = result.ubus_rpc_session;
					this.expires = this.__currentTime() + result.expires;
				});
		}
		return Promise.resolve();
	},

	__call: async function (method, params, requiresLogin = true) {
		if (this.remoteRpcBaseUrl === undefined) {
			throw new Error('No URL set for remote RPC call!');
		}

		if (requiresLogin) {
			await this.__checkLogin();
		}

		const req = {
			jsonrpc: '2.0',
			id: 0,
			method: 'call',
			params: [this.remoteRpcSessionId, 'rangetest', method, params],
		};

		const rpcResponse = await remoteRequest(this.remoteRpcBaseUrl, req);
		return this.__parseCallReply(rpcResponse);
	},

	__parseCallReply: function (response, isAuthCheck = false) {
		// Internal error: if response is a single number it means that
		// it produced a failure on the internal ubus dispatching object.
		// Fails on bad URLs, bad endpoints
		if (Number.isInteger(response)) {
			const message = rpc.getStatusText(response) || 'Unknown';

			if (isAuthCheck) {
				throw new Error(`Unable to reach ${this.remoteRpcBaseUrl}, please ensure the device is reachable on the network.`, { cause: 'offline' });
			} else {
				throw new Error(`Request to ${this.remoteRpcBaseUrl} failed with: ${message} (${response})`);
			}
		}

		// RPC error
		if (response.error || !response.result) {
			const returnCode = response.error.code || 'Unknown';
			const message = response.error.message || 'Unknown';
			throw new Error(`Request to ${this.remoteRpcBaseUrl} failed with: ${message} (${returnCode})`);
		}

		// UBUS error
		if (response.result && Array.isArray(response.result) && response.result.length === 1) {
			const returnCode = response.result[0];
			// Certain commands use the 'Command OK' (0) status code
			if (returnCode === 0) {
				return response.result[0];
			} else if (isAuthCheck && returnCode === 6) {
				throw new Error(`Login attempt to ${this.remoteRpcBaseUrl} failed, please try again with a different password.`, { cause: 'auth' });
			} else {
				throw new Error(`Request to ${this.remoteRpcBaseUrl} failed with UBUS code: ${returnCode}`);
			}
		}

		return response.result[1];
	},

	backgroundIperf3Server: async function () {
		return this.__call('background_iperf3_server', {});
	},

	getBackground: async function (id) {
		return this.__call('get_background', { id: id });
	},

	iwStationDump: async function () {
		return this.__call('iw_station_dump', {});
	},

	morseCliStatsReset: async function () {
		return this.__call('morse_cli_stats_reset', {});
	},

	morseCliStats: async function () {
		return this.__call('morse_cli_stats', {});
	},

	ipLink: async function () {
		return this.__call('ip_link', {});
	},

	info: async function () {
		return this.__call('info', {}, false);
	},

	/**
	 * Returns the current RPC session id.
	 *
	 * @returns {string}
	 * Returns the 32 byte session ID string used for authenticating remote
	 * requests.
	 */
	getSessionID: function () {
		return this.remoteRpcSessionId;
	},

	/**
	 * Set the RPC session id to use.
	 *
	 * @param {string} sid
	 * Sets the 32 byte session ID string used for authenticating remote
	 * requests.
	 */
	setSessionID: function (sid) {
		this.remoteRpcSessionId = sid;
	},

	/**
	 * Returns the current RPC base URL.
	 *
	 * @returns {string}
	 * Returns the RPC URL endpoint to issue requests against.
	 */
	getBaseURL: function () {
		return this.remoteRpcBaseUrl;
	},

	/**
	 * Set the RPC base URL to use.
	 *
	 * @param {string} sid
	 * Sets the RPC URL endpoint to issue requests against.
	 */
	setBaseURL: function (url) {
		this.remoteRpcBaseUrl = url;
	},

	/**
	 * Set the RPC password to use.
	 *
	 * @param {string} password
	 * Sets the plaintext password to use for session auth, only setting
	 * it if it isn't empty.
	 */
	setPassword: function (password) {
		if (password) {
			this.message.params[3].password = password;
		}
	},
});

var RemoteDeviceFactory = baseclass.extend({
	load: (url, password) => {
		var remoteRpc = new RemoteRpcClass();
		remoteRpc.setBaseURL('http://' + url + '/ubus/');
		remoteRpc.setPassword(password);
		return remoteRpc;
	},
});

return RemoteDeviceFactory;
