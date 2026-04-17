#
# Copyright 2022-2026 Morse Micro
#
# This is free software, licensed under the GPL 2 license.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=morse_driver_mm81x
PKG_VERSION:=1.17.8
PKG_RELEASE=1

PKG_SOURCE_VERSION:=$(PKG_VERSION)
PKG_SOURCE_URL:=https://github.com/MorseMicro/morse_driver.git
PKG_MIRROR_HASH:=38385a5e24ec45c2cf732b4183c043f1e8643fb43a446bb70ffac661156d835c
PKG_SOURCE_MIRROR:=0
PKG_SOURCE_PROTO:=git

include $(INCLUDE_DIR)/kernel.mk
include $(INCLUDE_DIR)/package.mk
include ../../include/morse_driver_common.mk

define KernelPackage/morse-81x
  CATEGORY:=Morse Micro
  SUBMENU:=Essentials
  TITLE:=Morse Micro Wi-Fi HaLow driver for MM81x
  DEPENDS:= +kmod-mmc +kmod-mac80211 +kmod-trelay +kmod-lib-crc7 morse-fw +morse-board-config +MORSE_USB:kmod-usb-core
  FILES:=\
    $(PKG_BUILD_DIR)/morse.ko \
    $(PKG_BUILD_DIR)/dot11ah/dot11ah.ko
  AUTOLOAD:=$(call AutoProbe,morse)
  MODPARAMS.morse:=country=US
  PROVIDES:=kmod-morse
  CONFLICTS:=kmod-morse-61x
endef

define KernelPackage/morse-81x/config
    source "$(SOURCE)/Config.in"
endef

$(eval $(call KernelPackage,morse-81x))
