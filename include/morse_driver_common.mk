PKG_LICENSE:=GPLv2
PKG_LICENSE_FILES:=

PKG_MAINTAINER:=Morse Micro
PKG_BUILD_PARALLEL:=1

UNZIP_CMD=unzip -q -n -d  $(1) $(DL_DIR)/$(PKG_SOURCE) && mv $(1)/*/* $(1)/
DTC=$(wildcard $(LINUX_DIR)/scripts/dtc/dtc)

ifeq ($(CONFIG_MORSE_SDIO),y)
  MORSE_MAKEDEFS += CONFIG_MORSE_SDIO=y
endif

ifeq ($(CONFIG_MORSE_SPI),y)
  MORSE_MAKEDEFS += CONFIG_MORSE_SPI=y
endif

ifeq ($(CONFIG_MORSE_USB),y)
  MORSE_MAKEDEFS += CONFIG_MORSE_USB=y
endif

ifeq ($(CONFIG_MORSE_USER_ACCESS),y)
  MORSE_MAKEDEFS += CONFIG_MORSE_USER_ACCESS=y
endif

ifeq ($(CONFIG_MORSE_VENDOR_COMMAND),y)
  MORSE_MAKEDEFS += CONFIG_MORSE_VENDOR_COMMAND=y
endif

ifeq ($(CONFIG_MORSE_MONITOR),y)
  MORSE_MAKEDEFS += CONFIG_MORSE_MONITOR=y
endif

ifeq ($(CONFIG_MORSE_DEBUG),y)
  # This DEBUG (used by the driver Makefile) should not be confused with
  # -DDEBUG (used by the kernel build system).
  MORSE_MAKEDEFS += DEBUG=y
  MORSE_MAKEDEFS += CONFIG_MORSE_DEBUGFS=y
  MORSE_MAKEDEFS += CONFIG_MORSE_ENABLE_TEST_MODES=y
else
  MORSE_MAKEDEFS += DEBUG=n
endif

ifneq ($(CONFIG_MORSE_RC),y)
  MORSE_MAKEDEFS += CONFIG_DISABLE_MORSE_RC=y
endif

OPENWRT_MAC80211_VERSION := $(shell grep '^PKG_VERSION:=' $(TOPDIR)/package/kernel/mac80211/Makefile | cut -d'=' -f2 | cut -d'-' -f1)

MORSE_MAKEDEFS += \
  MORSE_VERSION=0-$(PKG_VERSION) \
  KERNEL_SRC=$(LINUX_DIR) \
  CONFIG_MORSE_SDIO_ALIGNMENT=$(CONFIG_MORSE_SDIO_ALIGNMENT)

ifneq ($(CONFIG_MORSE_CUSTOM_MAC80211),y)
  # This refers to the version of mac80211 backported to OpenWrt
  # Occasionally patches are required to remove some parts of the driver
  # as OpenWrt may sometimes pull in further patches from later kernel versions
  # than that of the mac80211 backport.
  MORSE_MAKEDEFS += CONFIG_BACKPORT_VERSION=v$(OPENWRT_MAC80211_VERSION)

  NOSTDINC_FLAGS = \
    -I$(PKG_BUILD_DIR) \
    -I$(STAGING_DIR)/usr/include/mac80211-backport/uapi \
    -I$(STAGING_DIR)/usr/include/mac80211-backport \
    -I$(STAGING_DIR)/usr/include/mac80211/uapi \
    -I$(STAGING_DIR)/usr/include/mac80211 \
    -include backport/autoconf.h \
    -include backport/backport.h
endif

ifeq ($(CONFIG_MORSE_DEBUG_LOGGING),y)
  NOSTDINC_FLAGS += -DDYNAMIC_DEBUG_MODULE
  NOSTDINC_FLAGS += -DDEBUG
endif

MORSE_MAKEDEFS += CONFIG_WLAN_VENDOR_MORSE=m
MORSE_MAKEDEFS += V=1
MORSE_MAKEDEFS += EXTRA_CFLAGS+=-Wno-error=int-in-bool-context

NOSTDINC_FLAGS += -DMORSE_TRACE_PATH=.

include $(INCLUDE_DIR)/kernel-defaults.mk

define Build/Compile
	$(MAKE) $(MORSE_MAKEDEFS) $(PKG_JOBS) -C "$(LINUX_DIR)" \
		$(KERNEL_MAKE_FLAGS) \
		M="$(PKG_BUILD_DIR)" \
		NOSTDINC_FLAGS="$(NOSTDINC_FLAGS)" \
		modules
endef
