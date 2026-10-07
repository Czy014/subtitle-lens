/**
 * 字幕透镜 — popup 控制台
 * 控件：显示透镜（默认关）· 遮挡模式 · 强度滑杆。
 * 设置仅持久化 mode+strength（shared.js 单一事实源）；透镜位置绝不持久化。
 */
(() => {
  'use strict';
  const SBM = window.SBM;

  let settings = { ...SBM.DEFAULT_SETTINGS };
  let visible = false; // 与 content 的默认隐藏一致

  const $ = (id) => document.getElementById(id);

  init();

  async function init() {
    try {
      const data = await chrome.storage.local.get(SBM.SETTINGS_KEY);
      settings = SBM.normalizeSettings(data && data[SBM.SETTINGS_KEY]);
    } catch { /* 读失败用默认值 */ }

    const probe = await probeTab();
    visible = typeof probe.visible === 'boolean' ? probe.visible : false;
    showStatus(probe);

    renderControls();
    bind();
  }

  /**
   * 探测当前标签页：已注入则取状态；没注入且是支持站点则现场补注入
   * （扩展重载/标签页先于扩展打开的场景）。返回驱动 UI 的完整状态。
   */
  async function probeTab() {
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch { /* 无标签页权限 */ }
    if (!tab || tab.id == null) {
      return { reason: 'no-tab' };
    }

    // 已注入：直接取状态
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: SBM.MSG.PING });
      if (res) {
        return {
          mounted: !!res.mounted,
          visible: res.visible,
          reason: res.mounted ? null : 'no-player',
        };
      }
    } catch { /* 未注入，走补注入 */ }

    // 补注入：仅支持站点
    if (!SBM.isSupportedUrl(tab.url || tab.pendingUrl || '')) {
      return { reason: 'off-site' };
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'content.js'] });
      const res = await chrome.tabs.sendMessage(tab.id, { type: SBM.MSG.PING });
      return {
        mounted: !!(res && res.mounted),
        visible: res && res.visible,
        reason: res && res.mounted ? null : 'no-player',
      };
    } catch {
      return { reason: 'inject-failed' };
    }
  }

  function showStatus(probe) {
    const el = $('status');
    if (probe && probe.mounted) return;
    const texts = {
      'no-player': '页面没播放器：打开一个视频页试试',
      'off-site': '仅在 YouTube / Bilibili 页面可用',
      'inject-failed': '注入失败：刷新页面后再试',
      'no-tab': '仅在 YouTube / Bilibili 页面可用',
    };
    el.textContent = texts[probe ? probe.reason : 'off-site'] || '此页面没有检测到视频播放器';
    el.classList.remove('hidden');
  }

  function renderControls() {
    $('visible').checked = visible;
    $('strength').value = settings.strength;
    updateStrengthLabel();

    const radio = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
    if (radio) radio.checked = true;

    if (!SBM.morphSupported) {
      const morphRadio = document.querySelector('input[name="mode"][value="morph"]');
      if (morphRadio) morphRadio.disabled = true;
      $('morph-unsupported').classList.remove('hidden');
    }
  }

  function updateStrengthLabel() {
    const v = settings.strength;
    if (SBM.effectiveMode(settings.mode) === 'morph') {
      $('strength-label').textContent = '擦除半径';
      $('strength-value').textContent = `半径 ${SBM.morphRadius(v)} px`;
    } else {
      $('strength-label').textContent = '模糊强度';
      $('strength-value').textContent = `${v} px`;
    }
  }

  function bind() {
    $('visible').addEventListener('change', (e) => {
      visible = e.target.checked;
      sendToTab({ type: SBM.MSG.TOGGLE, visible });
    });

    $('strength').addEventListener('input', (e) => {
      settings = SBM.normalizeSettings({ ...settings, strength: Number(e.target.value) });
      updateStrengthLabel();
      pushSettings();
    });

    for (const radio of document.querySelectorAll('input[name="mode"]')) {
      radio.addEventListener('change', (e) => {
        if (!e.target.checked) return;
        settings = SBM.normalizeSettings({ ...settings, mode: e.target.value });
        updateStrengthLabel();
        pushSettings();
      });
    }
  }

  function pushSettings() {
    chrome.storage.local.set({ [SBM.SETTINGS_KEY]: settings });
    sendToTab({ type: SBM.MSG.SETTINGS, settings: { ...settings } });
  }

  async function sendToTab(msg) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) await chrome.tabs.sendMessage(tab.id, msg);
    } catch { /* 页面无 content script 时静默 */ }
  }
})();
