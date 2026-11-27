/**
 * 注入到页面的轻量作用域样式：优先适配 DSH Theme Tokens（`--dsw-alias-*`）并保留暗/亮双色 fallback。
 */
export const CLIENT_STYLES = `
.agy-card {
  display: grid;
  gap: 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, inherit);
}
.agy-muted {
  color: var(--dsw-alias-label-secondary, inherit);
  opacity: 0.82;
}
.agy-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
  padding-bottom: 8px;
}
.agy-tab {
  padding: 5px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.agy-tab[aria-selected="true"] {
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14));
  border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.28));
}
.agy-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 11px;
  min-height: 28px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
  background: transparent;
  color: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.agy-btn:hover:not(:disabled) {
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
}
.agy-btn:disabled { cursor: not-allowed; opacity: .5; }
.agy-btn-primary {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #25b879) 55%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #25b879) 12%, transparent);
}
.agy-btn-danger {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 55%, transparent);
  color: var(--dsw-alias-state-error-primary, #e5534b);
}
.agy-btn-danger[data-confirm="true"] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 16%, transparent);
  font-weight: 600;
}
.agy-chip { padding: 3px 10px; border-radius: 99px; font-size: 11px; min-height: 26px; }
.agy-chip[aria-pressed="false"] { opacity: .45; text-decoration: line-through; }
.agy-notice {
  margin: 0;
  padding: 9px 12px;
  border-radius: 9px;
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  border-left: 3px solid var(--dsw-alias-state-success-primary, #25b879);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #25b879) 10%, transparent);
}
.agy-notice[data-kind="error"] {
  border-left-color: var(--dsw-alias-state-error-primary, #e5534b);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 10%, transparent);
}
.agy-notice[data-kind="busy"] {
  border-left-color: var(--dsw-alias-state-warn-primary, #d99b28);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d99b28) 10%, transparent);
}
.agy-account-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
  border-radius: 10px;
  padding: 12px;
  display: grid;
  gap: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.agy-account-card[data-active="true"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary, #25b879) 55%, transparent);
}
.agy-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 99px;
  font-size: 11px;
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14));
}
.agy-tag-ok {
  color: var(--dsw-alias-state-success-primary, #25b879);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #25b879) 14%, transparent);
}
.agy-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.32));
  background: var(--dsw-alias-bg-base, transparent);
  color: inherit;
  font-size: 12px;
}
.agy-field { display: grid; gap: 4px; }
.agy-field-label { font-size: 12px; font-weight: 600; }
.agy-field-desc { font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); opacity: 0.78; }
.agy-switch-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22));
}
.agy-switch {
  flex: none;
  width: 34px;
  height: 20px;
  border-radius: 99px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.24));
  padding: 2px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition: background 120ms ease;
}
.agy-switch[aria-checked="true"] {
  background: var(--dsw-alias-state-success-primary, #25b879);
  border-color: var(--dsw-alias-state-success-primary, #25b879);
  justify-content: flex-end;
}
.agy-switch:disabled { opacity: .5; cursor: not-allowed; }
.agy-switch-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-base, #ffffff);
}
.agy-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  min-height: 26px;
  box-sizing: border-box;
  border-radius: 99px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
  background: transparent;
  color: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  max-width: min(52vw, 260px);
  cursor: pointer;
}
.agy-pill:hover {
  background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12));
}
.agy-pill[data-tone="warn"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d99b28) 50%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d99b28) 12%, transparent);
}
.agy-pill[data-tone="error"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 50%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 12%, transparent);
}
.agy-popover {
  position: fixed;
  z-index: 10000;
  width: min(320px, calc(100vw - 24px));
  max-height: min(70vh, 420px);
  overflow-y: auto;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3));
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #1e1f24));
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: 0 10px 28px rgba(0, 0, 0, .28);
  display: grid;
  gap: 10px;
  font-size: 12px;
  line-height: 1.5;
}
.agy-card button:focus-visible, .agy-card a:focus-visible, .agy-pill:focus-visible, .agy-popover button:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4a90e2);
  outline-offset: 2px;
}
`
