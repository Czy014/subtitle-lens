/**
 * 字幕透镜 (Subtitle Lens) — content script
 *
 * 结构（见 GLOSSARY.md 领域词汇）：
 *   Host   —— 播放器容器发现 + 挂载 + 保活（容器/z-index/SPA/全屏/代际令牌）
 *   Lens   —— 透镜 DOM + 几何（拖拽/缩放/百分比渲染/clamp）
 *   fx     —— 效果引擎（SVG 滤镜生命周期 + 效果链数据驱动）
 *   main   —— 设置装载 + 消息路由 + 启动
 *
 * 冻结决策：透镜几何只存内存，绝不持久化；默认隐藏，由 popup 开启。
 */
(function () {
  'use strict';
  const SBM = window.SBM;

  // ===== 站点适配常量（站点改版失效时，优先更新这里）=====
  const CONTAINER_SELECTORS = [
    '#movie_player',          // YouTube (www / m)
    '.bpx-player-container',  // Bilibili
    '#bilibili-player',       // Bilibili fallback
  ];
  const CONTROL_SELECTORS = [
    '.ytp-chrome-bottom',       // YouTube 控制条
    '.bpx-player-control-wrap', // Bilibili 控制条
  ];
  const DEFAULT_GEOMETRY = { x: 0.30, y: 0.84, w: 0.40, h: 0.07 }; // 容器百分比
  const MIN_SIZE_PX = 32;
  const LENS_Z_INDEX = 10; // 兜底；实际取「控制条 z-index − 1」
  const KEEPALIVE_MS = 1500;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ===== 模块间共享的运行时状态（全部内存态）=====
  const state = {
    geometry: { ...DEFAULT_GEOMETRY },
    settings: { ...SBM.DEFAULT_SETTINGS },
    visible: false, // 默认隐藏；不持久化
    host: null,     // 当前容器元素
  };

  // ============================================================
  // Host：容器发现 + 挂载 + 保活
  // 接口：ensure() / teardown() / current()
  // ============================================================
  const Host = (() => {
    let layer = null; // sbm-layer（absolute inset:0，包住透镜）

    function find() {
      for (const sel of CONTAINER_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      const video = document.querySelector('video');
      if (!video) return null;
      return video.closest('[class*="player" i]') || video.parentElement;
    }

    /** 控制条 z-index − 1：压过弹幕/渐变等内容层，仍让控制条可点 */
    function layerZIndex(container) {
      let z = LENS_Z_INDEX;
      for (const sel of CONTROL_SELECTORS) {
        const el = container.querySelector(sel);
        if (!el) continue;
        let node = el;
        while (node && node.parentElement && node.parentElement !== container) {
          node = node.parentElement;
        }
        if (!node || node === container) continue;
        const cz = parseInt(getComputedStyle(node).zIndex, 10);
        if (Number.isFinite(cz) && cz - 1 > z) z = cz - 1;
      }
      return z;
    }

    function ensurePositioned(el) {
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
    }

    function removeStrays(except) {
      for (const stray of document.querySelectorAll('.sbm-layer')) {
        if (stray !== except) stray.remove();
      }
    }

    /** 挂载/保活：容器变化时原地复用 layer（防闪烁），不拆事件 */
    function ensure() {
      const target = find();
      if (!target) return false;
      if (layer && layer.isConnected && state.host === target) return true;
      if (layer) {
        // 容器换了：同一元素换父级，监听/几何都保留
        removeStrays(layer);
        state.host = target;
        ensurePositioned(target);
        target.appendChild(layer);
        layer.style.zIndex = String(layerZIndex(target));
        return true;
      }
      removeStrays(null);
      state.host = target;
      ensurePositioned(target);
      layer = Lens.build(target);
      layer.style.zIndex = String(layerZIndex(target));
      return true;
    }

    function teardown() {
      // 只拆自己的层：新实例的层不能碰（双实例交替窗口期）
      if (layer && layer.isConnected) layer.remove();
      layer = null;
      state.host = null;
    }

    return { ensure, teardown, current: () => (layer && layer.isConnected ? state.host : null) };
  })();

  // ============================================================
  // Lens：透镜 DOM + 几何交互
  // 接口：build(container) / apply(lens) / setVisible(lens, v)
  // 几何用容器百分比渲染 → 窗口缩放/全屏自适应；clamp 保证不出界
  // ============================================================
  const Lens = (() => {
    const SWALLOW_EVENTS = [
      'pointerdown', 'pointerup', 'pointercancel',
      'mousedown', 'mouseup', 'click', 'dblclick',
      'contextmenu', 'touchstart', 'touchmove', 'touchend',
    ];

    function injectStyles() {
      if (document.querySelector('style[data-sbm]')) return;
      const style = document.createElement('style');
      style.dataset.sbm = '1';
      style.textContent = `
.sbm-layer { position: absolute; inset: 0; pointer-events: none; }
.sbm-lens {
  position: absolute;
  border-radius: 8px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.06);
  cursor: move;
  touch-action: none;
  pointer-events: auto;
}
.sbm-grip {
  position: absolute; right: 0; bottom: 0;
  width: 20px; height: 20px;
  cursor: nwse-resize;
  touch-action: none;
  opacity: .6;
  transition: opacity .15s;
}
.sbm-lens:hover .sbm-grip { opacity: 1; }
.sbm-grip::after {
  content: ''; position: absolute; right: 4px; bottom: 4px;
  width: 12px; height: 12px; border-radius: 3px;
  background: repeating-linear-gradient(-45deg,
    transparent 0 3px, rgba(255,255,255,.55) 3px 5px);
  box-shadow: 0 0 0 1px rgba(0,0,0,.35);
}
`;
      document.documentElement.appendChild(style);
    }

    /** 容器像素坐标 → clamp 后的百分比几何 */
    function moveGeometry(start, rect, dx, dy) {
      return {
        ...state.geometry,
        x: SBM.clamp(start.x + dx / rect.width, 0, 1 - start.w),
        y: SBM.clamp(start.y + dy / rect.height, 0, 1 - start.h),
      };
    }

    function resizeGeometry(start, rect, dx, dy) {
      return {
        ...state.geometry,
        w: SBM.clamp(start.w + dx / rect.width, MIN_SIZE_PX / rect.width, 1 - start.x),
        h: SBM.clamp(start.h + dy / rect.height, MIN_SIZE_PX / rect.height, 1 - start.y),
      };
    }

    function render(lens) {
      const g = state.geometry;
      lens.style.left = `${g.x * 100}%`;
      lens.style.top = `${g.y * 100}%`;
      lens.style.width = `${g.w * 100}%`;
      lens.style.height = `${g.h * 100}%`;
    }

    function bindDrag(lens) {
      const grip = lens.querySelector('.sbm-grip');

      for (const type of SWALLOW_EVENTS) {
        lens.addEventListener(type, (e) => e.stopPropagation()); // 防误触播放器
      }

      lens.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        // 事件时解析容器：SPA 重挂载后闭包里的旧容器已失效
        const container = state.host;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const resize = e.target === grip || grip.contains(e.target);
        const start = { px: e.clientX, py: e.clientY, ...state.geometry };

        e.preventDefault();
        try { lens.setPointerCapture(e.pointerId); } catch { /* 退化普通监听 */ }

        const onMove = (ev) => {
          const dx = ev.clientX - start.px;
          const dy = ev.clientY - start.py;
          state.geometry = resize
            ? resizeGeometry(start, rect, dx, dy)
            : moveGeometry(start, rect, dx, dy);
          render(lens);
        };
        const onUp = () => {
          lens.removeEventListener('pointermove', onMove);
          lens.removeEventListener('pointerup', onUp);
          lens.removeEventListener('pointercancel', onUp);
        };
        lens.addEventListener('pointermove', onMove);
        lens.addEventListener('pointerup', onUp);
        lens.addEventListener('pointercancel', onUp);
      });
    }

    function applyVisibility(lens) {
      lens.style.display = state.visible ? '' : 'none';
    }

    function build(container) {
      injectStyles();
      const layer = document.createElement('div');
      layer.className = 'sbm-layer';
      const lens = document.createElement('div');
      lens.className = 'sbm-lens';
      const grip = document.createElement('div');
      grip.className = 'sbm-grip';
      lens.appendChild(grip);
      layer.appendChild(lens);
      container.appendChild(layer);
      bindDrag(lens);
      render(lens);
      fx.apply(lens, state.settings);
      applyVisibility(lens);
      return layer;
    }

    return { build, setVisible: applyVisibility };
  })();

  // ============================================================
  // fx：效果引擎（SVG 滤镜生命周期）
  // 接口：apply(lens, settings)
  // 效果链数据驱动：结构改数据，不动构建代码
  // ============================================================
  const fx = (() => {
    const BLUR_BG = 'rgba(0,0,0,0.25)'; // 蒙层宜淡，背景要透出来

    // 形态学开运算链：腐蚀(吃白笔画)→膨胀(吃黑描边残线)→微模糊(抹边界)
    const CHAIN = [
      { op: 'erode', from: 'SourceGraphic' },
      { op: 'dilate' },
      { blur: 1 },
    ];

    let svgHost = null;
    let chainNodes = []; // 与 CHAIN 对应的 DOM 节点（半径可更新）

    function ensureSvg() {
      if (svgHost && svgHost.isConnected) return;
      svgHost = document.createElementNS(SVG_NS, 'svg');
      svgHost.setAttribute('width', '0');
      svgHost.setAttribute('height', '0');
      svgHost.setAttribute('aria-hidden', 'true');
      svgHost.style.position = 'absolute';

      const filter = document.createElementNS(SVG_NS, 'filter');
      filter.setAttribute('id', SBM.FILTER_ID);
      filter.setAttribute('x', '0%');
      filter.setAttribute('y', '0%');
      filter.setAttribute('width', '100%');
      filter.setAttribute('height', '100%');
      filter.setAttribute('color-interpolation-filters', 'sRGB');

      chainNodes = [];
      let prev = null;
      CHAIN.forEach((step, i) => {
        if (step.op) {
          const node = document.createElementNS(SVG_NS, 'feMorphology');
          node.setAttribute('operator', step.op);
          node.setAttribute('in', step.from || prev);
          node.setAttribute('radius', '3');
          node.setAttribute('result', `s${i}`);
          filter.appendChild(node);
          chainNodes.push(node);
          prev = `s${i}`;
        } else if (step.blur != null) {
          const node = document.createElementNS(SVG_NS, 'feGaussianBlur');
          node.setAttribute('in', prev);
          node.setAttribute('stdDeviation', String(step.blur));
          filter.appendChild(node);
          chainNodes.push(node);
          prev = `s${i}`;
        }
      });

      svgHost.appendChild(filter);
      document.documentElement.appendChild(svgHost);
    }

    function apply(lens, settings) {
      const mode = SBM.effectiveMode(settings.mode);
      if (mode === 'morph') {
        ensureSvg();
        const r = SBM.morphRadius(settings.strength);
        for (const node of chainNodes) {
          if (node.tagName.toLowerCase() === 'femorphology') {
            node.setAttribute('radius', String(r));
          }
        }
        lens.style.background = 'transparent';
        lens.style.backdropFilter = `url(#${SBM.FILTER_ID})`;
        lens.style.webkitBackdropFilter = `url(#${SBM.FILTER_ID})`;
      } else {
        // 强度 0 = 完全无滤镜；>0 才挂 blur
        lens.style.background = settings.strength > 0 ? BLUR_BG : 'transparent';
        lens.style.backdropFilter = settings.strength > 0 ? `blur(${settings.strength}px)` : '';
        lens.style.webkitBackdropFilter = lens.style.backdropFilter;
      }
    }

    return { apply };
  })();

  // ============================================================
  // main：设置装载 + 消息路由 + 保活 + 启动
  // ============================================================
  function withLens(fn) {
    const host = Host.current();
    const lens = host && host.querySelector(':scope > .sbm-layer > .sbm-lens');
    if (lens) fn(lens);
    return !!lens;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case SBM.MSG.PING:
        Host.ensure();
        sendResponse({
          ok: true,
          mounted: !!Host.current(),
          visible: state.visible,
          morphSupported: SBM.morphSupported,
        });
        break;
      case SBM.MSG.TOGGLE:
        state.visible = !!msg.visible;
        withLens((lens) => Lens.setVisible(lens));
        sendResponse({ ok: true, mounted: !!Host.current() });
        break;
      case SBM.MSG.SETTINGS:
        if (msg.settings) {
          state.settings = SBM.normalizeSettings(msg.settings);
          withLens((lens) => fx.apply(lens, state.settings));
        }
        sendResponse({ ok: true, mounted: !!Host.current() });
        break;
    }
  });

  // 代际令牌：popup 补注入/扩展重载导致双实例时，旧实例自动退出
  const GEN = Math.random().toString(36).slice(2);
  window.__SBM_GEN__ = GEN;
  const superseded = () => window.__SBM_GEN__ !== GEN;

  const timer = setInterval(() => {
    if (superseded()) {
      clearInterval(timer);
      Host.teardown();
      return;
    }
    Host.ensure(); // find() 为空时内部静默跳过
  }, KEEPALIVE_MS);

  const onFullscreenChange = () => {
    if (superseded()) {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      return;
    }
    Host.ensure();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  (async () => {
    try {
      const data = await chrome.storage.local.get(SBM.SETTINGS_KEY);
      state.settings = SBM.normalizeSettings(data && data[SBM.SETTINGS_KEY]);
    } catch { /* storage 不可用时用默认设置 */ }
    Host.ensure(); // 默认隐藏，等 popup 开启
  })();
})();
