import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Line, OrbitControls, Stars } from '@react-three/drei';

const PODS = [
  ['Planet-K','planet-k'], ['KashKorner','kashkorner'], ['X-Koin’s','x-koins'],
  ['Kernelodie’s','kernelodies'], ['KernelVision','kernelvision'], ['X-Shield','x-shield'],
];

function Core() {
  const core=useRef(), shell=useRef(), halo=useRef();
  const beams = useMemo(() => Array.from({length:48}, (_,i) => {
    const a=i*Math.PI*2/48, r=0.58+(i%5)*0.095, y=(i%2?1:-1)*2.25;
    return [[Math.cos(a)*r,y,Math.sin(a)*r],[Math.cos(a)*.12,0,Math.sin(a)*.12],[Math.cos(a)*r,-y,Math.sin(a)*r]];
  }), []);
  useFrame(({clock})=>{const t=clock.elapsedTime;if(core.current)core.current.rotation.y=t*.18;if(shell.current){shell.current.rotation.y=-t*.12;shell.current.rotation.x=Math.sin(t*.17)*.12;}if(halo.current)halo.current.scale.setScalar(1+Math.sin(t*2.2)*.035);});
  return <group>
    <mesh ref={core}><icosahedronGeometry args={[0.68,2]}/><meshStandardMaterial color="#04111c" emissive="#00cfff" emissiveIntensity={2.8} wireframe/></mesh>
    <mesh ref={shell}><octahedronGeometry args={[0.43,2]}/><meshBasicMaterial color="#edffff" wireframe/></mesh>
    <mesh ref={halo}><torusGeometry args={[1.12,.012,8,160]}/><meshBasicMaterial color="#00cfff" transparent opacity={.82}/></mesh>
    {beams.map((pts,i)=><Line key={i} points={pts} color={i%4===0?'#ffffff':i%3===0?'#8df7ff':'#00bfff'} lineWidth={i%4===0?2.2:1} transparent opacity={i%4===0?.92:.65}/>)}
    {Array.from({length:3},(_,i)=><mesh key={i} rotation={[i*.7,0,i*.4]}><torusGeometry args={[1.35+i*.19,.008,6,180]}/><meshBasicMaterial color={i===1?'#1a77ff':'#00cfff'} transparent opacity={.5}/></mesh>)}
    <pointLight color="#00cfff" intensity={18} distance={11}/><pointLight color="#e7ffff" intensity={9} distance={5}/>
  </group>;
}
function WaveFloor() {
  const ref=useRef();
  const {positions,base}=useMemo(()=>{const arr=[],original=[];for(let x=-14;x<=14;x+=.32)for(let z=-10;z<=5;z+=.32){arr.push(x,-2.5,z);original.push(x,-2.5,z);}return {positions:new Float32Array(arr),base:original};},[]);
  useFrame(({clock})=>{if(!ref.current)return;const p=ref.current.geometry.attributes.position.array,t=clock.elapsedTime;for(let i=0;i<base.length;i++){const [x,,z]=base[i];p[i*3+1]=-2.5+Math.sin(x*.48+t*.8)*.18+Math.cos(z*.55-t*.6)*.14;}ref.current.geometry.attributes.position.needsUpdate=true;});
  return <points ref={ref}><bufferGeometry><bufferAttribute attach="attributes-position" count={positions.length/3} array={positions} itemSize={3}/></bufferGeometry><pointsMaterial color="#087eff" size={.022} sizeAttenuation transparent opacity={.82}/></points>;
}
function Dome({onNode}) {
 const pts=useMemo(()=>{const p=[];const n=14;for(let i=0;i<=n;i++){const phi=Math.PI*i/n;for(let j=0;j<n*2;j++){const theta=Math.PI*2*j/(n*2);p.push([4.8*Math.sin(phi)*Math.cos(theta),4.8*Math.cos(phi),4.8*Math.sin(phi)*Math.sin(theta)]);}}return p;},[]);
 const lines=useMemo(()=>{const out=[];for(let i=0;i<pts.length;i+=28){const row=[];for(let j=0;j<12;j++)row.push(pts[(i+j*2)%pts.length]);out.push(row);}return out;},[pts]);
 return <group>{lines.map((p,i)=><Line key={i} points={p} color="#075aff" lineWidth={.5} transparent opacity={.2}/>)}<mesh onClick={e=>{e.stopPropagation();onNode({id:'geodesic-dome',state:'visualization-node',source:'R3F scene'});}}><icosahedronGeometry args={[4.7,2]}/><meshBasicMaterial color="#0077ff" wireframe transparent opacity={.055}/></mesh></group>;
}
function Filaments({onNode}) {
 const nodes=useMemo(()=>Array.from({length:96},(_,i)=>{const a=i*2.39996,r=1.2+(i%13)*.29;return [Math.cos(a)*r,Math.sin(i*1.71)*2.9,Math.sin(a)*r];}),[]);
 const edges=useMemo(()=>nodes.map((p,i)=>[p,nodes[(i+1)%nodes.length],nodes[(i+7)%nodes.length]]),[nodes]);
 const group=useRef();
 useFrame(({clock})=>{if(group.current)group.current.rotation.y=Math.sin(clock.elapsedTime*.12)*.12;});
 return <group ref={group}>{edges.map((pts,i)=><Line key={'e'+i} points={pts} color={i%7===0?'#ff9d24':'#006dff'} lineWidth={i%7===0?1.25:.55} transparent opacity={i%7===0?.48:.3}/>)}{nodes.map((p,i)=><mesh key={i} position={p} onClick={e=>{e.stopPropagation();onNode({id:'mesh-node-'+i,state:'rendered-node',source:'R3F scene'});}}><sphereGeometry args={[i%9===0?.07:.028,10,10]}/><meshBasicMaterial color={i%7===0?'#ff9d24':i%5===0?'#37e5ff':'#087dff'}/></mesh>)}</group>;
}
function BinaryHighways() {
 const paths=useMemo(()=>Array.from({length:9},(_,i)=>Array.from({length:150},(_,j)=>{const t=j/149*Math.PI*2;const r=5.1+i*.115;return [Math.cos(t)*r,Math.sin(t*2+i*.7)*.16,Math.sin(t)*r];})),[]);
 const ribbons=useRef();
 useFrame(({clock})=>{if(ribbons.current)ribbons.current.rotation.y=clock.elapsedTime*.025;});
 return <group ref={ribbons}>{paths.map((p,i)=><group key={i}><Line points={p} color={i%2?'#00d9ff':'#f5a623'} lineWidth={i%2?1.5:1.2} transparent opacity={.72}/>{Array.from({length:18},(_,j)=>{const q=p[(j*8+i*5)%p.length];return <mesh key={j} position={q}><meshBasicMaterial color={i%2?'#58eaff':'#ffc25c'}/>{(i+j)%2?<boxGeometry args={[.025,.14,.025]}/>:<torusGeometry args={[.045,.009,4,8]}/>}</mesh>;})}</group>)}
 {Array.from({length:5},(_,i)=><mesh key={'ring'+i} rotation={[Math.PI/2+i*.08,0,i*.12]}><torusGeometry args={[5.6+i*.18,.009,6,240]}/><meshBasicMaterial color={i%2?'#ffad2f':'#00bfff'} transparent opacity={.55}/></mesh>)}
 </group>;
}
function Scene({onNode}) { return <><color attach="background" args={['#000000']}/><fog attach="fog" args={['#000000',13,34]}/><ambientLight intensity={.18}/><Stars radius={90} depth={55} count={2200} factor={2.2} saturation={0}/><Float speed={.45} rotationIntensity={.025} floatIntensity={.06}><Core/></Float><WaveFloor/><Dome onNode={onNode}/><Filaments onNode={onNode}/><BinaryHighways/><OrbitControls enablePan={false} minDistance={8} maxDistance={20} enableDamping dampingFactor={.045}/></>; }
function Drawer({side,close,children}) { return <section className={'drawer '+side} role="dialog" aria-modal="true"><button className="close" onClick={close} aria-label="Close drawer">×</button>{children}</section>; }
export default function App(){
 const [drawer,setDrawer]=useState(null),[node,setNode]=useState(null),[snapshot,setSnapshot]=useState(()=>{try{return typeof window.KERNEL_TELEMETRY==='function'?window.KERNEL_TELEMETRY():window.KERNEL_TELEMETRY??null;}catch{return null;}}),touchX=useRef(0);
 useEffect(()=>{const receive=e=>setSnapshot(e.detail??null);const readInitial=()=>{try{setSnapshot(typeof window.KERNEL_TELEMETRY==='function'?window.KERNEL_TELEMETRY():window.KERNEL_TELEMETRY??null);}catch{setSnapshot(null);}};readInitial();window.addEventListener('kernel:telemetry',receive);return()=>window.removeEventListener('kernel:telemetry',receive);},[]);
 const read=(...paths)=>{for(const path of paths){const v=path.split('.').reduce((o,k)=>o==null?undefined:o[k],snapshot);if(v!==undefined&&v!==null&&v!=='')return typeof v==='object'?JSON.stringify(v):String(v);}return 'UNAVAILABLE';};
 const openNode=useCallback(n=>{setNode(n);setDrawer('bottom');},[]);
 const touchStart=useCallback(e=>{touchX.current=e.touches?.[0]?.clientX??0;},[]);
 const touchEnd=useCallback(e=>{const start=touchX.current,x=e.changedTouches?.[0]?.clientX??start,dx=x-start;if(start<28&&dx>65)setDrawer('left');else if(start>window.innerWidth-28&&dx< -65)setDrawer('right');touchX.current=0;},[]);
 return <main className="app" onTouchStart={touchStart} onTouchEnd={touchEnd}>
  <Canvas onPointerMissed={()=>setDrawer(null)} className="mesh-canvas" dpr={[1,1.7]} camera={{position:[0,1.2,12],fov:52}} gl={{antialias:true,alpha:false,powerPreference:'high-performance'}}>
   <Scene onNode={openNode}/>
  </Canvas>
  {drawer==='bottom'&&<Drawer side="bottom" close={()=>setDrawer(null)}><h2>NODE TELEMETRY</h2><p className="selected">Selected visual node: {node?.id??'unknown'}</p><dl><dt>WebRTC peers</dt><dd>{read('network.peerCount','peerCount','network.peers.length')}</dd><dt>Workers</dt><dd>{read('workers.active','workerCount','workers.activeCount')} / 10,000 target</dd><dt>OPFS bytes</dt><dd>{read('storage.opfsBytes','storage.bytes','opfsBytes')}</dd><dt>Ring-WAL</dt><dd>{read('storage.ringWalStatus','storage.walStatus','ringWalStatus')}</dd></dl></Drawer>}
  {drawer==='left'&&<Drawer side="left" close={()=>setDrawer(null)}><h2>SOVEREIGN LEDGER</h2><p>Authority security records</p><p>Authority: {read('security.authorityStatus','authorityStatus')} · Signature: {read('security.signatureStatus','signatureStatus')}</p><p>SHA-256: {read('security.lastSha256','security.lastHash','lastSha256','lastHash')}</p><p>Read-back: {read('security.readbackStatus','storage.readbackStatus','readbackStatus')} · Receipts: {read('security.receiptCount','storage.receiptCount','receiptCount')}</p></Drawer>}
  {drawer==='right'&&<Drawer side="right" close={()=>setDrawer(null)}><h2>APPLICATION PODS</h2><div className="pods">{PODS.map(([name,id])=><article key={id}><strong>{name}</strong><small>{id}</small><span>STATUS {read('pods.'+id+'.status','apps.'+id+'.status')}</span></article>)}</div></Drawer>}
 </main>;
}
