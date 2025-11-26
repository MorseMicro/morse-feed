include $(TOPDIR)/rules.mk

PKG_NAME:=morse-firmware-sign
PKG_VERSION:=1.0
PKG_RELEASE:=1

PKG_LICENSE:=BSD-3-Clause

PKG_MAINTAINER:=Morse Micro

PKG_BUILD_DEPENDS := fwtool/host ucert/host usign/host

PKG_CONFIG_DEPENDS += CONFIG_SIGNATURE_CHECK

include $(INCLUDE_DIR)/package.mk

define Package/morse-firmware-sign
  SECTION:=Utilities
  CATEGORY:=Morse Micro
  SUBMENU:=Features
  TITLE:=Morse Firmware Signing Support
  DEPENDS:=+fwtool +ucert-full +usign +openssl-util
endef

define Package/morse-firmware-sign/description
Installs public key for secure firmware signature verification,
and ensures required signing tools are available on both host and target.
endef

define Build/Compile
	cat ./morse_certs/* > $(PKG_BUILD_DIR)/morse_ca.pem
endef


define Package/morse-firmware-sign/install
	$(INSTALL_DIR) $(1)/usr/share/keys
	$(INSTALL_DATA) ./files/usr/share/keys/* $(1)/usr/share/keys/
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/etc/uci-defaults/* $(1)/etc/uci-defaults/
	$(INSTALL_DIR) $(1)/etc/morse-firmware-sign/certs
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/morse_ca.pem $(1)/etc/morse-firmware-sign/certs/morse_ca.pem
	$(INSTALL_DIR) $(1)/lib/upgrade
	$(INSTALL_BIN) ./files/lib/upgrade/* $(1)/lib/upgrade
endef

define Package/morse-firmware-sign/postinst
#!/bin/sh

IPKG_INSTROOT="$${IPKG_INSTROOT:-/}"
src="$${IPKG_INSTROOT}/usr/share/keys"
dst="$${IPKG_INSTROOT}/etc/opkg/keys"

[ -d "$$src" ] || exit 0
mkdir -p "$$dst"

for key in "$$src"/*; do
	[ -f "$$key" ] || continue
	basename="$${key##*/}"
	if [ -f "$$dst/$$basename" ]; then
		echo "OpenWrt firmware signing key $$basename already present; skipping."
	else
		cp "$$key" "$$dst/$$basename" || true
		echo "OpenWrt firmware signing key $$basename installed."
	fi
done

exit 0
endef

$(eval $(call BuildPackage,morse-firmware-sign))
