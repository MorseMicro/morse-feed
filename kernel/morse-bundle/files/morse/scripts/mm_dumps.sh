#!/bin/sh
#
# Copyright (C) 2023 Morse Micro Pty Ltd. All rights reserved.
#

INTERFACE="wlan0"
MORSE_DIR="/"
OUTPUT_PATH="."
DEBUG_DIR=$(date +"%F_%X")
COMPRESS=false
BUILD="OpenWRT"

tear_down_tmp_iface()
{
    if [ "$tear_down_iface" == 1 ]; then
        iw dev "$INTERFACE" del
    fi
}

find_morse_device() {
    local device=$1
    local type_morse
    config_get type_morse $device type

    if [ "$type_morse" == "morse" ]; then
        morse_radio=$1
        config_get morse_path $device path
        return 1
    fi
}

create_tmp_iface()
{
    . /lib/functions.sh
    config_load wireless
    config_foreach find_morse_device wifi-device

    iwinfo_cmd="iwinfo nl80211 phyname \"path=$morse_path\""
    phy=$(eval $iwinfo_cmd)
    INTERFACE=tmp_"$INTERFACE"

    iw phy "$phy" interface add "$INTERFACE" type managed
    rc="$?"
    if [ "$rc" = 0 ]; then
        ip link set "$INTERFACE" up
        tear_down_iface=1
    fi
}

morse_iface_available()
{
    ubus_cmd="ubus call iwinfo info '{\"device\": \"$INTERFACE\"}'"
    ubus_output=$(eval $ubus_cmd)

    . /usr/share/libubox/jshn.sh
    json_init
    json_load "$ubus_output"
    json_get_var hwmode hwmode

    [ "$hwmode" == "ah" ] && return 1
    return 0
}

validate_morse_iface()
{
    if morse_iface_available; then
        create_tmp_iface
    fi
}

get_dmesg()
{
    dmesg > dmesg.txt
}

get_versions()
{
    "$MORSE_DIR"morse/scripts/versions.sh > versions.txt
}

get_morsectrl_stats()
{
    morse_cli -i "$INTERFACE" stats -j > morsectrl_stats.json
}

get_morsectrl_channel()
{
    morse_cli -i "$INTERFACE" channel > morsectrl_channel.txt
}

get_iw_link()
{
    iw "$INTERFACE" link > iw_link.txt
}

get_iw_station_dump()
{
    iw "$INTERFACE" station dump > iw_station_dump.txt
}

get_iwinfo()
{
    iwinfo > iwinfo.txt
}

get_ifconfig()
{
    ifconfig > ifconfig.txt
}

get_morse_conf()
{
    cp "$MORSE_DIR"morse/configs/morse.conf .
}

get_log_dump()
{
    cp -r /var/log var_log_dump
}

get_bcf_binaries()
{
    cp -r /lib/firmware/morse binaries
}

get_interrupts()
{
    cat /proc/interrupts > interrupts.txt
}

get_gpios()
{
    cat /sys/kernel/debug/gpio > gpio.txt
}

get_ps()
{
    ps > running_procs.txt
}

get_kernel()
{
    cat /proc/version > kernel.txt
}

get_morse_modparams()
{
    cp -r /sys/module/morse/parameters modparams
}

get_cpu_and_mem_usage()
{
    top -n1 > cpu_and_mem_usage.txt
}

get_meminfo()
{
    cat /proc/meminfo > meminfo.txt
}

get_df()
{
    df -h > disk_usage.txt
}

get_syslog()
{
    logread > syslog.txt
}

get_etc_config()
{
    cp -r /etc/config etc_config
}

get_sys_fs_pstore()
{
    cp -r /sys/fs/pstore sys_fs_pstore
}

get_var_run_confs()
{
    mkdir var_run_confs
    cp /var/run/*.conf var_run_confs/
}

get_mm_chip_uart_logs()
{
    cp /var/log/ttyAMA1.log ttyAMA1.log
}

get_prplmesh_data_model()
{
    ubus call Device.WiFi.DataElements _get '{"depth":"10"}' > prplmesh_data_model.json
}

get_prplmesh_conn_map()
{
    prplmesh_enable=$(uci get prplmesh.config.enable)
    prplmesh_master=$(uci get prplmesh.config.master)
    if [ "$prplmesh_enable" = 1 ] && [ "$prplmesh_master" = 1 ]; then
        /opt/prplmesh/bin/beerocks_cli -c bml_conn_map > prplmesh_conn_map.txt
    fi
}

usage()
{
    echo " "
    echo "Usage: $(basename $0) [-c] [-b build system] [-i interface] [-m morse directory path] [-o Output folder name] [-d Output file path]"
    echo "Morse Micro file and information extraction tool"
    echo "   -c                          Compress output folder to .tar.gz. (default: disabled)"
    echo "   -b BUILD SYSTEM             Build system used to compile. (default: OpenWRT)"
    echo "                               Options:"
    echo "                                        'buildroot'"
    echo "                                        'OpenWRT'"
    echo "   -i INTERFACE                Network interface. (default: wlan0)"
    echo "   -m MORSE DIRECTORY PATH     Filepath to morse folder. (default: '/')"
    echo "   -o OUTPUT FOLDER NAME       Name of folder to output debug files. (default: 'YYYY-MM-DD_hh:mm:ss')"
    echo "   -d OUTPUT FILE PATH         Path to save output folder. (default: '.')"
    exit 1
}

optstring="cb:i:m:o:d:"

while getopts ${optstring} arg; do
    case ${arg} in
    c)
        COMPRESS=true
        ;;
    b)
        BUILD="$OPTARG"
        ;;
    i)
        INTERFACE="$OPTARG"
        ;;
    m)
        MORSE_DIR="$OPTARG"
        ;;
    o)
        DEBUG_DIR="$OPTARG"
        ;;
    d)
        OUTPUT_PATH="$OPTARG"
        ;;
    *)
        usage
        ;;
    esac
done

cd "$OUTPUT_PATH" || exit 1 ;
mkdir "$DEBUG_DIR" ; cd "$DEBUG_DIR" || exit 1


case $BUILD in
    "buildroot")
        get_iw_link
        get_etc_config
        get_iw_station_dump
        get_morsectrl_channel
        get_dmesg
        get_ps
        get_meminfo
        get_cpu_and_mem_usage
        get_versions
        get_morsectrl_stats
        get_iwinfo
        get_ifconfig
        get_morse_conf
        get_log_dump
        get_bcf_binaries
        get_interrupts
        get_gpios
        get_kernel
        get_morse_modparams
        get_df
        ;;
    "OpenWRT")
        validate_morse_iface
        get_syslog
        get_sys_fs_pstore
        get_var_run_confs
        get_iw_link
        get_etc_config
        get_iw_station_dump
        get_morsectrl_channel
        get_dmesg
        get_ps
        get_meminfo
        get_cpu_and_mem_usage
        get_morsectrl_stats
        get_iwinfo
        get_ifconfig
        get_log_dump
        get_bcf_binaries
        get_interrupts
        get_gpios
        get_kernel
        get_df
        get_morse_modparams
        get_mm_chip_uart_logs
        get_prplmesh_data_model
        get_prplmesh_conn_map
        tear_down_tmp_iface
        ;;
    *)
        echo "Invalid BUILD option. Exiting..."
        cd ../
        rm -rf "$DEBUG_DIR"
        exit 1
esac




if $COMPRESS; then
    cd ../
    tar -czvf "$DEBUG_DIR".tar.gz "$DEBUG_DIR"
    rm -rf "$DEBUG_DIR"
fi
