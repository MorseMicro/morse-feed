#!/bin/sh
# Copyright (C) 2006-2019 OpenWrt.org
# Copyright 2024 Morse Micro

# This is a rewritten version of /etc/diag.sh from base-files which
# adds more possible states and handles RGB leds. It also simplifies
# things by passing by argument rather than via setting status_led.

. /lib/functions.sh
. /lib/functions/leds.sh

# This lets us have a different basic LED colour depending
# on the mode of the device.
_mm_mode="$(persistent_vars_storage.sh READ mm_mode 2> /dev/null)"
if [ -z "$_mm_mode" ]; then
	# Sadly, fw_*.config files are populated by uci-defaults, and when we're
	# early in the boot process we don't have it. But we really want to
	# show the mode colour early in the boot process to avoid confusion.
	# Board_name is also not available, so...
	board_name="$(strings /proc/device-tree/compatible | head -1)"
	case "$board_name" in
	morse,artini)
		echo '/dev/mtd1 0x0 0x8000 0x1000' > /tmp/artini_preinit_fw_sys.config
		_mm_mode="$(fw_printenv -n -c /tmp/artini_preinit_fw_sys.config mm_mode 2> /dev/null)"
		rm /tmp/artini_preinit_fw_sys.config
		;;
	esac
fi

# halow and wifi leds are partly controlled by this script and partly by
# /etc/init.d/led (which is configured by uci, which is configured by
# /etc/board.d/). The status led is controlled at boot by device tree
# configuration and the driver, and then only by this script.
halow="$(get_dt_led halow)"
wifi="$(get_dt_led wifi)"
status="$(get_dt_led status)"

red="255 0 0"
green="0 255 0"
blue="0 0 127"
yellow="255 255 0"
cyan="0 255 127"
light_purple="255 0 127"
dark_purple="64 0 128"

led_set_color() {
	# input is <led> <R G B>, The assumption here is that
	# /sys/class/leds/$1/multi_index is always "red green blue". And that
	# /sys/class/leds/$1/max_brightness is always 255
	led_set_attr "$1" multi_intensity "$2"
}

disable_all_leds() {
	led_off "$halow"
	led_off "$wifi"
	led_off "$status"
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

set_leds_normal() {
	# There's a bug in the pwm-multicolor stuff which means colour
	# change malfunctions if the LED is off due to a timer trigger.
	# APP-3323
	led_on "$status"

	# This sets the color of all leds and the blink pattern on status only.
	# The blink pattern of the other leds is controlled by /etc/init.d/led
	led_set_color "$halow" "$light_purple"
	led_set_color "$wifi" "$green"
	led_set_color "$status" "$green"
	if [ "$_mm_mode" = sta ]; then
		led_set_color "$status" "$cyan"
	fi
}

# The transitions are:
# failsafe -> preinit_regular -> done
# preinit -> done
# done -> upgrade
# done -> ap_change -> sta_change -> factory_reset
# done -> dpp_started -> dpp_failed -> done
set_state() {
	case "$1" in
	preinit|preinit_regular)
		set_leds_normal
		led_blink_fast "$status"
		;;
	failsafe)
		disable_all_leds
		led_set_color "$status" "$red"
		led_blink_veryfast "$status"
		;;
	upgrade)
		disable_all_leds
		led_set_color "$status" "$blue"
		led_blink "$status"
		;;
	dpp_started)
		led_set_color "$halow" "$dark_purple"
		led_blink_slow "$halow"
		;;
	dpp_failed)
		led_set_color "$halow" "$dark_purple"
		led_blink_fast "$halow"
		;;
	factory_reset)
		disable_all_leds
		led_set_color "$status" "$yellow"
		led_blink "$status"
		;;
	ap_change)
		# Changing to AP mode.
		led_set_color "$status" "$green"
		led_blink "$status"
		;;
	sta_change)
		# Changing to STA mode.
		led_set_color "$status" "$cyan"
		led_blink_fast "$status"
		;;
	done)
		# This state is called both after boot completes and after a DPP session finishes.
		set_leds_normal
		# DPP overrides the normal halow led trigger, so restore it here by calling the led script.
		/etc/init.d/led restart
		;;
	esac
}
