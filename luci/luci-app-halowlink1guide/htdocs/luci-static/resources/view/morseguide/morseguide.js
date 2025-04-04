'use strict';
/* globals view */
'require view';

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	render: function () {
		var body = E([]);
		var ifrm = document.createElement('iframe');
		ifrm.setAttribute('src', '/halowlink1-userguide-2.7.4.pdf');
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
