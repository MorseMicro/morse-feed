#
# Copyright 2026 Morse Micro
#
# This is free software, licensed under the 3-Clause BSD License.
#

include $(TOPDIR)/rules.mk


PKG_NAME:=mt7603e-txpat-apx
PKG_RELEASE:=1
PKG_BUILD_DEPENDS:=python3/host

PKG_VERSION:=v1.1

include $(INCLUDE_DIR)/package.mk

define Package/mt7603e-txpat-apx
  SECTION:=net
  CATEGORY:=Morse Micro
  SUBMENU:=Hardware
  TITLE:=MT7603E Tx Power Adjustment Table for HaLowLink APX
  CONFLICTS:=mt7603e-txpat-artini mt7603e-txpat-halowlink2
  PKGARCH:=all
endef

define Package/mt7603e-txpat-apx/description
	This package generates the MT7603E Tx Power Adjustment Table for the HaLowLink APX
	as a binary file. It conflicts with the other mt7603e-txpat packages because they
	all install /lib/firmware/mt7603e_txpat.bin.
endef


define Build/Compile
	# Generate the mt7603e_txpat for the HaLowLink APX
	python3 generate_mt7603e_txpat.py --output $(PKG_BUILD_DIR)/mt7603e_txpat.bin
endef

define Package/mt7603e-txpat-apx/install
	$(INSTALL_DIR) $(1)/lib/firmware/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/mt7603e_txpat.bin $(1)/lib/firmware/
endef

$(eval $(call BuildPackage,mt7603e-txpat-apx))
