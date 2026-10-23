import React from 'react';
const PODS = [
 ['Planet-K','planet-k'],['KashKorner','kashkorner'],['X-Koin’s','x-koins'],
 ['Kernelodie’s','kernelodies'],['KernelVision','kernelvision'],['X-Shield','x-shield']
];
export function GestureDrawers({active,onClose,runtime}) {
 if(!active) return null;
 return <><button className="dismiss-scrim" aria-label="Close drawer" onClick={onClose}/>
 <section className={`drawer drawer-${active.type}`} role="dialog" aria-modal="true">
  <button className="close-drawer" onClick={onClose} aria-label="Close">×</button>
  {active.type==='telemetry'&&<><h2>Node Telemetry</h2><p>Selected node: {active.node?.id ?? 'peer'}</p><dl><dt>Live WebRTC peers</dt><dd>{runtime.peers}</dd><dt>Worker target</dt><dd>10,000</dd><dt>OPFS</dt><dd>{runtime.storage}</dd><dt>Ring-WAL</dt><dd>{runtime.wal}</dd></dl></>}
  {active.type==='ledger'&&<><h2>Sovereign Ledger</h2><p>Authority and integrity records</p><dl><dt>Authority verification</dt><dd>{runtime.authority}</dd><dt>SHA-256 receipts</dt><dd>{runtime.hashes}</dd><dt>Identity guards</dt><dd>Preserved modules · unchanged</dd></dl></>}
  {active.type==='pods'&&<><h2>Kernel Pods</h2><ul className="pods">{PODS.map(([name,id])=><li key={id}><span>{name}</span><small>{id}</small><span className="pod-state">Dual-state</span></li>)}</ul></>}
 </section></>;
}
