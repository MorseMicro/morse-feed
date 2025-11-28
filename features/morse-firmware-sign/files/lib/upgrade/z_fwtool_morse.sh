# When this file is copied into /lib/upgrade, it will override fwtool_check_signature
# function from this script. (Because the content of /lib/upgrade are included in
# the validate_firmware_image file on an alphabetical order. And the z_ is to make
# sure it's gonna come after fwtool.sh.)
fwtool_check_signature() {
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
	# Put the signature back for later re-checks.
	fwtool -S $IMG_S "$1"
	return $retval
}