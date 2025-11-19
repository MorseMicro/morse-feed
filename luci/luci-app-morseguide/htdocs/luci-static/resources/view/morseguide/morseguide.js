'use strict';
/* globals view ui */
'require view';
'require ui';

// WARNING: Every time the offline user guide is updated, this link must be updated as well.
const S3_BUCKET_USER_GUIDE_URL = 'https://repo.apps.morsemicro.com/openwrt/resources/UG+MM6108_MM8108+Eval+Kit+User+Guide+2.11.2.pdf';
const OFFLINE_USER_GUIDE_URL = '/UG MM6108_MM8108 Eval Kit User Guide 2.11.2 - v27.pdf';

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	render: function () {
		var body = E([]);

		var offlineBanner = ui.addNotification(null, [
			_('The offline user guide is compressed and some images may appear blurry.'),
			E('p', _(`
				Open this <a %s>offline guide</a>
				in a new tab or view the uncompressed <a %s>online guide</a>
				(requires internet connection).
			`).format(`target="_blank" href="${OFFLINE_USER_GUIDE_URL}"`, `target="_blank" href="${S3_BUCKET_USER_GUIDE_URL}"`)),
		], 'warning');
		offlineBanner.style.zIndex = 100;

		var ifrm = document.createElement('iframe');
		ifrm.setAttribute('src', OFFLINE_USER_GUIDE_URL);
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
