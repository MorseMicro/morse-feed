#!/bin/sh
#
# Copyright (C) 2023 MorseMicro
#


operation="$1"
key="$2"
value="$3"

set -eu

get_key_from_persistent_storage()
{
    local config_key=
    config_key=$(vcgencmd bootloader_config | grep "$key=")
    config_key=$(echo "$config_key" | sed "s/$key=//g")
    echo "$config_key"
}

print_usage()
{
    echo "persistent_vars_storage.sh OPERATION(READ|WRITE|ERASE) KEY [VALUE]" 1>&2;
}



case "$operation" in
    READ)
        value=$(get_key_from_persistent_storage)
        if [ -n "$value" ]; then
            echo "$value"
            exit 0
        else
            echo "The key \"$key\" doesn't exist in bootloader config." 1>&2;
            print_usage
            exit 1
        fi
    ;;

    WRITE|ERASE)
        echo "Writing to persistent memory isn't implemented on bcm2711, yet." 1>&2;
        exit 1
    ;;

    *)
        print_usage
        exit 1
    ;;

esac


