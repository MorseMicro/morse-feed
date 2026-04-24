#
# Copyright 2022-2026 Morse Micro
#
# This is free software, licensed under the GPL 2 license.
#

include $(TOPDIR)/rules.mk
include ../../include/morse_version.mk

PKG_NAME:=morse_driver
PKG_VERSION:=$(MORSE_FEED_SOURCE_VERSION)
PKG_RELEASE=1

PKG_SOURCE_VERSION:=$(PKG_VERSION)
PKG_SOURCE_URL:=https://github.com/MorseMicro/morse_driver.git
PKG_MIRROR_HASH:=$(MORSE_DRIVER_HASH)
PKG_SOURCE_MIRROR:=0
PKG_SOURCE_PROTO:=git
PATCH_DIR:=./patches/$(MORSE_FEED_PATCHES_DIR)

include $(INCLUDE_DIR)/kernel.mk
include $(INCLUDE_DIR)/package.mk
include ../../include/morse_driver_common.mk

define KernelPackage/morse
  CATEGORY:=Morse Micro
  SUBMENU:=Essentials
  TITLE:=Morse Micro Wi-Fi HaLow driver for MM61x
  DEPENDS:= +kmod-mmc +kmod-mac80211 +kmod-trelay +kmod-lib-crc7 morse-fw +morse-board-config +MORSE_USB:kmod-usb-core
  FILES:=\
    $(PKG_BUILD_DIR)/morse.ko \
    $(PKG_BUILD_DIR)/dot11ah/dot11ah.ko
  AUTOLOAD:=$(call AutoProbe,morse)
  MODPARAMS.morse:=country=US
  PROVIDES:=kmod-morse
endef

define KernelPackage/morse/config
	source "$(SOURCE)/Config.in"
endef

$(eval $(call KernelPackage,morse))
