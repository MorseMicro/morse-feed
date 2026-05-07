#!/bin/sh
# Copyright (C) 2006-2019 OpenWrt.org
# Copyright 2024 Morse Micro

# This is a rewritten version of /etc/diag.sh from base-files which
# adds more possible states and handles RGB leds. It also simplifies
# things by passing by argument rather than via setting status_led.

# New states are:
#   factory_reset/rebooting - 'about to happen' states in morse-button
#                             (triggered by holding down button)

# This is run before /tmp/sysinfo/board_name is populated on boot.
board_name="$(strings /proc/device-tree/compatible | head -1)"

# This lets us have a different basic LED colour depending
# on the mode of the device.
_mm_mode="$(persistent_vars_storage.sh READ mm_mode 2> /dev/null)"

status_red=$(get_dt_led status-red)
status_green=$(get_dt_led status-green)
status_blue=$(get_dt_led status-blue)

halow="$(get_dt_led halow)"
wifi="$(get_dt_led wifi)"
link="$(get_dt_led link)"
status="$(get_dt_led status)"

red="255 0 0"
green="0 255 0"
blue="0 0 127"
yellow="255 255 0"
cyan="0 255 127"
light_purple="255 0 127"
dark_purple="64 0 128"

three_pwmled_sta_color="$cyan"

three_pwmled_factory_reset_all_leds=0
case "$board_name" in
morse,halowlink-apx)
	three_pwmled_factory_reset_all_leds=1

	# Green is too similar to yellow on APX boards - use amber.
	yellow="255 100 0"
	three_pwmled_sta_color="$green"

	case "$_mm_mode" in
	ap)
		wifi=""
		;;
	sta)
		link=""
		;;
	esac
	;;
esac

led_set_color() {
	# input is <led> <R G B>, The assumption here is that
	# /sys/class/leds/$1/multi_index is always "red green blue". And that
	# /sys/class/leds/$1/max_brightness is always 255
	led_set_attr "$1" multi_intensity "$2"
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

set_three_pwmled_normal() {
	# There's a bug in the pwm-multicolor module which means colour
	# change malfunctions if the LED is off due to a timer trigger.
	# APP-3323
	led_on "$status"
	# Force the colours of all LEDs to the standard colours.
	led_set_color "$halow" "$light_purple"
	if [ "$_mm_mode" = sta ]; then
		led_set_color "$status" "$three_pwmled_sta_color"
	else
		led_set_color "$status" "$green"
	fi
	[ -n "$wifi" ] && led_set_color "$wifi" "$green"
	[ -n "$link" ] && led_set_color "$link" "$yellow"
}

# The transitions are:
# failsafe -> preinit_regular -> done
# preinit -> done
# done -> upgrade
# done -> ap_change -> sta_change -> factory_reset
set_three_pwmled_state() {
	case "$1" in
	preinit|preinit_regular)
		set_three_pwmled_normal
		led_blink_fast "$status"
		;;
	failsafe)
		led_off "$halow"
		[ -n "$wifi" ] && led_off "$wifi"
		[ -n "$link" ] && led_off "$link"
		led_set_color "$status" "$red"
		led_blink_veryfast "$status"
		;;
	upgrade)
		led_off "$halow"
		[ -n "$wifi" ] && led_off "$wifi"
		[ -n "$link" ] && led_off "$link"
		led_set_color "$status" "$blue"
		led_blink "$status"
		;;
	factory_reset)
		if [ "$three_pwmled_factory_reset_all_leds" = 1 ]; then
			# Set colours first, then start all timers together to keep blinks in sync.
			led_on "$halow"
			led_set_color "$halow" "$yellow"
			led_on "$status"
			led_set_color "$status" "$yellow"
			[ -n "$wifi" ] && led_on "$wifi"
			[ -n "$wifi" ] && led_set_color "$wifi" "$yellow"
			[ -n "$link" ] && led_on "$link"
			[ -n "$link" ] && led_set_color "$link" "$yellow"
			led_blink "$halow"
			led_blink "$status"
			[ -n "$wifi" ] && led_blink "$wifi"
			[ -n "$link" ] && led_blink "$link"
		else
			led_off "$halow"
			[ -n "$wifi" ] && led_off "$wifi"
			led_set_color "$status" "$yellow"
			led_blink "$status"
		fi
		;;
	soft_reset)
		led_on "$status"
		led_set_color "$status" "$yellow"
		led_blink_slow "$status"
		;;
	ap_change)
		# Changing to AP mode.
		led_set_color "$status" "$green"
		led_blink "$status"
		;;
	sta_change)
		# Changing to STA mode.
		led_set_color "$status" "$three_pwmled_sta_color"
		led_blink_fast "$status"
		;;
	link_down)
		set_three_pwmled_normal
		[ -n "$link" ] && led_off "$link"
		;;
	ip_assigned)
		set_three_pwmled_normal
		[ -n "$link" ] && led_on "$link"
		[ -n "$link" ] && led_set_color "$link" "$yellow"
		[ -n "$link" ] && led_blink_slow "$link"
		;;
	cloud_searching)
		set_three_pwmled_normal
		[ -n "$link" ] && led_on "$link"
		[ -n "$link" ] && led_set_color "$link" "$green"
		[ -n "$link" ] && led_blink_slow "$link"
		;;
	cloud_online)
		set_three_pwmled_normal
		[ -n "$link" ] && led_on "$link"
		[ -n "$link" ] && led_set_color "$link" "$green"
		;;
	done)
		set_three_pwmled_normal
		;;
	esac
}

set_single_rgbled_state() {
	led_off "$status_red"
	led_off "$status_green"
	led_off "$status_blue"

	case "$1" in
	preinit)
		led_blink_fast "$status_green"
		;;
	failsafe)
		led_blink_veryfast "$status_red"
		;;
	preinit_regular)
		led_blink "$status_green"
		;;
	upgrade)
		led_blink "$status_blue"
		;;
	rebooting)
		# Because rebooting and factory_reset are triggered
		# by the same button on the EKH03/4, and we start flashing
		# as soon as the function has changed, it's useful to
		# have both a colour difference and a timing difference
		# (for colour blindness, and to make it clear that
		# a different state has been reached).
		led_blink "$status_green"
		;;
	factory_reset)
		# This is intentionally the same colour as the uboot: the
		# idea is that the flashing yellow transition to solid yellow
		# which shows you that the reset has completed, just as the
		# flashing green transitions to solid green on boot.
		# yellow
		led_blink_fast "$status_green"
		led_blink_fast "$status_red"
		;;
	done)
		# Restore the LEDs default triggers since we might
		# have finished messing with it.
		status_led_restore_trigger status-red
		status_led_restore_trigger status-green
		status_led_restore_trigger status-blue

		led_on "$status_green"

		# Now force OpenWrt's normal LED management
		# to re-apply.
		/etc/init.d/led restart
		;;
	esac
}

set_state() {
	if [ -n "$halow" -a -n "$status" ]; then
		set_three_pwmled_state "$1"
	elif [ -n "$status_red" -a -n "$status_green" -a -n "$status_blue" ]; then
		set_single_rgbled_state "$1"
	elif [ -n "$boot" -o -n "$failsafe" -o -n "$running" -o -n "$upgrade" ]; then
		# This is the normal action, but with our additional button generated states added
		# for our enhanced button scripts.
		case "$1" in
		factory_reset)
			led_off "$running"
			led_blink_fast "$upgrade"
			;;
		rebooting)
			led_off "$running"
			led_blink "$boot"
			;;
		*)
			set_led_state "$1"
			;;
		esac
	fi
}
