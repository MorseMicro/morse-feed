#!/bin/sh
#
# Copyright (C) 2023 MorseMicro
#

set -eu
trap exit_handler EXIT

exit_handler()
{
	status=$?
	#Exit code 2 indicates intentional exit due to usage error
	if [ "$status" -eq 2 ]; then
		echo "User usage error"
		exit 2
	elif [ "$status" -ne 0 ]; then
		echo "Usage: $0 OPERATION(READ|READALL|WRITE|ERASE|RESTORE) KEY [VALUE]" 1>&2
		exit 1
	fi
}

# We don't use OpenWrt's find_mtd_part here because we want to write a script
# that exploits 'set -eu'.
find_mtd_partition()
{
	local name="$1"

	for partition in /sys/class/mtd/mtd*; do
		if [ "$(cat "$partition/name" 2> /dev/null)" = "$name" ]; then
			echo "/dev/$(basename "$partition")"
			return
		fi
	done

	1>&2 echo "Internal error: can't find $name partition"
	exit 1
}

show_raw_partition_data()
{
	local partition="$1" skip="$2" count="$3"

	# Running this through shell/echo strips the nulls and puts a newline in (consistent with fw_printenv)
	echo "$(dd if="$(find_mtd_partition "$partition")" bs=1  skip=$(($skip)) count="$count" 2> /dev/null)"
}

show_factory_data()
{
	local mm_region
	local board_name="$(cat /tmp/sysinfo/board_name)"

	case "$board_name" in
		morse,halowlink1 |\
		morse,halowlink2)
			case "$1" in
				device_password)
					show_raw_partition_data factory 0x40a0 32
				;;
				default_wifi_key)
					show_raw_partition_data factory 0x4080 32
				;;
				mm_region)
					show_raw_partition_data factory 0x40c0 2
				;;
				mm_sku)
					# This is used to select a BCF other than the OTP default.
					# See /lib/netifd/wireless/morse.sh
					show_raw_partition_data factory 0x40e0 32
				;;
			esac
		;;
		glinet,gl-mt3000|\
		morse,*ekh19*)
			case "$1" in
				default_wifi_key)
					show_raw_partition_data Factory 0x40 16
				;;
			esac
		;;
	esac
}

# Use secondary uboot env in preference
# (this one is less likely to be the 'real' uboot env).
# The disadvantage of using the real uboot env is that if it's empty/fails the CRC
# uboot-envtools decides to write the 'default' environment that it understands.
# Unfortunately, this is very unlikely to be consistent with the default environment
# compiled into the uboot, so it causes issues.
if [ -e /etc/fw_sys.config ]; then
	conffile=/etc/fw_sys.config
else
	conffile=/etc/fw_env.config
fi

operation="$1"
key="$2"

all_keys="device_password default_wifi_key dpp_priv_key mm_region
	mm_virtual_wire mm_mode dropbear_authorized_keys dropbear_ed25519_host_key
	dropbear_rsa_host_key"

# Does factory data exist for this key?
factory_has_key() {
	val="$(show_factory_data "$1" 2> /dev/null || true)"
	[ -n "$val" ]
}

case "$operation" in
	READ)
		# If this key is marked ERASED, do not try to read it
		erased_flag=$(fw_printenv -n -c "$conffile" "${key}_ERASED" 2> /dev/null || true)
		if [ "$erased_flag" = "1" ]; then
			exit 0
		fi
		if ! fw_printenv -n -c "$conffile" "$key" 2> /dev/null; then
			# If the user asks for env data that's not available, fall back to factory
			# defaults for the device (if available).
			show_factory_data "$2"
		fi
	;;

	READALL)
		for key in $all_keys; do
			printf '%s=%s\n' "$key" "$($0 READ "$key")"
		done
	;;

	WRITE)
		value="$3"
		# Refuse to write empty values. Use ERASE instead.
		if [ -z "$value" ]; then
			echo "ERROR: Empty values cannot be written, use ERASE instead" 1>&2
			exit 2
		fi
		fw_setenv -c "$conffile" "$key" "$value"
	;;

	ERASE)
		fw_setenv -c "$conffile" "$key"
		# If factory data is available for this key, mark it ERASED
		if factory_has_key "$key"; then
			fw_setenv -c "$conffile" "${key}_ERASED" "1"
			echo "WARNING: $key exists in factory data and is ignored currently. \
				To restore it, run $0 RESTORE $key." 1>&2
		fi
	;;

	RESTORE)
		# Clear the ERASED flag if it exists, so READ falls back to factory data
		fw_setenv -c "$conffile" "${key}_ERASED"
		# Also clear any existing value in the env if it was overridden
		fw_setenv -c "$conffile" "$key"
	;;

	*)
		exit 1
	;;
esac
