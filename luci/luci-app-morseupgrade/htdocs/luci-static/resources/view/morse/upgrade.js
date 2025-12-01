'use strict';
/* globals fs rpc ui view request upgradesearch uci */
'require view';
'require rpc';
'require ui';
'require fs';
'require request';
'require uci';
'require tools.morse.morseupgrade.upgradesearch as upgradesearch';

// this is a standard list propagated around LuCI to poll the device
// after an action which would have lost connection. Used by the handleSysupgrade
// 10.42.0.1/192.168.12.1 added by morse to attempt to reach out to our default configuration
const hrefs = [window.location.host, '10.42.0.1', '192.168.12.1', '192.168.8.1', '192.168.1.1', 'openwrt.lan'];

var callUpgradeStat = rpc.declare({
	object: 'morseupgrade',
	method: 'stat',
	params: [],
});

var callUpgradeDownload = rpc.declare({
	object: 'morseupgrade',
	method: 'download',
	params: ['name', 'sum'],
});

var callUpgradeVerify = rpc.declare({
	object: 'morseupgrade',
	method: 'verify',
	params: ['sum'],
});

var callSystemValidateFirmwareImage = rpc.declare({
	object: 'system',
	method: 'validate_firmware_image',
	params: ['path'],
	expect: { '': { valid: false, forcable: true } },
});

var callFileStat = rpc.declare({
	object: 'file',
	method: 'stat',
	params: ['path'],
});

var callGetLocaltime = rpc.declare({
	object: 'luci',
	method: 'getLocaltime',
	params: [],
});

var callSetLocaltime = rpc.declare({
	object: 'luci',
	method: 'setLocaltime',
	params: ['localtime'],
	expect: { result: 0 },
});

document.querySelector('head').appendChild(E('link', {
	rel: 'stylesheet',
	type: 'text/css',
	href: L.resourceCacheBusted('view/morse/css/upgrade.css'),
}));

/*
 * LuCI  doesn't expose this through any library, so I've copied it verbatim from
 * flash.js
 */
function findStorageSize(procmtd, procpart) {
	var kernsize = 0, rootsize = 0, wholesize = 0;

	procmtd.split(/\n/).forEach(function (ln) {
		var match = ln.match(/^mtd\d+: ([0-9a-f]+) [0-9a-f]+ "(.+)"$/),
			size = match ? parseInt(match[1], 16) : 0;

		switch (match ? match[2] : '') {
			case 'linux':
			case 'firmware':
				if (size > wholesize)
					wholesize = size;
				break;

			case 'kernel':
			case 'kernel0':
				kernsize = size;
				break;

			case 'rootfs':
			case 'rootfs0':
			case 'ubi':
			case 'ubi0':
				rootsize = size;
				break;
		}
	});

	if (wholesize > 0)
		return wholesize;
	else if (kernsize > 0 && rootsize > kernsize)
		return kernsize + rootsize;

	procpart.split(/\n/).forEach(function (ln) {
		var match = ln.match(/^\s*\d+\s+\d+\s+(\d+)\s+(\S+)$/);
		if (match) {
			var size = parseInt(match[1], 10);

			if (!match[2].match(/\d/) && size > 2048 && wholesize == 0)
				wholesize = size * 1024;
		}
	});

	return wholesize;
}

/*
 * If delta > 5 minutes try to synchronise.
 * return true if time was changed.
 */
function synchroniseDeviceTimeWithBrowser() {
	return callGetLocaltime()
		.then((res) => {
			const deviceTime = res.result;
			const browserTime = Math.floor(Date.now() / 1000);
			if (Math.abs(browserTime - deviceTime) > 300) {
				return callSetLocaltime(browserTime).then(() => true);
			}
			return false;
		})
		.catch(() => false);
}

const states = {
	LOADING: 'loading',
	DOWNLOADING: 'downloading',
	UPGRADEREADY: 'upgrade-ready',
	DOWNLOADREADY: 'download-ready',
	ERROR: 'error',
	UPDATED: 'updated',
};

const ubusStatus = {
	ArgumentError: 'ArgumentError',
	BoardNotFoundError: 'BoardNotFoundError',
	DownloadError: 'DownloadError',
	HTTPError: 'HTTPError',
	SHAMismatchError: 'SHAMismatchError',
	UpdateImageNotFoundError: 'UpdateImageNotFoundError',
	DownloadStartedOK: 'DownloadStartedOK',
	DownloadInProgressOK: 'DownloadInProgressOK',
	DownloadFinishOK: 'DownloadFinishOK',
	NoUpdateNeededOK: 'NoUpdateNeededOK',
	ReadyForDownloadOK: 'ReadyForDownloadOK',
	UpdateImageFoundOK: 'UpdateImageFoundOK',
	VerifyOK: 'VerifyOK',
};

// just providing some default messages for the status codes coming from ubus.
// An alternative string may be used throughout the UI to provide more context.
// For errors, these are provided as additional context to the backend error message.
const defaultMessages = {
	ArgumentError: _('This is an internal error and may be due to configuration modifications. Please reset your device to factory defaults and try again or upgrade manually. If the problem persists, consider contacting Morse Micro support.'),
	BoardNotFoundError: _('This may happen if the device is not recognized by the server. Please verify that your device is supported and try again.'),
	DownloadError: _('This issue may occur when your internet connection is unstable or the device has run out of space. Please reboot your Morse Micro device and ensure it is connected to stable internet (via the browser or device) before trying again.'),
	HTTPError: _('This could be due to a network issue or server unavailability. Please ensure either your browser or Morse Micro device has internet access before retrying.'),
	SHAMismatchError: _('sha256sum does not match.'),
	UpdateImageNotFoundError: _('The latest version of firmware has not been made available for your device type.'),
	DownloadStartedOK: _('Download started...'),
	DownloadInProgressOK: _('Previous download in progress...'),
	DownloadFinishOK: _('Download completed successfully!'),
	NoUpdateNeededOK: _('Already up to date!'),
	ReadyForDownloadOK: _('Waiting for download...'),
	UpdateImageFoundOK: _('File available on MorseMicro image server.'),
	VerifyOK: _('SHA256 OK.'),
};

function checkResultTemplate(title, statusClass = null, summary = null, details = null) {
	return E('p', { class: `alert-message ${statusClass ?? ''}` }, [
		E('span', { style: 'font-weight: bold' }, title),

		(summary && E('span', [
			E('br'), E('br'),
			E('span', { style: 'font-weight: normal' }, summary),
		])),

		(details && E('span', [
			E('br'), E('br'),
			E('details', [
				E('summary', { style: 'cursor: pointer; user-select: none' }, _('Details')),
				E('br'),
				E('pre', { style: 'white-space: pre-wrap' }, details),
			]),
		])),
	].filter(e => e));
}

const compatibilityFailureCases = [
	{
		test: log => log.includes('Image metadata not present'),
		title: _('Compatibility check failed: image metadata not present.'),
		summary: _('The uploaded image file does not contain the required metadata to \
			perform device compatibility checks. Please verify that you have selected the correct \
			image file for your device model.'),
	},
	{
		test: log => log.includes('Invalid image metadata'),
		title: _('Compatibility check failed: invalid image metadata.'),
		summary: _('The uploaded image file contains invalid or corrupted metadata. \
			Please verify that you have selected the correct image file for your device model.'),
	},
	{
		test: log => /Device .* not supported by this image/mi.test(log),
		title: _('Compatibility check failed: device mismatch.'),
		summary: (log) => {
			const currentDeviceMatch = log.match(/Device (.+?) not supported by this image/mi);
			const supportedDevicesMatch = log.match(/Supported devices: (.+)/mi);
			if (currentDeviceMatch && currentDeviceMatch.length > 1 && supportedDevicesMatch && supportedDevicesMatch.length > 1) {
				return _('The uploaded image file is not compatible with this device model (%s). Supported devices for this image are: %s.').format(currentDeviceMatch[1], supportedDevicesMatch[1]);
			}
			return _('The uploaded image file is not compatible with this device model. \
				Please verify that you have selected the correct image file for your device model.');
		},
	},
	{
		test: log => log.includes('The device is supported, but this image is incompatible for sysupgrade based on the image version'),
		title: _('Compatibility check failed: incompatible image version.'),
		summary: _('The uploaded image file is compatible with this device model, \
			but the image version is not suitable for sysupgrade. Please select a different image file.'),
	},
	{
		test: log => log.includes('The device is supported, but the config is incompatible to the new image'),
		title: _('Compatibility check failed: incompatible configuration.'),
		summary: _('The uploaded image file is compatible with this device model, \
			but the current configuration cannot be preserved. Please uncheck \'Keep settings\' \
			and try again, or select a different image file.'),
	},
];

const signatureFailureCases = [
	{
		test: log => log.includes('Image signature not present'),
		title: _('Morse Micro signature authentication failed: signature not present.'),
		summary: _('The uploaded image file does not include the required firmware \
			signature for this device. Please download an official Morse Micro firmware \
			image and try again.'),
	},
	{
		test: log => /Cannot open file '\/etc\/opkg\/keys\//.test(log),
		title: _('Morse Micro signature authentication failed: signing keys missing.'),
		summary: _('The device cannot access the required firmware signing keys  \
			to authenticate this image. If this is a custom or locally built development \
			image you may force the upgrade but do so at your own risk.'),
	},
	{
		test: log => /Cannot open file '\/tmp\/sysupgrade\.ucert'/.test(log) || /Unable to load certificate file/i.test(log),
		title: _('Morse Micro signature authentication failed: signature metadata missing.'),
		summary: _('The firmware certificate embedded in the image cannot be read \
			by the device. The download may be incomplete or corrupted; please re-download \
			the firmware and try again.'),
	},
	{
		test: log => /certificate expired/i.test(log),
		title: _('Morse Micro signature authentication failed: certificate expired.'),
		summary: _('The signing certificate bundled with this firmware has expired. \
			Please download an updated firmware image that is signed with a valid \
			Morse Micro certificate.'),
	},
	{
		test: log => /key .* has been revoked/i.test(log),
		title: _('Morse Micro signature authentication failed: key revoked.'),
		summary: _('The signing key for this firmware has been revoked on this device. \
			Please download a more recent firmware release that is signed with a \
			current Morse Micro key.'),
	},
	{
		test: log => /missing mandatory ucert attributes/i.test(log) || /no ucert in signed payload/i.test(log) || /cannot parse (payload|cert)/i.test(log),
		title: _('Morse Micro signature authentication failed: invalid payload.'),
		summary: _('The firmware signature payload is malformed or incomplete. Please \
			download the firmware image again from the Morse Micro server.'),
	},
	{
		test: log => /wrong certificate type/i.test(log),
		title: _('Morse Micro signature authentication failed: unsupported certificate type.'),
		summary: _('The firmware contains a certificate that cannot authorize upgrades. \
			Please use an official Morse Micro firmware image.'),
	},
	{
		test: log => /cannot get fingerprint for chained key/i.test(log),
		title: _('Morse Micro signature authentication failed: signature chain error.'),
		summary: _('The device could not build the certificate chain for the firmware \
			signature. Please re-download the firmware or contact Morse Micro support.'),
	},
	{
		test: log => /stray trailing signature/i.test(log) || /missing signature to verify message/i.test(log),
		title: _('Morse Micro signature authentication failed: signature structure invalid.'),
		summary: _('The firmware signature blob is incomplete or contains unexpected \
			data. The download might be truncated or tampered with.'),
	},
	{
		test: log => /Failed to decode (signature|public key)/i.test(log) || /Premature end of file/i.test(log),
		title: _('Morse Micro signature authentication failed: decode failed.'),
		summary: _('The device failed to decode the signature or public key embedded \
			in the firmware. Please download the firmware again.'),
	},
	{
		test: log => /signature verification failed/i.test(log) || /verification failed/i.test(log) || /Failed to verify .*\.cert/i.test(log),
		title: _('Morse Micro signature authentication failed: verification failed.'),
		summary: _('The firmware signature could not be verified with the trusted \
			Morse Micro keys. The file may be corrupt or tampered with. Please download \
			it again or contact Morse Micro support.'),
	},
];

function parseSysupgradeTestFailureReason(log, testCases, defaultTitle, defaultSummary) {
	const failureReason = { title: defaultTitle, summary: defaultSummary };
	for (const testCase of testCases) {
		if (testCase.test(log)) {
			failureReason.title = typeof testCase.title === 'function' ? testCase.title(log) : testCase.title;
			failureReason.summary = typeof testCase.summary === 'function' ? testCase.summary(log) : testCase.summary;
			break;
		}
	}
	return failureReason;
}

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	handleManualUpload: function (storage_size, has_rootfs_data, _ev) {
		return ui.uploadFile('/tmp/sysupgrade.bin')
			.then(L.bind(this.handleSysupgrade, this, storage_size, has_rootfs_data));
	},

	handleSysupgradeAuto: function (storage_size, has_rootfs_data) {
		return callFileStat('/tmp/sysupgrade.bin')
			.then((res) => {
				res['sha256sum'] = this.search.sum;
				return res;
			}).then(L.bind(this.handleSysupgrade, this, storage_size, has_rootfs_data));
	},

	// this, and handleSysupgradeConfirm are practically a direct copy paste from the flash.js.
	//  some massaging was required to replace the ui.uploadFile which started this function.
	handleSysupgrade: function (storage_size, has_rootfs_data, file_stat) {
		var imgCheckModal = ui.showModal(_('Checking image…'), [
			E('span', { class: 'spinning' }, _('Synchronizing device time with the browser.')),
		]);

		return Promise.resolve([file_stat])
			.then((reply) => {
				return synchroniseDeviceTimeWithBrowser()
					.then(function (res) {
						reply.push({ skew_fixed: res });
						return reply;
					});
			})
			.then((reply) => {
				var imgCheckModalSpanElem = imgCheckModal.querySelector('.spinning');
				imgCheckModalSpanElem.textContent = _('Verifying the uploaded image file.');
				return callSystemValidateFirmwareImage('/tmp/sysupgrade.bin')
					.then(function (res) {
						reply.push(res);
						return reply;
					});
			})
			.then((reply) => {
				return fs.exec('/sbin/sysupgrade', ['--test', '/tmp/sysupgrade.bin'])
					.then(function (res) {
						reply.push(res);
						return reply;
					});
			})
			.then((res) => {
				/* sysupgrade opts table  [0]:checkbox element [1]:check condition [2]:args to pass */
				var opts = {
						keep: [E('input', { type: 'checkbox' }), false, '-n'],
						force: [E('input', { type: 'checkbox' }), true, '--force'],
						skip_orig: [E('input', { type: 'checkbox' }), true, '-u'],
						backup_pkgs: [E('input', { type: 'checkbox' }), true, '-k'],
					},
					skew_fixed = res[1].skew_fixed,
					image_tests = res[2].tests,
					is_signature_valid = image_tests.fwtool_signature,
					is_device_supported = image_tests.fwtool_device_match,
					is_valid = res[2].valid,
					is_forceable = res[2].forceable,
					allow_backup = res[2].allow_backup,
					sysupgrade_test_result = res[3],
					is_too_big = (storage_size > 0 && res[0].size > storage_size),
					body = [];

				sysupgrade_test_result.stderr = sysupgrade_test_result.stderr || '';

				body.push(E('p', _('The flash image was uploaded. Below is the checksum and file size listed, compare them with the original file to ensure data integrity. <br /> Click \'Continue\' below to start the flash procedure.')));
				body.push(E('ul', {}, [
					res[0].size ? E('li', {}, '%s: %1024.2mB'.format(_('Size'), res[0].size)) : '',
					res[0].sha256sum ? E('li', {}, '%s: %s'.format(_('SHA256'), res[0].sha256sum)) : '',
				]));

				body.push(E('p', {}, E('label', { class: 'btn' }, [
					opts.keep[0], ' ', _('Keep settings and retain the current configuration'),
				])));

				if (allow_backup) {
					opts.keep[0].checked = true;

					if (has_rootfs_data) {
						body.push(E('p', {}, E('label', { class: 'btn' }, [
							opts.skip_orig[0], ' ', _('Skip from backup files that are equal to those in /rom'),
						])));
					}

					body.push(E('p', {}, E('label', { class: 'btn' }, [
						opts.backup_pkgs[0], ' ', _('Include in backup a list of current installed packages at /etc/backup/installed_packages.txt'),
					])));
				}

				/* visually separate the upgrade configuration (above) from the validation feedback (below) */
				body.push(E('hr'));

				if (skew_fixed)
					body.push(checkResultTemplate(
						_('Device time updated.'),
						'notice',
						_('Your device time was out of sync with the browser and has been automatically updated.'),
					));

				if (!allow_backup) {
					if (is_valid) {
						body.push(checkResultTemplate(
							_('Configuration backup not supported.'),
							'notice',
							_('The uploaded firmware does not allow keeping current configuration.'),
						));
					}
					opts.keep[0].disabled = true;
				}

				/* disk space check */
				if (is_too_big) {
					body.push(checkResultTemplate(
						_('Disk space check failed: image too large.'),
						'warning',
						_('It appears that you are trying to flash an image that does not fit into the flash memory, please verify the image file!'),
						_('Image size: %1024.2mB, Storage size: %1024.2mB').format(res[0].size, storage_size),
					));
				} else {
					body.push(checkResultTemplate(_('Disk space check succeeded.'), 'success'));
				}

				/* compatibility check */
				if (is_device_supported) {
					body.push(checkResultTemplate(_('Compatibility check succeeded.'), 'success'));
				} else {
					const {
						'title': compatibility_failure_title,
						'summary': compatibility_failure_summary,
					} = parseSysupgradeTestFailureReason(
						sysupgrade_test_result.stderr,
						compatibilityFailureCases,
						_('Compatibility check failed.'),
						_('The uploaded image failed the device compatibility check. \
						Please verify that you have selected the correct image file for your device model. \
						See details for more information.'),
					);
					body.push(checkResultTemplate(compatibility_failure_title, 'warning', compatibility_failure_summary, sysupgrade_test_result.stderr));
				}

				/* platform specific validation (rare, only show error case) */
				const platform_check_image_failures = Object.entries(image_tests).filter(([k, v]) => {
					const default_tests = ['fwtool_signature', 'fwtool_device_match'];
					return !default_tests.includes(k) && v === false;
				});
				if (!is_valid && platform_check_image_failures.length > 0) {
					body.push(checkResultTemplate(
						_('Platform checks failed.'),
						'warning',
						_('The uploaded image file did not pass all platform specific validation checks. \
							Please verify that you have selected the correct image file for your device model. \
							See details for more information.'),
						sysupgrade_test_result.stderr,
					));
				}

				/* signature validation */
				if (uci.get_first('system', null, 'enforce_fw_sign') == '0') {
					body.push(checkResultTemplate(_('Morse Micro signature authentication not enforced.'), 'notice'));
				} else if (is_signature_valid) {
					body.push(checkResultTemplate(_('Morse Micro signature authentication succeeded.'), 'success'));
				} else {
					const {
						'title': signature_failure_title,
						'summary': signature_failure_summary,
					} = parseSysupgradeTestFailureReason(
						sysupgrade_test_result.stderr,
						signatureFailureCases,
						_('Morse Micro signature authentication failed.'),
						_('The uploaded image file is not properly signed. \
							Flashing unsigned images may compromise device security and is not recommended.'),
					);
					body.push(checkResultTemplate(signature_failure_title, 'warning', signature_failure_summary, sysupgrade_test_result.stderr));
				}

				/* visually separate the validation feedback (above) from the action buttons (below) */
				body.push(E('hr'));

				var cntbtn = E('button', {
					class: 'btn cbi-button-action important',
					click: ui.createHandlerFn(this, 'handleSysupgradeConfirm', opts),
				}, [_('Continue')]);

				if ((!is_valid || is_too_big || sysupgrade_test_result.code != 0) && is_forceable) {
					body.push(
						E('details', [
							E('summary', { style: 'font-weight: bold; cursor: pointer; user-select: none' }, _('Do you still want to flash this image?')),
							E('p', {}, E('label', { class: 'btn alert-message', style: 'margin: 0' }, [
								opts.force[0], ' ', E('span', { class: 'show-warning' }, _('Force upgrade')),
								E('br'), E('br'),
								E('span', { style: 'font-weight: normal' },
									_('Select \'Force upgrade\' to flash the image even \
										if checks fail. Use only if you are sure that \
										the firmware is correct and meant for your device!'),
								),
							])),
						]),
						E('hr'),
					);
					cntbtn.disabled = true;
				}

				// this has been modified to not remove the downloaded binary. Just hides the modal.
				body.push(E('div', { class: 'right' }, [
					E('button', {
						class: 'btn',
						click: ui.hideModal,
					}, [_('Cancel')]), ' ', cntbtn,
				]));

				opts.force[0].addEventListener('change', function (ev) {
					cntbtn.disabled = !ev.target.checked;
				});

				opts.keep[0].addEventListener('change', function (ev) {
					opts.skip_orig[0].disabled = !ev.target.checked;
					opts.backup_pkgs[0].disabled = !ev.target.checked;
				});

				ui.showModal(_('Flash image?'), body);
			})
			.catch(function (e) {
				ui.addNotification(null, E('p', e.message));
			});
	},

	handleSysupgradeRetry: async function () {
		// attempt to clean up but non-critical files
		try {
			fs.remove('/tmp/sysupgrade.bin');
			fs.remove('/tmp/sysupgrade.pid');
		} catch (e) {
			console.error('Failed to clean up files from previous upgrade attempt:', e);
		}

		try {
			await fs.remove('/tmp/sysupgrade.status');
		} catch (e) {
			console.error('Could not remove /tmp/sysupgrade.status:', e);
		}

		// redirect the user back to the automatic upgrade search view
		const url = new URL(window.location.href);
		url.searchParams.set('action', 'auto-upgrade');
		window.location.assign(url.toString());
	},

	handleSysupgradeConfirm: function (opts) {
		ui.showModal(_('Flashing…'), [
			E('p', { class: 'spinning' }, _('The system is flashing now.<br /> DO NOT POWER OFF THE DEVICE!<br /> Wait a few minutes before you try to reconnect. It might be necessary to renew the address of your computer to reach the device again, depending on your settings.')),
		]);

		var args = [];

		for (var key in opts)
			/* if checkbox == condition add args to sysupgrade */
			if (opts[key][0].checked == opts[key][1])
				args.push(opts[key][2]);

		args.push('/tmp/sysupgrade.bin');

		/* Currently the sysupgrade rpc call will not return, hence no promise handling */
		fs.exec('/sbin/sysupgrade', args);

		if (opts['keep'][0].checked)
			ui.awaitReconnect(window.location.host);
		else
			ui.awaitReconnect(...hrefs);
	},

	// start with stat to determine initial state - dont do in load as sha256sum may take some time to calc
	// if stat shows device download in progress --> show downloading progress
	// if stat shows device download complete, search and verify, then show ready to upgrade. Flag in page to stop repeated stats. enable upgrade button
	// if stat shows no file, search via browser and device.
	// if browser and device have internet, preference browser results.
	// stop poll when done.
	// ---> if up to date, show success
	// ---> if error, show error
	// ---> if file found, enable download button and show version as a clickable link to found image url

	// download button restarts stat poll
	// upgrade button pops sysupgrade modal
	handleUpgradeSearch: async function () {
		let browserSearch, deviceSearch;
		try {
			({ browser: browserSearch, device: deviceSearch } = await upgradesearch.search());
		} catch (e) {
			console.error('Upgrade search failed:', e);
			this.setState(states.ERROR, defaultMessages[ubusStatus.ArgumentError]);
			throw new Error('Something has gone horribly wrong in upgrade search');
		}

		this.browserConnectionAvailable = browserSearch?.status && browserSearch.status !== ubusStatus.HTTPError;
		this.deviceConnectionAvailable = deviceSearch?.status && deviceSearch.status !== ubusStatus.HTTPError;

		console.info('browserConnectionAvailable', this.browserConnectionAvailable);
		console.info('deviceConnectionAvailable', this.deviceConnectionAvailable);

		// choose a primary search result to use, prefer browser
		const search = this.browserConnectionAvailable ? browserSearch : deviceSearch;

		switch (search.status) {
			case ubusStatus.HTTPError:
				this.setState(states.ERROR, `${search.error}. ${defaultMessages[ubusStatus.HTTPError]}`);
				return null;
			case ubusStatus.UpdateImageNotFoundError:
				this.setState(states.ERROR, `${search.error}. ${defaultMessages[ubusStatus.UpdateImageNotFoundError]}`);
				return null;
			case ubusStatus.BoardNotFoundError:
				this.setState(states.ERROR, `${search.error}. ${defaultMessages[ubusStatus.BoardNotFoundError]}`);
				return null;
			case ubusStatus.NoUpdateNeededOK:
				this.setState(states.UPDATED, defaultMessages[ubusStatus.NoUpdateNeededOK]);
				return null;
			default:
				break;
		}

		if (search.status != ubusStatus.UpdateImageFoundOK) {
			console.error(search);
			this.setState(states.ERROR, defaultMessages[ubusStatus.ArgumentError]);
			throw new Error('Something has gone horribly wrong in search');
		}

		return search;
	},

	setState: function (state, message) {
		if (!Object.values(states).includes(state))
			throw new Error(`Attempting to set unknown state: ${state}`);

		this.stateElement.classList.remove(...Object.values(states));
		this.stateElement.classList.add(state);
		this.stateElement.classList.remove('hidden');
		this.messageBox.innerHTML = message;
		this.messageBox.classList.remove('hidden');

		switch (state) {
			case states.UPGRADEREADY:
				this.sysupgradeButton.classList.remove('hidden');
				this.upgradeButtonContainer.classList.add('hidden');
				break;
			case states.DOWNLOADREADY:
				this.sysupgradeButton.classList.add('hidden');
				this.upgradeButtonContainer.classList.remove('hidden');

				this.deviceUpgradeButtonContainer.querySelector('button').disabled = !this.deviceConnectionAvailable;
				this.browserUpgradeButtonContainer.querySelector('button').disabled = !this.browserConnectionAvailable;

				this.deviceUpgradeButtonContainer.querySelector('.upgrade-page-button-subtitle').classList.toggle('hidden', this.deviceConnectionAvailable);
				this.browserUpgradeButtonContainer.querySelector('.upgrade-page-button-subtitle').classList.toggle('hidden', this.browserConnectionAvailable);

				break;
			case states.ERROR:
				this.retrySysupgradeButton.classList.remove('hidden');
				break;
			default:
				this.sysupgradeButton.classList.add('hidden');
				this.upgradeButtonContainer.classList.add('hidden');
				break;
		}
	},

	pollState: async function () {
		if (this.queryResult == null || typeof this.queryResult != 'object') {
			this.setState(states.ERROR, _(
				'Configuration error detected. The upgrade service could'
				+ ' not be started due to a missing or invalid system setting.'
				+ ' Please check your device configuration or perform a factory reset before re-trying.'),
			);
			return;
		}

		let stat = await callUpgradeStat();
		let rootfs_warn = '';

		switch (stat.status) {
			case ubusStatus.DownloadInProgressOK:
				this.setState(states.DOWNLOADING, _('Downloading firmware to device: ') + stat.bytes);
				this.stateTimeout = window.setTimeout(L.bind(this.pollState, this), 2000);
				return;
			case ubusStatus.ReadyForDownloadOK:
				this.search = await this.handleUpgradeSearch();
				if (this.search == null)
					return;
				this.foundUpgrade = true;
				if (this.queryResult.rootfs_type != this.search.filesystem)
					rootfs_warn = _('<br> New image is of format: ') + this.search.filesystem;
				this.setState(states.DOWNLOADREADY, _('New firmware version available: <a href="%s" target="_blank">%s</a>').format(this.search.url, this.search.version) + rootfs_warn);
				return;
			case ubusStatus.DownloadError:
				this.setState(states.ERROR, `${stat.error}. ${defaultMessages[ubusStatus.DownloadError]}`);
				return;
			default:
				break;
		}

		if (stat.status != ubusStatus.DownloadFinishOK) {
			console.error(stat);
			throw new Error('Something has gone horribly wrong in stat');
		}

		if (!this.foundUpgrade) {
			this.search = await this.handleUpgradeSearch();
			if (this.search == null)
				return;
		}

		await this.verifyAndUpgrade();

		return;
	},

	verifyAndUpgrade: async function () {
		let rootfs_warn = '';
		let verify = await callUpgradeVerify(this.search.sum);
		switch (verify.status) {
			case ubusStatus.ArgumentError:
				console.error(this.search);
				this.setState(states.ERROR, defaultMessages[ubusStatus.ArgumentError]);
				throw new Error('Something has gone horribly wrong in verify');
			case ubusStatus.SHAMismatchError:
				// this one is a bit confusing. The status was designed around passing the wrong shasum into the verify
				// but we don't want to transition to an error state. We know there's an upstream file avaiable, so
				// indicate something is available.
				if (this.queryResult.rootfs_type != this.search.filesystem)
					rootfs_warn = _('<br> New image is of format: ') + this.search.filesystem;
				this.setState(states.DOWNLOADREADY, _('New firmware version available: <a href="%s" target="_blank">%s</a>').format(this.search.url, this.search.version) + rootfs_warn);
				return;
			default:
				break;
		}

		this.setState(states.UPGRADEREADY, _('Ready to upgrade!'));
		this.sysupgradeButton.click();
		return;
	},

	start: async function () {
		this.stateTimeout = window.setTimeout(L.bind(this.pollState, this), 2000);
		this.startButton.classList.add('hidden');
		// Hide the manual button to prevent user confusion and avoid the
		// possibility of that process writing to the same file as the automatic
		// process.
		this.manualUploadButton.classList.add('hidden');
		this.setState(states.LOADING, _('Checking for upgrades'));
	},

	browserDownload: async function (url, sum) {
		if (!url || !sum) {
			throw new Error('Correct target and sha256sum not provided to browser download function');
		}

		const downloadResponse = await fetch(url, { cache: 'no-cache' });

		if (!downloadResponse.ok || !downloadResponse.body) {
			throw new Error(`Failed to download firmware from upgrade server (${downloadResponse.status})`);
		}

		// show the download to browser progress
		const contentLength = downloadResponse.headers.get('Content-Length');
		const total = contentLength ? parseInt(contentLength, 10) : 0;
		let loaded = 0;

		const reader = downloadResponse.body.getReader();
		const chunks = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			loaded += value.length;

			// aim to use percentage but fallback to using bytes, like the device upgrades
			if (total) {
				const percent = ((loaded / total) * 100).toFixed(2);
				this.setState(states.DOWNLOADING, _('Downloading firmware to browser: %s%%').format(percent));
			} else {
				this.setState(states.DOWNLOADING, _('Downloading firmware to browser: %s bytes').format(loaded));
			}
		}

		const data = new FormData();
		const blob = new Blob(chunks);
		data.append('sessionid', L.env.sessionid);
		data.append('filename', '/tmp/sysupgrade.bin');
		data.append('filedata', blob);

		const uploadResponse = await request.post(L.env.cgi_base + '/cgi-upload', data, {
			timeout: 0,
			// show the upload to device progress
			progress: (pev) => {
				const percent = ((pev.loaded / pev.total) * 100).toFixed(2);
				this.setState(states.DOWNLOADING, _('Uploading firmware to device: %s%%').format(percent));
			},
		});

		if (!uploadResponse.ok) {
			const text = await uploadResponse.text();
			console.error('Upload failed:', text);
			throw new Error('Upload to device failed');
		}
	},

	// use the browser to download the firmware image and then upload it to the device
	browserDownloadAndUpgrade: async function () {
		if (!this.foundUpgrade) {
			this.setState(states.LOADING);

			this.search = await this.handleUpgradeSearch();
			if (this.search == null)
				return;
		}

		this.setState(states.DOWNLOADING, '');
		try {
			await this.browserDownload(this.search.url, this.search.sum);
			await this.verifyAndUpgrade();
		} catch (e) {
			console.error(e);
			this.setState(states.ERROR, `Firmware image download failed. ${defaultMessages[ubusStatus.DownloadError]}`);
		}
	},

	// start the download process on the device
	startDownloadAndUpgrade: async function () {
		if (!this.foundUpgrade) {
			this.setState(states.LOADING);

			this.search = await this.handleUpgradeSearch();
			if (this.search == null)
				return;
		}

		await callUpgradeDownload(this.search.name, this.search.sum);
		this.setState(states.DOWNLOADING, '');
		this.stateTimeout = window.setTimeout(L.bind(this.pollState, this), 2000);
	},

	load: function () {
		var tasks = [
			fs.trimmed('/proc/mtd'),
			fs.trimmed('/proc/partitions'),
			fs.trimmed('/proc/mounts'),
			upgradesearch.load(),
			uci.load('system'),
		];

		return Promise.all(tasks);
	},

	render: function (data) {
		var procmtd = data[0],
			procpart = data[1],
			procmounts = data[2],
			has_rootfs_data = (procmtd.match(/"rootfs_data"/) != null) || (procmounts.match('overlayfs:/overlay / ') != null),
			storage_size = findStorageSize(procmtd, procpart);

		this.queryResult = data[3];

		this.startButton = E('button', {
			class: 'cbi-button cbi-button-action',
			style: 'margin: auto; margin-left: 50%; transform: translateX(-50%);',
			click: ui.createHandlerFn(this, () => this.start()),
		}, [_('Check for automatic upgrade')]);

		this.browserUpgradeButtonContainer = E('div', { class: 'upgrade-button-container' }, [
			E('button', {
				title: 'firmware download will use browser internet',
				class: 'cbi-button cbi-button-action',
				style: 'margin: 0.5rem !important;',
				click: ui.createHandlerFn(this, () => this.browserDownloadAndUpgrade()),
			}, [_('Upgrade via browser')]),
			E('div', { class: 'upgrade-page-button-subtitle' }, [
				E('p', _('Browser could not reach upgrade server')),
				E('p', _('(check browser internet connection)')),
			]),
		]),

		this.deviceUpgradeButtonContainer = E('div', { class: 'upgrade-button-container' }, [
			E('button', {
				title: 'firmware download will use device internet',
				class: 'cbi-button cbi-button-action',
				style: 'margin: 0.5rem !important;',
				click: ui.createHandlerFn(this, () => this.startDownloadAndUpgrade()),
			}, [_('Upgrade via device')]),
			E('div', { class: 'upgrade-page-button-subtitle' }, [
				E('p', _('Device could not reach upgrade server')),
				E('p', _('(check device internet connection)')),
			]),
		]),

		this.upgradeButtonContainer = E('div', {
			class: 'upgrade-page-controls hidden',
		}, [E('div', { style: 'display: flex; justify-content: center; gap: 0.5rem; flex-wrap: wrap;' }, [
			this.browserUpgradeButtonContainer,
			this.deviceUpgradeButtonContainer,
		])]);

		this.sysupgradeButton = E('button', {
			class: 'cbi-button cbi-button-action upgrade-page-controls hidden',
			click: ui.createHandlerFn(this, () => this.handleSysupgradeAuto(storage_size, has_rootfs_data)),
		}, [_('Upgrade')]);

		this.manualUploadButton = E('button', {
			class: 'cbi-button cbi-button-action upgrade-page-controls',
			click: L.bind(this.handleManualUpload, this, storage_size, has_rootfs_data),
		}, [_('Manually upload firmware file')]);

		this.retrySysupgradeButton = E('button', {
			class: 'cbi-button cbi-button-action upgrade-page-controls hidden',
			click: ui.createHandlerFn(this, () => this.handleSysupgradeRetry()),
		}, [_('Retry')]);

		this.stateElement = E('div', { class: 'upgrade-state hidden' });

		this.messageBox = E('div', { id: 'message', class: 'hidden', style: 'margin-top: 40px; text-align: center; display: block;' });

		this.foundUpgrade = false;
		this.browserConnectionAvailable = false;
		this.deviceConnectionAvailable = false;

		// if the upgrade link on the home page is clicked take the user directly to the the automatic upgrade
		const urlAction = new URLSearchParams(window.location.search).get('action');
		if (urlAction == 'auto-upgrade') {
			window.history.replaceState({}, document.title, window.location.pathname);
			this.startButton.click();
		}

		return [
			E('h2', {}, _('Morse Upgrade')),
			E('p', [
				_('Additional firmware controls can be found on the '),
				E('a', { href: L.url('admin', 'system', 'flash') }, _('Backup/Flash Firmware page')),
				'.',
			]),
			this.stateElement,
			this.messageBox,
			this.startButton,
			this.upgradeButtonContainer,
			this.sysupgradeButton,
			this.manualUploadButton,
			this.retrySysupgradeButton,
		];
	},
});
