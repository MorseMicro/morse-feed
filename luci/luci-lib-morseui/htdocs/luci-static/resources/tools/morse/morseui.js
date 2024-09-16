'use strict';
/* globals baseclass form fs poll rpc uci ui */
'require form';
'require ui';
'require uci';
'require fs';
'require rpc';
'require baseclass';
'require poll';

const callIwinfoScan = rpc.declare({
	object: 'iwinfo',
	method: 'scan',
	params: ['device'],
	nobatch: true,
	expect: { results: [] },
});

const mmCommonConsts = {
	ip_regex: '^((25[0-5]|(2[0-4]|1\\d|[1-9]|)\\d)\\.){3}(25[0-5]|(2[0-4]|1\\d|[1-9]|)\\d)$',
	ip_regex_errormsg: _('The input doesn\'t seem to be a valid IPv4 address!'),
};

document.querySelector('head').appendChild(E('link', {
	rel: 'stylesheet',
	type: 'text/css',
	href: L.resourceCacheBusted('tools/morse/css/ui-addons.css'),
}));

var CBIDppPB = form.DummyValue.extend({
	renderWidget: function () {
		return E([], [
			E('span', { class: 'control-group' }, [
				E('button', {
					class: 'cbi-button cbi-button-apply',
					click: ui.createHandlerFn(this, async function () {
						console.log('dpp push button');
						await fs.exec('/morse/scripts/dpp_start.sh');
						// add a wait to keep the busy indicator showing on the button for 100s.
						// 100s is the dpp push button timeout.
						await new Promise(r => setTimeout(r, 100000));
					}),
					disabled: this.disabled,
				}, _('Start')),
			]),
		]);
	},
});

var UIStandardList = ui.Select.extend({
	// DO NOT USE: modifying the ui element at a low level like this causes
	// it to misbehave when reloading after a save, as the CBIStandardList
	// hasn't been updated with the new options. Use clear/renderUpdate/formvalue
	// instead.
	setValue: function (value) {
		var inputEl = this.node.querySelector('select');
		var options = inputEl.options.length;
		for (var i = 0; i < options; i++) {
			if (inputEl.options[i].value == value) {
				inputEl.options[i].selected = true;
				break;
			}
		}
	},

	clearOptions: function () {
		var inputEl = this.node.querySelector('select');
		inputEl.innerHTML = '';
	},

	addOption: function (val, label) {
		var inputEl = this.node.querySelector('select');
		inputEl.appendChild(E('option', { value: val }, label));
	},

});

var CBIStandardList = form.ListValue.extend({
	renderWidget: function (section_id, option_index, cfgvalue) {
		var choices = this.transformChoices();
		var widget = new UIStandardList(cfgvalue != null ? cfgvalue : this.default, choices, {
			id: this.cbid(section_id),
			size: this.size,
			sort: this.keylist,
			widget: this.widget,
			optional: this.optional,
			orientation: this.orientation,
			placeholder: this.placeholder,
			validate: L.bind(this.validate, this, section_id),
			disabled: this.readonly != null ? this.readonly : this.map.readonly,
		});
		return widget.render();
	},
});

var UIToggle = ui.Select.extend({
	render: function () {
		var frameEl = E('div', { id: this.options.id, style: 'margin: 0 auto;' }),
			keys = Object.keys(this.choices);

		if (this.options.sort === true)
			keys.sort();
		else if (Array.isArray(this.options.sort))
			keys = this.options.sort;

		var toggleDiv = E('div', {
			class: 'morse-toggle',
		});

		for (var i = 0; i < keys.length; i++) {
			toggleDiv.appendChild(E([
				E('input', {
					id: this.options.id ? 'widget.%s.%d'.format(this.options.id, i) : null,
					name: this.options.id || this.options.name,
					type: 'radio',
					value: keys[i],
					checked: (this.values.indexOf(keys[i]) > -1) ? '' : null,
					disabled: this.options.disabled ? '' : null,
				}),
				E('label', { for: this.options.id ? 'widget.%s.%d'.format(this.options.id, i) : null }, [this.choices[keys[i]] || keys[i]]),
			]));
		}

		frameEl.appendChild(toggleDiv);
		return this.bind(frameEl);
	},

	setValue: function (value) {
		var radioEls = this.node.querySelectorAll('input[type="radio"]');
		for (var i = 0; i < radioEls.length; i++) {
			radioEls[i].checked = (radioEls[i].value == value);
		}
	},
});

var CBIToggle = form.Value.extend({
	__name__: 'CBI.Toggle',

	__init__: function () {
		this.super('__init__', arguments);
		this.widget = 'radio';
		this.orientation = 'horizontal';
		this.deplist = [];
	},

	renderWidget: function (section_id, option_index, cfgvalue) {
		var choices = this.transformChoices();
		var widget = new UIToggle((cfgvalue != null) ? cfgvalue : this.default, choices, {
			id: this.cbid(section_id),
			size: this.size,
			sort: this.keylist,
			widget: this.widget,
			optional: this.optional,
			orientation: this.orientation,
			placeholder: this.placeholder,
			validate: L.bind(this.validate, this, section_id),
			disabled: (this.readonly != null) ? this.readonly : this.map.readonly,
		});
		return widget.render();
	},
});

var UISlider = ui.Checkbox.extend(/** @lends LuCI.ui.Checkbox.prototype */ {
	/** @override */
	render: function () {
		var id = 'cb%08x'.format(Math.random() * 0xffffffff);
		var frameEl = E('div', {
			id: this.options.id,
			class: 'cbi-checkbox',
		});

		if (this.options.hiddenname)
			frameEl.appendChild(E('input', {
				type: 'hidden',
				name: this.options.hiddenname,
				value: 1,
			}));

		frameEl.appendChild(
			E('label', { class: 'morse-switch' }, [
				E('input', {
					'id': id,
					'name': this.options.name,
					'type': 'checkbox',
					'value': this.options.value_enabled,
					'checked': (this.value == this.options.value_enabled) ? '' : null,
					'disabled': this.options.disabled ? '' : null,
					'data-widget-id': this.options.id ? 'widget.' + this.options.id : null,
				}),
				E('span', {
					class: 'morse-slider round',
				}),
			]),
		);

		frameEl.appendChild(E('label', { for: id }));

		if (this.options.tooltip != null) {
			var icon = '⚠️';

			if (this.options.tooltipicon != null)
				icon = this.options.tooltipicon;

			frameEl.appendChild(
				E('label', { class: 'cbi-tooltip-container' }, [
					icon,
					E('div', { class: 'cbi-tooltip' },
						this.options.tooltip,
					),
				]),
			);
		}

		return this.bind(frameEl);
	},
});

var CBISlider = form.Flag.extend({

	updateLabel: function (cbid, value) {
		var id = 'widget.' + cbid;
		var search = 'label[for="%s"]'.format(id);
		var label = document.querySelector(search);

		switch (value) {
			case this.enabled:
				label.innerHTML = this.enable_string;
				break;
			case this.disabled:
			default:
				label.innerHTML = this.disable_string;
				break;
		}
	},

	renderWidget: function (section_id, option_index, cfgvalue) {
		var tooltip = null;

		if (typeof (this.tooltip) == 'function')
			tooltip = this.tooltip.apply(this, [section_id]);
		else if (typeof (this.tooltip) == 'string')
			tooltip = (arguments.length > 1) ? ''.format.apply(this.tooltip, this.varargs(arguments, 1)) : this.tooltip;

		var widget = new UISlider((cfgvalue != null) ? cfgvalue : this.default, {
			id: this.cbid(section_id),
			validate: L.bind(this.validate, this, section_id),
			value_enabled: this.enabled,
			value_disabled: this.disabled,
			tooltip: tooltip,
			tooltipicon: this.tooltipicon,
			disabled: (this.readonly != null) ? this.readonly : this.map.readonly,
		});

		return widget.render();
	},

	render: async function (option_index, section_id /* ... */) {
		const el = await form.Flag.prototype.render.apply(this, arguments);
		if (this.enable_string && this.disable_string) {
			el.addEventListener('widget-change', () => {
				this.updateLabel(this.cbid(section_id), this.formvalue(section_id));
			});
		}
		return el;
	},
});

var CBIEditableList = form.Value.extend({
	__name__: 'CBI.EditableListValue',
	__init__: function () {
		this.super('__init__', arguments);
		this.orientation = 'horizontal';
		this.deplist = [];
	},

	renderWidget: function (section_id, option_index, cfgvalue) {
		var choices = this.transformChoices();
		var widget = new ui.Dropdown(cfgvalue != null ? cfgvalue : this.default, choices != null ? choices : {}, {
			id: this.cbid(section_id),
			widget: this.widget,
			// Force placeholder if no valid choices.
			// If we don't do this, the create input box gets selected and leads to a '-' SSID being
			// treated as valid input (as the default value of this input box is '-').
			// Note that the validity check will still fail if this.optional is false.
			optional: choices == null ? true : this.optional,
			orientation: this.orientation,
			placeholder: this.placeholder,
			create: true,
			disabled: this.readonly != null ? this.readonly : this.map.readonly,
			custom_placeholder: '',
			validate: L.bind(this.validate, this, section_id),
			datatype: this.datatype,
		});

		if (this.onclick) {
			var bt = E('button', {
				class: 'cbi-button cbi-button-apply',
				style: 'vertical-align:top; margin-top:1px',
				click: ui.createHandlerFn(this, function (section_id, ev) {
					return this.onclick(ev, section_id);
				}, section_id),
				disabled: this.readonly,
			}, [this.btnText]);
			return E([], [widget.render(), ' ', bt]);
		}
		return widget.render();
	},
});

var mmRenderElement = function (s, opt, init_val) {
	var o;
	switch (opt.type) {
		case 'text': {
			o = s.option(form.Value, opt.field, _(opt.description));
			break;
		}

		case 'ApDppPB': {
			o = s.option(CBIDppPB, opt.field, _(opt.description));
			o.disabled = opt.disabled;
			break;
		}

		case 'StaDppPB': {
			o = s.option(CBIDppPB, opt.field, _(opt.description));
			o.disabled = opt.disabled;
			break;
		}

		case 'password':
		{
			o = s.option(form.Value, opt.field, _(opt.description));
			o.password = true;
			break;
		}

		case 'dropdown':
		{
			o = s.option(CBIStandardList, opt.field, _(opt.description));
			opt.vals.forEach(
				function (val) {
					o.value(val.key, val.value);
				},
			);
			break;
		}

		case 'editdrop':
		{
			o = s.option(CBIEditableList, opt.field, _(opt.description));
			opt.vals.forEach(
				function (val) {
					o.value(val.key, val.value);
				},
			);
			break;
		}

		case 'radio':
		{
			o = s.option(form.ListValue, opt.field, _(opt.description));
			o.widget = 'radio';
			o.orientation = 'vertical';
			opt.vals.forEach(
				function (val) {
					o.value(val.key, val.value);
				},
			);
			break;
		}

		case 'checkbox':
		{
			o = s.option(form.Flag, opt.field, _(opt.description));
			o.multiple = true;
			o.optional = true;
			o.value(opt.field);
			break;
		}

		case 'slider':
		{
			var enabled = opt.strings.filter(e => e.key == '1')[0];
			var disabled = opt.strings.filter(e => e.key == '0')[0];
			o = s.option(CBISlider, opt.field, init_val == '1' ? enabled.value : disabled.value);
			o.multiple = true;
			o.optional = true;
			o.disable_string = disabled.value;
			o.enable_string = enabled.value;
			o.value(opt.field);
			break;
		}

		case 'toggle': {
			o = s.option(CBIToggle, opt.field);
			o.multiple = true;
			opt.vals.forEach(function (val) {
				o.value(val.key, val.value);
			});
			break;
		}

		case 'hidden': {
			s.option(form.HiddenValue, opt.field);
			break;
		}

		case 'href': {
			o = s.option(form.DummyValue, opt.field, opt.description);
			o.default = opt.url_text;
			o.href = opt.url;
			break;
		}
	}

	if (Object.prototype.hasOwnProperty.call(opt, 'helptext')) {
		o.description = opt.helptext;
	}

	if (Object.prototype.hasOwnProperty.call(opt, 'depends')) {
		if (Array.isArray(opt.depends))
			opt.depends.forEach(obj => o.depends(obj));
		else
			o.depends(opt.depends);
	}

	if (Object.prototype.hasOwnProperty.call(opt, 'validate')) {
		o.validate = opt.validate;
	} else if (Object.prototype.hasOwnProperty.call(opt, 'validationRegex')) {
		o.validate = function (station_id, value) {
			if (Object.prototype.hasOwnProperty.call(opt, 'validationRegexASCII')) {
				var val_asciiregex = opt.validationRegexASCII;
				var asciiregex = new RegExp(val_asciiregex);
			}
			var val_regex = opt.validationRegex;
			/* if a option is allowed to be empty but has validation
             * regex, then add the empry alternative to its regex. */
			if (Object.prototype.hasOwnProperty.call(opt, 'allow_empty')) {
				if (opt.allow_empty) {
					val_regex = val_regex + '|^$';
				}
			}
			var regex = new RegExp(val_regex);
			if (regex.test(value))
				return true;
			if (Object.prototype.hasOwnProperty.call(opt, 'validationRegexASCII') && asciiregex.test(value))
				return opt.validateErrMessageASCII;
			else if (Object.prototype.hasOwnProperty.call(opt, 'validateErrMessage'))
				return opt.validateErrMessage;
			else
				return 'invalid input';
		};
	} else if (Object.prototype.hasOwnProperty.call(opt, 'validationRange')) {
		o.validate = function (station_id, value) {
			if (value >= opt.validationRange.min && value <= opt.validationRange.max)
				return true;

			if (Object.prototype.hasOwnProperty.call(opt, 'validateErrMessage'))
				return opt.validateErrMessage;
			else
				return 'invalid input';
		};
	}

	return o;
};

var mmRenderSection = function (topSection, opts, layout, conf) {
	var elements = {};
	layout.forEach(
		(section) => {
			var so = topSection.option(form.SectionValue, section.name, form.NamedSection, 'config', 'config', _(section.description));
			var ss = so.subsection;
			section.opts.forEach(
				(opt) => {
					let obj = opts.find((obj) => {
						return obj.field == opt;
					});
					if (!obj) return;
					elements[opt] = mmRenderElement(ss, obj,
						typeof conf['config'][opt] === 'undefined' ? '' : conf['config'][opt],
					);
				},
			);

			if (Object.prototype.hasOwnProperty.call(section, 'depends')) {
				so.depends(section.depends);
			}
		},
	);

	return elements;
};

var UITimeoutModal = function (changes, extraHrefs) {
	var hrefs = [window.location.host];
	if (extraHrefs !== undefined) {
		hrefs.push(...extraHrefs);
	}

	if (changes.network != null) {
		changes.network.forEach(
			([command, , key, value]) => {
				if (command == 'set' && key == 'ipaddr')
					hrefs.push(value);
			},
		);
	}

	var ts = performance.now();
	var timerId = 0;
	var timer = 60 * 1000;
	var deadline = ts + timer;
	var tick = function () {
		var now = performance.now();

		ui.showModal(_('Saving'), [
			E('p', { class: 'spinning' }, _('Applying configuration changes %ds. The page will reload on successful reconnect').format(Math.max(Math.floor((deadline - performance.now()) / 1000, 0)))),
		]);

		if (now > (deadline - 1000)) {
			window.clearTimeout(timerId);
			ui.showModal(_('Unable to reconnect'), [
				E('p', { class: 'spinning warning' }, _('Couldn\'t reconnect to device. If you\'ve set your device to DHCP Client, or changed the device subnet, you may need to reconnect manually.')),
			], 'alert-message', 'warning');
			return;
		}

		timerId = window.setTimeout(tick, 1000 - (now - ts));
		ts = now;
	};

	var reconnect = function () {
		var poller = function () {
			poll.add(function () {
				var tasks = [];
				hrefs.forEach(
					ip => tasks.push(
						ui.pingDevice(window.location.protocol.replace(/:/g, ''), ip).then(() => {
							return ip;
						}),
					));
				return Promise.any(tasks).then(function (ip) {
					poll.stop();
					window.clearTimeout(timerId);
					ui.hideModal();
					window.location.replace(window.location.protocol + '//' + ip + window.location.pathname);
				});
			});
		};
		window.setTimeout(poller, 5000);
	};

	tick();

	window.setTimeout(reconnect, 10 * 1000);
};

/**
 * Do a single successful scan on the specified interface, matching only the specified mode.
 *
 * Will retry if no results or error.
 *
 * @param {string} iface
 * @param {string} mode  (default 'Master')
 * @param {number} retries  how many times to retry the scan (until without error + some results)
 * @returns {object} map of ssids to preferred encryption
 */
async function scanWifi(iface, mode = 'Master', retries = 6) {
	let scanResult = [];
	for (let i = 0; i < retries; ++i) {
		try {
			scanResult = (await callIwinfoScan(iface)).filter(result => result.mode == mode);

			if (scanResult.length > 0) {
				break;
			}
		} catch (e) {
			// i.e. if we're on the last retry, give up and re-throw.
			if (retries === i + 1) {
				throw e;
			}
		}
	}

	function getBestEncryption(enc) {
		// From wireless.js
		const is_psk = (enc && Array.isArray(enc.wpa) && L.toArray(enc.authentication).filter(function (a) {
			return a == 'psk';
		}).length > 0);
		const is_sae = (enc && Array.isArray(enc.wpa) && L.toArray(enc.authentication).filter(function (a) {
			return a == 'sae';
		}).length > 0);

		if (is_sae) {
			return 'sae';
		} else if (is_psk) {
			if (enc.wpa.includes(2)) {
				return 'psk2';
			} else {
				return 'psk';
			}
		} else {
			return 'none';
		}
	}

	const result = {};
	for (const res of scanResult) {
		if (res['ssid'] && !result[res['ssid']]) {
			result[res['ssid']] = getBestEncryption(res.encryption);
		}
	}

	return result;
}

/* If the adjacent mode is sta, adds a 'scan' button to Value
 * (and update itself + encryption if necessary).
 *
 * If the adjacent mode is not sta, just present a value (without a button).
 *
 * Requires the map to call renderUpdate when appropriate
 * (i.e. when the mode changes).
 */
var CBISSIDListScan = form.Value.extend({
	__name__: 'CBI.SSIDWithScan',
	__init__: function () {
		this.super('__init__', arguments);
		this.scanResults = {};
	},

	onchange(ev, sectionId, value) {
		if (this.section.formvalue(sectionId, 'mode') === 'sta') {
			if (this.scanResults[value]) {
				const encryption = this.section.getUIElement(sectionId, 'encryption');
				if (encryption) {
					encryption.setValue(this.scanResults[value]);
					// Programmatic change doesn't cause 'change' event for a select, but we may need to
					// add a 'Key' field after an encryption change.
					encryption.node.querySelector('select').dispatchEvent(new Event('change'));
				}
			}
		}
	},

	renderStaWidget: function (sectionId, optionIndex, cfgvalue) {
		this.clear();
		if (cfgvalue) {
			this.value(cfgvalue, cfgvalue);
		}
		for (const ssid of Object.keys(this.scanResults)) {
			if (ssid !== cfgvalue) {
				this.value(ssid, ssid);
			}
		}

		return E('div', { class: 'control-group' }, [
			form.Value.prototype.renderWidget.call(this, sectionId, optionIndex, cfgvalue),
			E('button', {
				'class': 'cbi-button cbi-button-action',
				'title': _('Scan for wifi networks'),
				'aria-label': _('Scan for wifi networks'),
				'click': ui.createHandlerFn(this, async () => {
					this.scanResults = await scanWifi(uci.get('wireless', sectionId, 'device'));
					this.renderUpdate(sectionId);
				}),
			}, '\u{1F50D}'),
		]);
	},

	renderWidget: function (sectionId, optionIndex, cfgvalue) {
		if (['sta', 'sta-wds'].includes(this.section.formvalue(sectionId, 'mode'))) {
			return this.renderStaWidget(sectionId, optionIndex, cfgvalue);
		} else {
			this.clear();
			return form.Value.prototype.renderWidget.call(this, sectionId, optionIndex, cfgvalue);
		}
	},
});

return baseclass.extend({
	EditableList: CBIEditableList,
	SSIDListScan: CBISSIDListScan,
	StandardList: CBIStandardList,
	Slider: CBISlider,
	Toggle: CBIToggle,
	UISlider,
	UIToggle,
	timeoutModal: UITimeoutModal,
	renderElement: mmRenderElement,
	renderSection: mmRenderSection,
	commonConsts: mmCommonConsts,
});
