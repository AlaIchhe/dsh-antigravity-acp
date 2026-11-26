/** 注入到页面的轻量作用域样式，取代原 1,048 行单文件里的重复 inline style。 */
export const CLIENT_STYLES = `
.agy-card { display: grid; gap: 14px; font-size: 13px; line-height: 1.5; }
.agy-tabs { display: flex; gap: 6px; border-bottom: 1px solid rgba(128,128,128,.2); padding-bottom: 8px; }
.agy-tab { padding: 5px 12px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; font-size: 12px; font-weight: 600; }
.agy-tab[aria-selected="true"] { background: rgba(128,128,128,.14); border-color: rgba(128,128,128,.28); }
.agy-btn { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; min-height: 28px; border-radius: 8px; border: 1px solid rgba(128,128,128,.3); background: transparent; color: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
.agy-btn:hover:not(:disabled) { background: rgba(128,128,128,.12); }
.agy-btn:disabled { cursor: not-allowed; opacity: .5; }
.agy-btn-primary { border-color: rgba(37,184,121,.55); background: rgba(37,184,121,.12); }
.agy-btn-danger { border-color: rgba(229,83,75,.5); color: #e5534b; }
.agy-chip { padding: 3px 10px; border-radius: 99px; font-size: 11px; min-height: 26px; }
.agy-chip[aria-pressed="false"] { opacity: .45; text-decoration: line-through; }
.agy-notice { margin: 0; padding: 9px 12px; border-radius: 9px; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; border-left: 3px solid #25b879; background: rgba(37,184,121,.10); }
.agy-notice[data-kind="error"] { border-left-color: #e5534b; background: rgba(229,83,75,.10); }
.agy-notice[data-kind="busy"] { border-left-color: #d99b28; background: rgba(217,155,40,.10); }
.agy-account-card { border: 1px solid rgba(128,128,128,.22); border-radius: 10px; padding: 12px; display: grid; gap: 10px; }
.agy-account-card[data-active="true"] { border-color: rgba(37,184,121,.55); }
.agy-tag { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 99px; font-size: 11px; background: rgba(128,128,128,.14); }
.agy-tag-ok { color: #25b879; background: rgba(37,184,121,.14); }
.agy-input { width: 100%; box-sizing: border-box; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(128,128,128,.32); background: transparent; color: inherit; font-size: 12px; }
.agy-pill { display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; min-height: 26px; box-sizing: border-box; border-radius: 99px; border: 1px solid rgba(128,128,128,.3); background: transparent; color: inherit; font-size: 12px; font-weight: 600; white-space: nowrap; max-width: min(52vw, 260px); }
.agy-card button:focus-visible, .agy-card a:focus-visible, .agy-pill:focus-visible { outline: 2px solid #4a90e2; outline-offset: 2px; }
`
