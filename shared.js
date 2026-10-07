/**
 * 字幕透镜 — 共享模块（popup 与 content 的单一事实源）
 * 非构建链项目：用全局对象 SBM 共享，两侧通过 <script>/manifest 引入。
 * 领域词汇见 GLOSSARY.md：设置(Settings)、模式(Mode)、强度(Strength)、透镜(Lens)。
 */
(function (global) {
  'use strict';

  /** 持久化键。只允许存 {mode, strength}——透镜几何绝不持久化（冻结决策） */
  const SETTINGS_KEY = 'sbm:settings';

  /** 默认设置：模糊档、强度 16 */
  const DEFAULT_SETTINGS = { mode: 'blur', strength: 16 };

  /** 遮挡模式：'blur' 毛玻璃 | 'morph' 形态学开运算 */
  const MODES = ['blur', 'morph'];

  /** 形态学滤镜 id（backdrop-filter: url(#…) 引用） */
  const FILTER_ID = 'sbm-opening';

  /** popup ↔ content 消息类型 */
  const MSG = {
    PING: 'SBM_PING',
    TOGGLE: 'SBM_TOGGLE',
    SETTINGS: 'SBM_SETTINGS',
  };

  /** 支持的站点域名后缀（popup 补注入前的白名单，与 manifest matches 对应） */
  const SUPPORTED_HOSTS = [/(\.|^)youtube\.com$/i, /(\.|^)bilibili\.com$/i];

  /** 当前引擎是否支持 backdrop-filter: url(#svg)（Firefox/Safari 不支持） */
  const morphSupported =
    typeof CSS !== 'undefined' &&
    CSS.supports('backdrop-filter', `url(#${FILTER_ID})`);

  /** 强度(0–30) → 形态学半径 px，默认 16 → 3 */
  function morphRadius(strength) {
    return Math.max(1, Math.round(Number(strength) / 5));
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /**
   * 把任意输入（storage 旧值/消息载荷）规范化为合法设置。
   * 含模式回退：环境不支持 morph 时强制 blur。
   */
  function normalizeSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const mode = MODES.includes(src.mode) ? src.mode : DEFAULT_SETTINGS.mode;
    const strength = clamp(
      Number.isFinite(src.strength) ? Number(src.strength) : DEFAULT_SETTINGS.strength,
      0, 30
    );
    return { mode: effectiveMode(mode), strength };
  }

  /** 生效模式：不支持 morph 的环境回退 blur */
  function effectiveMode(mode) {
    return mode === 'morph' && morphSupported ? 'morph' : 'blur';
  }

  /** URL → 是否支持站点（非法 URL 返回 false） */
  function isSupportedUrl(url) {
    try {
      const h = new URL(url).hostname;
      return SUPPORTED_HOSTS.some((re) => re.test(h));
    } catch {
      return false;
    }
  }

  global.SBM = {
    SETTINGS_KEY,
    DEFAULT_SETTINGS,
    MODES,
    FILTER_ID,
    MSG,
    morphSupported,
    morphRadius,
    normalizeSettings,
    effectiveMode,
    isSupportedUrl,
  };
})(typeof window !== 'undefined' ? window : globalThis);
