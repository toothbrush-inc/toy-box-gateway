// The card design system: one stylesheet every view inherits. Tokens on
// :root, dark mode by OS preference, phone-first. No scripts, no external
// assets — a card is a single self-contained document.
//
// Direction: an instrument panel set in editorial type. Warm paper surfaces
// (not white), ink text, serif titles over sans figures, one accent for data
// marks, fixed status colors for meaning. The data is the only loud thing.

export const THEME_CSS = `
:root{color-scheme:light dark;
--page:#f6f5f1;--surface:#fdfdfc;--surface-2:#f1f0eb;
--ink:#141413;--ink-2:#52514e;--muted:#8a8882;
--hair:#e6e4dd;--ring:rgba(20,20,19,.09);
--accent:#2a78d6;--accent-wash:rgba(42,120,214,.12);--accent-track:#d6e6fa;
--good:#006300;--good-mark:#0ca30c;--good-track:rgba(12,163,12,.18);
--warn:#8a5600;--warn-mark:#fab219;--warn-track:rgba(250,178,25,.24);
--bad:#b92f2f;--bad-mark:#d03b3b;--bad-track:rgba(208,59,59,.16);
--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,"Times New Roman",serif;
--sans:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
--shadow:0 1px 2px rgba(20,20,19,.04),0 10px 28px -14px rgba(20,20,19,.16);
--shadow-hover:0 2px 4px rgba(20,20,19,.05),0 18px 40px -16px rgba(20,20,19,.26)}
@media (prefers-color-scheme:dark){:root{
--page:#0e0e0d;--surface:#1a1a19;--surface-2:#232322;
--ink:#f4f4f1;--ink-2:#c3c2b7;--muted:#908f89;
--hair:#2c2c2a;--ring:rgba(255,255,255,.09);
--accent:#3987e5;--accent-wash:rgba(57,135,229,.16);--accent-track:#18365c;
--good:#34b834;--good-mark:#0ca30c;--good-track:rgba(12,163,12,.24);
--warn:#fab219;--warn-mark:#fab219;--warn-track:rgba(250,178,25,.2);
--bad:#e66767;--bad-mark:#d03b3b;--bad-track:rgba(208,59,59,.24);
--shadow:0 1px 2px rgba(0,0,0,.5),0 14px 36px -16px rgba(0,0,0,.7);
--shadow-hover:0 2px 4px rgba(0,0,0,.5),0 22px 48px -16px rgba(0,0,0,.8)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page) radial-gradient(1100px 520px at 50% -160px,var(--surface-2) 0%,transparent 70%) no-repeat;color:var(--ink);font:15px/1.45 var(--sans);-webkit-font-smoothing:antialiased;min-height:100vh}
a{color:inherit}
.page{max-width:1200px;margin:0 auto;padding:28px 20px 64px}
.page--single{max-width:720px}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0 0 18px}
.top a{font-size:13px;color:var(--muted);text-decoration:none}
.top a:hover{color:var(--ink)}
.top .id{font:12px var(--mono);color:var(--muted)}
.masthead{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:6px 0 28px;padding-bottom:14px;border-bottom:1px solid var(--hair)}
.masthead h1{font:400 36px/1.1 var(--serif);letter-spacing:-.01em;margin:0}
.masthead p{margin:0;color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px;align-items:start}
.card-link{display:block;text-decoration:none;color:inherit;border-radius:14px}
.card-link:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.card{position:relative;background:var(--surface);border:1px solid var(--ring);border-radius:14px;padding:22px 24px 16px;box-shadow:var(--shadow);animation:rise .5s cubic-bezier(.2,.7,.2,1) backwards;animation-delay:calc(var(--i,0)*55ms)}
.card-link .card{transition:transform .25s ease,box-shadow .25s ease}
.card-link:hover .card{transform:translateY(-2px);box-shadow:var(--shadow-hover)}
.card--error{border-left:3px solid var(--bad-mark)}
.card-head{margin-bottom:16px}
.kicker{display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.kicker .name{color:var(--ink-2);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip{display:inline-block;padding:2px 7px;border-radius:999px;border:1px solid var(--hair);font-size:10.5px;line-height:1.4;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-2);background:var(--surface-2)}
.chip--shareable{border-color:var(--accent-track);color:var(--accent);background:transparent}
.chip--bad{border-color:var(--bad-track);color:var(--bad);background:transparent}
.status{width:7px;height:7px;border-radius:50%;background:var(--good-mark);flex:none}
.status--bad{background:var(--bad-mark)}
.status--none{background:var(--hair)}
.card-title{font:400 25px/1.15 var(--serif);letter-spacing:-.01em;margin:0;color:var(--ink)}
.card-sub{margin:5px 0 0;color:var(--ink-2);font-size:14px}
.sec{margin:18px 0 0;padding-top:16px;border-top:1px solid var(--hair)}
.sec:first-child{margin-top:0;padding-top:0;border-top:0}
.sec-title{margin:0 0 10px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:16px 20px}
.stat .l{font-size:12.5px;color:var(--muted);margin-bottom:4px}
.stat .v{font-size:28px;line-height:1.1;font-weight:600;letter-spacing:-.02em;color:var(--ink)}
.stat .d{font-size:12.5px;font-weight:500;margin-top:4px;color:var(--ink-2)}
.stat .d--good{color:var(--good)}.stat .d--warn{color:var(--warn)}.stat .d--bad{color:var(--bad)}
.stat .h{font-size:11.5px;color:var(--muted);margin-top:2px}
.kv{display:grid;grid-template-columns:minmax(88px,max-content) 1fr;gap:7px 18px;margin:0;font-size:14px}
.kv dt{color:var(--muted)}.kv dd{margin:0;color:var(--ink)}
.list{list-style:none;margin:0;padding:0;font-size:14.5px}
.list li{position:relative;padding:6px 0 6px 18px;border-bottom:1px solid var(--hair)}
.list li:last-child{border-bottom:0}
.list li::before{content:"";position:absolute;left:2px;top:14px;width:6px;height:6px;border-radius:50%;background:var(--hair)}
.list li.t-good::before{background:var(--good-mark)}.list li.t-warn::before{background:var(--warn-mark)}.list li.t-bad::before{background:var(--bad-mark)}.list li.t-neutral::before{background:var(--muted)}
.tbl{overflow-x:auto;margin:0 -6px}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);text-align:left;padding:0 6px 8px;white-space:nowrap}
td{padding:7px 6px;border-top:1px solid var(--hair);vertical-align:top;color:var(--ink);white-space:nowrap}
td.wrap{white-space:normal;min-width:14ch}
th.num,td.num{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover td{background:var(--surface-2)}
.txt{margin:0;font-size:14.5px;white-space:pre-wrap;color:var(--ink-2);max-width:62ch}
.spark-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:12.5px;color:var(--muted)}
.spark-head b{font-size:17px;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.spark svg{display:block;width:100%;height:64px;margin-top:6px;overflow:visible}
.spark-foot{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px;font-variant-numeric:tabular-nums}
.bars{display:flex;align-items:flex-end;gap:clamp(2px,1.6vw,10px);height:108px;border-bottom:1px solid var(--hair);padding:0 2px}
.bar-col{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}
.bar-val{font-size:11px;color:var(--ink-2);margin-bottom:4px;font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{width:100%;max-width:24px;border-radius:4px 4px 0 0;background:var(--accent);min-height:2px}
.bar-labs{display:flex;gap:clamp(2px,1.6vw,10px);padding:6px 2px 0;font-size:11px;color:var(--muted)}
.bar-lab{flex:1 1 0;min-width:0;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-labs--ends{justify-content:space-between}
.bar-unit{font-size:11px;color:var(--muted);text-align:right;margin-top:4px}
.meter{margin:0 0 12px}.meter:last-child{margin-bottom:0}
.meter-head{display:flex;justify-content:space-between;gap:12px;font-size:13px;margin-bottom:6px}
.meter-head .ml{color:var(--ink-2)}.meter-head .mv{color:var(--ink);font-variant-numeric:tabular-nums}
.track{height:8px;border-radius:999px;background:var(--accent-track);overflow:hidden}
.fill{height:100%;border-radius:999px;background:var(--accent)}
.meter--good .track{background:var(--good-track)}.meter--good .fill{background:var(--good-mark)}
.meter--warn .track{background:var(--warn-track)}.meter--warn .fill{background:var(--warn-mark)}
.meter--bad .track{background:var(--bad-track)}.meter--bad .fill{background:var(--bad-mark)}
.meter--neutral .track{background:var(--hair)}.meter--neutral .fill{background:var(--muted)}
.err{margin:0;color:var(--ink-2);font-size:14px}
.err code{font:12.5px var(--mono);color:var(--bad);background:var(--surface-2);padding:2px 6px;border-radius:4px;word-break:break-word}
.err-q{margin:10px 0 0;padding:0;list-style:none;font-size:13px;color:var(--ink-2)}
.err-q li{padding:3px 0}.err-q code{font:12px var(--mono)}
.card-foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:18px;padding-top:12px;border-top:1px solid var(--hair);font-size:11.5px;color:var(--muted)}
.empty{color:var(--muted);font-size:15px;max-width:48ch;margin:0}
.more{margin:16px 0 0;padding-top:12px;border-top:1px solid var(--hair);font-size:12.5px;color:var(--accent)}
@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.card{animation:none}.card-link .card{transition:none}}
@media (max-width:480px){.page{padding:18px 14px 44px}.card{padding:18px 18px 14px;border-radius:12px}.stat .v{font-size:24px}.masthead h1{font-size:30px}.card-title{font-size:22px}}
`.trim();
