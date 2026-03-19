#!/bin/sh

# If you use this script to persist your dropbear setup, it will
# get automatically loaded on a fresh flash (i.e. not retaining settings).

if [ -s /etc/dropbear/authorized_keys ]; then
	persistent_vars_storage.sh WRITE dropbear_authorized_keys "$(cat /etc/dropbear/authorized_keys)"
else
	persistent_vars_storage.sh ERASE dropbear_authorized_keys
fi
