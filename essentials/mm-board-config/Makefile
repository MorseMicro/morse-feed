#
# Copyright 2022 Morse Micro
#
# This is free software, licensed under the MIT License.
#
# This package installs Morse Micro board configuration binaries, which are
# distributed under the Morse Micro Binary Distribution License.
# This license is available in LICENSE.binaries.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=morse-board-config
PKG_RELEASE=6

PKG_VERSION:=1.17.8

PKG_SOURCE_VERSION:=1457e131f1b1cd7728d73ae3a09729b1782a776a
PKG_SOURCE_URL:=https://github.com/MorseMicro/morse-firmware.git
PKG_MIRROR_HASH:=b228fd210e1827feb3db86c394a90755d0d8948d1e032198ebfa7100d2301bc9
PKG_SOURCE_MIRROR:=0
PKG_SOURCE_PROTO:=git


PKG_MAINTAINER:=Morse Micro <info@morsemicro.com>
PKG_BUILD_PARALLEL:=1

RSTRIP:=:

include $(INCLUDE_DIR)/kernel.mk
include $(INCLUDE_DIR)/package.mk

define Package/morse-board-config
  SECTION:=firmware
  CATEGORY:=Morse Micro
  SUBMENU:=Essentials
  URL:=$(PKG_SOURCE_URL)
  TITLE:=Morse Micro WIFI HaLow Board Config File
  PROVIDES:=morse-board-config
endef

define Package/morse-board-config-hotplug-model
  SECTION:=firmware
  CATEGORY:=Morse Micro
  SUBMENU:=Essentials
  TITLE:=Hotplug scripts for module type reporting
  DEPENDS:=+morse-board-config
endef

define Package/morse-board-config-hotplug-model/description
  When enabled, a hotplug script will be installed to
  append a relevant module type suffix based on the value
  programmed into the Morse chips OTP bits.
endef

define Build/Compile

endef

define Package/morse-board-config/install
	$(INSTALL_DIR) $(1)/usr/share/morse-bcf
	$(INSTALL_DIR) $(1)/lib/firmware/morse

	find $(PKG_BUILD_DIR)/bcf -name "*.bin" -exec $(INSTALL_DATA) {} $(1)/lib/firmware/morse/ \;

	# Install files from override folder, including failsafe.
	for file in ./files/lib/firmware/morse/*; do \
		filename=$$$$(basename $$$$file); \
		if [ -e "$(PKG_BUILD_DIR)/lib/firmware/morse/$$$$filename" ]; then \
			echo "Error: Attempting to override $$$$filename which already exists in morse_bcf repo."; \
			exit 1; \
		else \
			$(INSTALL_DATA) $$$$file $(1)/lib/firmware/morse/; \
		fi; \
	done

	# Link the failsafe bcf by default so userspace can query the driver.
	ln -s /lib/firmware/morse/bcf_failsafe.bin $(1)/lib/firmware/morse/bcf_default.bin

	$(INSTALL_DATA) ./files/usr/share/morse-bcf/db.txt $(1)/usr/share/morse-bcf/db.txt
endef

define Package/morse-board-config-hotplug-model/install
	$(INSTALL_DIR) $(1)/etc/hotplug.d/ieee80211
	$(INSTALL_DATA) ./files/etc/hotplug.d/ieee80211/20-module-type $(1)/etc/hotplug.d/ieee80211/20-module-type
endef

$(eval $(call BuildPackage,morse-board-config))
$(eval $(call BuildPackage,morse-board-config-hotplug-model))
