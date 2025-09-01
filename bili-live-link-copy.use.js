// ==UserScript==
// @name         Bilibili Live Master URL Copier (Header Placement)
// @namespace    https://space.bilibili.com/521676
// @version      1.1.0
// @description  Adds a header-area button (same location as the reference script) to copy the HLS master_url of a Bilibili live stream to clipboard
// @author       you
// @match        https://live.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @license      MIT
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      api.live.bilibili.com
// ==/UserScript==

(function () {
    'use strict';

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

    function get_room_id_from_page() {
        const neptune = unsafeWindow.__NEPTUNE_IS_MY_WAIFU__;
        const possible_id = neptune && neptune.roomInitRes && neptune.roomInitRes.data && neptune.roomInitRes.data.room_id;
        if (possible_id) return Number(possible_id);
        const match = location.pathname.match(/\/(\d+)/);
        return Number(match && match[1]);
    }

    function build_play_info_url(room_id_number) {
        return `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${room_id_number}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&dolby=5&panorama=1`;
    }

    function gm_get_json(url_string) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url_string,
                headers: { 'Accept': 'application/json' },
                onload: function (response) {
                    resolve(JSON.parse(response.responseText));
                }
            });
        });
    }

    function depth_first_find_master_url(any_object) {
        const stack = [any_object];
        while (stack.length) {
            const current = stack.pop();
            if (!current) continue;
            if (typeof current === 'object') {
                for (const key of Object.keys(current)) {
                    const value = current[key];
                    if (key === 'master_url' && typeof value === 'string' && value.startsWith('http')) {
                        return value;
                    }
                    if (value && typeof value === 'object') stack.push(value);
                }
            }
        }
        return null;
    }

    function try_compose_hls_master_from_parts(playurl_object) {
        const streams = playurl_object && playurl_object.stream;
        if (!Array.isArray(streams)) return null;

        const hls_stream = streams.find(s => String(s.protocol_name).toLowerCase().includes('hls')) || streams[0];
        if (!hls_stream) return null;

        const first_format = Array.isArray(hls_stream.format) ? hls_stream.format[0] : null;
        const first_codec = first_format && Array.isArray(first_format.codec) ? first_format.codec[0] : null;
        if (!first_codec) return null;

        const url_info = Array.isArray(first_codec.url_info) ? first_codec.url_info[0] : null;
        const host = url_info && url_info.host;
        const base_url = first_codec.base_url;
        const extra = url_info && url_info.extra;

        if (typeof host === 'string' && typeof base_url === 'string' && typeof extra === 'string') {
            return `${host}${base_url}${extra}`;
        }
        return null;
    }

    function extract_master_url_from_play_info_json(play_info_json) {
        const playurl_object =
            play_info_json &&
            play_info_json.data &&
            play_info_json.data.playurl_info &&
            play_info_json.data.playurl_info.playurl;

        if (!playurl_object) return null;

        const by_key = depth_first_find_master_url(playurl_object);
        if (by_key) return by_key;

        return try_compose_hls_master_from_parts(playurl_object);
    }

    function create_header_button_node() {
        const wrapper = document.createElement('span');
        const button = document.createElement('button');

        wrapper.style.display = 'inline-block';
        button.id = 'copy-master-url-header-button';
        button.type = 'button';
        button.textContent = '复制 Master URL';
        button.classList.add('live-skin-normal-a-text');

        // mimic reference project styles for header controls
        button.style.width = '7.5em';
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

        wrapper.appendChild(button);
        return { wrapper, button };
    }

    async function mount_button_in_header_area() {
        // Same anchor area that the reference script uses
        // Prefer the right container inside the lower row of #head-info-vm
        const right_container =
            await wait_for_element_by_query('#head-info-vm .lower-row .right-ctnr', 180000) ||
            await wait_for_element_by_query('#head-info-vm .lower-row', 10000);

        if (!right_container) return;

        const { wrapper, button } = create_header_button_node();
        right_container.appendChild(wrapper);

        button.addEventListener('click', async () => {
            const room_id_number = get_room_id_from_page();
            const api_url_string = build_play_info_url(room_id_number);
            const play_info_json = await gm_get_json(api_url_string);
            const master_url_string = extract_master_url_from_play_info_json(play_info_json);

            GM_setClipboard(master_url_string, { type: 'text', mimetype: 'text/plain' });

            const original_text = button.textContent;
            button.textContent = '已复制';
            setTimeout(() => { button.textContent = original_text; }, 1000);
        });
    }

    if (/https:\/\/live\.bilibili\.com\/(blanc\/)?\d+/.test(location.href)) {
        mount_button_in_header_area();
    }
})();
