#
# Copyright 2022 Morse Micro
#
# This is free software, licensed under the MIT License.
#
# This package installs Morse Micro firmware binaries, which are
# distributed under the Morse Micro Binary Distribution License.
# This license is available in LICENSE.binaries.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=morse-fw
PKG_RELEASE=2

PKG_VERSION:=rel_1_14_1_2024_Dec_05

PKG_SOURCE:=morsemicro-fw-rel_1_14_1_2024_Dec_05.tar
PKG_SOURCE_URL:=https://github.com/MorseMicro/firmware_binaries/releases/download/v1.14.1/
PKG_HASH:=56e7cd3ec6a5f1321b9be3d3551c965b7762d4f180fa415a38a365ddb2f43cd1

PKG_MAINTAINER:=Morse Micro <info@morsemicro.com>
PKG_BUILD_PARALLEL:=1

RSTRIP:=:

include $(INCLUDE_DIR)/kernel.mk
include $(INCLUDE_DIR)/package.mk

TAR_CMD=$(HOST_TAR) -C $(1) $(TAR_OPTIONS)

define Package/morse-fw
  SECTION:=firmware
  CATEGORY:=Firmware
  URL:=$(PKG_SOURCE_URL)
  TITLE:=Morse Micro WIFI HaLow firmware
  PROVIDES:=morse-fw
endef

define Package/morse-fw-tlm
  SECTION:=firmware
  CATEGORY:=Firmware
  URL:=$(PKG_SOURCE_URL)
  TITLE:=Morse Micro WIFI HaLow Thin LMAC firmware
  PROVIDES:=morse-fw-tlm
  DEPENDS:=morse-fw
endef

define Package/morse-fw-tlm/description
  This Firmware reduces the per-station table size in the chip to
  allow a large number of associations in AP mode.
endef

define Build/Compile

endef

define Package/morse-fw/install
	$(INSTALL_DIR) $(1)/lib/firmware/morse/.
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/lib/firmware/morse/mm8108b2-rl.bin $(1)/lib/firmware/morse/
	if [ -e ./files/lib/firmware/morse/mm6108.bin ]; then \
		$(INSTALL_DATA) ./files/lib/firmware/morse/mm6108.bin $(1)/lib/firmware/morse/; \
	else \
		$(INSTALL_DATA) $(PKG_BUILD_DIR)/lib/firmware/morse/mm6108.bin $(1)/lib/firmware/morse/; \
	fi
endef

define Package/morse-fw-tlm/install
	$(INSTALL_DIR) $(1)/lib/firmware/morse/.
	if [ -e ./files/lib/firmware/morse/mm6108-tlm.bin ]; then \
		$(INSTALL_DATA) ./files/lib/firmware/morse/mm6108-tlm.bin $(1)/lib/firmware/morse/; \
	else \
		$(INSTALL_DATA) $(PKG_BUILD_DIR)/lib/firmware/morse/mm6108-tlm.bin $(1)/lib/firmware/morse/; \
	fi
endef

$(eval $(call BuildPackage,morse-fw))
$(eval $(call BuildPackage,morse-fw-tlm))
