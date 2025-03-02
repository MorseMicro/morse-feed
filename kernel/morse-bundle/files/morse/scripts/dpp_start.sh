#!/bin/sh

# This script is called by the button handler when the DPP button is pressed.
# The button can be pressed physically or via luci.

. /lib/functions.sh
. /lib/functions/leds.sh

has_ap_interface=0
has_sta_interface=0

# This file is removed upon DPP timeout/Success in wpa_s1g_dpp_action.sh script
dpp_start_time=/tmp/dpp_start_time

error_exit() {
	echo "$*"
	logger -t button -p daemon.notice "$*"
	exit 1
}

start_wpa_event_listener() {
	# Start the wpa_event_listener to listen for DPP events. The
	# wpa_event_listener will write the config on the STA side and control the
	# blinking led.
	killall wpa_event_listener
	wpa_event_listener "$@" -a /lib/netifd/morse/wpa_s1g_dpp_action.sh -B
}

_check_available_interfaces() {
	local section_name="$1"
	config_get device "$section_name" device
	if [ "$(uci -q get "wireless.$device.type")" != "morse" ]; then
		return
	fi
	config_get disabled "$section_name" disabled 0
	if [ "$disabled" != 0 ]; then
		return
	fi
	config_get mode "$section_name" mode
	case "$mode" in
		"ap")
			has_ap_interface=1
		;;
		"sta")
			has_sta_interface=1
		;;
	esac
}

perform_dpp_actions() {
	dpp_push_btn_cmd=""
	if [ "$has_ap_interface" -eq 1 ]; then
		start_wpa_event_listener -p /var/run/hostapd_s1g/
		dpp_push_btn_cmd="hostapd_cli_s1g"
	elif [ "$has_sta_interface" -eq 1 ]; then
		start_wpa_event_listener
		dpp_push_btn_cmd="wpa_cli_s1g"
	else
		logger -t button -p daemon.error "No available interface to start DPP"
	fi

	if [ -n "$dpp_push_btn_cmd" ]; then
		sleep 1  # Wait a sec for wpa_event_listener to be listening
		$dpp_push_btn_cmd dpp_push_button
		# Check the result of the dpp push button command
		if [ $? -eq 0 ]; then
			logger -t button -p daemon.notice "starting DPP due to button press"
			# Update the dpp start time
			echo "$current_uptime" > "$dpp_start_time"
		fi
	fi
}

# Check that the device is in a DPP mode (AP or STA) and tell hostap/wpa_supplicant that the
# button is pressed if so.
# If both AP and STA interfaces are available, prioritize starting DPP 
# on the AP interface, which also applies to the EasyMesh agent scenario.
maybe_press_dpp_button() {
	config_load wireless
	config_foreach _check_available_interfaces wifi-iface
	perform_dpp_actions
}

# Create a DPP timestamp file with the current uptime after the initial button press.
# For subsequent button presses, check the timestamp to ensure at least 120 seconds have passed,
# preventing rapid consecutive DPP events.
current_uptime=$(awk '{print int($1)}' /proc/uptime)

if [ -f $dpp_start_time ]; then
	stored_uptime=$(cat "$dpp_start_time")
	uptime_diff=$((current_uptime - stored_uptime))
	# If you change this time, make sure to update luci-mod-home
	if [ "$uptime_diff" -lt 120 ]; then
		error_exit "DPP button already pressed. Please wait for 2 minutes after the initial press."
	fi
fi

maybe_press_dpp_button
exit 0
