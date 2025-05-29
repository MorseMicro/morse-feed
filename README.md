# Morse Micro public package feed

## Description

This feed contains necessary packages to add Morse Micro HaLow to an OpenWrt
distribution. It also contains packages to support the the OpenWrt based
Morse Micro SDK.

## Usage

This repository is intended to be layered on-top of an OpenWrt buildroot.
If you do not have an OpenWrt buildroot installed, see the documentation at:
[OpenWrt Buildroot – Installation][1] on the OpenWrt support site.

This feed is enabled by default. To install all its package definitions, run:

```
./scripts/feeds update morse
./scripts/feeds install -a -p morse
```

## Package/Directory structure

Most of the Morse packages will appear in the main 'Morse' category
in menuconfig for easy identification. Sub-categories then correspond to:

- *essentials* - packages you almost certainly want to bring up a morse chip (e.g. driver/firmware)
- *features* - optional feature related packages (e.g. Mesh, DPP, ...)
- *hardware* - packages intended for particular hardware/products/eval kits
- *luci* - any LuCI pages/themes; these are targeted at Morse produced products, and are not
  required for correct operation. If you're using LuCI, minor changes to correctly display
  HaLow radio information are in the Morse fork of the luci repository.

The other directories here (e.g. multimedia/net/utils) are packages which
are not Morse specific and go in their normal OpenWrt categories.

# License

This repository and its contents, including all package recipes and metadata, are licensed under the GNU General Public License v2, unless otherwise stated in individual files.

Each package recipe in this repository includes software that is distributed under its own license, which can be found in the corresponding package's source repository or documentation.

[1]: https://openwrt.org/docs/guide-developer/build-system/install-buildsystem
