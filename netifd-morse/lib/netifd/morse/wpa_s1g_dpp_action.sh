#!/bin/sh

# This helper script should go away in the future if we combine
# the rpcd dpp ucode plugin and wpa_event_listener.

case "$1" in
    config)
        ubus call dpp apply_config "{
            \"config\": {
                \"iface_name\": \"$iface_name\",
                \"key\": \"$(echo "$psk" | xxd -r -p)\",
                \"encryption\": \"$encryption\",
                \"ssid\": \"$ssid\"
            }
        }"
    ;;
    *)
        ubus call dpp set_state "{\"state\": \"$1\"}"
    ;;
esac
