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

PKG_VERSION:=rel_1_12_4_2024_Jun_11

PKG_SOURCE:=morsemicro-fw-rel_1_12_4_2024_Jun_11.tar
PKG_SOURCE_URL:=https://github.com/MorseMicro/firmware_binaries/releases/download/v1.12.4/
PKG_HASH:=1510550a13409c5614fe9d3c3c432eb288427ebdb755d242a1360d684839c174

PKG_MAINTAINER:=Morse Micro <info@morsemicro.com>
PKG_BUILD_PARALLEL:=1

RSTRIP:=:

include $(INCLUDE_DIR)/kernel.mk
include $(INCLUDE_DIR)/package.mk

define Package/morse-fw
  SECTION:=firmware
  CATEGORY:=Firmware
  URL:=$(PKG_SOURCE_URL)
  TITLE:=Morse Micro WIFI HaLow firmware
  PROVIDES:=morse-fw
endef

TAR_CMD=$(HOST_TAR) -C $(1) $(TAR_OPTIONS)

define Build/Compile

endef

define Package/morse-fw/install
	$(INSTALL_DIR) $(1)/lib/firmware/morse/.
	if [ -e ./files/lib/firmware/morse/mm6108.bin ]; then \
		$(INSTALL_DATA) ./files/lib/firmware/morse/mm6108.bin $(1)/lib/firmware/morse/; \
	else \
		$(INSTALL_DATA) $(PKG_BUILD_DIR)/lib/firmware/morse/mm6108.bin $(1)/lib/firmware/morse/; \
	fi
endef

$(eval $(call BuildPackage,morse-fw))
