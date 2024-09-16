#
# Copyright 2024 Morse Micro
#
# This is free software, licensed under the Apache License, Version 2.0 .
#

# Inspired by luci-mod-dashboard
include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Home
LUCI_DEPENDS:=+luci-base +libiwinfo +luci-app-morseconfig +luci-lib-vivagraphjs

# Because we're using newer CSS, csstidy makes a mess.
CONFIG_LUCI_CSSTIDY:=

PKG_LICENSE:=Apache-2.0

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature