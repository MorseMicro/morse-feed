#
# Copyright (C) 2022 Morse Micro
#

include $(TOPDIR)/rules.mk

PKG_NAME:=dpp-handler
PKG_RELEASE:=3

include $(INCLUDE_DIR)/package.mk

define Package/dpp-handler
  SECTION:=net
  CATEGORY:=Morse Micro
  SUBMENU:=Features
  TITLE:=Handle DPP actions/results for Morse devices
  MAINTAINER:=Morse Micro
  DEPENDS:= wpa_supplicant_s1g +ucode +ucode-mod-fs +ucode-mod-ubus +ucode-mod-uci +ucode-mod-math +ucode-mod-uloop
endef

define Package/dpp-handler/description
  This package adds a ubus handler for DPP related
  actions (push button to initiate, and set UCI config if successful). It's currently
  somewhat tied to preferring S1G DPP-PB over other things.
endef

define Build/Compile

endef

define Package/dpp-handler/install
	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) ./files/usr/sbin/* $(1)/usr/sbin/.
	$(INSTALL_DIR) $(1)/usr/share/ucode/dpp
	$(INSTALL_DATA) ./files/usr/share/ucode/dpp/* $(1)/usr/share/ucode/dpp/.
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/* $(1)/etc/init.d/.
endef

$(eval $(call BuildPackage,dpp-handler))