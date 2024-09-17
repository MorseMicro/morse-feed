#!/bin/sh
#
# Copyright (C) 2023 MorseMicro
#

set -eu
trap exit_handler EXIT

exit_handler()
{
	if [ "$?" -ne 0 ]; then
		echo "Usage: $0 OPERATION(READ|WRITE|ERASE) KEY [VALUE]" 1>&2
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

case "$operation" in
	READ)
		fw_printenv -n -c "$conffile" "$key" 2> /dev/null
	;;

	WRITE)
		value="$3"
		fw_setenv -c "$conffile" "$key" "$value"
	;;

	ERASE)
		fw_setenv -c "$conffile" "$key"
	;;

	*)
		exit 1
	;;
esac
