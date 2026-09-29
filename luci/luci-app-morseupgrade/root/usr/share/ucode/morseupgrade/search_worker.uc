#!/usr/bin/ucode
// Copyright 2026 Morse Micro
// Licensed under the Apache License, Version 2.0.
//
// morseupgrade async search worker.
//
// The search() ubus method spawns this as a detached process so the network
// fetches never block the rpcd event loop. It runs the blocking search from
// core.uc (run_search) and owns the result lifecycle.
//
// This is a separate file so that core.uc can avoid importing any native modules
// as per its header.

'use strict';

import { connect } from 'ubus';
import { cursor } from 'uci';
import * as fs from 'fs';
import { sha256_file } from 'digest';
import { create, SEARCH_RESULT, SEARCH_LOCK } from '/usr/share/ucode/morseupgrade/core.uc';

const handlers = create({
	ubus: connect(),
	cursor,
	fs,
	sha256_file,
	system,
	log: () => {},
	warn: () => {},
});

const result = handlers.run_search({});

fs.writefile(`${SEARCH_RESULT}.tmp`, sprintf('%J', result));
fs.rename(`${SEARCH_RESULT}.tmp`, SEARCH_RESULT);
fs.unlink(SEARCH_LOCK);
