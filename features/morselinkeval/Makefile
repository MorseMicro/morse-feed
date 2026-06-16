#
# Copyright (C) 2026 Morse Micro
#

include $(TOPDIR)/rules.mk

PKG_NAME:=morselinkeval
PKG_RELEASE:=1

PKG_MAINTAINER:=Morse Micro

include $(INCLUDE_DIR)/package.mk

define Package/morselinkeval
  SECTION:=utils
  CATEGORY:=Morse Micro
  SUBMENU:=Features
  TITLE:=Live HaLow link diagnostics service
  DEPENDS:=+morsecli +ucode +ucode-mod-fs +ucode-mod-log +ucode-mod-math \
	+ucode-mod-nl80211 +ucode-mod-ubus +ucode-mod-uloop
endef

define Package/morselinkeval/description
  Morse HaLow Link Quality Diagnostics is a procd-managed ucode service
  that continuously collects and publishes live link quality metrics for
  Morse Micro HaLow (IEEE 802.11ah) interfaces. It samples per-peer
  statistics via nl80211 and supplements them with vendor data from
  morse_cli, computing indicators such as RSSI, SNR, MCS, PER, throughput,
  retries and airtime utilisation.

  Metrics are exposed over ubus and logged for use by upstream monitoring,
  UI dashboards and field diagnostics tools. Sampling intervals and session
  limits are passed as command-line arguments by the init script, which
  derives them from the optional UCI config (/etc/config/morselinkeval) when
  present and otherwise relies on built-in defaults.
endef

define Build/Compile
endef

define Package/morselinkeval/install
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/morselinkeval $(1)/etc/init.d/

	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) ./files/usr/sbin/morselinkeval $(1)/usr/sbin/

	$(INSTALL_DIR) $(1)/usr/share/ucode/morselinkeval
	$(INSTALL_DATA) ./files/usr/share/ucode/morselinkeval/* $(1)/usr/share/ucode/morselinkeval/
endef

$(eval $(call BuildPackage,morselinkeval))
