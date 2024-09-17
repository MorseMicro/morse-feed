#
# Copyright 2023 Morse Micro
#
# This is free software, licensed under the Apache License, Version 2.0.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=aws-kvs
PKG_VERSION:=3.4.1

ARCHIVE_NAME:=amazon-kinesis-video-streams-producer-sdk-cpp
PKG_SOURCE:= $(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=https://codeload.github.com/awslabs/$(ARCHIVE_NAME)/tar.gz/v$(PKG_VERSION)?
PKG_HASH:=ac85de2cd61326150471bdce68176c2c8e93cff979633bc6b99f6293de8dd5d4
PKG_BUILD_DIR:=$(BUILD_DIR)/$(ARCHIVE_NAME)-$(PKG_VERSION)

PKG_USE_NINJA:=1
PKG_MAINTAINER:=Morse Micro <info@morsemicro.com>

include $(INCLUDE_DIR)/package.mk
include $(INCLUDE_DIR)/cmake.mk
include $(INCLUDE_DIR)/nls.mk


define Package/aws-kvs
    SECTION:=multimedia
    CATEGORY:=Multimedia
    SUBMENU:=Streaming
    URL:=https://github.com/awslabs/amazon-kinesis-video-streams-producer-sdk-cpp.git
    TITLE:=Amazon Kinesis Video Streams Producer
    DEPENDS:= +libopenssl +libcurl +log4cplus +libgstreamer1 +libgst1app +gst1-mod-videoparsersbad +gstreamer1-utils +gst1-mod-rtpmanager +gst1-mod-udp +gstreamer1-plugins-base +@PACKAGE_gstreamer1-plugins-good +gst1-mod-rtsp +gst1-mod-rtp $(INTL_DEPENDS)
endef


define Package/aws-kvs/description
	Amazon Kinesis Video Streams provides a service that publishes a video stream to AWS Kinesis Video Streams using the gstreamer plugins
endef

CMAKE_OPTIONS += -DBUILD_dumpcap=ON
CMAKE_OPTIONS += -DBUILD_DEPENDENCIES=OFF
CMAKE_OPTIONS += -DCOMPILER_WARNINGS=ON
CMAKE_OPTIONS += -DCONSTRAINED_DEVICE=ON
CMAKE_OPTIONS += -DBUILD_GSTREAMER_PLUGIN=ON

define Build/Prepare
	$(Build/Prepare/Default)
	$(CP) files/*.patch $(PKG_BUILD_DIR)/
endef

define Package/aws-kvs/install
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/etc/init.d/aws_kvs $(1)/etc/init.d/
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_BIN) ./files/etc/config/aws_kvs $(1)/etc/config/
	$(INSTALL_DIR) $(1)/usr/lib
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/dependency/libkvscproducer/kvscproducer-src/libcproducer.so $(1)/usr/lib/
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/libKinesisVideoProducer.so $(1)/usr/lib/
	$(INSTALL_DIR) $(1)/usr/lib/gstreamer-1.0
	$(INSTALL_DATA) $(PKG_BUILD_DIR)/libgstkvssink.so $(1)/usr/lib/gstreamer-1.0/
endef

$(eval $(call BuildPackage,aws-kvs))
