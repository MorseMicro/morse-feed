#
# Copyright 2024 Morse Micro
#
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=morse-leds
PKG_RELEASE:=1

include $(INCLUDE_DIR)/package.mk

define Package/morse-leds
  SECTION:=utils
  CATEGORY:=Base system
  TITLE:=Morse Micro LED Functionality
  MAINTAINER:=Morse Micro
endef

define Package/morse-modeswitch-button/description
  Override default LED state handler for Morse devices.
endef

define Build/Compile

endef

define Package/morse-leds/install
	$(INSTALL_DIR) $(1)/etc
	$(INSTALL_BIN) ./files/etc/diag_override.sh $(1)/etc/
endef

$(eval $(call BuildPackage,morse-leds))
