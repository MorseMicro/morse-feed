/*
 * wpa_supplicant / ubus support
 * Copyright (c) 2018, Daniel Golle <daniel@makrotopia.org>
 * Copyright (c) 2013, Felix Fietkau <nbd@nbd.name>
 *
 * This software may be distributed under the terms of the BSD license.
 * See README for more details.
 */

#include "utils/includes.h"
#include "utils/common.h"
#include "common/defs.h"
#include "utils/eloop.h"
#include "utils/wpabuf.h"
#include "common/ieee802_11_defs.h"
#include "wpa_supplicant_i.h"
#include "wps_supplicant.h"
#include "dpp_supplicant.h"
#include "ubus.h"
#include <libubox/blobmsg_json.h>
#include "bss.h"
#include "config.h"

#define VALID_BW(bw)       ((bw) == 1 || (bw) == 2 || (bw) == 4 || (bw) == 8)
#define VALID_PBW(pbw, bw) (((pbw) == 1 || (pbw) == 2) && (pbw) <= (bw))
#define VALID_PCI(idx, bw) ((idx) >= 0 && (idx) < (bw))

static struct ubus_context *ctx;
static struct blob_buf b;
static int ctx_ref;

int hostapd_config_s1g_val(const struct hostapd_config *conf) {
	return 0;
}

static inline struct wpa_global *get_wpa_global_from_object(struct ubus_object *obj)
{
	return container_of(obj, struct wpa_global, ubus_global);
}

static inline struct wpa_supplicant *get_wpas_from_object(struct ubus_object *obj)
{
	return container_of(obj, struct wpa_supplicant, ubus.obj);
}

static void ubus_reconnect_timeout(void *eloop_data, void *user_ctx)
{
	if (ubus_reconnect(ctx, NULL)) {
		eloop_register_timeout(1, 0, ubus_reconnect_timeout, ctx, NULL);
		return;
	}

	ubus_add_uloop(ctx);
}

static void wpas_ubus_connection_lost(struct ubus_context *ctx)
{
	uloop_fd_delete(&ctx->sock);
	eloop_register_timeout(1, 0, ubus_reconnect_timeout, ctx, NULL);
}

static bool wpas_ubus_init(void)
{
	if (ctx)
		return true;

	eloop_add_uloop();
	ctx = ubus_connect(NULL);
	if (!ctx)
		return false;

	ctx->connection_lost = wpas_ubus_connection_lost;
	ubus_add_uloop(ctx);

	return true;
}

static void wpas_ubus_ref_inc(void)
{
	ctx_ref++;
}

static void wpas_ubus_ref_dec(void)
{
	ctx_ref--;
	if (!ctx)
		return;

	if (ctx_ref)
		return;

	uloop_fd_delete(&ctx->sock);
	ubus_free(ctx);
	ctx = NULL;
}

static int
wpas_bss_get_features(struct ubus_context *ctx, struct ubus_object *obj,
			struct ubus_request_data *req, const char *method,
			struct blob_attr *msg)
{
	struct wpa_supplicant *wpa_s = get_wpas_from_object(obj);

	blob_buf_init(&b, 0);
	blobmsg_add_u8(&b, "ht_supported", ht_supported(wpa_s->hw.modes));
	blobmsg_add_u8(&b, "vht_supported", vht_supported(wpa_s->hw.modes));
	ubus_send_reply(ctx, req, b.head);

	return 0;
}

static int
wpas_bss_reload(struct ubus_context *ctx, struct ubus_object *obj,
		struct ubus_request_data *req, const char *method,
		struct blob_attr *msg)
{
	struct wpa_supplicant *wpa_s = get_wpas_from_object(obj);

	if (wpa_supplicant_reload_configuration(wpa_s))
		return UBUS_STATUS_UNKNOWN_ERROR;
	else
		return 0;
}

#ifdef CONFIG_WPS
enum {
	WPS_START_MULTI_AP,
	__WPS_START_MAX
};

static const struct blobmsg_policy wps_start_policy[] = {
	[WPS_START_MULTI_AP] = { "multi_ap", BLOBMSG_TYPE_BOOL },
};

static int
wpas_bss_wps_start(struct ubus_context *ctx, struct ubus_object *obj,
			struct ubus_request_data *req, const char *method,
			struct blob_attr *msg)
{
	int rc;
	struct wpa_supplicant *wpa_s = get_wpas_from_object(obj);
	struct blob_attr *tb[__WPS_START_MAX], *cur;
	int multi_ap = 0;

	blobmsg_parse(wps_start_policy, __WPS_START_MAX, tb, blobmsg_data(msg), blobmsg_data_len(msg));

	if (tb[WPS_START_MULTI_AP])
		multi_ap = blobmsg_get_bool(tb[WPS_START_MULTI_AP]);

	rc = wpas_wps_start_pbc(wpa_s, NULL, 0, multi_ap);

	if (rc != 0)
		return UBUS_STATUS_NOT_SUPPORTED;

	return 0;
}

static int
wpas_bss_wps_cancel(struct ubus_context *ctx, struct ubus_object *obj,
			struct ubus_request_data *req, const char *method,
			struct blob_attr *msg)
{
	int rc;
	struct wpa_supplicant *wpa_s = get_wpas_from_object(obj);

	rc = wpas_wps_cancel(wpa_s);

	if (rc != 0)
		return UBUS_STATUS_NOT_SUPPORTED;

	return 0;
}
#endif

#ifdef CONFIG_DPP3
enum {
	DPP_PUSH_BUTTON_COMMAND,
	__DPP_PUSH_BUTTON_MAX
};

static const struct blobmsg_policy dpp_push_button_policy[__DPP_PUSH_BUTTON_MAX] = {
	[DPP_PUSH_BUTTON_COMMAND] = { "command", BLOBMSG_TYPE_STRING },
};

static int
wpas_bss_dpp_push_button(struct ubus_context *ctx, struct ubus_object *obj,
			 struct ubus_request_data *req, const char *method,
			 struct blob_attr *msg)
{
	int rc;
	struct blob_attr *tb[__DPP_PUSH_BUTTON_MAX];
	struct wpa_supplicant *wpa_s = get_wpas_from_object(obj);

	blobmsg_parse(dpp_push_button_policy, __DPP_PUSH_BUTTON_MAX, tb, blob_data(msg), blob_len(msg));

	rc = wpas_dpp_push_button(wpa_s, tb[DPP_PUSH_BUTTON_COMMAND] ? blobmsg_data(tb[DPP_PUSH_BUTTON_COMMAND]) : NULL);

	if (rc != 0)
		return UBUS_STATUS_NOT_SUPPORTED;

	return 0;
}
#endif

static const struct ubus_method bss_methods[] = {
	UBUS_METHOD_NOARG("reload", wpas_bss_reload),
	UBUS_METHOD_NOARG("get_features", wpas_bss_get_features),
#ifdef CONFIG_WPS
	UBUS_METHOD_NOARG("wps_start", wpas_bss_wps_start),
	UBUS_METHOD_NOARG("wps_cancel", wpas_bss_wps_cancel),
#endif
#ifdef CONFIG_DPP3
	UBUS_METHOD("dpp_push_button", wpas_bss_dpp_push_button, dpp_push_button_policy),
#endif
};

static struct ubus_object_type bss_object_type =
	UBUS_OBJECT_TYPE("wpas_bss", bss_methods);

void wpas_ubus_add_bss(struct wpa_supplicant *wpa_s)
{
	struct ubus_object *obj = &wpa_s->ubus.obj;
	char *name;
	int ret;

	if (!wpas_ubus_init())
		return;

	if (asprintf(&name, "wpa_supplicant.%s", wpa_s->ifname) < 0)
		return;

	obj->name = name;
	obj->type = &bss_object_type;
	obj->methods = bss_object_type.methods;
	obj->n_methods = bss_object_type.n_methods;
	ret = ubus_add_object(ctx, obj);
	wpas_ubus_ref_inc();
}

void wpas_ubus_free_bss(struct wpa_supplicant *wpa_s)
{
	struct ubus_object *obj = &wpa_s->ubus.obj;
	char *name = (char *) obj->name;

	if (!ctx)
		return;

	if (obj->id) {
		ubus_remove_object(ctx, obj);
		wpas_ubus_ref_dec();
	}

	free(name);
}

void wpas_ubus_notify_type(struct wpa_supplicant *wpa_s, const char *type)
{
	if (!wpa_s->ubus.obj.has_subscribers)
		return;

	ubus_notify(ctx, &wpa_s->ubus.obj, type, NULL, -1);
}

#ifdef CONFIG_DPP3
void wpas_ubus_notify_dpp_pb_result(struct wpa_supplicant *wpa_s, const char *status)
{
	if (!wpa_s->ubus.obj.has_subscribers)
		return;

	blob_buf_init(&b, 0);
	blobmsg_add_string(&b, "status", status);
	ubus_notify(ctx, &wpa_s->ubus.obj, "dpp_pb_result", b.head, -1);
}
#endif

#ifdef CONFIG_DPP
void wpas_ubus_notify_dpp_conf_received(struct wpa_supplicant *wpa_s,
                                        const struct dpp_config_obj *conf)
{
	char *encryption, *ssid, *key;

	blob_buf_init(&b, 0);

	blobmsg_add_json_from_string(&b, conf->conf_obj);
	ubus_notify(ctx, &wpa_s->ubus.obj, "dpp_conf_received", b.head, -1);
}
#endif

#ifdef CONFIG_WPS
void wpas_ubus_notify(struct wpa_supplicant *wpa_s, const struct wps_credential *cred)
{
	u16 auth_type;
	char *ifname, *encryption, *ssid, *key;
	size_t ifname_len;

	if (!cred)
		return;

	auth_type = cred->auth_type;

	if (auth_type == (WPS_AUTH_WPAPSK | WPS_AUTH_WPA2PSK))
		auth_type = WPS_AUTH_WPA2PSK;

	if (auth_type != WPS_AUTH_OPEN &&
	    auth_type != WPS_AUTH_WPAPSK &&
	    auth_type != WPS_AUTH_WPA2PSK) {
		wpa_printf(MSG_DEBUG, "WPS: Ignored credentials for "
			   "unsupported authentication type 0x%x",
			   auth_type);
		return;
	}

	if (auth_type == WPS_AUTH_WPAPSK || auth_type == WPS_AUTH_WPA2PSK) {
		if (cred->key_len < 8 || cred->key_len > 2 * PMK_LEN) {
			wpa_printf(MSG_ERROR, "WPS: Reject PSK credential with "
				   "invalid Network Key length %lu",
				   (unsigned long) cred->key_len);
			return;
		}
	}

	blob_buf_init(&b, 0);

	ifname_len = strlen(wpa_s->ifname);
	ifname = blobmsg_alloc_string_buffer(&b, "ifname", ifname_len + 1);
	memcpy(ifname, wpa_s->ifname, ifname_len + 1);
	ifname[ifname_len] = '\0';
	blobmsg_add_string_buffer(&b);

	switch (auth_type) {
		case WPS_AUTH_WPA2PSK:
			encryption = "psk2";
			break;
		case WPS_AUTH_WPAPSK:
			encryption = "psk";
			break;
		default:
			encryption = "none";
			break;
	}

	blobmsg_add_string(&b, "encryption", encryption);

	ssid = blobmsg_alloc_string_buffer(&b, "ssid", cred->ssid_len + 1);
	memcpy(ssid, cred->ssid, cred->ssid_len);
	ssid[cred->ssid_len] = '\0';
	blobmsg_add_string_buffer(&b);

	if (cred->key_len > 0) {
		key = blobmsg_alloc_string_buffer(&b, "key", cred->key_len + 1);
		memcpy(key, cred->key, cred->key_len);
		key[cred->key_len] = '\0';
		blobmsg_add_string_buffer(&b);
	}

//	ubus_notify(ctx, &wpa_s->ubus.obj, "wps_credentials", b.head, -1);
	ubus_send_event(ctx, "wps_credentials", b.head);
}

#endif /* CONFIG_WPS */

static inline struct ieee80211_ht_operation *get_ht_ie(struct wpa_bss *bss)
{
    const u8 *ie;

    if (!bss)
        return NULL;

    ie = wpa_bss_get_ie(bss, WLAN_EID_HT_OPERATION);
    if (!ie)
        return NULL;

    /* Need the full HT Operation struct (22 bytes) */
    if (ie[1] < sizeof(struct ieee80211_ht_operation))
        return NULL;

    return (struct ieee80211_ht_operation *)(ie + 2);
}

static inline struct ieee80211_vht_operation *get_vht_ie(struct wpa_bss *bss)
{
    const u8 *ie;

    if (!bss)
        return NULL;

    ie = wpa_bss_get_ie(bss, WLAN_EID_VHT_OPERATION);
    if (!ie)
        return NULL;

    /* Need the full VHT Operation struct (5 bytes) */
    if (ie[1] < sizeof(struct ieee80211_vht_operation))
        return NULL;

    return (struct ieee80211_vht_operation *)(ie + 2);
}

struct s1g_chan_info {
    int op_class;
    int channel;
    int bandwidth;
    int prim_chwidth;
    int prim_1mhz_chan;
    int prim_1mhz_index;
};

int wpas_get_current_chan_info(struct wpa_supplicant *wpa_s,
                               struct s1g_chan_info *out)
{
    struct ieee80211_ht_operation *ht_oper;
    struct ieee80211_vht_operation *vht_oper;

    int s1g_chan, s1g_bw, s1g_prim_1mhz_chan, prim_bw, s1g_prim_1mhz_index;
    const struct ah_class *classp = NULL;

    if (!wpa_s || !wpa_s->current_bss || !out)
        return -1;

    /* Point to the right chan pairs. */
    morse_set_s1g_ht_chan_pairs(wpa_s->conf->country);
    ht_oper = get_ht_ie(wpa_s->current_bss);
    vht_oper = get_vht_ie(wpa_s->current_bss);
    if (!ht_oper) {
        wpa_msg(wpa_s, MSG_INFO, "S1G: missing HT Operation IE in current BSS");
        return -1;
    }

    s1g_chan            = morse_s1g_get_oper_chan_from_ht_vht_ies(wpa_s->conf->country, ht_oper, vht_oper);
    s1g_bw              = morse_s1g_chan_to_bw(s1g_chan);
    s1g_prim_1mhz_chan  = morse_s1g_get_prim_chane_from_ht_ie(wpa_s->conf->country, ht_oper);
    prim_bw             = morse_s1g_get_prim_chwidth_from_ht_ies(ht_oper);
    s1g_prim_1mhz_index = morse_s1g_get_prim_1mhz_ch_idx(wpa_s->conf->country, s1g_chan, s1g_bw, s1g_prim_1mhz_chan);

	/* Validate the parameters */
    if (s1g_chan            <= 0    ||
        s1g_prim_1mhz_chan  <= 0    ||
        !VALID_BW(s1g_bw)           ||
        !VALID_PBW(prim_bw, s1g_bw) ||
        !VALID_PCI(s1g_prim_1mhz_index, s1g_bw)) {
        wpa_msg(wpa_s, MSG_INFO,
                "S1G: invalid derived params (chan=%d, bw=%d, prim=%d)",
                s1g_chan, s1g_bw, s1g_prim_1mhz_chan);
        return -1;
    }

    classp = morse_s1g_ch_to_op_class(s1g_bw, wpa_s->conf->country, s1g_chan);
    if (!classp) {
        wpa_msg(wpa_s, MSG_INFO,
                "S1G: op-class lookup failed (bw=%d, cc=%s, chan=%d)",
                s1g_bw, wpa_s->conf->country, s1g_chan);
        return -1;
    }

    /* Fill result */
    out->op_class       = classp->global_op_class;
    out->channel        = s1g_chan;
    out->bandwidth      = s1g_bw;
    out->prim_chwidth   = prim_bw;
    out->prim_1mhz_chan = s1g_prim_1mhz_chan;
    out->prim_1mhz_index= s1g_prim_1mhz_index;
    wpa_msg(wpa_s, MSG_INFO,
            "S1G: op_class=%d chan=%d bw=%dMHz prim_bw=%d prim1MHz=%d prim1MHzIndex=%d cc=%s",
            out->op_class,
            out->channel,
            out->bandwidth,
            out->prim_chwidth,
            out->prim_1mhz_chan,
            out->prim_1mhz_index,
            wpa_s->conf->country);

    return 0;
}

void wpas_ubus_event_state(struct wpa_supplicant *wpa_s, const char *state)
{
    if (!ctx || !wpa_s || !wpa_s->ifname || !state)
        return;

    struct blob_buf b = {0};
    blob_buf_init(&b, 0);
    blobmsg_add_string(&b, "ifname", wpa_s->ifname);
    blobmsg_add_string(&b, "state", state);

    if (wpa_s->wpa_state == WPA_COMPLETED) {
        struct s1g_chan_info s1g_chan_info;
        if (!wpas_get_current_chan_info(wpa_s, &s1g_chan_info)) {
            blobmsg_add_u32(&b, "op_class",                  s1g_chan_info.op_class);
            blobmsg_add_u32(&b, "channel",                   s1g_chan_info.channel);
            blobmsg_add_u32(&b, "s1g_chanbw",                s1g_chan_info.bandwidth);
            blobmsg_add_u32(&b, "s1g_prim_chwidth",          s1g_chan_info.prim_chwidth);
            blobmsg_add_u32(&b, "s1g_prim_1mhz_chan_index",  s1g_chan_info.prim_1mhz_index);
            blobmsg_add_u32(&b, "s1g_prim_1mhz_chan",        s1g_chan_info.prim_1mhz_chan);
        }
    }

    ubus_send_event(ctx, "wpa_supplicant_s1g.state", b.head);

    blob_buf_free(&b);
    return;
}

