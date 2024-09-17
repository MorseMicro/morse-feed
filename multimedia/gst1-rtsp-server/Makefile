#
# Copyright (C) 2009-2016 OpenWrt.org
# Copyright 2024 Morse Micro
#
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=gst1-rtsp-server
PKG_VERSION:=1.20.5
PKG_RELEASE:=1

PKG_SOURCE:=gst-rtsp-server-$(PKG_VERSION).tar.xz
PKG_SOURCE_URL:=https://gstreamer.freedesktop.org/src/gst-rtsp-server/
PKG_HASH:=ba398a7ddd559cce56ef4b91f448d174e0dccad98a493563d2d59c41a2ef39c5
PKG_BUILD_DIR:=$(BUILD_DIR)/gst-rtsp-server-$(PKG_VERSION)

PKG_MAINTAINER:=Morse Micro
PKG_LICENSE:=LGPL-2.1-or-later
PKG_LICENSE_FILES:=COPYING

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/meson.mk

define Package/libgst1rtspserver
  CATEGORY:=Multimedia
  SECTION:=multimedia
  TITLE:=GStreamer RTSP server
  URL:=https://gstreamer.freedesktop.org/
  DEPENDS:= +libgstreamer1 +libgst1app +libgst1net +libgst1rtp +libgst1rtsp +libgst1sdp +gst1-mod-rtpmanager +gst1-mod-rtp +gst1-mod-rtsp
endef

define Package/libgst1rtspserver/description
	GStreamer RTSP server.
endef

define Package/gst1-mod-rtspclientsink
  CATEGORY:=Multimedia
  SECTION:=multimedia
  TITLE:=GStreamer RTSP client sink plugin.
  URL:=https://gstreamer.freedesktop.org/
  DEPENDS:= +libgst1rtspserver
endef

define Package/gst1-mod-rtspclientsink/description
	GStreamer RTSP client sink plugin.
endef


MESON_ARGS += \
	-Dexamples=disabled \
	-Dtests=disabled \
	-Dgobject-cast-checks=disabled \
	-Dglib-asserts=disabled \
	-Dglib-checks=disabled \
	-Ddoc=disabled

GST_VERSION=1.0

define Package/gst1-mod-rtspclientsink/install
	$(INSTALL_DIR) $(1)/usr/lib/gstreamer-$(GST_VERSION)
	( cd $(PKG_INSTALL_DIR); $(CP) \
		./usr/lib/gstreamer-$(GST_VERSION)/libgstrtspclientsink.so* \
		$(1)/usr/lib/gstreamer-$(GST_VERSION)/ \
	)
endef

define Build/InstallDev
	$(INSTALL_DIR) $(1)/usr/include/gstreamer-$(GST_VERSION)/gst/rtsp-server
	( cd $(PKG_INSTALL_DIR); $(CP) \
		./usr/include/gstreamer-$(GST_VERSION)/gst/rtsp-server/* \
		$(1)/usr/include/gstreamer-$(GST_VERSION)/gst/rtsp-server \
	)
	$(INSTALL_DIR) $(1)/usr/lib
	( cd $(PKG_INSTALL_DIR); $(CP) \
		./usr/lib/libgstrtspserver-$(GST_VERSION).so* \
		$(1)/usr/lib/ \
	)
	$(INSTALL_DIR) $(1)/usr/lib/gstreamer-$(GST_VERSION)
	( cd $(PKG_INSTALL_DIR); $(CP) \
		./usr/lib/gstreamer-$(GST_VERSION)/libgst*.so \
		$(1)/usr/lib/gstreamer-$(GST_VERSION)/ \
	)
	$(INSTALL_DIR) $(1)/usr/lib/pkgconfig
	( cd $(PKG_INSTALL_DIR); $(CP) \
		./usr/lib/pkgconfig/gstreamer-rtsp-server-$(GST_VERSION).pc \
		$(1)/usr/lib/pkgconfig/ \
	)
endef

define Package/libgst1rtspserver/install
	$(INSTALL_DIR) $(1)/usr/lib
	( cd $(PKG_INSTALL_DIR); $(CP) \
		./usr/lib/libgstrtspserver-$(GST_VERSION).so.* \
		$(1)/usr/lib/ \
	)
endef

$(eval $(call BuildPackage,libgst1rtspserver))
$(eval $(call BuildPackage,gst1-mod-rtspclientsink))
