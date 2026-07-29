'use strict';
/* globals baseclass rpc uci */
'require baseclass';
'require rpc';
'require uci';

const callUpgradeQuery = rpc.declare({
	object: 'morseupgrade',
	method: 'query',
	params: [],
});

const deviceSearch = rpc.declare({
	object: 'morseupgrade',
	method: 'search',
	params: [],
});

const UpgradeSearch = baseclass.extend({
	queryResult: null,
	repo: null,

	// Call this method in view load to initialize the upgrade search.
	// It will load the information which can be used for repeated searches.
	load: async function () {
		[this.queryResult] = await Promise.all([
			callUpgradeQuery().catch(() => null),
			uci.load('upgrade'),
		]);
		this.repo = uci.get('upgrade', '@upgrade[0]', 'repo');
		return this.queryResult;
	},

	// Extract the version numbers from a version string for display, using the
	// last dash so tagged versions like 'Morse-RTK-1.1.0' parse correctly.
	parseMorseVersionString(morseVersion) {
		morseVersion ??= '';
		const dash = morseVersion.lastIndexOf('-');
		const tail = dash >= 0 ? morseVersion.slice(dash + 1) : morseVersion;
		return tail.split('.').map(Number);
	},

	// Parse a version into a fixed [major, minor, patch, build] array, mirroring
	// the rpcd backend so browser and device comparisons agree exactly.
	parseVersion(version) {
		version ??= '';
		const dash = version.lastIndexOf('-');
		const tail = dash >= 0 ? version.slice(dash + 1) : version;
		const parts = tail.split('.');

		const out = [];
		for (let i = 0; i < 4; i++) {
			const m = (parts[i] ?? '').match(/^[0-9]+/);
			out.push(m ? parseInt(m[0], 10) : 0);
		}
		return out;
	},

	// True if the server version is strictly newer than the device version.
	isNewer(serverVersion, deviceVersion) {
		const a = this.parseVersion(serverVersion);
		const b = this.parseVersion(deviceVersion);
		for (let i = 0; i < 4; i++) {
			if (a[i] != b[i])
				return a[i] > b[i];
		}
		return false;
	},

	// Fetch and parse a JSON file relative to the configured repo. Returns the
	// parsed object, or an HTTPError status object matching the rpcd backend.
	fetchJson: async function (file) {
		const url = `${this.repo}/${file}`;
		try {
			const response = await fetch(url, { cache: 'no-cache' });
			if (!response.ok) {
				return { status: 'HTTPError', error: 'Could not reach upgrade server', code: `${response.status}` };
			}

			const jsonObject = await response.json();
			if (typeof jsonObject != 'object' || jsonObject == null) {
				return { status: 'HTTPError', error: 'Could not reach upgrade server' };
			}

			return jsonObject;
		} catch (e) {
			return { status: 'HTTPError', error: 'Could not reach upgrade server', code: e.message };
		}
	},

	// Look up the single {version, server} rule for this board within one
	// version bucket ("latest" or an explicit running-version key).
	getUpgradeRule(latestJson, boardInfo, bucket) {
		const versionBucket = latestJson[bucket];
		if (typeof versionBucket != 'object' || versionBucket == null)
			return null;

		const rule = versionBucket[boardInfo.board];
		if (typeof rule != 'object' || rule == null)
			return null;

		return rule;
	},

	// Resolve the applicable upgrade rule for this board from latest.json.
	// Returns a single rule object, null when the board is not listed, or a
	// status object on error.
	resolveLatest: async function (boardInfo) {
		const latestJson = await this.fetchJson('latest.json');
		if (latestJson.status)
			return latestJson;

		// A rule keyed by the currently running version takes precedence.
		let upgradeRule = this.getUpgradeRule(latestJson, boardInfo, boardInfo.morse_version);

		// Fall back to the default "latest" rule.
		if (!upgradeRule)
			upgradeRule = this.getUpgradeRule(latestJson, boardInfo, 'latest');

		return upgradeRule;
	},

	getSysupgradeImage: async function (boardInfo, upgradeRule) {
		const base = `${upgradeRule.server}/targets/${boardInfo.target}`;
		const profilesJson = await this.fetchJson(`${base}/profiles.json`);
		if (profilesJson.status)
			return profilesJson;

		let images = null;
		for (const profile of Object.values(profilesJson.profiles ?? {})) {
			if (typeof profile != 'object' || profile == null)
				continue;
			if ((profile.supported_devices ?? []).includes(boardInfo.board)) {
				images = profile.images;
				break;
			}
		}

		if (!Array.isArray(images) || images.length == 0)
			return { status: 'UpdateImageNotFoundError', error: `No images found on upgrade server for ${boardInfo.board}` };

		// Decision is to force people to squashfs.
		const image = images.find(img => typeof img == 'object' && img != null
			&& img.type == 'sysupgrade' && img.filesystem == 'squashfs');

		if (!image?.name)
			return { status: 'UpdateImageNotFoundError', error: `No sysupgrade image found for ${boardInfo.board}` };

		return {
			status: 'UpdateImageFoundOK',
			name: image.name,
			version: profilesJson.version_code,
			filesystem: image.filesystem,
			sum: image.sha256,
			url: `${this.repo}/${base}/${image.name}`,
		};
	},

	// use the browser to search for an upgrade image,
	// mimic the returns of the deviceSearch() rpc call
	browserSearch: async function () {
		// implementers should be responsible for calling upgradeSearch.load() before calling this function
		if (!this.queryResult || !this.repo) {
			throw new Error('upgradesearch not initialized, ensure that upgradeSearch.load() is called first!');
		}

		const boardInfo = this.queryResult;

		if (!boardInfo.board || !boardInfo.morse_version || !boardInfo.target)
			return { status: 'BoardInfoError', error: 'Could not read board information' };

		const upgradeRule = await this.resolveLatest(boardInfo);

		// Failure/status object detected while loading latest.json.
		if (typeof upgradeRule == 'object' && upgradeRule != null && upgradeRule.status)
			return upgradeRule;

		// Board not listed (or deprecated) - nothing to upgrade to.
		if (!upgradeRule || (!upgradeRule.version && !upgradeRule.server))
			return { status: 'NoUpdateNeededOK', message: 'Already up to date!' };

		if (!this.isNewer(upgradeRule.version, boardInfo.morse_version))
			return { status: 'NoUpdateNeededOK', message: 'Already up to date!' };

		return this.getSysupgradeImage(boardInfo, upgradeRule);
	},

	/**
	 * Search for available firmware upgrades via the device (RPC call) and
	 * browser (HTTP fetch) internet connections.
	 *
	 * Returns an object with the following properties:
	 *   - browser: The result of the browser-based search, or null if it failed.
	 *   - device:  The result of the device-based search, or null if it failed.
	 *
	 * The result objects should always contain a `status` property indicating
	 * the result of the search which can be found in `upgrade.js` in the variable
	 * `ubusStatus`.
	 *
	 * A successful search result where an ugprade image was found only via RPC
	 * will return an object like this:
	 * ```
	 *   {
	 *       "browser": {
	 *           "status": "HTTPError",
	 *           "error": "Could not reach upgrade server",
	 *           "code": "Failed to fetch"
	 *       },
	 *       "device": {
	 *           "status": "UpdateImageFoundOK",
	 *           "name": "openwrt-morse-2.8.5-morsemicro-mm6108-ekh01-03-squashfs-sysupgrade.img.gz",
	 *           "version": "Morse-2.8.5",
	 *           "filesystem": "squashfs",
	 *           "sum": "97c13d9808e19920062cc13463a5323ab970dcdf1c96cc6b9c8fede05cc61037",
	 *           "url": "https://repo.apps.morsemicro.com/openwrt/releases/<version>/<board>/targets/bcm27xx/bcm2711/openwrt-morse-2.8.5-morsemicro-mm6108-ekh01-03-squashfs-sysupgrade.img.gz"
	 *       }
	 *   }
	 * ```
	 *
	 * @returns {Promise<{browser: Object|null, device: Object|null}>}
	 */
	search: async function ({ useBrowser = true, useDevice = true } = {}) {
		if (!useBrowser && !useDevice) {
			throw new Error('At least one upgrade search method must be enabled (browser or device)');
		}

		const searchTasks = [
			useBrowser ? this.browserSearch() : Promise.resolve(null),
			useDevice ? deviceSearch() : Promise.resolve(null),
		];

		const [
			browserResult,
			deviceResult,
		] = await Promise.allSettled(searchTasks);

		// re-raise any errors thrown during the browser search
		if (browserResult.status === 'rejected') {
			throw new Error(`Browser search fatal error: ${browserResult.reason}`);
		}

		const browserSearchResults = browserResult.status === 'fulfilled' ? browserResult.value : null;
		const deviceSearchResults = deviceResult.status === 'fulfilled' ? deviceResult.value : null;

		return {
			browser: browserSearchResults,
			device: deviceSearchResults,
		};
	},
});

return UpgradeSearch;
