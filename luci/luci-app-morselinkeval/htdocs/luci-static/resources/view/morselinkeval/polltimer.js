'use strict';
/* globals baseclass */
'require baseclass';

/* PollTimer — a private, per-controller polling timer.
 *
 * Replaces LuCI's global poll singleton so each tab owns its refresh lifecycle
 * (no shared header toggle, no cross-tab coupling). The callback runs
 * immediately on start(), then every `interval` seconds; ticks never overlap —
 * the next is scheduled only after the current (async) callback settles, so a
 * slow RPC can't pile up requests. */
class PollTimer {
	#fn;
	#intervalMs;
	#timer = null;
	#running = false;

	constructor(fn, intervalSec) {
		this.#fn = fn;
		this.#intervalMs = intervalSec * 1000;
	}

	start() {
		if (this.#running) return;
		this.#running = true;
		/* Fire the first tick immediately. */
		this.#tick();
	}

	stop() {
		this.#running = false;
		if (this.#timer != null) {
			window.clearTimeout(this.#timer);
			this.#timer = null;
		}
	}

	async #tick() {
		if (!this.#running) return;

		try {
			await this.#fn();
		} catch (e) {
			/* A failed poll must not kill the timer. */
		}

		/* The callback may have called stop() (e.g. on a lost session). */
		if (!this.#running) return;
		this.#timer = window.setTimeout(() => this.#tick(), this.#intervalMs);
	}
}

return baseclass.extend({ PollTimer });
