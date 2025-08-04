/**
 * Initial landing page for devices with Morse wifi chips that don't have a fixed country.
 *
 * Automatically configure the TZ and time based on the browser.
 */
/* globals dom form halow rpc uci ui view widgets */
'require view';
'require form';
'require dom';
'require halow';
'require tools.widgets as widgets';
'require uci';
'require rpc';
'require ui';

const S1G_AUTO_ONLY_COUNTRIES = new Set(['EU', 'GB']);

const callSetLocaltime = rpc.declare({
	object: 'luci',
	method: 'setLocaltime',
	params: ['localtime'],
	expect: { result: 0 },
});

const callGetTimezones = rpc.declare({
	object: 'luci',
	method: 'getTimezones',
	expect: { '': {} },
});

return view.extend({
	load() {
		return Promise.all([
			callGetTimezones(),
			halow.loadChannelMap(),
			uci.load('luci'),
			uci.load('wireless').catch(() => null),
		]);
	},

	async handleApply(_ev) {
		const mapEls = document.getElementById('maincontent').querySelectorAll('.cbi-map');
		const maps = Array.from(mapEls).map(mapEl => dom.findClassInstance(mapEl));
		const morseDeviceName = uci.sections('wireless', 'wifi-device').find(s => s.type === 'morse')['.name'];
		const wifiDevices = uci.sections('wireless', 'wifi-device').filter(s => s.type === 'mac80211');

		try {
			for (const m of maps) {
				m.checkDepends();
			}

			await Promise.all(maps.map(m => m.parse()));

			// Make sure all non-morse wifi devices are enabled where they exist.
			for (const wifiDevice of wifiDevices) {
				uci.unset('wireless', wifiDevice['.name'], 'disabled');
			}

			// Make sure our first HaLow device is enabled.
			uci.unset('wireless', morseDeviceName, 'disabled');

			// Update TZ based on browser TZ if we're on UTC.
			if (uci.get('system', '@system[0]', 'timezone') === 'UTC') {
				const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
				const tzstring = this.timezones[browserTz]?.tzstring;
				if (tzstring) {
					uci.set('system', '@system[0]', 'zonename', browserTz);
					uci.set('system', '@system[0]', 'timezone', tzstring);
				}
			}

			// If this was the homepage, we've completed it, so remove.
			if (uci.get('luci', 'main', 'homepage') === L.env.requestpath.join('/')) {
				uci.unset('luci', 'main', 'homepage');
			}

			const tasks = [];
			tasks.push(uci.save());
			tasks.push(callSetLocaltime(Math.floor(Date.now() / 1000)));

			await Promise.all(tasks);

			// Add a custom redirect handler which should fire before the
			// normal LuCI redirect on Apply (which goes back to the same page).
			document.addEventListener('uci-applied', () => {
				window.location.href = L.url('admin', 'morseapwizard');
				// In some situations the browser doesn't manage to redirect to our
				// page before the LuCI one kicks in. This is because the event loop keeps
				// running despite the requested location change until the browser receives
				// a network response. If we override apply_timeout here to 1000s, this
				// default redirect will definitely not fire before we've had a chance to
				// do our redirect.
				// NB: even though this is a global, we're about to reload the page so this
				// value will be reset.
				L.env.apply_display = 1000;
			});
			ui.changes.apply(false /* checked */);
		} catch (e) {
			console.error(e);

			ui.showModal(_('Save error'), [
				E('p', {}, [_('An error occurred while saving the form:')]),
				E('p', {}, [E('em', { style: 'white-space:pre-wrap' }, [e.message])]),
				E('div', { class: 'right' }, [
					E('button', { class: 'cbi-button', click: ui.hideModal }, [_('Dismiss')]),
				]),
			]);
		}
	},

	render([timezones, channelMap]) {
		this.timezones = timezones;

		const morseDevice = uci.sections('wireless', 'wifi-device').find(s => s.type === 'morse');
		if (!morseDevice) {
			// If there's no morse device detected at all, we can't do anything useful in the wizard,
			// so just drop to the standard homepage.
			return E('div', { class: 'wizard-contents' }, [
				E('div', { class: 'cbi-section' }, [
					E('h1', _('Welcome!')),
					E('p', _(`
						Usually, you would set the country for your Morse Micro HaLow device here.
						However, no Morse Micro device has been detected. If this is a transient issue,
						you can set the country later on the Network -> Wireless page.
					`)),
				]),
			]);
		}

		const wirelessMap = new form.Map(
			'wireless',
		);
		let section = wirelessMap.section(
			form.NamedSection, morseDevice['.name'], 'wifi-device',
			_('HaLow Configuration'),
		);

		let option = section.option(widgets.WifiCountryValue, 'country', _('Country'),
			_(`The country determines the frequencies used by your HaLow device.
			   For details, see the <a href="%s" target="_blank">regulatory data table</a>.`).format(L.url('admin', 'help', 'regulatoryinfo')),
		);
		option.rmempty = false;
		option.write = function (sectionId, value) {
			this.super('write', [sectionId, value]);

			// Set channel appropriately if the country was mutated
			// so we're less likely to leave this in a broken state.
			const bestBw = Math.max(...Object.values(channelMap[value]).map(ch => Number(ch.bw)));
			const bestChannels = Object.values(channelMap[value]).filter(ch => Number(ch.bw) === bestBw);
			// Choose centre channel as least likely to have back-offs
			// (and least likely to be disabled, since we don't have access
			// to this as we're not using iwinfo countrylist since the
			// driver may not have been loaded).
			const bestChannel = bestChannels[Math.floor(bestChannels.length / 2)];

			if (S1G_AUTO_ONLY_COUNTRIES.has(value)) {
				uci.set('wireless', morseDevice['.name'], 'channel', 'auto');
				uci.set('wireless', morseDevice['.name'], 's1g_chanbw', bestChannel.bw);
			} else {
				uci.set('wireless', morseDevice['.name'], 'channel', bestChannel.s1g_chan);
				uci.unset('wireless', morseDevice['.name'], 's1g_chanbw');
			}
		};

		return wirelessMap.render().then(wirelessHtml => E('div', { class: 'wizard-contents' }, [
			E('div', { class: 'cbi-section' }, [
				E('h1', _('Welcome!')),
				E('p', _('Before you can use your HaLow device, you must set the country appropriately.')),
			]),
			wirelessHtml,
		]));
	},

	/**
	 * Usually, addFooter deals with handleSave etc.
	 *
	 * Because we're copying the wizard approach and want to use the wizard.css,
	 * we override this to create a 'wizard-style' footer.
	 *
	 * @override
	 */
	addFooter() {
		return E('div', { class: 'cbi-page-actions' }, [
			E('div', { class: 'container' }, [
				E('div', { class: 'cbi-page-actions-flex' }, [
					E('div', { style: 'flex-grow: 1' }),
					E('button', {
						class: 'cbi-button cbi-button-apply',
						click: classes.ui.createHandlerFn(this, 'handleApply'),
					}, [_('Apply')]),
				]),
			]),
		]);
	},
});
