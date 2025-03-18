This directory contains examples of how to add a morse chip
to a particular device.

You can add them to your OpenWrt tree by doing:

    cp -r <examplename>/. <openwrttree>

bcm2711
=======

Tested on ekh01 kits (which are rpi4 + SDIO HAT). Note that this
is atypical, because:
- it uses device tree overlays
- it also has to modify the RPI config.txt (or rather distroconfig.txt)
- it does a few other things to make it nicer to use the RPI as
  a development platform (e.g. enabling a UART for the chip output)

For example, to add the overlays for an RPI4 (bcm2711) you would do:

    cp -r <morse-feed-repo-path>/examples/bcm27xx/. <openwrt-repo-path>/

An example of the changes you would see in the `./target` folder might be:

```
> pwd
/home/user/openwrt

> git status target
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   target/linux/bcm27xx/image/distroconfig.txt

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	target/linux/bcm27xx/patches-5.15/991-0001-dt-overlays-morse-add-sdio-overlay-fragment.patch
	target/linux/bcm27xx/patches-5.15/991-0002-dt-overlays-morse-add-powersave-and-reset-pin-defini.patch
	target/linux/bcm27xx/patches-5.15/991-0003-dt-overlays-morse-add-spi-overlay-fragment.patch
	target/linux/bcm27xx/patches-5.15/991-0004-dt-overlays-morse-add-ramoops-overlay-fragment.patch
	target/linux/bcm27xx/patches-5.15/991-0005-dt-overlays-morse-add-HAT-gpios-to-gpio-line-names.patch
	target/linux/bcm27xx/patches-5.15/991-dt-overlays-build-morse-overlays.patch
```
