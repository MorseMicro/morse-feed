include $(TOPDIR)/rules.mk

PKG_NAME:=morse-client-config
PKG_RELEASE=1

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Morse Micro

include $(INCLUDE_DIR)/package.mk

define Package/morse-client-config
  SECTION:=utils
  CATEGORY:=Morse Micro
  SUBMENU:=Features
  TITLE:=Morse Client Config
  # We require LuCI because we use LuCI's http handler to simplify
  # our ucode cgi-bin script. If it was important, this would be easy
  # to split off.
  DEPENDS:=uhttpd +ucode +ucode-mod-ubus +ucode-mod-uci +luci-base
endef

define Package/morse-client-config/description
  Replace the standard LuCI WebUI with a simple configuration page
  which lets the user set the country and wifi credentials, and
  after applying switches from DHCP server to client mode and
  restores the normal luci webpages.

  This is useful for when you really just want to configure a
  STA/WDS/4addr mode bridge, and do not want a DHCP server after
  configuration.
endef

define Build/Compile
endef

define Package/morse-client-config/install
	$(INSTALL_DIR) $(1)/www-client-config
	$(INSTALL_DATA) ./files/www-client-config/index.html $(1)/www-client-config/
	$(INSTALL_DATA) ./files/www-client-config/style.css $(1)/www-client-config/

	$(INSTALL_DIR) $(1)/www-client-config/cgi-bin
	$(INSTALL_BIN) ./files/www-client-config/cgi-bin/* $(1)/www-client-config/cgi-bin/

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/etc/uci-defaults/* $(1)/etc/uci-defaults/

	$(INSTALL_DIR) $(1)/usr/lib/lua/luci/i18n
	for po in ./po/*/*.po; do \
		lang=$$$$(basename $$$$(dirname "$$$$po")); \
		base=$$$$(basename "$$$$po" .po); \
		po2lmo "$$$$po" $(1)/usr/lib/lua/luci/i18n/$$$$base.$$$$lang.lmo; \
	done
endef


$(eval $(call BuildPackage,morse-client-config))
