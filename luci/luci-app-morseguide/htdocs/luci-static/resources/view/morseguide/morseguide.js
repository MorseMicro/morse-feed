'use strict';
/* globals view ui */
'require view';
'require ui';

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	render: function () {
		var body = E([]);

		var offlineBanner = ui.addNotification(null, [
			'You are viewing a compressed offline version of this document and some images may appear blurry. The original PDF can be found ',
			E('a', { href: 'https://www.morsemicro.com/downloads-dashboard/', target: '_blank' }, ' here'),
			'.',
		], 'warning');
		offlineBanner.style.zIndex = 100;

		var ifrm = document.createElement('iframe');
		ifrm.setAttribute('src', '/UG MM6108 Eval Kit User Guide 2.7 - v21.pdf');
		ifrm.style.overflow = 'hidden';
		ifrm.style.margin = '0px';
		ifrm.style.padding = '0px';
		ifrm.style.height = '100%';
		ifrm.style.width = '100%';
		ifrm.style.position = 'absolute';
		ifrm.style.top = '0px';
		ifrm.style.left = '0px';
		ifrm.style.right = '0px';
		ifrm.style.bottom = '0px';
		ifrm.height = '100%';
		ifrm.width = '100%';
		body.appendChild(ifrm);
		return body;
	},
});
