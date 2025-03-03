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

PKG_VERSION:=rel_1_15_3_2025_Apr_16

PKG_SOURCE:= morsemicro-fw-rel_1_15_3_2025_Apr_16.tar
PKG_SOURCE_URL:=https://github.com/MorseMicro/firmware_binaries/releases/download/v1.15.3/
PKG_HASH:=de7e3e9f1b7b97aff9d63687c4d3e99fe2544fcfc7e5567df1ab0da194656469

PKG_MAINTAINER:=Morse Micro <info@morsemicro.com>
PKG_BUILD_PARALLEL:=1

RSTRIP:=:

include $(INCLUDE_DIR)/kernel.mk
include $(INCLUDE_DIR)/package.mk

TAR_CMD=$(HOST_TAR) -C $(1) $(TAR_OPTIONS)

define Package/morse-fw-6108
  CATEGORY:=Morse Micro
  SUBMENU:=Essentials
  URL:=$(PKG_SOURCE_URL)
  TITLE:=Morse Micro WIFI HaLow firmware for 6108
  PROVIDES:=morse-fw
endef

define Package/morse-fw/config
  source "$(SOURCE)/Config.in"
endef

define Package/morse-fw-6108-tlm
  CATEGORY:=Morse Micro
  SUBMENU:=Essentials
  URL:=$(PKG_SOURCE_URL)
  TITLE:=Morse Micro WIFI HaLow Thin LMAC firmware for 6108
  PROVIDES:=morse-fw
endef

define Package/morse-fw-tlm/description
  This Firmware reduces the per-station table size in the chip to
  allow a large number of associations in AP mode.
endef

define Package/morse-fw-8108
  CATEGORY:=Morse Micro
  SUBMENU:=Essentials
  URL:=$(PKG_SOURCE_URL)
  TITLE:=Morse Micro WIFI HaLow firmware for 8108
  PROVIDES:=morse-fw
endef

define Build/Compile

endef

# Files from the tarball are overriden by a file in this path.
# This is for local development and used by jenkins.
define install_file_or_override
	if [ -e ./files/lib/firmware/morse/$(1) ]; then \
		$(INSTALL_DATA) ./files/lib/firmware/morse/$(1) $(2)/lib/firmware/morse/; \
	else \
		$(INSTALL_DATA) $(PKG_BUILD_DIR)/lib/firmware/morse/$(1) $(2)/lib/firmware/morse/; \
	fi
endef

define Package/morse-fw-6108/install
	$(INSTALL_DIR) $(1)/lib/firmware/morse/.
	$(call install_file_or_override,mm6108.bin,$(1))
endef

define Package/morse-fw-6108-tlm/install
	$(INSTALL_DIR) $(1)/lib/firmware/morse/.
	$(call install_file_or_override,mm6108-tlm.bin,$(1))
endef

define Package/morse-fw-8108/install
	$(INSTALL_DIR) $(1)/lib/firmware/morse/.
	$(call install_file_or_override,mm8108b2-rl.bin,$(1))
endef

$(eval $(call BuildPackage,morse-fw-6108))
$(eval $(call BuildPackage,morse-fw-6108-tlm))
$(eval $(call BuildPackage,morse-fw-8108))
