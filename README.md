This branch contains is an OpenWrt feed which allow you to add Morse
HaLow devices to a distribution based on OpenWrt 23.05. Unlike the main
branch, which contains LuCI frontend and evaluation kit specific
packages and is designed to work with the Morse OpenWrt fork, this
feed contains the minimum set of packages to get a Morse module
loaded and configurable via UCI.

_You should use this branch_ if you have already have a customised
OpenWrt distribution and you want to add Morse Micro HaLow support.

_You should *NOT* use this branch_ if you're starting from scratch.
Instead, it will be easier to use our
[OpenWrt fork](https://github.com/MorseMicro/openwrt). Among other
things, this will ensure that the web frontend code supports HaLow
devices.


Contents
========

| file/dir | description |
| --- | --- |
| *setup_openwrt.sh* | script for automatically applying patches (see below) |
| *patches* | patches to apply to a standard OpenWrt distribution |
| *packages* | OpenWrt packages to enable usage of Morse chips |
| *examples* | Device tree modification examples |


Installation
============

1.  Clone or checkout a new branch in your existing OpenWrt repository.

2.  Make sure you can succesfully build and flash a an image
    for your device, and validate that it works correctly
    (without enabling the Morse chip).

3.  In your OpenWrt repository checkout, **not this one**, edit
    `feeds.conf.default` (or `feeds.conf` if it exists) to add
    this branch of morse-feed:

        src-get morse https://github.com/MorseMicro/morse-feed;mm/openwrt-23.05

4.  Update the local package indexes to add the morse packages:

        ./scripts/feeds update morse
        ./scripts/feeds install -p morse -a

5.  Add/apply the `patches` directory to your main tree by running:

        ./feeds/morse/setup_openwrt.sh

    This will add a small number of required kernel/mac80211/netifd patches,
    and point the local iwinfo package at a modified iwinfo (so s1g
    frequencies are supported). Please look at the script output
    for more information. After doing this, you may want to confirm
    the the kernel still builds, and you should consider checking in
    the changes. Make sure to add the new files!

6.  If using SDIO or SPI, modify the device tree appropriately to add
    the Morse chip. There is an example of how to do this in the
    examples folder. For more details, see section 6 - Defining the
    Hardware in the Morse Micro APPNOTE-24 - Linux Porting Guide.


Build and run
=============

1.  Run `make menuconfig` and select `netifd-morse` package from the
    Morse category. This will pull in all other necessary packages
    as dependencies. However, you may need to go to the options
    for kmod-morse if you want SPI support or if you need to change
    the SDIO alignment (from the default value of 2).

    Alternatively, if you only want to bring up the driver manually,
    add just the `kmod-morse` package.

    Eventually, you should add any necessary packages directly to
    your board's Device definition in target/linux/<target> by adding
    or amending the DEVICE_PACKAGES definition.

2.  Make and install a new image to your device as before.

3.  If you have Morse devices correctly configured on boot, they should
    _automatically_ appear in your /etc/config/wireless file
    (you should _not_ add these manually, as they will be populated
    by `/lib/wifi/morse.sh`):

        config wifi-device 'radio0'
                option type 'morse'
                option path 'platform/1e130000.sdhci/mmc_host/mmc0/mmc0:0001/mmc0:0001:2'
                option band 's1g'
                option hwmode '11ah'
                option reconf '0'
                option disabled '1'
        
        config wifi-iface 'default_radio0'
                option mode 'ap'
                option wds '1'
                option device 'radio0'
                option network 'lan'
                option ssid 'MorseMicro'
                option encryption 'sae'
                option key '12345678'

    If you ever want to rerun the autodetection, you can remove `/etc/config/wireless`
    and run `wifi config`. If autodetection is not working, most likely the morse
    module has not correctly identified the chip. Run `logread | grep morse` to
    see any diagnostic messages from the boot` and address them before continuing.

4.  Once these entries are there, it means your chip has been correctly detected. However,
    to use it, you will need to add a country and channel and remove disabled. You may
    also need to specify a bcf (the bcf must be present
    in /lib/firmware/morse; to have it configured automatically, you will need to
    amend `netifd-morse/lib/wifi/morse.sh`). For example:

        uci set wireless.radio0.channel=44
        uci set wireless.radio0.country=US
        uci set wireless.radio0.bcf=bcf_mybcf.bin
        uci delete wireless.radio0.disabled
        uci commit
        reload_config

5.  Use `logread | grep hostapd_s1g` to check that hostapd_s1g has started correctly.
    For example:

        # logread | grep hostapd_s1g
        ...
        Wed Mar  5 13:20:44 2025 daemon.notice hostapd_s1g: wlan0: AP-ENABLED


Validation
==========

After following the steps above, you should be able to connect to your AP on
the specified credentials, and also scan for nearby APs. Run `iwinfo` for more
information; if you can see the interface name there, you can then run `iwinfo wlan0 scan`:

     # iwinfo
     wlan0     ESSID: "MorseMicro"
               Access Point: 0C:BF:74:59:9F:62
               Mode: Master  Channel: 27 (915.500 MHz)  HT Mode: unknown
               Center Channel 1: 27 2: unknown
               Tx-Power: 21 dBm  Link Quality: unknown/70
               Signal: unknown  Noise: -110 dBm
               Bit Rate: unknown
               Encryption: WPA3 SAE (CCMP)
               Type: dot11ah  HW Mode(s): 802.11ah
               Hardware: 325B:0206 0000:0000 [Morse Micro MM6108A0]
               TX power offset: none
               Frequency offset: none
               Supports VAPs: yes  PHY name: phy1
     # iwinfo wlan0 scan
     ...


Potential issues
================

SDHCI modules
-------------

When adding an SDIO chip, the existing board config may not have the necessary
modules to bring up the host controller. You will need to add these to your
configuration.

Chip reset
----------

This does not include any chip reset functionality for SPI/SDIO.
Depending on how your system is brought up, it's possible that the chip
will need to be reset _before_ being probed. This can be done in the kernel
or via a userspace script; for an example, see morsechipreset.sh
in the main branch.

Package size
------------

wpa_supplicant_s1g and hostapd_s1g are linked against OpenSSL, unlike
OpenWrt's default mbedtls. Unfortunately, carrying two SSL libraries
on smaller devices (e.g. 16mb flash) will waste a significant amount of space.
We would recommend switching the normal OpenWrt packages (e.g. wpad,
libustream) to use openssl. This is slightly complicated, as the default
packages need to be forced off if using `make defconfig` due to how they're
specified:

    CONFIG_PACKAGE_libustream-openssl=y
    CONFIG_PACKAGE_wpad-openssl=y
    CONFIG_LIBCURL_OPENSSL=y
    CONFIG_PACKAGE_wpad-basic-mbedtls=n
    CONFIG_PACKAGE_libmbedtls=n
    CONFIG_PACKAGE_libustream-mbedtls=n

Frontend
--------

This feed does NOT include changes to handle S1G in the luci frontend.
Please refer to our OpenWrt fork (which has a custom luci feed) to
see how this might be accomplished.
