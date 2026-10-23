/**
 * X-KOM'Z client-only command-center interface.
 * This module owns presentation, Three.js rendering, and UI gestures only.
 * It does not import, mutate, or call backend, WebRTC, OPFS, Ring-WAL, or authority modules.
 *
 * Live data contract:
 *   window.dispatchEvent(new CustomEvent('kernel:telemetry', { detail: snapshot }))
 * or provide window.KERNEL_TELEMETRY as a snapshot / getter.
 * Unknown values stay "UNAVAILABLE"; the UI never invents operational metrics.
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const TOOL_LINKS = [
  ['Mesh console', './mesh-console.html', 'Live peer mesh, node state, console'],
  ['Live peer verification', './live-peer-verify.html', 'WebRTC peer verification harness'],
  ['Live peer persistence', './live-peer-persistence-verify.html', 'Peer persistence verification'],
  ['Authenticated shard verification', './authenticated-shard-verify.html', 'Authenticated shard receipt checks'],
  ['Storage verification', './storage-verify.html', 'Storage/read-back verification'],
  ['Ring-WAL console', './ringwal-console.html', 'Append-only log inspection'],
  ['Authority enrollment', './authority-enroll.html', 'Authority identity and enrollment'],
  ['Authority migration', './authority-migrate.html', 'Authority migration tools'],
  ['Non-exportable authority vault', './non-exportable-vault-verify.html', 'Vault verification'],
  ['Vault persistence', './vault-persistence-verify.html', 'Vault persistence verification'],
  ['Full verification harness', './verify.html', 'Run existing verification harness'],
  ['Pod command drawer', './pod-command-drawer.html', 'Existing app-pod command controls']
];

const PODS = [
  { id: 'kernel-vision', name: 'KernelVision', desc: 'Visual telemetry, frame buffer and node inspection', href: './pod-command-drawer.html' },
  { id: 'planet-apex', name: 'PlanetApeX', desc: 'Peer topography and decentralized state mapping', href: './pod-command-drawer.html' },
  { id: 'kash-korner', name: 'KashKorner', desc: 'Ledger visibility, balance auditing and escrow state', href: './pod-command-drawer.html' },
  { id: 'koin-kobs', name: "KoinKob's", desc: 'Asset liquidity and peer exchange operations', href: './pod-command-drawer.html' },
  { id: 'kernelodies', name: "Kernelodie'z", desc: 'State-machine and audio-visual stream synchronization', href: './pod-command-drawer.html' },
  { id: 'x-shield', name: 'XShield', desc: 'Authority verification, security gates and firewall status', href: './pod-command-drawer.html' }
];

const UNKNOWN = 'UNAVAILABLE';
const fmt = (value, suffix = '') => value === 0 ? '0' : (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) && typeof value === 'number') ? UNKNOWN : `${value}${suffix}`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]));
const readPath = (obj, paths) => {
  for (const path of paths) {
    const value = path.split('.').reduce((v, k) => v == null ? undefined : v[k], obj);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

export class XKomzMasterInterface {
  constructor(containerEl, options = {}) {
    if (!(containerEl instanceof Element)) throw new TypeError('XKomzMasterInterface requires a DOM container element.');
    this.container = containerEl;
    this.options = options;
    this.snapshot = null;
    this.selectedNode = null;
    this.destroyed = false;
    this.raf = 0;
    this.cleanups = [];
    this.nodes = [];
    this.sceneObjects = [];
    this.pods = PODS;
    this.toolLinks = options.toolLinks || TOOL_LINKS;
    this.renderShell();
    this.initThreeScene();
    this.bindEvents();
    this.consumeSnapshot(this.getExternalSnapshot(), 'initial');
    this.onTelemetry = event => this.consumeSnapshot(event.detail, 'event');
    window.addEventListener('kernel:telemetry', this.onTelemetry);
    this.cleanups.push(() => window.removeEventListener('kernel:telemetry', this.onTelemetry));
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize, { passive: true });
    this.cleanups.push(() => window.removeEventListener('resize', this.onResize));
    this.onVisibility = () => { if (document.hidden) cancelAnimationFrame(this.raf); else if (!this.destroyed) this.animate(); };
    document.addEventListener('visibilitychange', this.onVisibility);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', this.onVisibility));
  }

  renderShell() {
    this.container.innerHTML = `
      <section class="xk-root" aria-label="X-KOM'Z Overseer command center">
        <div class="xk-viewport" data-xk-viewport aria-label="Interactive three-dimensional peer mesh"></div>
        <header class="xk-hud">
          <div class="xk-brand"><span class="xk-mark">KERNEL</span><b>X-KOM'Z / OVERSEER</b></div>
          <div class="xk-subtitle">PHANTOM BLACK · LOCAL-FIRST · FAIL-CLOSED</div>
          <div class="xk-statusline"><span class="xk-live-dot"></span><span data-xk="connection">WAITING FOR LIVE TELEMETRY</span><span class="xk-sep">/</span><span data-xk="updated">NO SNAPSHOT RECEIVED</span></div>
        </header>
        <div class="xk-side-hints"><button type="button" data-open="ledger">← LEDGER / EVIDENCE</button><button type="button" data-open="pods">APP PODS / →</button></div>
        <div class="xk-bottom-bar">
          <div class="xk-mini-stats"><span>LIVE PEERS <b data-xk="peerCount">UNAVAILABLE</b></span><span>SHARDS <b data-xk="shardCount">UNAVAILABLE</b></span><span>RING-WAL <b data-xk="walStatus">UNAVAILABLE</b></span></div>
          <div class="xk-actions"><button type="button" data-open="telemetry">NODE / CONSOLE</button><button type="button" data-open="tools">OPERATIONS</button></div>
        </div>
        <div class="xk-scrim" data-xk-scrim hidden></div>
        <aside class="xk-drawer xk-ledger" data-drawer="ledger" aria-label="Cryptographic ledger and evidence vault" aria-hidden="true">
          <div class="xk-drawer-head"><div><small>SOVEREIGN EVIDENCE VAULT</small><h2>Cryptographic ledger</h2></div><button type="button" data-close aria-label="Close ledger">×</button></div>
          <p class="xk-muted">Values below are populated only from received application telemetry. No hashes or signature results are fabricated.</p>
          <div class="xk-metric-grid">
            <div class="xk-metric"><small>AUTHORITY</small><b data-xk="authorityStatus">UNAVAILABLE</b></div>
            <div class="xk-metric"><small>SIGNATURE</small><b data-xk="signatureStatus">UNAVAILABLE</b></div>
            <div class="xk-metric"><small>LAST SHA-256</small><b class="xk-hash" data-xk="lastHash">UNAVAILABLE</b></div>
            <div class="xk-metric"><small>SHARD RECEIPTS</small><b data-xk="receiptCount">UNAVAILABLE</b></div>
            <div class="xk-metric"><small>READ-BACK</small><b data-xk="readbackStatus">UNAVAILABLE</b></div>
            <div class="xk-metric"><small>FAIL-CLOSED GATE</small><b data-xk="gateStatus">UNAVAILABLE</b></div>
          </div>
          <h3>Evidence records</h3><div class="xk-records" data-xk-records><p class="xk-empty">Waiting for signed manifests, hashes, receipts and verification records.</p></div>
          <h3>Security tools</h3><div class="xk-tool-list" data-tool-group="security"></div>
        </aside>
        <aside class="xk-drawer xk-pods" data-drawer="pods" aria-label="Canonical application pods" aria-hidden="true">
          <div class="xk-drawer-head"><div><small>DUAL-STATE APPLICATIONS</small><h2>Canonical app pods</h2></div><button type="button" data-close aria-label="Close app pods">×</button></div>
          <p class="xk-muted">Tap a card to flip between its description and current telemetry. Command links open the existing pod command interface.</p>
          <div class="xk-pod-grid" data-xk-pods></div>
        </aside>
        <aside class="xk-drawer xk-telemetry" data-drawer="telemetry" aria-label="Node telemetry and console" aria-hidden="true">
          <div class="xk-drawer-head"><div><small>SELECTED MESH NODE</small><h2 data-xk="nodeLabel">No node selected</h2></div><button type="button" data-close aria-label="Close telemetry">×</button></div>
          <div class="xk-metric-grid">
            <div class="xk-metric"><small>PEER COUNT</small><b data-xk="peerCountFull">UNAVAILABLE</b></div>
            <div class="xk-metric"><small>LATENCY</small><b data-xk="latency">UNAVAILABLE</b></div>
            <div class="xk-metric"><small>BANDWIDTH</small><b data-xk="bandwidth">UNAVAILABLE</b></div>
            <div class="xk-metric"><small>SHARD COUNT</small><b data-xk="shardCountFull">UNAVAILABLE</b></div>
            <div class="xk-metric"><small>OPFS BYTES</small><b data-xk="opfsBytes">UNAVAILABLE</b></div>
            <div class="xk-metric"><small>RING-WAL</small><b data-xk="walStatusFull">UNAVAILABLE</b></div>
          </div>
          <div class="xk-node-details" data-xk-node-details><p class="xk-empty">Select a node in the 3D mesh to inspect its live state.</p></div>
          <div class="xk-console-head"><h3>Existing console / controls</h3><span data-xk="consoleStatus">READY WHEN CONNECTED</span></div>
          <div class="xk-tool-list" data-tool-group="network"></div>
          <div class="xk-tool-list" data-tool-group="storage"></div>
          <div class="xk-console-frame" data-xk-console-frame><div class="xk-empty">Select a tool to open its existing console below. No backend calls are made by this interface.</div></div>
        </aside>
        <aside class="xk-drawer xk-tools" data-drawer="tools" aria-label="All operations and verification tools" aria-hidden="true">
          <div class="xk-drawer-head"><div><small>OPERATIONS DIRECTORY</small><h2>Network · Storage · Security</h2></div><button type="button" data-close aria-label="Close tools">×</button></div>
          <input class="xk-search" type="search" placeholder="Filter tools…" aria-label="Filter operations tools" data-xk-tool-search>
          <div class="xk-tool-list xk-all-tools" data-tool-group="all"></div>
          <p class="xk-footnote">Controls navigate to existing client tools. This UI does not modify network, signing, storage, or routing code.</p>
        </aside>
      </section>`;
    this.installStyles();
    this.root = this.container.querySelector('.xk-root');
    this.viewport = this.container.querySelector('[data-xk-viewport]');
    this.scrim = this.container.querySelector('[data-xk-scrim]');
    this.drawers = Object.fromEntries([...this.root.querySelectorAll('[data-drawer]')].map(el => [el.dataset.drawer, el]));
    this.renderToolLinks();
    this.renderPods();
  }

  installStyles() {
    if (document.getElementById('xk-master-styles')) return;
    const style = document.createElement('style');
    style.id = 'xk-master-styles';
    style.textContent = `
      .xk-root{position:relative;isolation:isolate;width:100%;height:100%;min-height:560px;overflow:hidden;background:#02050c;color:#e7f4ff;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.015em;user-select:none}
      .xk-root *{box-sizing:border-box}.xk-viewport{position:absolute;inset:0;z-index:0;touch-action:pan-y}.xk-viewport canvas{display:block;width:100%;height:100%;outline:none}
      .xk-hud{position:absolute;z-index:2;top:max(14px,env(safe-area-inset-top));left:50%;transform:translateX(-50%);width:min(620px,calc(100% - 28px));padding:12px 16px;text-align:center;border:1px solid #8ddcff30;border-radius:15px;background:#040b16b8;backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);box-shadow:0 10px 45px #0008;pointer-events:none}
      .xk-brand{display:flex;align-items:center;justify-content:center;gap:10px;font-size:12px;letter-spacing:.14em}.xk-mark{color:#fff;font-weight:800}.xk-brand b{color:#a5eaff}.xk-subtitle{margin-top:4px;color:#8198af;font-size:9px;letter-spacing:.16em}.xk-statusline{display:flex;justify-content:center;gap:8px;align-items:center;margin-top:9px;color:#8fa9c2;font:9px/1.4 ui-monospace,monospace;letter-spacing:.07em}.xk-live-dot{width:6px;height:6px;border-radius:50%;background:#8adfff;box-shadow:0 0 12px #48caff}
      .xk-side-hints{position:absolute;z-index:2;top:48%;left:0;right:0;display:flex;justify-content:space-between;padding:0 10px;pointer-events:none}.xk-side-hints button{pointer-events:auto;writing-mode:vertical-rl;padding:12px 8px;border:1px solid #8ddcff30;border-radius:10px;background:#050c18a8;color:#b4d9ef;font:9px ui-monospace,monospace;letter-spacing:.12em;backdrop-filter:blur(12px)}
      .xk-bottom-bar{position:absolute;z-index:2;left:10px;right:10px;bottom:max(10px,env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border:1px solid #8ddcff2b;border-radius:15px;background:#040a14cf;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)}.xk-mini-stats{display:flex;flex-wrap:wrap;gap:10px 16px;color:#7892ab;font:9px ui-monospace,monospace}.xk-mini-stats b{color:#d9f4ff;font-weight:600}.xk-actions{display:flex;gap:6px;flex-shrink:0}
      .xk-root button,.xk-root a{font:inherit}.xk-root button{cursor:pointer;touch-action:manipulation}.xk-actions button{padding:9px 10px;border:1px solid #70d8ff55;border-radius:9px;background:#0b2033c9;color:#c8efff;font-size:9px;letter-spacing:.08em}.xk-actions button:hover,.xk-side-hints button:hover{border-color:#b2edff}
      .xk-scrim{position:absolute;inset:0;z-index:5;background:#0008;backdrop-filter:blur(3px)}.xk-drawer{position:absolute;z-index:6;display:flex;flex-direction:column;gap:14px;overflow:auto;overscroll-behavior:contain;padding:calc(18px + env(safe-area-inset-top)) 16px calc(20px + env(safe-area-inset-bottom));background:#050b15eF;border:1px solid #8adfff35;box-shadow:0 0 70px #000a;backdrop-filter:blur(28px) saturate(125%);-webkit-backdrop-filter:blur(28px) saturate(125%);transition:transform .32s cubic-bezier(.2,.8,.2,1);scrollbar-width:thin;scrollbar-color:#25465c transparent}
      .xk-drawer[aria-hidden="true"]{pointer-events:none}.xk-ledger{inset:0 auto 0 0;width:min(430px,92vw);transform:translateX(-105%);border-radius:0 20px 20px 0}.xk-pods{inset:0 0 0 auto;width:min(440px,94vw);transform:translateX(105%);border-radius:20px 0 0 20px}.xk-telemetry{inset:auto 8px max(8px,env(safe-area-inset-bottom));max-height:min(76dvh,760px);min-height:250px;transform:translateY(calc(100% + 30px));border-radius:20px}.xk-tools{inset:0 0 0 auto;width:min(470px,96vw);transform:translateX(105%);border-radius:20px 0 0 20px}
      .xk-drawer.open{transform:translate(0,0)}.xk-drawer-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:1px solid #b1dfff20;padding-bottom:12px}.xk-drawer-head small{color:#79c9ec;font:9px ui-monospace,monospace;letter-spacing:.16em}.xk-drawer-head h2{margin:5px 0 0;font-size:19px;font-weight:550;letter-spacing:-.02em}.xk-drawer-head>button{width:34px;height:34px;border:1px solid #b1dfff30;border-radius:10px;background:#07111f;color:#d4edff;font-size:23px;line-height:1}
      .xk-muted,.xk-footnote{margin:0;color:#8198af;font-size:11px;line-height:1.65}.xk-drawer h3{margin:3px 0 0;color:#c6eaff;font-size:11px;letter-spacing:.1em;text-transform:uppercase}.xk-metric-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.xk-metric{min-width:0;padding:11px;border:1px solid #9adfff1b;border-radius:11px;background:#081321b8}.xk-metric small{display:block;color:#718da6;font:9px ui-monospace,monospace;letter-spacing:.1em}.xk-metric b{display:block;margin-top:7px;overflow-wrap:anywhere;color:#d9f4ff;font:500 12px/1.45 ui-monospace,monospace}.xk-hash{font-size:10px!important}.xk-records,.xk-node-details{display:flex;flex-direction:column;gap:7px}.xk-record{padding:10px;border:1px solid #9adfff1b;border-radius:9px;background:#07111c;color:#b4cbe0;font:10px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}.xk-empty{margin:0;padding:12px;border:1px dashed #8dbedc26;border-radius:10px;color:#718ba4;font-size:11px;line-height:1.6}.xk-tool-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.xk-tool{display:flex;min-width:0;flex-direction:column;gap:5px;padding:11px;border:1px solid #8ddcff24;border-radius:10px;background:#07121f;color:#d4eaff;text-decoration:none}.xk-tool:hover,.xk-tool:focus-visible{outline:none;border-color:#7ddaff9c;background:#0b2033}.xk-tool strong{font-size:10px;font-weight:600}.xk-tool span{color:#8198af;font-size:9px;line-height:1.5}.xk-tool[hidden]{display:none}.xk-console-head{display:flex;justify-content:space-between;align-items:center;gap:8px}.xk-console-head span{color:#728ca4;font:9px ui-monospace,monospace}.xk-console-frame{min-height:80px}.xk-console-frame iframe{display:block;width:100%;height:min(44dvh,500px);min-height:260px;border:1px solid #8ddcff30;border-radius:12px;background:#02060c}.xk-search{width:100%;padding:12px;border:1px solid #8ddcff30;border-radius:10px;background:#020812;color:#e6f7ff;outline:none}.xk-pod-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.xk-pod{perspective:900px;min-height:170px}.xk-pod-inner{position:relative;min-height:170px;height:100%;transform-style:preserve-3d;transition:transform .45s}.xk-pod.flipped .xk-pod-inner{transform:rotateY(180deg)}.xk-pod-face{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;padding:13px;border:1px solid #8ddcff2b;border-radius:13px;background:linear-gradient(145deg,#0b1b2bde,#050a13f2);backface-visibility:hidden;-webkit-backface-visibility:hidden}.xk-pod-face h3{margin:0;color:#d7f3ff;font-size:12px;text-transform:none;letter-spacing:0}.xk-pod-face p{margin:0;color:#829ab0;font-size:10px;line-height:1.55}.xk-pod-back{transform:rotateY(180deg)}.xk-pod-face button,.xk-pod-face a{margin-top:auto;padding:9px;border:1px solid #8ddcff40;border-radius:8px;background:#0a2032;color:#bcecff;text-decoration:none;text-align:center;font-size:9px}.xk-pod-state{color:#8fcbe8;font:9px ui-monospace,monospace;overflow-wrap:anywhere}.xk-root a:focus-visible,.xk-root button:focus-visible{outline:2px solid #8de2ff;outline-offset:2px}
      @media(max-width:600px){.xk-root{min-height:100dvh}.xk-hud{padding:10px}.xk-brand{font-size:10px}.xk-statusline{font-size:8px;gap:5px}.xk-mini-stats{gap:5px 10px;font-size:8px}.xk-bottom-bar{align-items:flex-start;flex-direction:column}.xk-actions{width:100%}.xk-actions button{flex:1}.xk-side-hints{top:45%}.xk-pod-grid{grid-template-columns:1fr}.xk-pod,.xk-pod-inner{min-height:140px}.xk-drawer{padding-left:13px;padding-right:13px}.xk-telemetry{max-height:78dvh}.xk-metric-grid{gap:6px}.xk-metric{padding:9px}}
      @media(prefers-reduced-motion:reduce){.xk-drawer,.xk-pod-inner{transition:none}}
    `;
    document.head.appendChild(style);
  }

  renderToolLinks() {
    const groups = {
      security: this.toolLinks.filter(t => /authority|vault|authenticated|verification harness/i.test(t[0])),
      network: this.toolLinks.filter(t => /mesh|peer/i.test(t[0])),
      storage: this.toolLinks.filter(t => /storage|shard|ring-wal|persistence/i.test(t[0])),
      all: this.toolLinks
    };
    for (const [group, links] of Object.entries(groups)) {
      const target = this.root.querySelector(`[data-tool-group="${group}"]`);
      if (!target) continue;
      target.innerHTML = links.map(([name, href, description]) => `<a class="xk-tool" href="${esc(href)}" data-tool-name="${esc(name.toLowerCase())}"><strong>${esc(name)}</strong><span>${esc(description)}</span></a>`).join('');
    }
    this.root.querySelector('[data-xk-tool-search]').addEventListener('input', e => {
      const q = e.currentTarget.value.trim().toLowerCase();
      this.root.querySelectorAll('[data-tool-group="all"] .xk-tool').forEach(link => { link.hidden = !link.textContent.toLowerCase().includes(q); });
    });
    this.root.querySelectorAll('[data-tool-group] .xk-tool').forEach(link => link.addEventListener('click', event => {
      // Existing tools open in the current UI; no synthetic backend command is issued.
      if (link.href && link.href !== location.href) return;
      event.preventDefault();
      this.openTool(link.getAttribute('href'), link.querySelector('strong')?.textContent || 'Existing tool');
    }));
  }

  renderPods() {
    const target = this.root.querySelector('[data-xk-pods]');
    target.innerHTML = this.pods.map(pod => `
      <article class="xk-pod" data-pod="${esc(pod.id)}" tabindex="0" aria-label="${esc(pod.name)} card; tap to flip">
        <div class="xk-pod-inner">
          <div class="xk-pod-face"><small class="xk-pod-state">POD / DESCRIPTION</small><h3>${esc(pod.name)}</h3><p>${esc(pod.desc)}</p><button type="button" data-flip="${esc(pod.id)}">FLIP FOR LIVE STATE ↻</button></div>
          <div class="xk-pod-face xk-pod-back"><small class="xk-pod-state">LIVE SNAPSHOT</small><h3>${esc(pod.name)}</h3><p data-pod-state="${esc(pod.id)}">No pod-specific telemetry received.</p><a href="${esc(pod.href)}">OPEN POD CONTROLS ↗</a></div>
        </div>
      </article>`).join('');
    target.querySelectorAll('[data-flip]').forEach(btn => btn.addEventListener('click', e => { e.stopPropagation(); btn.closest('.xk-pod').classList.toggle('flipped'); }));
    target.querySelectorAll('.xk-pod').forEach(card => {
      card.addEventListener('click', e => { if (!e.target.closest('a,button')) card.classList.toggle('flipped'); });
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.classList.toggle('flipped'); } });
    });
  }

  getExternalSnapshot() {
    const source = window.KERNEL_TELEMETRY;
    try { return typeof source === 'function' ? source() : source?.snapshot ? source.snapshot() : source || null; }
    catch (error) { this.reportError('Could not read KERNEL_TELEMETRY', error); return null; }
  }

  consumeSnapshot(snapshot, source = 'external') {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.snapshot = snapshot;
    const peerCount = readPath(snapshot, ['network.livePeerCount','network.peerCount','livePeerCount','peerCount','metrics.peers']);
    const shardCount = readPath(snapshot, ['storage.shardCount','shardCount','metrics.shards']);
    const latency = readPath(snapshot, ['network.latencyMs','network.latency','latencyMs','metrics.latencyMs']);
    const bandwidth = readPath(snapshot, ['network.bandwidth','network.bytesPerSecond','bandwidth','metrics.bandwidth']);
    const opfsBytes = readPath(snapshot, ['storage.opfsBytes','storage.bytes','opfsBytes','metrics.opfsBytes']);
    const walStatus = readPath(snapshot, ['storage.ringWalStatus','storage.walStatus','ringWalStatus','walStatus']);
    const authority = readPath(snapshot, ['security.authorityStatus','security.authority','authorityStatus']);
    const signature = readPath(snapshot, ['security.signatureStatus','security.signatureVerified','signatureStatus']);
    const hash = readPath(snapshot, ['security.lastSha256','security.lastHash','lastSha256','lastHash']);
    const receipts = readPath(snapshot, ['security.receiptCount','storage.receiptCount','receiptCount']);
    const readback = readPath(snapshot, ['storage.readbackStatus','storage.readBackStatus','readbackStatus']);
    const gate = readPath(snapshot, ['security.failClosedStatus','security.gateStatus','gateStatus']);
    const connected = readPath(snapshot, ['network.connected','connected','status']);
    this.set('connection', connected === true ? 'LIVE DATA CONNECTED' : connected === false ? 'DISCONNECTED' : 'LIVE SNAPSHOT RECEIVED');
    this.set('updated', readPath(snapshot, ['updatedAt','timestamp','lastUpdated']) || new Date().toLocaleTimeString());
    this.set('peerCount', fmt(peerCount)); this.set('peerCountFull', fmt(peerCount));
    this.set('shardCount', fmt(shardCount)); this.set('shardCountFull', fmt(shardCount));
    this.set('latency', latency === undefined ? UNKNOWN : fmt(latency, ' ms'));
    this.set('bandwidth', bandwidth === undefined ? UNKNOWN : fmt(bandwidth));
    this.set('opfsBytes', opfsBytes === undefined ? UNKNOWN : fmt(opfsBytes, ' bytes'));
    this.set('walStatus', fmt(walStatus)); this.set('walStatusFull', fmt(walStatus));
    this.set('authorityStatus', fmt(authority)); this.set('signatureStatus', typeof signature === 'boolean' ? (signature ? 'VERIFIED' : 'NOT VERIFIED') : fmt(signature));
    this.set('lastHash', fmt(hash)); this.set('receiptCount', fmt(receipts)); this.set('readbackStatus', fmt(readback)); this.set('gateStatus', fmt(gate));
    this.set('consoleStatus', source === 'event' ? 'LIVE EVENT RECEIVED' : 'SNAPSHOT LOADED');
    this.renderRecords(readPath(snapshot, ['security.records','ledger.records','evidence','records']));
    this.renderNodeDetails(this.selectedNode);
    for (const pod of this.pods) {
      const state = readPath(snapshot, [`pods.${pod.id}.status`, `apps.${pod.id}.status`, `pods.${pod.name}.status`]);
      const detail = readPath(snapshot, [`pods.${pod.id}.summary`, `apps.${pod.id}.summary`, `pods.${pod.name}.summary`]);
      const el = this.root.querySelector(`[data-pod-state="${pod.id}"]`);
      if (el) el.textContent = [state, detail].filter(Boolean).join(' · ') || 'No pod-specific telemetry received.';
    }
    const peerList = readPath(snapshot, ['network.peers','peers','nodes']);
    if (Array.isArray(peerList)) this.syncNodes(peerList);
    this.dispatch('xkomz:telemetry-rendered', { snapshot });
  }

  set(key, value) {
    const el = this.root.querySelector(`[data-xk="${key}"]`);
    if (el) el.textContent = String(value ?? UNKNOWN);
  }

  renderRecords(records) {
    const target = this.root.querySelector('[data-xk-records]');
    if (!Array.isArray(records) || records.length === 0) {
      target.innerHTML = '<p class="xk-empty">No evidence records supplied by the live data source.</p>';
      return;
    }
    target.innerHTML = records.slice(-100).reverse().map(record => {
      const text = typeof record === 'string' ? record : JSON.stringify(record);
      return `<div class="xk-record">${esc(text)}</div>`;
    }).join('');
  }

  renderNodeDetails(node) {
    const target = this.root.querySelector('[data-xk-node-details]');
    if (!node) {
      target.innerHTML = '<p class="xk-empty">Select a node in the 3D mesh to inspect its live state.</p>';
      this.set('nodeLabel', 'No node selected');
      return;
    }
    const fields = [
      ['Node ID', node.id ?? node.peerId ?? node.peer_id],
      ['State', node.state ?? node.status ?? node.connectionState],
      ['Latency', node.latencyMs === undefined ? undefined : `${node.latencyMs} ms`],
      ['RX bytes', node.bytesReceived ?? node.rxBytes],
      ['TX bytes', node.bytesSent ?? node.txBytes],
      ['Shard count', node.shardCount ?? node.shards],
      ['Last SHA-256', node.lastSha256 ?? node.hash]
    ];
    this.set('nodeLabel', node.name || node.id || node.peerId || 'Selected mesh node');
    target.innerHTML = fields.map(([label, value]) => `<div class="xk-record"><b>${esc(label)}:</b> ${esc(value ?? UNKNOWN)}</div>`).join('');
  }

  syncNodes(peerList) {
    const normalized = peerList.slice(0, 1000).map((peer, index) => ({
      id: String(peer.id ?? peer.peerId ?? peer.peer_id ?? `peer-${index + 1}`),
      label: String(peer.name ?? peer.label ?? peer.id ?? peer.peerId ?? `PEER ${index + 1}`),
      state: String(peer.state ?? peer.status ?? peer.connectionState ?? 'unknown').toLowerCase(),
      raw: peer
    }));
    this.nodes = normalized;
    if (!this.nodeGroup) return;
    while (this.nodeGroup.children.length) {
      const child = this.nodeGroup.children.pop();
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose()); else child.material?.dispose();
    }
    this.sceneObjects = [];
    const radius = 8.5;
    normalized.forEach((node, index) => {
      const phi = Math.acos(1 - 2 * (index + .5) / Math.max(1, normalized.length));
      const theta = Math.PI * (1 + Math.sqrt(5)) * index;
      const pos = new THREE.Vector3(radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta));
      const live = /connected|open|live|active|verified/.test(node.state);
      const geometry = new THREE.SphereGeometry(live ? .17 : .12, 10, 10);
      const material = new THREE.MeshBasicMaterial({ color: live ? 0x8eeaff : 0x31465e, transparent: true, opacity: live ? .98 : .38 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(pos); mesh.userData.node = node; mesh.userData.isPeerNode = true;
      this.nodeGroup.add(mesh); this.sceneObjects.push(mesh);
    });
  }

  initThreeScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x02050c, 0.012);
    this.camera = new THREE.PerspectiveCamera(58, 1, .1, 500);
    this.camera.position.set(0, 9, 30); this.camera.lookAt(0, 0, 0);
    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch (error) {
      this.viewport.innerHTML = '<div class="xk-empty" style="position:absolute;inset:45% 20px auto;text-align:center">WebGL is unavailable in this browser. The command panels remain usable.</div>';
      this.reportError('WebGL initialization failed', error);
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    this.renderer.setSize(this.viewport.clientWidth || window.innerWidth, this.viewport.clientHeight || window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D mesh; select a glowing peer node');
    this.renderer.domElement.tabIndex = 0;
    this.viewport.appendChild(this.renderer.domElement);
    this.scene.add(new THREE.AmbientLight(0x7ebfff, .65));

    // Layer 1: engineered digital core (interlocking toroidal lattices; no biological silhouette).
    this.coreGroup = new THREE.Group();
    const coreMaterials = [
      new THREE.MeshBasicMaterial({ color: 0x9cefff, wireframe: true, transparent: true, opacity: .27 }),
      new THREE.MeshBasicMaterial({ color: 0x167cff, wireframe: true, transparent: true, opacity: .22 }),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .62 })
    ];
    const torusA = new THREE.Mesh(new THREE.TorusKnotGeometry(4.6, .56, 220, 12, 2, 5), coreMaterials[0]);
    const torusB = new THREE.Mesh(new THREE.TorusKnotGeometry(3.5, .34, 180, 10, 3, 7), coreMaterials[1]);
    torusB.rotation.set(1.1, .4, .7);
    const nucleus = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4, 2), coreMaterials[2]);
    this.coreGroup.add(torusA, torusB, nucleus);
    const corePoints = new THREE.Points(new THREE.IcosahedronGeometry(5.1, 4), new THREE.PointsMaterial({ color: 0xb8f5ff, size: .045, transparent: true, opacity: .9 }));
    this.coreGroup.add(corePoints);
    this.scene.add(this.coreGroup);

    // Layer 2: undulating point-field floor and geodesic containment dome.
    const floorGeometry = new THREE.BufferGeometry();
    const floorPositions = [];
    for (let x = -42; x <= 42; x += 1.35) for (let z = -28; z <= 28; z += 1.35) floorPositions.push(x, -9, z);
    floorGeometry.setAttribute('position', new THREE.Float32BufferAttribute(floorPositions, 3));
    this.floorBase = new Float32Array(floorPositions);
    this.floor = new THREE.Points(floorGeometry, new THREE.PointsMaterial({ color: 0x218bff, size: .055, transparent: true, opacity: .62 }));
    this.scene.add(this.floor);
    const dome = new THREE.Mesh(new THREE.IcosahedronGeometry(23, 3), new THREE.MeshBasicMaterial({ color: 0x1b8dff, wireframe: true, transparent: true, opacity: .10 }));
    this.dome = dome; this.scene.add(dome);
    const domeDots = new THREE.Points(new THREE.IcosahedronGeometry(23, 4), new THREE.PointsMaterial({ color: 0x80dfff, size: .035, transparent: true, opacity: .62 }));
    this.scene.add(domeDots);

    // Layer 3: multi-depth colored filaments and bokeh particles.
    const palette = [new THREE.Color(0x168dff), new THREE.Color(0xff6b21), new THREE.Color(0xffc34a), new THREE.Color(0xff4545), new THREE.Color(0x74dfff)];
    const count = 2400, pos = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const r = 7 + Math.random() * 28, a = Math.random() * Math.PI * 2, y = (Math.random() - .5) * 28;
      pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = y; pos[i * 3 + 2] = Math.sin(a) * r;
      const c = palette[Math.floor(Math.random() * palette.length)];
      colors.set([c.r, c.g, c.b], i * 3); sizes[i] = .035 + Math.random() * .08;
    }
    const bokehGeometry = new THREE.BufferGeometry();
    bokehGeometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    bokehGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.bokeh = new THREE.Points(bokehGeometry, new THREE.PointsMaterial({ size: .105, vertexColors: true, transparent: true, opacity: .82, depthWrite: false, sizeAttenuation: true }));
    this.scene.add(this.bokeh);
    this.filaments = new THREE.Group();
    for (let j = 0; j < 26; j++) {
      const pts = [];
      const phase = j / 26 * Math.PI * 2;
      for (let k = 0; k <= 80; k++) {
        const t = k / 80 * Math.PI * 2;
        const r = 9 + 5 * Math.sin(t * 2 + phase);
        pts.push(new THREE.Vector3(Math.cos(t + phase) * r, Math.sin(t * 3 + phase) * 5, Math.sin(t + phase) * r));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(pts);
      const material = new THREE.LineBasicMaterial({ color: palette[j % palette.length], transparent: true, opacity: .24 });
      this.filaments.add(new THREE.Line(geometry, material));
    }
    this.scene.add(this.filaments);

    // Layer 4: curved binary highways, glowing energy ribbons and concentric radar rings.
    this.highways = new THREE.Group();
    for (let i = 0; i < 12; i++) {
      const phase = i / 12 * Math.PI * 2, pts = [];
      for (let k = 0; k <= 100; k++) {
        const t = k / 100 * Math.PI * 2;
        const r = 8 + 2.5 * Math.sin(t * 2 + phase);
        pts.push(new THREE.Vector3(Math.cos(t + phase) * r, Math.sin(t * 2 + phase) * 3.5, Math.sin(t + phase) * r));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(pts);
      const material = new THREE.LineBasicMaterial({ color: i % 3 ? 0x30baff : 0xffb34d, transparent: true, opacity: .55 });
      this.highways.add(new THREE.Line(geometry, material));
    }
    this.scene.add(this.highways);
    this.rings = new THREE.Group();
    [6.5, 9, 12, 15].forEach((r, i) => {
      const ring = new THREE.Mesh(new THREE.RingGeometry(r, r + .035, 128), new THREE.MeshBasicMaterial({ color: i % 2 ? 0xffbd4a : 0x58d9ff, side: THREE.DoubleSide, transparent: true, opacity: .48 }));
      ring.rotation.x = Math.PI / 2; ring.position.y = -3.8 + i * .15; this.rings.add(ring);
    });
    this.scene.add(this.rings);
    this.binaryGroup = new THREE.Group();
    const binaryCanvas = document.createElement('canvas');
    binaryCanvas.width = 512; binaryCanvas.height = 64;
    const ctx = binaryCanvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, 512, 64); ctx.font = '18px monospace'; ctx.fillStyle = '#b8f5ff';
      let bits = ''; for (let i = 0; i < 76; i++) bits += Math.random() > .5 ? '1 ' : '0 ';
      ctx.fillText(bits, 4, 38);
      const texture = new THREE.CanvasTexture(binaryCanvas);
      for (let i = 0; i < 6; i++) {
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: .36 + i * .045, side: THREE.DoubleSide, depthWrite: false, color: i % 2 ? 0x77dfff : 0xffbd56 });
        const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(18 + i * 1.4, 1.2), material);
        ribbon.position.set(0, -4 + i * 1.35, 0); ribbon.rotation.y = i * .49; ribbon.rotation.x = -.15 + i * .04;
        this.binaryGroup.add(ribbon);
      }
    }
    this.scene.add(this.binaryGroup);
    this.nodeGroup = new THREE.Group(); this.scene.add(this.nodeGroup);
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.onCanvasPointer = event => this.pickNode(event);
    this.renderer.domElement.addEventListener('pointerup', this.onCanvasPointer);
    this.cleanups.push(() => this.renderer?.domElement.removeEventListener('pointerup', this.onCanvasPointer));
    this.resize();
    this.animate();
  }

  animate() {
    if (this.destroyed || !this.renderer || document.hidden) return;
    this.raf = requestAnimationFrame(() => this.animate());
    const t = performance.now() * .001;
    if (this.coreGroup) { this.coreGroup.rotation.x = Math.sin(t * .17) * .12; this.coreGroup.rotation.y = t * .14; }
    if (this.dome) { this.dome.rotation.y = -t * .025; this.dome.rotation.x = Math.sin(t * .07) * .025; }
    if (this.bokeh) this.bokeh.rotation.y = t * .012;
    if (this.filaments) { this.filaments.rotation.y = -t * .03; this.filaments.rotation.x = Math.sin(t * .09) * .04; }
    if (this.highways) this.highways.rotation.y = t * .07;
    if (this.rings) this.rings.rotation.y = -t * .06;
    if (this.binaryGroup) this.binaryGroup.rotation.y = Math.sin(t * .18) * .22;
    if (this.floor) {
      const attr = this.floor.geometry.getAttribute('position');
      for (let i = 0; i < attr.count; i++) {
        const x = this.floorBase[i * 3], z = this.floorBase[i * 3 + 2];
        attr.array[i * 3 + 1] = -9 + Math.sin(x * .15 + t * .7) * .28 + Math.cos(z * .18 + t * .55) * .22;
      }
      attr.needsUpdate = true;
    }
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    if (!this.renderer || !this.camera || !this.viewport) return;
    const width = Math.max(1, this.viewport.clientWidth), height = Math.max(1, this.viewport.clientHeight);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.renderer.setSize(width, height, false);
  }

  pickNode(event) {
    if (!this.renderer || !this.sceneObjects.length) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.sceneObjects, false);
    if (!hits.length) return;
    const node = hits[0].object.userData.node;
    this.selectedNode = node.raw;
    this.renderNodeDetails(this.selectedNode);
    this.openDrawer('telemetry');
    const target = hits[0].object.position.clone();
    const direction = target.clone().normalize();
    const end = target.clone().add(direction.multiplyScalar(4));
    this.camera.position.lerp(end, .35);
    this.camera.lookAt(target);
    this.dispatch('xkomz:node-selected', { node: this.selectedNode });
  }

  bindEvents() {
    this.root.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => this.openDrawer(button.dataset.open)));
    this.root.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => this.closeDrawers()));
    this.scrim.addEventListener('click', () => this.closeDrawers());
    this.onKeyDown = event => { if (event.key === 'Escape') this.closeDrawers(); };
    window.addEventListener('keydown', this.onKeyDown); this.cleanups.push(() => window.removeEventListener('keydown', this.onKeyDown));
    let startX = 0, startY = 0, startAt = 0;
    this.root.addEventListener('touchstart', event => {
      const touch = event.changedTouches[0]; startX = touch.clientX; startY = touch.clientY; startAt = performance.now();
    }, { passive: true });
    this.root.addEventListener('touchend', event => {
      const touch = event.changedTouches[0], dx = touch.clientX - startX, dy = touch.clientY - startY;
      if (performance.now() - startAt > 900 || Math.abs(dx) < 65 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      if (startX < 28 && dx > 0) this.openDrawer('ledger');
      else if (startX > window.innerWidth - 28 && dx < 0) this.openDrawer('pods');
      else if (dx < -110 && this.currentDrawer === 'ledger') this.closeDrawers();
      else if (dx > 110 && this.currentDrawer === 'pods') this.closeDrawers();
    }, { passive: true });
    this.root.addEventListener('xkomz:telemetry-rendered', () => {});
  }

  openDrawer(name) {
    if (!this.drawers[name]) return;
    this.currentDrawer = name;
    Object.entries(this.drawers).forEach(([key, drawer]) => {
      const open = key === name;
      drawer.classList.toggle('open', open);
      drawer.setAttribute('aria-hidden', String(!open));
    });
    this.scrim.hidden = false;
    this.root.querySelectorAll('[data-open]').forEach(el => el.setAttribute('aria-expanded', String(el.dataset.open === name)));
  }

  closeDrawers() {
    Object.values(this.drawers).forEach(drawer => { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); });
    this.scrim.hidden = true; this.currentDrawer = null;
    this.root.querySelectorAll('[data-open]').forEach(el => el.setAttribute('aria-expanded', 'false'));
  }

  openTool(href, title) {
    const frame = this.root.querySelector('[data-xk-console-frame]');
    if (!href || href === '#') { frame.innerHTML = '<p class="xk-empty">No client tool URL is configured.</p>'; return; }
    const safeHref = new URL(href, document.baseURI);
    if (safeHref.origin !== location.origin) { window.open(safeHref.href, '_blank', 'noopener,noreferrer'); return; }
    frame.innerHTML = `<div class="xk-record">OPENING EXISTING TOOL: ${esc(title)}</div><iframe title="${esc(title)}" src="${esc(safeHref.href)}" loading="lazy" referrerpolicy="same-origin"></iframe>`;
  }

  dispatch(name, detail) {
    this.container.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
  }

  reportError(message, error) {
    this.dispatch('xkomz:error', { message, error: String(error?.message || error || '') });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; cancelAnimationFrame(this.raf);
    this.cleanups.splice(0).forEach(cleanup => { try { cleanup(); } catch {} });
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    this.scene?.traverse(object => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach(m => m.dispose?.());
      else object.material?.dispose?.();
    });
    this.container.innerHTML = '';
  }
}

export default XKomzMasterInterface;
