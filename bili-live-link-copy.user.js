// ==UserScript==
// @name                 Bilibili Live URL Copy
// @name:zh-CN           Bilibili 直播流链接复制器
// @namespace            https://github.com/TZFC
// @version              1.0
// @description          Show all (quality × stream type) options from live playurl (HLS-TS, HLS-fMP4, FLV). Defaults to the lowest-quality m3u8. Dark-mode aware. Pink→blue button.
// @description:zh-CN    从直播播放信息列出所有清晰度与流类型（HLS-TS、HLS-fMP4、FLV），默认选择最低清晰度的m3u8。深色模式与粉蓝按钮。
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

  const qn_label_map = {
    30000: '杜比', 25000: '默认', 20000: '4K', 15000: '2K',
    10000: '原画', 400: '蓝光', 250: '超清', 150: '高清', 80: '流畅'
  };

  const format_priority = { ts: 1, fmp4: 2, flv: 3 }; // for sorting and default pick
  const is_hls = (fmt) => fmt === 'ts' || fmt === 'fmp4';

  function wait_for_element(query_selector, timeout_ms) {
    const start = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const node = document.querySelector(query_selector);
        if (node) { clearInterval(timer); resolve(node); return; }
        if (Date.now() - start > timeout_ms) { clearInterval(timer); resolve(null); }
      }, 150);
    });
  }

  function safe_get(getter) { try { return getter(); } catch { return undefined; } }

  function get_room_id() {
    const neptune = unsafeWindow.__NEPTUNE_IS_MY_WAIFU__;
    const by_neptune = safe_get(() => neptune.roomInitRes.data.room_id);
    if (by_neptune) return Number(by_neptune);
    const m = location.pathname.match(/\/(\d+)/);
    return m ? Number(m[1]) : null;
  }

  function build_play_info_url(room_id_number) {
    return `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo` +
           `?room_id=${room_id_number}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&dolby=5&panorama=1`;
  }

  function gm_get_json(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, headers: { 'Accept': 'application/json' },
        onload: (res) => { try { resolve(JSON.parse(res.responseText)); } catch (e) { reject(e); } },
        onerror: reject
      });
    });
  }

  function build_url_with_qn(codec_obj, target_qn) {
    const info = Array.isArray(codec_obj.url_info) ? codec_obj.url_info[0] : null;
    const host = info && info.host;
    const base = codec_obj.base_url;
    let extra = info && info.extra;
    if (!host || !base || !extra) return null;

    extra = extra.replace(/([?&])qn=\d+/i, `$1qn=${target_qn}`);
    if (!/[?&]qn=\d+/i.test(extra)) extra += `&qn=${target_qn}`;
    extra = extra.replace(/([?&])expected_qn=\d+/i, `$1expected_qn=${target_qn}`);
    if (!/[?&]expected_qn=\d+/i.test(extra)) extra += `&expected_qn=${target_qn}`;

    return host + base + extra;
  }

  function inject_styles() {
    const style = document.createElement('style');
    style.textContent = `
      .blmuc_wrap { display:inline-flex; gap:8px; align-items:center; }
      .blmuc_btn {
        padding: 4px 10px; border: none; border-radius: 8px; font-weight: 600; cursor: pointer;
        background-image: linear-gradient(135deg, #ff7ac6 0%, #8aa8ff 100%); color: #111;
        box-shadow: 0 2px 8px rgba(0,0,0,.15); transition: transform .08s ease, filter .15s ease;
      }
      .blmuc_btn:hover { filter: brightness(1.05); }
      .blmuc_btn:active { transform: translateY(1px); }
      .blmuc_sel {
        height: 26px; border-radius: 6px; padding: 0 8px;
        border: 1px solid var(--blmuc-border, #bbb);
        background: var(--blmuc-bg, #fff); color: var(--blmuc-fg, #222);
      }
      @media (prefers-color-scheme: dark) {
        .blmuc_btn { color: #000; }
        .blmuc_sel { --blmuc-bg: #1f1f1f; --blmuc-fg: #eaeaea; --blmuc-border: #444; }
      }
    `;
    document.head.appendChild(style);
  }

  function create_controls() {
    const wrap = document.createElement('span');
    wrap.className = 'blmuc_wrap';

    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'blmuc_btn'; btn.textContent = '复制直播流 URL';

    const sel = document.createElement('select');
    sel.className = 'blmuc_sel'; sel.id = 'blmuc_quality_select';

    wrap.appendChild(btn); wrap.appendChild(sel);
    return { wrap, btn, sel };
  }

  function scan_all_entries(play_info_json) {
    const playurl = safe_get(() => play_info_json.data.playurl_info.playurl) || {};
    const streams = Array.isArray(playurl.stream) ? playurl.stream : [];

    /** Dedup by key `${qn}|${fmt}` but keep one URL; we still present all fmts for each qn */
    const entry_map = new Map(); // key -> { qn, fmt, protocol, url }

    for (const stream of streams) {
      const protocol = String(stream.protocol_name || '').toLowerCase(); // http_hls | http_stream
      const formats = Array.isArray(stream.format) ? stream.format : [];
      for (const fmt of formats) {
        const fmt_name = String(fmt.format_name || '').toLowerCase();   // ts | fmp4 | flv
        const codecs = Array.isArray(fmt.codec) ? fmt.codec : [];
        for (const codec of codecs) {
          const current_qn = Number(codec.current_qn);
          const accept_qn = Array.isArray(codec.accept_qn || codec.acceptQn) ? (codec.accept_qn || codec.acceptQn) : [];
          const qn_candidates = [current_qn, ...accept_qn].filter((n, i, arr) => Number.isFinite(n) && arr.indexOf(n) === i);

          for (const qn of qn_candidates) {
            const url = build_url_with_qn(codec, qn);
            if (!url) continue;
            const key = `${qn}|${fmt_name}`;
            if (!entry_map.has(key)) entry_map.set(key, { qn, fmt: fmt_name, protocol, url });
          }
        }
      }
    }

    // To present: sort by qn asc, then fmt priority (ts < fmp4 < flv)
    const entries = Array.from(entry_map.values()).sort((a, b) => {
      if (a.qn !== b.qn) return a.qn - b.qn;
      return (format_priority[a.fmt] ?? 99) - (format_priority[b.fmt] ?? 99);
    });

    return entries;
  }

  function fill_select_with_entries(select_node, entries) {
    select_node.innerHTML = '';
    for (const e of entries) {
      const quality = qn_label_map[e.qn] ? `${qn_label_map[e.qn]} (${e.qn})` : `品质 ${e.qn}`;
      const tag = e.fmt === 'flv' ? 'FLV' : (e.fmt === 'ts' ? 'HLS-TS' : 'HLS-fMP4');
      const opt = document.createElement('option');
      opt.value = e.url; // store URL directly
      opt.textContent = `${quality} · ${tag}`;
      opt.setAttribute('data-qn', String(e.qn));
      opt.setAttribute('data-fmt', e.fmt);
      opt.setAttribute('data-protocol', e.protocol);
      select_node.appendChild(opt);
    }

    // Default: lowest-quality m3u8 (HLS-TS first, then HLS-fMP4), otherwise lowest overall
    const options = Array.from(select_node.options);
    let default_index = options.findIndex(o => o.getAttribute('data-protocol') === 'http_hls' && o.getAttribute('data-fmt') === 'ts');
    if (default_index < 0) default_index = options.findIndex(o => o.getAttribute('data-protocol') === 'http_hls'); // fmp4 ok
    select_node.selectedIndex = default_index >= 0 ? default_index : 0;
  }

  async function main() {
    if (!/https:\/\/live\.bilibili\.com\/(blanc\/)?\d+/.test(location.href)) return;

    inject_styles();

    const container =
      await wait_for_element('#head-info-vm .lower-row .right-ctnr', 180000) ||
      await wait_for_element('#head-info-vm .lower-row', 10000);
    if (!container) return;

    const { wrap, btn, sel } = create_controls();
    container.appendChild(wrap);

    const room_id = get_room_id();
    if (!room_id) { btn.textContent = '未获取房间号'; return; }

    let play_info_json;
    try { play_info_json = await gm_get_json(build_play_info_url(room_id)); }
    catch { btn.textContent = '加载失败'; return; }

    const entries = scan_all_entries(play_info_json);
    if (entries.length === 0) { btn.textContent = '无可用清晰度'; return; }

    fill_select_with_entries(sel, entries);

    btn.addEventListener('click', () => {
      const url = sel.value;
      if (!url) {
        btn.textContent = '未找到链接';
        setTimeout(() => (btn.textContent = '复制直播流 URL'), 1200);
        return;
      }
      GM_setClipboard(url, { type: 'text', mimetype: 'text/plain' });
      const original = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => (btn.textContent = original), 1000);
    });
  }

  main();
})();
