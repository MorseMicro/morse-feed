#
# Copyright 2022 Morse Micro
#
# This is free software, licensed under the GNU General Public License v2.
# See /LICENSE for more information.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=nload
PKG_RELEASE:=1
PKG_VERSION:=0.7.4

PKG_BUILD_DIR:=$(BUILD_DIR)/nload-$(PKG_VERSION)
PKG_SOURCE:=$(PKG_NAME)-$(PKG_VERSION).tar.gz
PKG_SOURCE_URL:=http://www.roland-riegel.de/nload/
PKG_HASH:=c1c051e7155e26243d569be5d99c744d8620e65fa8a7e05efcf84d01d9d469e5
PKG_CAT:=zcat
PKG_FIXUP:=autoreconf

include $(INCLUDE_DIR)/package.mk

define Package/nload
  SECTION:=Utilities
  CATEGORY:=Utilities
  TITLE:=nload network load monitor
  DEPENDS:=+libstdcpp +libncursesw
  MAINTAINER:=Morse Micro
endef

define Package/nload/description
 nload network load monitor
endef

define Package/nload/install
	$(INSTALL_DIR) $(1)/sbin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/src/nload 	$(1)/sbin/
endef

$(eval $(call BuildPackage,nload))