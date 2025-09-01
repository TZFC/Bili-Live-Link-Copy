// ==UserScript==
// @name                 Bilibili Live Master URL Copier
// @name:zh-CN           Bilibili 直播流链接复制按钮
// @namespace            https://github.com/TZFC
// @version              0.5
// @description          Create a button above Bilibili Livestream that copies the stream url to clipboard. Can be used in custom player, download, or in VRChat stream video player.
// @description:zh-CN    在Bilibili直播间上方添加一个“复制直播流链接”按钮。直播流链接可用在任意播放器，下载，或用于VRChat直播播放器。
// @downloadURL          https://raw.githubusercontent.com/TZFC/Bili-Live-Link-Copy/main/bili-live-link-copy.user.js
// @updateURL            https://raw.githubusercontent.com/TZFC/Bili-Live-Link-Copy/main/bili-live-link-copy.user.js
// @author               tianzifangchen
// @match                *://live.bilibili.com/*
// @icon                 https://www.bilibili.com/favicon.ico
// @license              GPL-3.0
// @run-at               document-idle
// @grant                unsafeWindow
// @grant                GM_setClipboard
// @grant                GM_xmlhttpRequest
// @connect              api.live.bilibili.com
// ==/UserScript==

(function () {
    'use strict';

    const QN_LABEL = {
        30000: '杜比',
        25000: '默认',
        20000: '4K',
        10000: '原画',
        400:   '蓝光',
        250:   '超清',
        150:   '高清',
        80:    '流畅'
    };

    function wait_for_element_by_query(query_selector, timeout_milliseconds) {
        const start_time = Date.now();
        return new Promise((resolve) => {
            const interval_id = setInterval(() => {
                const node = document.querySelector(query_selector);
                if (node) {
                    clearInterval(interval_id);
                    resolve(node);
                } else if (Date.now() - start_time > timeout_milliseconds) {
                    clearInterval(interval_id);
                    resolve(null);
                }
            }, 150);
        });
    }

    function safely_get(obj, getter) {
        try { return getter(obj); } catch { return undefined; }
    }

    function get_room_id_from_page() {
        const neptune = unsafeWindow.__NEPTUNE_IS_MY_WAIFU__;
        const possible_id = neptune && neptune.roomInitRes && neptune.roomInitRes.data && neptune.roomInitRes.data.room_id;
        if (possible_id) return Number(possible_id);
        const match = location.pathname.match(/\/(\d+)/);
        return Number(match && match[1]);
    }

    function get_anchor_uid_from_page() {
        const neptune = unsafeWindow.__NEPTUNE_IS_MY_WAIFU__;
        const uid_from_anchor = safely_get(neptune, n => n.roomInitRes.data.anchor_info.base_info.uid);
        const uid_from_room   = safely_get(neptune, n => n.roomInitRes.data.room_info.uid);
        const uid = Number(uid_from_anchor || uid_from_room || 0);
        return uid || null;
    }

    function build_play_info_url(room_id_number) {
        return `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${room_id_number}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&dolby=5&panorama=1`;
    }

    function build_master_gateway_url(cid_number, mid_number, qn_number) {
        const cid = `cid=${cid_number}`;
        const mid = `mid=${mid_number || 0}`;
        const qn  = `qn=${qn_number}`;
        const fixed = 'pt=web&p2p_type=-1&net=0&free_type=0&build=0&feature=2&drm_type=0&cam_id=0';
        return `https://api.live.bilibili.com/xlive/play-gateway/master/url?${cid}&${mid}&${qn}&${fixed}`;
    }

    function gm_get_json(url_string) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url_string,
                headers: { 'Accept': 'application/json' },
                onload: function (response) {
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (e) { reject(e); }
                },
                onerror: reject
            });
        });
    }

    function gm_fetch_raw(url_string) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url_string,
                responseType: 'text',
                onload: function (response) {
                    const content_type = (response.responseHeaders || '')
                        .split(/\r?\n/)
                        .find(h => /^content-type:/i.test(h)) || '';
                    const final_url = response.finalUrl || url_string;
                    resolve({
                        text: response.responseText || '',
                        contentType: content_type.split(':')[1]?.trim().toLowerCase() || '',
                        finalUrl: final_url,
                        status: response.status
                    });
                },
                onerror: reject
            });
        });
    }

    function depth_first_find_value_by_keys(any_object, keys_array) {
        const stack = [any_object];
        while (stack.length) {
            const current = stack.pop();
            if (!current || typeof current !== 'object') continue;
            for (const key of Object.keys(current)) {
                const value = current[key];
                if (keys_array.includes(key) && typeof value === 'string' && /^https?:\/\//.test(value)) {
                    return value;
                }
                if (value && typeof value === 'object') stack.push(value);
            }
        }
        return null;
    }

    function compose_from_codec(codec_obj) {
        const ui = Array.isArray(codec_obj.url_info) ? codec_obj.url_info[0] : null;
        const host = ui && ui.host;
        const base = codec_obj.base_url;
        const extra = ui && ui.extra;
        if (typeof host === 'string' && typeof base === 'string' && typeof extra === 'string') {
            return host + base + extra;
        }
        if (typeof codec_obj.url === 'string' && /^https?:\/\//.test(codec_obj.url)) {
            return codec_obj.url;
        }
        return null;
    }

    function extract_master_url_from_play_info_json(play_info_json) {
        const playurl = safely_get(play_info_json, j => j.data.playurl_info.playurl);
        if (!playurl) return null;
        const explicit = depth_first_find_value_by_keys(playurl, ['master_url', 'm3u8_master_url']);
        if (explicit) return explicit;
        const streams = Array.isArray(playurl.stream) ? playurl.stream : [];
        const sorted_streams = [...streams].sort((a, b) => {
            const ah = String(a.protocol_name || '').toLowerCase().includes('hls') ? -1 : 1;
            const bh = String(b.protocol_name || '').toLowerCase().includes('hls') ? -1 : 1;
            return ah - bh;
        });
        for (const s of sorted_streams) {
            const formats = Array.isArray(s.format) ? s.format : [];
            for (const f of formats) {
                const codecs = Array.isArray(f.codec) ? f.codec : [];
                for (const c of codecs) {
                    const u = compose_from_codec(c);
                    if (u) return u;
                }
            }
        }
        return null;
    }

    function extract_cid_from_play_info_json(play_info_json) {
        const cid = safely_get(play_info_json, j => j.data.playurl_info.playurl.cid)
                 || safely_get(play_info_json, j => j.data.playurl_info.playurl.video_project.cid);
        return Number(cid || 0) || null;
    }

    function compose_url_for_selected_qn_from_play_info(play_info_json, selected_qn) {
        const playurl = safely_get(play_info_json, j => j.data.playurl_info.playurl);
        if (!playurl) return null;
        const streams = Array.isArray(playurl.stream) ? playurl.stream : [];
        const sorted_streams = [...streams].sort((a, b) => {
            const ah = String(a.protocol_name || '').toLowerCase().includes('hls') ? -1 : 1;
            const bh = String(b.protocol_name || '').toLowerCase().includes('hls') ? -1 : 1;
            return ah - bh;
        });
        for (const s of sorted_streams) {
            const formats = Array.isArray(s.format) ? s.format : [];
            for (const f of formats) {
                const codecs = Array.isArray(f.codec) ? f.codec : [];
                const exact = codecs.find(c => Number(c.current_qn) === Number(selected_qn));
                if (exact) {
                    const u = compose_from_codec(exact);
                    if (u) return u;
                }
            }
        }
        for (const s of sorted_streams) {
            const formats = Array.isArray(s.format) ? s.format : [];
            for (const f of formats) {
                const codecs = Array.isArray(f.codec) ? f.codec : [];
                for (const c of codecs) {
                    const u = compose_from_codec(c);
                    if (u) return u;
                }
            }
        }
        return null;
    }

    function collect_available_qn_and_current(play_info_json) {
        const playurl = safely_get(play_info_json, j => j.data.playurl_info.playurl);
        const available_set = new Set();
        let current_max_qn = null;
        const g_desc = safely_get(playurl, p => p.g_qn_desc) || [];
        for (const item of g_desc) {
            const qn = Number(item.qn);
            if (!Number.isNaN(qn)) available_set.add(qn);
        }
        const streams = safely_get(playurl, p => p.stream) || [];
        for (const s of streams) {
            const formats = s && s.format || [];
            for (const f of formats) {
                const codecs = f && f.codec || [];
                for (const c of codecs) {
                    const cur = Number(c.current_qn);
                    if (!Number.isNaN(cur)) {
                        available_set.add(cur);
                        if (current_max_qn === null || cur > current_max_qn) current_max_qn = cur;
                    }
                    const accepts = c.accept_qn || c.acceptQn || [];
                    for (const a of accepts) {
                        const n = Number(a);
                        if (!Number.isNaN(n)) available_set.add(n);
                    }
                }
            }
        }
        if (current_max_qn === null) current_max_qn = 10000;
        const filtered_sorted = Array.from(available_set).filter(q => q <= current_max_qn).sort((a, b) => b - a);
        if (filtered_sorted.length === 0) filtered_sorted.push(current_max_qn);
        return { available_qn_sorted: filtered_sorted, current_max_qn };
    }

    function create_header_controls_node() {
        const wrapper = document.createElement('span');
        const button = document.createElement('button');
        const select = document.createElement('select');
        wrapper.style.display = 'inline-flex';
        wrapper.style.gap = '6px';
        wrapper.style.alignItems = 'center';
        button.id = 'copy-master-url-header-button';
        button.type = 'button';
        button.textContent = '复制直播流URL';
        button.classList.add('live-skin-normal-a-text');
        button.style.width = '8.5em';
        button.style.padding = '1px';
        button.style.background = 'transparent';
        button.style.border = '1.5px solid #999';
        button.style.borderRadius = '4px';
        button.style.color = '#999';
        button.style.filter = 'contrast(0.6)';
        button.style.cursor = 'pointer';
        button.addEventListener('mouseenter', () => { button.style.filter = 'none'; });
        button.addEventListener('mouseleave', () => { button.style.filter = 'contrast(0.6)'; });
        button.addEventListener('mousedown', () => { button.style.transform = 'translate(0.3px, 0.3px)'; });
        button.addEventListener('mouseup', () => { button.style.transform = 'none'; });
        select.id = 'quality-number-selector';
        select.style.height = '22px';
        select.style.border = '1.5px solid #999';
        select.style.borderRadius = '4px';
        select.style.background = 'transparent';
        select.style.color = '#999';
        select.style.filter = 'contrast(0.8)';
        select.classList.add('live-skin-normal-a-text');
        wrapper.appendChild(button);
        wrapper.appendChild(select);
        return { wrapper, button, select };
    }

    function fill_quality_selector(select_node, qn_list, default_qn) {
        select_node.innerHTML = '';
        const unique_sorted = Array.from(new Set(qn_list)).sort((a, b) => b - a);
        for (const qn of unique_sorted) {
            const opt = document.createElement('option');
            const label = QN_LABEL[qn] ? `${QN_LABEL[qn]} (${qn})` : `品质 ${qn}`;
            opt.value = String(qn);
            opt.textContent = label;
            select_node.appendChild(opt);
        }
        const default_index = unique_sorted.findIndex(q => q === default_qn);
        select_node.selectedIndex = default_index >= 0 ? default_index : 0;
    }

    async function mount_button_in_header_area() {
        const right_container =
            await wait_for_element_by_query('#head-info-vm .lower-row .right-ctnr', 180000) ||
            await wait_for_element_by_query('#head-info-vm .lower-row', 10000);
        if (!right_container) return;

        const { wrapper, button, select } = create_header_controls_node();
        right_container.appendChild(wrapper);

        const room_id_number = get_room_id_from_page();
        if (!room_id_number) {
            button.textContent = '未获取房间号';
            return;
        }

        let play_info_json = null;
        try {
            const url = build_play_info_url(room_id_number);
            play_info_json = await gm_get_json(url);
        } catch (e) {
            console.log('[bili-copy] 获取房间播放信息失败', e);
        }

        const { available_qn_sorted, current_max_qn } = collect_available_qn_and_current(play_info_json || {});
        fill_quality_selector(select, available_qn_sorted, current_max_qn);

        const cid = extract_cid_from_play_info_json(play_info_json || {});
        const mid = get_anchor_uid_from_page();

        button.addEventListener('click', async () => {
            const original_text = button.textContent;
            try {
                const selected_qn = Number(select.value || current_max_qn);
                if (cid) {
                    const master_url = build_master_gateway_url(cid, mid, selected_qn);
                    const gw = await gm_fetch_raw(master_url);
                    let result_url = null;
                    if (gw.text.trim().startsWith('{')) {
                        try {
                            const gateway_json = JSON.parse(gw.text);
                            result_url = depth_first_find_value_by_keys(gateway_json, ['master_url', 'm3u8_master_url']);
                            if (result_url) console.log('[bili-copy] 使用JSON返回的master url');
                        } catch (_) {}
                    }
                    if (!result_url) {
                        const looks_like_m3u8 = gw.text.startsWith('#EXTM3U') || /apple\.mpegurl|mpegurl|m3u8/.test(gw.contentType);
                        if (looks_like_m3u8) {
                            result_url = gw.finalUrl;
                            console.log('[bili-copy] 网关直接返回M3U8，使用finalUrl');
                        }
                    }
                    if (!result_url) {
                        result_url = compose_url_for_selected_qn_from_play_info(play_info_json || {}, selected_qn)
                                  || extract_master_url_from_play_info_json(play_info_json || {});
                        if (result_url) console.log('[bili-copy] 使用回退URL');
                    }
                    if (result_url) {
                        GM_setClipboard(result_url, { type: 'text', mimetype: 'text/plain' });
                        button.textContent = '已复制';
                        setTimeout(() => { button.textContent = original_text; }, 1000);
                        return;
                    }
                }
                const fallback_url = compose_url_for_selected_qn_from_play_info(play_info_json || {}, Number(select.value || current_max_qn))
                                  || extract_master_url_from_play_info_json(play_info_json || {});
                if (fallback_url) {
                    GM_setClipboard(fallback_url, { type: 'text', mimetype: 'text/plain' });
                    console.log('[bili-copy] 无cid/网关失败，使用备用URL');
                    button.textContent = '已复制(备用)';
                    setTimeout(() => { button.textContent = original_text; }, 1000);
                } else {
                    button.textContent = '未找到链接';
                    setTimeout(() => { button.textContent = original_text; }, 1200);
                }
            } catch (err) {
                console.log('[bili-copy] 复制失败', err);
                button.textContent = '出错';
                setTimeout(() => { button.textContent = original_text; }, 1200);
            }
        });
    }

    if (/https:\/\/live\.bilibili\.com\/(blanc\/)?\d+/.test(location.href)) {
        mount_button_in_header_area();
    }
})();
