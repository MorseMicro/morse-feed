#!/bin/sh

. /lib/functions.sh
. /lib/functions/network.sh
. /lib/netifd/morse/morse_utils.sh

network_flush_cache

find_ethernet_network_interface() {
    [ -n "$ethernet_network_interface" ] && return;

    config_get device "$1" device

    case "$device" in
        "${ethernet_network_bridge:=NOBRIDGE}"|eth*)
            ethernet_network_interface="$1"
            ;;
    esac
}

find_ethernet_bridge() {
    [ -n "$ethernet_network_bridge" ] && return;

    local type
    local ports
    config_get type "$1" type
    config_get ports "$1" ports

    if [ "$type" = "bridge" ]; then
        case "$ports" in
            *eth*)
                config_get ethernet_network_bridge "$1" name
                ;;
        esac
    fi
}

# This gets the _first_ network interface with an ethernet port on it.
# This may not be sufficient if there are multiple ethernet ports.
get_uci_ethernet_network_interface()
{
    config_load network
    config_foreach find_ethernet_bridge device
    config_foreach find_ethernet_network_interface interface
}

get_zone_for_network() {
    local zone="$1"
    local varname="$2"
    local network="$3"

    config_get zone_networks "$zone" network

    for zone_network in $zone_networks; do
        if [ "$network" = "$zone_network" ]; then
            eval "$varname=$zone"
        fi
    done
}

get_forward() {
    local fwd="$1"
    local src="$2"
    local dest="$3"

    config_get fwd_src "$fwd" src
    config_get fwd_dest "$fwd" dest
    config_get fwd_enabled "$fwd" enabled

    if [ "$src" = "$fwd_src" ] && [ "$dest" = "$fwd_dest" ] && [ "$fwd_enabled" != "0" ]; then
        forward=1
    fi
}

has_forward() {
    local src_network="$1"
    local dest_network="$2"

    config_load firewall
    config_foreach get_zone_for_network zone src_zone "$src_network"
    config_foreach get_zone_for_network zone dest_zone "$dest_network"

    config_foreach get_forward forwarding "$src_zone" "$dest_zone"

    test "$forward" = 1
}

find_morse_device() {
    # if morse_uci_wifi_device is already found, don't bother.
    [ -n "$morse_uci_wifi_device" ] && return
    local device="$1"
    local type
    config_get type $device type
    [ $type = "morse" ] && morse_uci_wifi_device=$device
}

get_morse_uci_wifi_device()
{
    config_load wireless
    config_foreach find_morse_device wifi-device
}

find_morse_iface() {
    local iface="$1"
    local device
    local mode
    local state=
    config_get device $iface device
    config_get state $iface disabled
    config_get mode $iface mode

    if [ $device = "$morse_uci_wifi_device" ] && [ "$mode" != "none" ]; then
        if [ -z "$state" ] || [ "$state" == "0" ]; then
            # Record the first one as morse_uci_wifi_iface
            [ -z "$morse_uci_wifi_iface" ] && morse_uci_wifi_iface="$iface"
            if [ "$mode" == "ap" ]; then
                has_ap=1
            elif [ "$mode" == "mesh" ]; then
                has_mesh=1
            fi
        fi
    fi
}

get_morse_uci_wifi_iface()
{
    has_ap=
    has_mesh=
    config_load wireless
    config_foreach find_morse_iface wifi-iface
}

print_mac_ip_of_interface()
{
    local iface="$1"
    network_get_device DEVICE "$iface"
    ifconfig "$DEVICE" | grep "$DEVICE" -A 1
}

print_banner()
{
    local mode=$1
    case "$mode" in
        "ap")
            cat /morse/banners/msgap.txt
            ;;
        "MultiAP")
            cat /morse/banners/msgmultiap.txt
            ;;
        "sta")
            cat /morse/banners/msgsta.txt
            ;;
        "adhoc")
            cat /morse/banners/msgibss.txt
            ;;
        "bridge")
            cat /morse/banners/msgbridge.txt
            ;;
        "extender")
            cat /morse/banners/msgextender.txt
            ;;
        "router")
            cat /morse/banners/msgrouter.txt
            ;;
        "mesh")
            cat /morse/banners/msgmesh.txt
            ;;
        "meshap")
            cat /morse/banners/msgmeshap.txt
            ;;
        *)
            ;;
    esac
}


print_interface_info()
{
    local country=$(uci -q get wireless.$morse_uci_wifi_device.country)
    local disabled=$(uci -q get wireless.$morse_uci_wifi_device.disabled)

    if [ -z "$country" ] || [ "$disabled" = 1 ] || [ -z "$morse_uci_wifi_iface" ]; then
        echo -e "\nHaLow not configured.\n"
        print_mac_ip_of_interface "$ethernet_network_interface"
        return
    fi

    local morse_interface_mode=$(uci -q get wireless.$morse_uci_wifi_iface.mode)
    local morse_interface_network=$(uci -q get wireless.$morse_uci_wifi_iface.network)

    local mode=
    if [ "$(uci -q get prplmesh.config.enable)" = 1 ]; then
        mode="MultiAP"
    elif [ "$has_mesh" == 1 ]; then
        if [ "$has_ap" == 1 ]; then
            mode="meshap"
        else
            mode="mesh"
        fi
    elif [ "$morse_interface_network" = "$ethernet_network_interface" ]; then
        mode="bridge"
    elif has_forward "$morse_interface_network" "$ethernet_network_interface"; then
        mode="router"
    elif has_forward "$ethernet_network_interface" "$morse_interface_network"; then
        mode="extender"
    else
        mode="$morse_interface_mode"
    fi

    print_banner "$mode"

    echo "Country: $country"

    if [ "$mode" = MultiAP ]; then
        echo "MultiAP Mode: $(uci -q get prplmesh.config.management_mode)"
    fi

    if [ "$mode" = mesh ]; then
        echo "Mesh ID: $(uci -q get wireless.$morse_uci_wifi_iface.mesh_id)"
    else
        echo "SSID: $(uci -q get wireless.$morse_uci_wifi_iface.ssid)"
    fi

    echo "Encryption: $(uci -q get wireless.$morse_uci_wifi_iface.encryption)"

    if [ "$morse_interface_mode" = "ap" ]; then
        local channel="$(uci -q get wireless.$morse_uci_wifi_device.channel)"
        echo "Channel: $channel"

        _get_regulatory "$morse_interface_mode" "$country" "$channel" ""
        if [ $? -ne 0 ]; then
            echo "Couldn't find reg for $morse_interface_mode in $country with ch=$channel op=$op_class" >&2
        fi
        echo "Bandwidth: $halow_bw"
    fi

    echo

    print_mac_ip_of_interface "$ethernet_network_interface"

    if [ "$morse_interface_network" != "$ethernet_network_interface" ]; then
        print_mac_ip_of_interface "$morse_interface_network"
    fi
}

get_uci_ethernet_network_interface
get_morse_uci_wifi_device
get_morse_uci_wifi_iface

print_interface_info