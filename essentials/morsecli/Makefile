#
# Copyright 2023 Morse Micro
#
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=morsecli
PKG_RELEASE=5

PKG_VERSION:=1.17.9

PKG_LICENSE:=GPLv2
PKG_LICENSE_FILES:=

PKG_SOURCE_VERSION:=$(PKG_VERSION)
PKG_SOURCE_URL:=https://github.com/MorseMicro/morse_cli.git
PKG_MIRROR_HASH:=1a4f4a89b1aca6a6771c2996128327f9a8c9227a36deecf8025ada81ca5ce684
PKG_SOURCE_MIRROR:=0
PKG_SOURCE_PROTO:=git

PKG_MAINTAINER:=Morse Micro <info@morsemicro.com>
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk

define Package/morsecli
  SECTION:=utils
  CATEGORY:=Morse Micro
  SUBMENU:=Essentials
  TITLE:=Morse Micro WIFI HaLow driver command line tool
  DEPENDS:= kmod-morse +libnl +libusb-1.0
  FILES:=\
	$(PKG_BUILD_DIR)/morse_cli
endef

MAKE_FLAGS += \
    MORSECTRL_VERSION_STRING=$(PKG_VERSION) \
    CONFIG_MORSE_TRANS_NL80211=1 \

TARGET_CFLAGS += -I$(STAGING_DIR)/usr/include/libnl3

define Package/morsecli/install
	$(INSTALL_DIR) $(1)/sbin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/morse_cli $(1)/sbin/

	$(INSTALL_DIR) $(1)/etc/profile.d
	$(CP) $(CURDIR)/files/morse_cli.sh $(1)/etc/profile.d/
endef

$(eval $(call BuildPackage,morsecli))
