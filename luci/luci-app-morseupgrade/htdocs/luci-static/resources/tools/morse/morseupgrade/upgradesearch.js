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

	parseMorseVersionString(morseVersion) {
		let versionNumber = morseVersion.split('-');
		return versionNumber[1].split('.').map(Number);
	},

	isUpgradeable(currentVersion, latestVersion) {
		const currentSemVer = this.parseMorseVersionString(currentVersion);
		const latestSemVer = this.parseMorseVersionString(latestVersion);

		let maxLength = Math.max(currentSemVer.length, latestSemVer.length);
		for (let i = 0; i < maxLength; i++) {
			const currentValue = currentSemVer[i] ?? 0;
			const latestValue = latestSemVer[i] ?? 0;

			if (currentValue < latestValue) return true;
			if (currentValue > latestValue) return false;
		}

		// identical versions
		return false;
	},

	// use the browser to search for an upgrade image,
	// mimic the returns of the deviceSearch() rpc call
	browserSearch: async function () {
		// implementers should be responsible for calling upgradeSearch.load() before calling this function
		if (!this.queryResult || !this.repo) {
			throw new Error('upgradesearch not initialized, ensure that upgradeSearch.load() is called first!');
		}

		let profiles, latestVersion;
		const profilesUrl = `${this.repo}/${this.queryResult.target}/profiles.json`;
		try {
			let response = await fetch(profilesUrl, { cache: 'no-cache' });

			if (!response.ok) {
				throw new Error(`Could not reach upgrade server via browser (${response.status})`);
			}

			({ version_code: latestVersion, profiles } = await response.json());
		} catch (e) {
			return {
				status: 'HTTPError',
				error: 'Could not reach upgrade server',
				code: e.message,
			};
		}

		if (!this.isUpgradeable(this.queryResult.morse_version, latestVersion)) {
			return {
				status: 'NoUpdateNeededOK',
				message: 'Already up to date!',
			};
		}

		const profile = Object.values(profiles).find(profile => profile.supported_devices.includes(this.queryResult.board));

		// skip the backend trying again by not throwing an error
		// maybe this is dangerous and the backend should try again?
		// I just don't see any case where it would end differently.
		if (!profile) {
			return {
				status: 'BoardNotFoundError',
				error: `No profiles found on upgrade server for device type '${this.queryResult.board}'`,
			};
		}

		const image = Object.values(profile.images).find(image => image.filesystem == 'squashfs' && image.type == 'sysupgrade');

		if (!image) {
			return {
				status: 'UpdateImageNotFoundError',
				error: `No ${latestVersion} images found on upgrade server for '${this.queryResult.board}'`,
			};
		}

		return {
			status: 'UpdateImageFoundOK',
			name: image.name,
			version: latestVersion,
			filesystem: image.filesystem,
			sum: image.sha256,
			url: `${this.repo}/${this.queryResult.target}/${image.name}`,
		};
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
	 *           "url": "https://repo.apps.morsemicro.com/openwrt/releases/latest/targets/bcm27xx/bcm2711/openwrt-morse-2.8.5-morsemicro-mm6108-ekh01-03-squashfs-sysupgrade.img.gz"
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
