# When this file is copied into /lib/upgrade, it will override fwtool_check_signature
# function from this script. (Because the content of /lib/upgrade are included in
# the validate_firmware_image file on an alphabetical order. And the z_ is to make
# sure it's gonna come after fwtool.sh.)

# There are 4 states we consider for image signing:
#   valid    - a signature was present and verified
#   invalid  - a signature was present but not verified
#   absent   - no signature at all
#   unknown  - we couldn't tell (no openssl, or the check never ran)
MORSE_SIGNATURE_STATE=/tmp/morse_image_sig_state

morse_set_signature_state() {
	echo "$1" > "$MORSE_SIGNATURE_STATE" 2>/dev/null
}

fwtool_check_signature() {
	morse_set_signature_state unknown
	[ $# -gt 1 ] && return 1

	# Check if signature enforcement is enabled in UCI
	enforce_fw_sign="$(uci -q get system.@system[0].enforce_fw_sign || echo 0)"
	if [ "$enforce_fw_sign" = "1" ] && [ "$REQUIRE_IMAGE_SIGNATURE" != "1" ]; then
		REQUIRE_IMAGE_SIGNATURE=1
	fi

	[ ! -x /usr/bin/openssl ] && {
		if [ "$REQUIRE_IMAGE_SIGNATURE" = 1 ]; then
			return 1
		else
			return 0
		fi
	}

	# IMG_S is the p7s signature section of the image that contains both sig and cert.
	IMG_S=/tmp/sysupgrade.p7s
	if ! fwtool -q -t -s $IMG_S "$1"; then
		morse_set_signature_state absent
		v "Image signature not present"
		[ "$REQUIRE_IMAGE_SIGNATURE" = 1 -a "$FORCE" != 1 ] && {
			v "Use sysupgrade -F to override this check when downgrading or flashing to vendor firmware"
		}
		[ "$REQUIRE_IMAGE_SIGNATURE" = 1 ] && return 1
		return 0
	fi

	MORSE_CA_CERTS=/etc/morse-firmware-sign/certs/Morse_Micro_Root_Signing_CA_2025-11-19.pem
	#TODO: enable cert revokation by adding -crl_check -crl_check_all after we get the crl file.
	openssl cms -verify \
				-in "$IMG_S" \
				-inform DER \
				-binary \
				-content "$1" \
				-CAfile "$MORSE_CA_CERTS" \
				-purpose any \
				-out /dev/null
	local retval=$?
	if [ "$retval" = 0 ]; then
		morse_set_signature_state valid
	else
		morse_set_signature_state invalid
	fi
	# Put the signature back for later re-checks.
	fwtool -S $IMG_S "$1"
	return $retval
}

# Record whether the image we're about to flash was signed by Morse, so the
# running system can tell later. If it's unsigned, the flag's value is the
# version_code of the image flashed - only the unsigned case is ever retained.
morse_record_image_trust() {
	local state="$1" image="$2"
	local meta=/tmp/sysupgrade.morse.meta
	local version_code="" old_ns

	command -v persistent_vars_storage.sh >/dev/null 2>&1 || {
		v "No persistent vars storage; not recording firmware trust"
		return 0
	}

	case "$state" in
		valid)
			# Signed: drop whatever an earlier unsigned image left.
			if persistent_vars_storage.sh ERASE mm_image_unsigned >/dev/null 2>&1; then
				v "Image is signed; cleared mm_image_unsigned"
			else
				v "Image is signed but could not clear mm_image_unsigned"
			fi
			return 0
			;;
		absent|invalid)	;;
		*)
			v "Signature state '$state' is not conclusive; not recording firmware trust"
			return 0
			;;
	esac

	# Unsigned, flag the version_code.
	if fwtool -q -i "$meta" "$image" 2>/dev/null; then
		json_set_namespace morse_image_trust old_ns
		if json_load "$(cat "$meta" 2>/dev/null)" 2>/dev/null; then
			json_select version 2>/dev/null && json_get_var version_code version_code
		fi
		json_cleanup
		json_set_namespace "$old_ns"
		rm -f "$meta"
	else
		v "Image has no fwtool metadata"
	fi

	[ -n "$version_code" ] || {
		if persistent_vars_storage.sh ERASE mm_image_unsigned >/dev/null 2>&1; then
			v "Image is unsigned but carries no version_code; cleared mm_image_unsigned"
		else
			v "Image is unsigned but carries no version_code; could not clear mm_image_unsigned"
		fi
		return 0
	}

	if persistent_vars_storage.sh WRITE mm_image_unsigned "$version_code" >/dev/null 2>&1; then
		v "Recorded unsigned firmware $version_code"
	else
		v "Could not record unsigned firmware $version_code"
	fi
}

# platform.sh is sourced before us and may already define this hook, so call
# theirs as well rather than replacing it (asus_rt-ax59u needs filogic's).
morse_prev_pre_upgrade_body=
if type platform_pre_upgrade >/dev/null 2>&1; then
	morse_prev_pre_upgrade_body="$(sed -n '/^platform_pre_upgrade()[[:space:]]*{/,/^}/p' \
		/lib/upgrade/platform.sh 2>/dev/null | sed '1d;$d')"
fi

if ! type platform_pre_upgrade >/dev/null 2>&1; then
	platform_pre_upgrade() {
		morse_record_image_trust "$(cat "$MORSE_SIGNATURE_STATE" 2>/dev/null)" "$1"
	}
elif [ -n "$morse_prev_pre_upgrade_body" ]; then
	eval "morse_prev_platform_pre_upgrade() {
${morse_prev_pre_upgrade_body}
}"

	platform_pre_upgrade() {
		morse_prev_platform_pre_upgrade "$@"
		morse_record_image_trust "$(cat "$MORSE_SIGNATURE_STATE" 2>/dev/null)" "$1"
	}
else
	v "Could not chain platform_pre_upgrade; not recording firmware trust"
fi
