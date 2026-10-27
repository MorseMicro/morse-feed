#!/bin/sh
#
# Copyright 2023-2024 Morse Micro
#

remove_driver() {
    modules="morse dot11ah"

    for module in morse dot11ah; do
        rmmod "$module" > /dev/null
    done
}

reset_chip() {
    line_name="$1"
    # Note:
    # GPIO line names are not guaranteed to be unique across all gpiochips.
    # The '-s' option ensures uniqueness by scanning all chips and aborts if duplicates are found.
    # The '--by-name' option treats the input as a line name, even if it looks like a numeric offset.
    if ! gpioinfo -s --by-name "$line_name" > /dev/null 2>&1; then
         2>&1 echo "morsechipreset: unable to reset as $line_name is not in gpio-line-names or is duplicated in device tree"
        exit 1
    fi

    #Timing is from reset.c in morse-ctrl
    gpioset -s -p 50000us -t0 --by-name $line_name=0
    # Force pin back to in.
    gpioget -s --by-name $line_name > /dev/null
    ucode -e 'sleep(50)'
}


# Only look for an SDIO host when the chip is actually on SDIO. On boards where
# the Morse chip is attached over SPI there is no Morse SDIO function at all,
# and the first mmc_host found here is the SD card holding the root filesystem.
# Unbinding that ejects the rootfs mid-boot, which shows up as
# "mmc0: card 0001 removed" followed by endless SQUASHFS -EIO errors.
morse_on_spi=
for spidev in /sys/bus/spi/devices/*; do
    [ -e "$spidev/of_node/compatible" ] || continue
    if tr -d '\0' < "$spidev/of_node/compatible" | grep -q '^morse,'; then
        morse_on_spi=1
        break
    fi
done

if [ -n "$morse_on_spi" ]; then
    # Nothing to do on an SPI board: the SPI driver resets the chip itself via
    # its reset-gpios, and there is no SDIO bus to re-enumerate. Continuing
    # would rmmod a perfectly healthy driver and then abort in reset_chip()
    # on boards that have no MM_RESET in gpio-line-names, leaving the radio
    # down for the rest of the boot.
    echo 'morsechipreset: chip is on SPI; the driver handles reset, nothing to do'
    exit 0
fi

# This finds something like:
#    /sys/devices/platform/10130000.mmc/mmc_host
# and extracts a driver location and the device (10130000.mmc).
sdio_device_path="$(find /sys/devices/platform -name mmc_host | head -1)"
if [ -n "$sdio_device_path" ]; then
    sdio_driver_path="$(readlink -f "$sdio_device_path"/../driver)"
    sdio_device="$(basename $(dirname "$sdio_device_path"))"
fi

if [ -z "$sdio_device" ]; then
    2>&1 echo 'morsechipreset: unable to find sdio device/driver to unbind; proceeding anyway'
fi

# Strictly speaking, this:
#  (a) shouldn't be necessary, as unbind will remove (as long as sdio_device was found).
#  (b) will perform a reset anyway during removal so calling may be pointless.
# But for avoidance of any issues, we leave it in for now.

remove_driver

# Resetting the chip also resets its sdio bus. Therefore we need to tell the sdio
# driver to take another look.

if [ -n "$sdio_device_path" ]; then
    echo -n "$sdio_device" > "$sdio_driver_path/unbind"
fi

reset_chip "MM_RESET"

if [ -n "$sdio_device_path" ]; then
    echo -n "$sdio_device" > "$sdio_driver_path/bind"
fi
