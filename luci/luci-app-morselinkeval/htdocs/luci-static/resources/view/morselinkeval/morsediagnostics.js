'use strict';

/* globals mleApi mleUi peerlink planner ui view */
'require view';
'require ui';
'require view.morselinkeval.api as mleApi';
'require view.morselinkeval.ui as mleUi';
'require view.morselinkeval.peerlink as peerlink';
'require view.morselinkeval.planner as planner';

/* Active controller references — stored so destroy() can be called if the
 * view is torn down before polling finishes naturally. */
let activePeerController = null;
let activePlannerController = null;

return view.extend({
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	/* load() fetches all async data so render() stays synchronous. */
	async load() {
		return Promise.all([
			mleApi.getS1GInterfaces(),
			/* Load Chart.js v4 via absolute resource URL so the dynamic import
			 * resolves correctly regardless of the document's CGI base path.
			 * The library registers window.Chart as a global side-effect. */
			import(L.resource('chart-4.min.js')).catch(() => null),
		]);
	},

	render([ifaces]) {
		/* Inject custom CSS once per page load. */
		if (!document.getElementById('mle-diag-css')) {
			const link = E('link', {
				id: 'mle-diag-css',
				rel: 'stylesheet',
				href: L.resource('view/morselinkeval/css/diagnostics.css'),
			});
			document.head.appendChild(link);
		}

		/* Tear down any previous controllers (handles repeated render calls). */
		if (activePeerController) {
			activePeerController.destroy();
			activePeerController = null;
		}
		if (activePlannerController) {
			activePlannerController.destroy();
			activePlannerController = null;
		}

		/* The Peer Link and Link Planner backend sessions are mutually
		 * exclusive — each controller pauses the other when it goes active. */
		let peerLinkContent, linkPlannerContent;
		if (ifaces.length === 0) {
			peerLinkContent = mleUi.noInterfacesNotice();
			linkPlannerContent = mleUi.noInterfacesNotice();
		} else {
			activePeerController = new peerlink.PeerLinkController(ifaces, {
				onBusy: () => { if (activePlannerController) activePlannerController.pause(); },
			});
			activePlannerController = new planner.LinkPlannerController(ifaces, {
				onBusy: () => { if (activePeerController) activePeerController.pause(); },
			});
			peerLinkContent = activePeerController.render();
			linkPlannerContent = activePlannerController.render();
		}

		const tabGroup = E('div', { 'data-tab-group': '0' }, [
			E('div', {
				'data-tab': 'peer-link',
				'data-tab-title': _('Peer Link Quality'),
			}, [peerLinkContent]),
			E('div', {
				'data-tab': 'link-planner',
				'data-tab-title': _('Link Planner'),
			}, [linkPlannerContent]),
		]);

		requestAnimationFrame(() => ui.tabs.initTabGroup(tabGroup.childNodes));

		return E('div', {}, [
			E('h2', {}, _('HaLow Diagnostics')),
			tabGroup,
		]);
	},
});
