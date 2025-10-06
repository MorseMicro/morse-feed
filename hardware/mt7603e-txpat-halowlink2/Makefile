#
# Copyright 2025 Morse Micro
#
# This is free software, licensed under the 3-Clause BSD License.
#

include $(TOPDIR)/rules.mk


PKG_NAME:=mt7603e-txpat-halowlink2
PKG_RELEASE:=1
PKG_BUILD_DEPENDS:=python3/host

PKG_VERSION:=v1.0

include $(INCLUDE_DIR)/package.mk

define Package/mt7603e-txpat-halowlink2
  SECTION:=net
  CATEGORY:=Morse Micro
  SUBMENU:=Hardware
  TITLE:=MT7603E Tx Power Adjustment Table for HaLowLink 2
  PKGARCH:=all
endef

define Package/mt7603e-txpat-halowlink2/description
	This package generates the MT7603E Tx Power Adjustment tables for the HaLowLink 2.
	It relies on 95-morse-wireless-defaults (see morse-bundle) if you want to use
	the region specific (i.e. non-global) tables.
endef


define Build/Compile
	cd $(PKG_BUILD_DIR) && python3 generate_mt7603e_txpat.py
endef

define Package/mt7603e-txpat-halowlink2/install
	$(INSTALL_DIR) $(1)/lib/firmware/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/*mt7603e_txpat.bin $(1)/lib/firmware/
endef

$(eval $(call BuildPackage,mt7603e-txpat-halowlink2))
