include $(TOPDIR)/rules.mk

PKG_NAME:=morse-firmware-sign
PKG_VERSION:=1.0
PKG_RELEASE:=1

PKG_LICENSE:=BSD-3-Clause

PKG_MAINTAINER:=Morse Micro

include $(INCLUDE_DIR)/package.mk

define Package/morse-firmware-sign
  SECTION:=Utilities
  CATEGORY:=Morse Micro
  SUBMENU:=Features
  TITLE:=Morse Firmware Signing Support
  DEPENDS:=+fwtool +openssl-util
endef

define Package/morse-firmware-sign/description
Installs public key for secure firmware signature verification,
and ensures required signing tools are available on both host and target.
endef

define Build/Compile
endef


define Package/morse-firmware-sign/install
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/etc/uci-defaults/* $(1)/etc/uci-defaults/
	$(INSTALL_DIR) $(1)/etc/morse-firmware-sign/certs
	$(INSTALL_DATA) ./files/etc/morse-firmware-sign/certs/Morse_Micro_Root_Signing_CA_2025-11-19.pem $(1)/etc/morse-firmware-sign/certs/
	$(INSTALL_DIR) $(1)/lib/upgrade
	$(INSTALL_BIN) ./files/lib/upgrade/* $(1)/lib/upgrade
endef

$(eval $(call BuildPackage,morse-firmware-sign))
