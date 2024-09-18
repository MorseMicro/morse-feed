#
# Copyright 2023 Morse Micro
#
# This is free software, licensed under the Apache License, Version 2.0.
#

include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI Camera Viewer
# Only depends on luci-app-morseconfig because it places itself in the Morse menu.
LUCI_DEPENDS:=+rpcd-mod-onvif +luci-lib-httpclient +mediamtx +luci-app-morseconfig

PKG_LICENSE:=Apache-2.0

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature