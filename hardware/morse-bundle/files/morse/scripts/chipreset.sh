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

# Check for the reset GPIO before touching any MMC/SDIO controller.  Some
# Raspberry Pi MM6108 device trees do not expose an MM_RESET line.  In that
# case the reset is optional, but unbinding the controller and exiting before
# the matching bind leaves the Morse device unavailable for this boot.
if ! gpioinfo -s --by-name MM_RESET > /dev/null 2>&1; then
    2>&1 echo 'morsechipreset: MM_RESET is unavailable; skipping reset without unbinding SDIO'
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
