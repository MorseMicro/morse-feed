#!/bin/sh
# Copyright (C) 2006-2019 OpenWrt.org
# Copyright 2024 Morse Micro

# This is a rewritten version of /etc/diag.sh from base-files which
# adds more possible states. It also simplifies things by disabling
# all LEDs on every call (so we don't have to test what to disable)
# and passing by argument rather than via setting status_led.

. /lib/functions.sh
. /lib/functions/leds.sh

boot="$(get_dt_led boot)"
failsafe="$(get_dt_led failsafe)"
running="$(get_dt_led running)"
runningsta="$(get_dt_led runningsta)"
upgrade="$(get_dt_led upgrade)"
dpp="$(get_dt_led dpp)"

disable_all_leds() {
	led_off "$boot"
	led_off "$failsafe"
	led_off "$running"
	led_off "$upgrade"
	led_off "$dpp"
}

led_blink_slow() {
	led_timer "$1" 1000 1000
}

led_blink() {
	led_timer "$1" 300 300
}

led_blink_fast() {
	led_timer "$1" 100 100
}

led_blink_veryfast() {
	led_timer "$1" 50 50
}

set_state() {
	disable_all_leds

	case "$1" in
	preinit)
		led_blink_fast "$running"
		;;
	failsafe)
		led_blink_veryfast "$failsafe"
		;;
	preinit_regular)
		led_blink_fast "$running"
		;;
	upgrade)
		led_blink "$upgrade"
		;;
	dpp_started)
		led_blink_slow "$dpp"
		;;
	dpp_failed)
		led_blink_fast "$dpp"
		;;
	factory_reset)
		# On Morse RGB LED devices, this usually produces a yellow
		# (which is the same as the uboot colour).
		led_blink "$failsafe"
		led_blink "$running"
		;;
	ap_change)
		# Changing to AP mode.
		led_blink "$running"
		;;
	sta_change)
		# Changing to STA mode.
		led_blink_fast "$running"
		led_blink_fast "$runningsta"
		;;
	done)
		# Restore the boot LEDs default trigger since we might
		# have finished messing with it.
		status_led_restore_trigger boot

		led_on "$running"
		;;
	esac
}
