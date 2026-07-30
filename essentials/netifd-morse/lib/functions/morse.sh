. /lib/functions.sh

MORSE_REGDB_CHANNELS_CSV="/usr/share/morse-regdb/channels.csv"

kill_wait()
{
	local names=$*
	local count=3

	for pid in $(pidof $names)
	do
		kill $pid &> /dev/null
	done

	while pidof $names &> /dev/null;
	do
		sleep 1
		let "count--"
		if [ $count -eq 0 ]
		then
			echo "$names failed to terminate normally, force quitting" >&2
			kill -9 $(pidof $names)
			return 1
		fi
	done
	return 0
}

_list_phy_interfaces() {
	local phy="$1"
	if [ -d "/sys/class/ieee80211/${phy}/device/net" ]; then
		ls "/sys/class/ieee80211/${phy}/device/net" 2>/dev/null;
	else
		ls "/sys/class/ieee80211/${phy}/device" 2>/dev/null | grep net: | sed -e 's,net:,,g'
	fi
}

list_phy_interfaces() {
	local phy="$1"

	for dev in $(_list_phy_interfaces "$phy"); do
		readlink "/sys/class/net/${dev}/phy80211" | grep -q "/${phy}\$" || continue
	done
}

# _get_s1g_default_bandwidth <variable> <country> [s1g_chzn]
#
# Get the default (maximum) S1G operating bandwidth for a given country.
#
# s1g_chzn is optional. Rows with no chzn column value are always considered.
#
# Leaves the named output variable empty if no matching rows are found.
#
# Returns:
#	- 1 if the output variable name is invalid or no rows were found
#	- 2 if the country is missing
#
# Usage:
#	_get_s1g_default_bandwidth bw EU
#	[ -n "$bw" ] || { echo "no bandwidth for EU" >&2; exit 1; }
#
_get_s1g_default_bandwidth() {
	local __out="$1"
	local __country="$2"
	local __s1g_chzn="$3"

	case "$__out" in
		*[!A-Za-z0-9_]*|'')
			echo "invalid output variable name: $__out" >&2
			return 1
			;;
	esac

	if [ -z "$__country" ]; then
		return 2
	fi

	local __s1g_chanbw
	__s1g_chanbw="$(awk -F, '$1==country && (!$2 || (!chzn && $3 == "True") || $2 ~ ("(^|;)" chzn "(;|$)")) && $4 > max {max=$4} END {print max}' \
		chzn="$__s1g_chzn" country="$__country" "$MORSE_REGDB_CHANNELS_CSV")"

	eval "$__out=\$__s1g_chanbw"

	[ -n "$__s1g_chanbw" ]
}

# _get_s1g_default_channel <channel_var> <freq_var> <op_class_var> <country> <s1g_chanbw> [op_class] [s1g_chzn]
#
# Get the default (middle) S1G channel for a country and bandwidth.
#
# Sets channel_var/freq_var/op_class_var to the middle channel by frequency.
# op_class and s1g_chzn are optional filters.
#
# Returns:
#	- 1 if an output variable name is invalid or no matching channel is found
#	- 2 if country or s1g_chanbw is missing
#
# Usage:
#	_get_s1g_default_bandwidth bw EU
#	_get_s1g_default_channel ch freq op_class EU "$bw"
#	[ -n "$ch" ] || { echo "no channel for EU" >&2; exit 1; }
#
_get_s1g_default_channel() {
	local __channel_out="$1"
	local __freq_out="$2"
	local __op_class_out="$3"
	local __country="$4"
	local __s1g_chanbw="$5"
	local __op_class_filter="$6"
	local __s1g_chzn="$7"

	local __row

	case "$__channel_out" in
		*[!A-Za-z0-9_]*|'')
			echo "invalid output variable name: $__channel_out" >&2
			return 1
			;;
	esac
	case "$__freq_out" in
		*[!A-Za-z0-9_]*|'')
			echo "invalid output variable name: $__freq_out" >&2
			return 1
			;;
	esac
	case "$__op_class_out" in
		*[!A-Za-z0-9_]*|'')
			echo "invalid output variable name: $__op_class_out" >&2
			return 1
			;;
	esac

	if [ -z "$__country" -o -z "$__s1g_chanbw" ]; then
		return 2
	fi

	__row="$(awk -F, '$1==country && $4==bw && \
			(!$2 || (!chzn && $3 == "True") || $2 ~ ("(^|;)" chzn "(;|$)")) && \
			(!op_class || $6==op_class || $7==op_class) \
			{print $8, $5, $7}' \
		country="$__country" bw="$__s1g_chanbw" chzn="$__s1g_chzn" op_class="$__op_class_filter" \
		"$MORSE_REGDB_CHANNELS_CSV" \
		| sort -n | awk '{a[NR]=$0} END {if (NR) print a[int((NR+1)/2)]}')"

	if [ -z "$__row" ]; then
		return 1
	fi

	set -- $__row
	local __center_freq=$1
	local __channel=$2
	local __op_class="$__op_class_filter"
	if [ -z "$__op_class" ]; then
		__op_class=$3
	fi

	eval "$__channel_out=\$__channel"
	eval "$__freq_out=\$__center_freq"
	eval "$__op_class_out=\$__op_class"

	return 0
}

# _get_regulatory <country> [channel] [s1g_chanbw] [op_class] [s1g_chzn]
#
# Get regulatory info for a country.
#
# Country is required, remaining args are optional.
#
# If channel is unset/0/auto, the default bandwidth is chosen (if
# not already provided), and the default channel of that bandwidth is chosen.
# Otherwise, the given channel is validated and its bandwidth/op_class/center_freq
# are looked up.
#
# Sets "$country", "$channel", "$s1g_chanbw", "$op_class", and "$center_freq".
#
# Returns:
#	- 1 if no matching regulatory entry is found
#	- 2 if country is missing or channel is invalid.
#
# Usage:
#	_get_regulatory "$country" "$channel" "$s1g_chanbw" "$op_class" "$s1g_chzn"
#	if [ $? -ne 0 ]; then
#		echo "Couldn't find regulatory data for $country" >&2
#	fi
#
_get_regulatory() {
	country=$1
	channel=$2
	s1g_chanbw=$3
	op_class=$4
	s1g_chzn=$5

	local cc; local bw; local l_op; local g_op; local freq
	local remainder

	if [ -z "$country" ]; then
		return 2
	fi

	# Setting auto_channel allows _get_regulatory to operate independent of netifd wireless scripts.
	if [ -z "$auto_channel" ]; then
		case "$channel" in
			""|0|auto)
				auto_channel=1 ;;
			[0-9]*)
				auto_channel=0 ;;
			*)
				return 2 ;;
		esac
	fi

	if [ "$auto_channel" -gt 0 ]; then
		# Choose the maximum possible bandwidth if none was requested, then
		# resolve the default (middle) channel of that bandwidth.
		if [ -z "$s1g_chanbw" ]; then
			_get_s1g_default_bandwidth s1g_chanbw "$country" "$s1g_chzn" || return 1
		fi
		_get_s1g_default_channel channel center_freq op_class "$country" "$s1g_chanbw" "$op_class" "$s1g_chzn"
		return $?
	fi

	oIFS=$IFS
	HEADER=1
	while IFS=, read -r cc chzn default_chzn bw ch l_op g_op freq remainder; do
		if [ "$HEADER" = 1 ]; then
			HEADER=0
			continue
		fi

		if [ "$cc" != "$country" ]; then
			continue
		fi

		if [ -n "$chzn" ]; then
			if [ -n "$s1g_chzn" ]; then
				case "$chzn" in
				"$s1g_chzn"|"$s1g_chzn;"*|*";$s1g_chzn"|*";$s1g_chzn;"*)
					;;
				*)
					continue
					;;
				esac
			elif [ "$default_chzn" != True ]; then
				continue
			fi
		fi

		if [ -n "$s1g_chanbw" -a "$bw" != "$s1g_chanbw" ]; then
			continue
		fi

		if [ -n "$op_class" ] && ! [ "$l_op" = "$op_class" -o "$g_op" = "$op_class" ]; then
			continue
		fi

		if [ "$channel" = "$ch" ]; then
			s1g_chanbw=$bw
			if [ -z "$op_class" ]; then
				op_class="$g_op"
			fi
			channel=$ch
			center_freq=$freq

			IFS=$oIFS
			return 0
		fi
	done < "$MORSE_REGDB_CHANNELS_CSV"

	IFS=$oIFS
	return 1
}


morse_find_ifname()
{
	for file in "/sys/class/net/wlan"*;
	do
		if [ -d "$file"/device/morse ]
		then
			ifname=$(basename $file)
			break
		fi
	done
}

# morse_config_get_iface <variable> [mode]
#
# Find the (first) UCI section name of a wifi-iface attached
# to the (first) morse-wifi-device. If <mode> is given (e.g.
# "ap", "sta", "mesh"), only ifaces with that mode are considered.
#
# Sets the named output variable to the matching section name, empty
# if nothing is found.
#
# Caller must have already run `config_load wireless`.
#
# Usage
#	config_load wireless
#	morse_config_get_iface sta_iface sta
#	[ -n "$sta_iface" ] || { echo "no morse STA found" >&2; exit 1; }
#
morse_config_get_iface() {
	local __out
	__out="$1"
	local __mode
	__mode="$2"

	case "$__out" in
		*[!A-Za-z0-9_]*|'')
			echo "invalid output variable name: $__out" >&2
			return 1
			;;
	esac

	local __morse_uci_device
	__morse_uci_device=
	config_foreach _morse_config_get_device_cb wifi-device

	local __morse_uci_iface
	__morse_uci_iface=
	[ -n "$__morse_uci_device" ] && config_foreach _morse_config_get_iface_cb wifi-iface "$__mode"

	eval "$__out=\$__morse_uci_iface"
}

_morse_config_get_iface_cb() {
	local section
	section="$1"
	local want_mode
	want_mode="$2"
	local device mode

	[ -n "$__morse_uci_iface" ] && return 0

	config_get device "$section" device
	[ "$device" = "$__morse_uci_device" ] || return 0

	if [ -n "$want_mode" ]; then
		config_get mode "$section" mode
		[ "$mode" = "$want_mode" ] || return 0
	fi

	__morse_uci_iface="$section"
}

# morse_config_get_device <variable>
#
# Find the (first) UCI section name of the morse wifi-device.
#
# Mimics /lib/functions.sh config_get by setting the named
# output variable to the first wifi-device section with type='morse'
# or an empty string if none was found.
#
# Caller must have already run `config_load wireless`.
#
# Usage:
#	config_load wireless
#	morse_config_get_device dev
#	[ -n "$dev" ] || { echo "no morse device" >&2; exit 1; }
#
morse_config_get_device() {
	local __out
	__out="$1"

	case "$__out" in
		*[!A-Za-z0-9_]*|'')
			echo "invalid output variable name: $__out" >&2
			return 1
			;;
	esac

	local __morse_uci_device
	__morse_uci_device=

	config_foreach _morse_config_get_device_cb wifi-device

	eval "$__out=\$__morse_uci_device"
}

_morse_config_get_device_cb() {
	local section
	section="$1"

	local type

	[ -n "$__morse_uci_device" ] && return 0

	config_get type "$section" type
	[ "$type" = morse ] && __morse_uci_device="$section"
}
