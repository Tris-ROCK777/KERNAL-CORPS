import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float, Html, Line, OrbitControls, Stars } from '@react-three/drei';

const PODS = [
  ['PlanetApeX','planetapex'], ['KashKorner','kashkorner'], ['KoinKob’s','koinkobs'],
  ['Kernelodie’z','kernelodiez'], ['KernelVision','kernelvision'], ['XShield','xshield'],
];

function CoreNexus({onNode, selected}) {
  const core=useRef(), shell=useRef(), halo=useRef();
  const beams=useMemo(()=>Array.from({length:48},(_,i)=>{
    const a=i*Math.PI*2/48,r=.58+(i%5)*.095,y=(i%2?1:-1)*2.25;
    return [[Math.cos(a)*r,y,Math.sin(a)*r],[Math.cos(a)*.12,0,Math.sin(a)*.12],[Math.cos(a)*r,-y,Math.sin(a)*r]];
  }),[]);
  const select=e=>{e.stopPropagation();onNode({id:'core-nexus',kind:'CORE',source:'three-raycast',position:[0,0,0]});};
  useFrame(({clock})=>{const t=clock.elapsedTime;if(core.current){core.current.rotation.y=t*.18;core.current.rotation.x=Math.sin(t*.1)*.12;}if(shell.current){shell.current.rotation.y=-t*.12;shell.current.rotation.x=Math.sin(t*.17)*.12;}if(halo.current)halo.current.scale.setScalar(1+Math.sin(t*2.2)*.035);});
  return <group>
    <mesh ref={core} onClick={select} onPointerDown={e=>{if(e.pointerType==='touch')select(e);}}>
      <icosahedronGeometry args={[.82,2]}/><meshStandardMaterial color="#04111c" emissive="#00cfff" emissiveIntensity={2.8} wireframe/>
    </mesh>
    <mesh ref={shell}><octahedronGeometry args={[.48,2]}/><meshBasicMaterial color="#edffff" wireframe/></mesh>
    <mesh ref={halo}><torusGeometry args={[1.12,.012,8,160]}/><meshBasicMaterial color="#00cfff" transparent opacity={.82}/></mesh>
    {beams.map((pts,i)=><Line key={i} points={pts} color={i%4===0?'#ffffff':i%3===0?'#8df7ff':'#00bfff'} lineWidth={i%4===0?2.2:1} transparent opacity={i%4===0?.92:.65}/>)}
    {Array.from({length:3},(_,i)=><mesh key={i} rotation={[i*.7,0,i*.4]}><torusGeometry args={[1.35+i*.19,.008,6,180]}/><meshBasicMaterial color={i===1?'#1a77ff':'#00cfff'} transparent opacity={.5}/></mesh>)}
    {selected?.id==='core-nexus'&&<Html position={[0,1.45,0]} center distanceFactor={9} zIndexRange={[80,0]}><div className="world-telemetry"><strong>CORE NEXUS</strong><span>RAYCAST SELECTED</span><small>Runtime data is shown only when supplied by the telemetry bridge.</small></div></Html>}
    <pointLight color="#00cfff" intensity={18} distance={11}/><pointLight color="#e7ffff" intensity={9} distance={5}/>
  </group>;
}
function WaveFloor(){
 const ref=useRef();
 const {positions,base}=useMemo(()=>{const a=[];for(let x=-14;x<=14;x+=.32)for(let z=-10;z<=5;z+=.32)a.push(x,-2.5,z);const p=new Float32Array(a);return{positions:p,base:p.slice()};},[]);
 useFrame(({clock})=>{if(!ref.current)return;const attr=ref.current.geometry.attributes.position,p=attr.array,t=clock.elapsedTime;for(let i=0;i<base.length;i+=3){const x=base[i],z=base[i+2];p[i+1]=-2.5+Math.sin(x*.48+t*.8)*.18+Math.cos(z*.55-t*.6)*.14;}attr.needsUpdate=true;});
 return <points ref={ref}><bufferGeometry><bufferAttribute attach="attributes-position" count={positions.length/3} array={positions} itemSize={3}/></bufferGeometry><pointsMaterial color="#087eff" size={.022} sizeAttenuation transparent opacity={.82}/></points>;
}
function ContainmentDome({onNode}){
 const select=e=>{e.stopPropagation();onNode({id:'containment-dome',kind:'MESH',source:'three-raycast'});};
 return <group><mesh onClick={select} onPointerDown={e=>{if(e.pointerType==='touch')select(e);}}><icosahedronGeometry args={[4.7,2]}/><meshBasicMaterial color="#0077ff" wireframe transparent opacity={.055}/></mesh>
 {Array.from({length:14},(_,i)=><mesh key={i} rotation={[i*.17,i*.31,i*.12]}><torusGeometry args={[3.8+i*.055,.004,4,180]}/><meshBasicMaterial color="#075aff" transparent opacity={.14}/></mesh>)}</group>;
}
function BokehFilaments({onNode,selected}){
 const nodes=useMemo(()=>Array.from({length:120},(_,i)=>{const a=i*2.39996,r=1.2+(i%13)*.29;return[Math.cos(a)*r,Math.sin(i*1.71)*2.9,Math.sin(a)*r];}),[]);
 const group=useRef();
 useFrame(({clock})=>{if(group.current)group.current.rotation.y=Math.sin(clock.elapsedTime*.12)*.12;});
 return <group ref={group}>{nodes.map((p,i)=><mesh key={i} position={p} onClick={e=>{e.stopPropagation();onNode({id:'mesh-node-'+i,kind:'PEER-NODE',source:'three-raycast',position:p});}} onPointerDown={e=>{if(e.pointerType==='touch'){e.stopPropagation();onNode({id:'mesh-node-'+i,kind:'PEER-NODE',source:'three-raycast',position:p});}}}><sphereGeometry args={[i%9===0?.07:.028,10,10]}/><meshBasicMaterial color={i%7===0?'#ffad2f':i%5===0?'#37e5ff':'#087dff'}/>{selected?.id==='mesh-node-'+i&&<Html position={[0,.16,0]} center distanceFactor={8} zIndexRange={[80,0]}><div className="world-telemetry"><strong>{selected.id}</strong><span>RAYCAST SELECTED</span><small>{selected.source}</small></div></Html>}</mesh>)}
 {nodes.filter((_,i)=>i%3===0).map((p,i)=><Line key={'filament-'+i} points={[p,nodes[(i*3+7)%nodes.length],nodes[(i*3+19)%nodes.length]]} color={i%4===0?'#ffad2f':'#006dff'} lineWidth={i%4===0?1.1:.55} transparent opacity={i%4===0?.42:.26}/>)}</group>;
}
function BinaryHighways(){
 const paths=useMemo(()=>Array.from({length:9},(_,i)=>Array.from({length:150},(_,j)=>{const t=j/149*Math.PI*2,r=5.1+i*.115;return[Math.cos(t)*r,Math.sin(t*2+i*.7)*.16,Math.sin(t)*r];})),[]);
 const ref=useRef();
 useFrame(({clock})=>{if(ref.current)ref.current.rotation.y=clock.elapsedTime*.025;});
 return <group ref={ref}>{paths.map((p,i)=><group key={i}><Line points={p} color={i%2?'#00d9ff':'#f5a623'} lineWidth={i%2?1.5:1.2} transparent opacity={.72}/>{Array.from({length:18},(_,j)=>{const q=p[(j*8+i*5)%p.length];return <mesh key={j} position={q}><sphereGeometry args={[.025,6,6]}/><meshBasicMaterial color={i%2?'#58eaff':'#ffc25c'}/></mesh>;})}</group>)}
 {Array.from({length:5},(_,i)=><mesh key={'ring'+i} rotation={[Math.PI/2+i*.08,0,i*.12]}><torusGeometry args={[5.6+i*.18,.009,6,240]}/><meshBasicMaterial color={i%2?'#ffad2f':'#00bfff'} transparent opacity={.55}/></mesh>)}</group>;
}
function InfrastructureStations({onNode,selected}) {
 const stations = [
  {id:'worker-pool',label:'WORKER POOL',kind:'WORKERS',p:[-2.9,.25,1.15],color:'#ffad2f'},
  {id:'network-router',label:'PEER NETWORK',kind:'NETWORK',p:[2.9,.25,1.15],color:'#19cfff'},
  {id:'security-authority',label:'AUTHORITY SECURITY',kind:'SECURITY',p:[-2.9,-.95,-.75],color:'#d7f7ff'},
  {id:'opfs-storage',label:'OPFS / RING-WAL',kind:'STORAGE',p:[2.9,-.95,-.75],color:'#398cff'},
 ];
 return <group>{stations.map((s,i)=><group key={s.id} position={s.p}>
  <mesh onClick={e=>{e.stopPropagation();onNode({id:s.id,name:s.label,kind:s.kind,source:'infrastructure-station',position:s.p});}} onPointerDown={e=>{if(e.pointerType==='touch'){e.stopPropagation();onNode({id:s.id,name:s.label,kind:s.kind,source:'infrastructure-station',position:s.p});}}}>
   <octahedronGeometry args={[.22,1]}/><meshStandardMaterial color={s.color} emissive={s.color} emissiveIntensity={1.6} wireframe/>
  </mesh>
  <mesh rotation={[Math.PI/2,0,0]}><torusGeometry args={[.34,.006,5,64]}/><meshBasicMaterial color={s.color} transparent opacity={.65}/></mesh>
  <Line points={[[0,0,0],[s.p[0]*-.18,.12,s.p[2]*-.18]]} color={s.color} transparent opacity={.65}/>
  {selected?.id===s.id&&<Html position={[0,.48,0]} center distanceFactor={8} zIndexRange={[80,0]}><div className="world-telemetry"><strong>{s.label}</strong><span>INFRASTRUCTURE NODE</span><small>Runtime status: telemetry bridge required</small></div></Html>}
 </group>)}</group>;
}
function WorkerPlacement({onNode,selected}) {
 const workers=useMemo(()=>Array.from({length:24},(_,i)=>{const ring=Math.floor(i/8),a=(i%8)*Math.PI/4+ring*.19,r=1.9+ring*.82;return {id:'worker-slot-'+String(i+1).padStart(2,'0'),p:[Math.cos(a)*r,Math.sin(i*1.9)*1.15-.15,Math.sin(a)*r],live:false};}),[]);
 return <group>{workers.map((w,i)=><mesh key={w.id} position={w.p} onClick={e=>{e.stopPropagation();onNode({id:w.id,name:'WORKER PLACEMENT '+String(i+1).padStart(2,'0'),kind:'WORKER-SLOT',source:'visual-placement-fixture',position:w.p});}} onPointerDown={e=>{if(e.pointerType==='touch'){e.stopPropagation();onNode({id:w.id,name:'WORKER PLACEMENT '+String(i+1).padStart(2,'0'),kind:'WORKER-SLOT',source:'visual-placement-fixture',position:w.p});}}}>
 <dodecahedronGeometry args={[i%6===0?.095:.052,0]}/><meshBasicMaterial color={i%6===0?'#ffad2f':'#168cff'} transparent opacity={.82}/>
 </mesh>)}</group>;
}
function Scene({onNode,selected}){return <><color attach="background" args={['#000000']}/><fog attach="fog" args={['#000000',13,34]}/><ambientLight intensity={.18}/><Stars radius={90} depth={55} count={1800} factor={2.2} saturation={0}/><Float speed={.45} rotationIntensity={.025} floatIntensity={.06}><CoreNexus onNode={onNode} selected={selected}/></Float><WaveFloor/><ContainmentDome onNode={onNode}/><BokehFilaments onNode={onNode} selected={selected}/><WorkerPlacement onNode={onNode} selected={selected}/><InfrastructureStations onNode={onNode} selected={selected}/><BinaryHighways/><OrbitControls enablePan={false} minDistance={8} maxDistance={20} enableDamping dampingFactor={.045}/></>;}
function Drawer({side,close,children}){return <section className={'drawer '+side} role="dialog" aria-modal="true"><button className="close" onClick={close} aria-label="Close drawer">×</button>{children}</section>;}
class SceneErrorBoundary extends React.Component{
 constructor(props){super(props);this.state={failed:false,message:'',stack:''};}
 static getDerivedStateFromError(error){return{failed:true,message:String(error?.message??error),stack:String(error?.stack??'No stack supplied')};}
 componentDidCatch(error,info){console.error('KERNEL 3D scene failed:',error,info);this.setState({stack:[error?.stack,info?.componentStack].filter(Boolean).join('\n\nREACT COMPONENT STACK\n')});}
 render(){if(this.state.failed)return <div className="scene-fallback" role="alert"><strong>KERNEL 3D RENDERER FAILURE</strong><span>{this.state.message}</span><pre>{this.state.stack}</pre><button onClick={()=>this.setState({failed:false,message:'',stack:''})}>RETRY RENDERER</button></div>;return this.props.children;}
}
export default function App(){
 const [drawer,setDrawer]=useState(null),[node,setNode]=useState(null),[snapshot,setSnapshot]=useState(null),touchX=useRef(0);
 useEffect(()=>{let alive=true;const readInitial=()=>{try{const source=window.KERNEL_TELEMETRY;const value=typeof source==='function'?source():source;if(value&&typeof value==='object'&&alive)setSnapshot(value);}catch(error){console.error('KERNEL telemetry snapshot read failed',error);}};const receive=e=>{if(alive&&e.detail&&typeof e.detail==='object')setSnapshot(e.detail);};readInitial();window.addEventListener('kernel:telemetry',receive);const timer=window.setInterval(readInitial,1500);return()=>{alive=false;window.clearInterval(timer);window.removeEventListener('kernel:telemetry',receive);};},[]);
 const read=(...paths)=>{for(const path of paths){const value=path.split('.').reduce((o,k)=>o==null?undefined:o[k],snapshot);if(value!==undefined&&value!==null&&value!=='')return typeof value==='object'?JSON.stringify(value):String(value);}return'NO LIVE TELEMETRY';};
 const openNode=useCallback(n=>{setNode(n);setDrawer('bottom');},[]);
 const selectPod=useCallback(([name,id])=>{setNode({id,kind:'APP-POD',name,source:'pod-selector'});setDrawer('bottom');},[]);
 const touchStart=e=>{touchX.current=e.touches?.[0]?.clientX??0;};
 const touchEnd=e=>{const start=touchX.current,x=e.changedTouches?.[0]?.clientX??start,dx=x-start;if(start<28&&dx>65)setDrawer('left');else if(start>window.innerWidth-28&&dx< -65)setDrawer('right');touchX.current=0;};
 return <main className="app" onTouchStart={touchStart} onTouchEnd={touchEnd}>
  <div className="mesh-viewport"><SceneErrorBoundary><Canvas fallback={<div className="scene-fallback"><strong>KERNEL MESH</strong><span>WebGL renderer unavailable on this device.</span></div>} onPointerMissed={()=>{setNode(null);setDrawer(null);}} className="mesh-canvas" dpr={[1,1.7]} camera={{position:[0,1.2,12],fov:52}} gl={{antialias:true,alpha:false,powerPreference:'high-performance'}}><Scene onNode={openNode} selected={node}/></Canvas></SceneErrorBoundary></div>
  {drawer==='bottom'&&<Drawer side="bottom" close={()=>setDrawer(null)}><h2>NODE TELEMETRY</h2><p className="selected">{node?.name??node?.id??'unknown'} · {node?.kind??'NODE'} · {node?.source??'unknown source'}</p><dl><dt>Network · WebRTC peers</dt><dd>{read('network.peerCount','peerCount','network.peers.length')}</dd><dt>Network · latency</dt><dd>{read('network.latencyMs','network.rttMs','latencyMs','rttMs')}</dd><dt>Network · bandwidth</dt><dd>{read('network.bandwidth','network.bytesPerSecond','bandwidth')}</dd><dt>Workers · active</dt><dd>{read('workers.active','workerCount','workers.activeCount')} / 10,000 target</dd><dt>Workers · placement</dt><dd>24 visible representative placement slots; not a claim of live workers.</dd><dt>Storage · OPFS bytes</dt><dd>{read('storage.opfsBytes','storage.bytes','opfsBytes')}</dd><dt>Storage · verified shards</dt><dd>{read('storage.verifiedShardCount','storage.activeShardCount','verifiedShardCount','activeShardCount')}</dd><dt>Storage · Ring-WAL status</dt><dd>{read('storage.ringWalStatus','storage.walStatus','ringWalStatus')}</dd><dt>Storage · OPFS shard target</dt><dd>3,145,728 bytes (target; not a live measurement)</dd><dt>Security · authority</dt><dd>{read('security.authorityStatus','authorityStatus')}</dd><dt>Security · SHA-256 read-back</dt><dd>{read('security.readbackStatus','storage.readbackStatus','readbackStatus')}</dd><dt>Security · signature</dt><dd>{read('security.signatureStatus','signatureStatus')}</dd><dt>Runtime source</dt><dd>{snapshot?'KERNEL_TELEMETRY / event bridge detected':'No live telemetry bridge detected'}</dd></dl></Drawer>}
  {drawer==='left'&&<Drawer side="left" close={()=>setDrawer(null)}><h2>SOVEREIGN LEDGER</h2><p>Sovereign cryptographic ledger · live values only when supplied by the runtime telemetry bridge.</p><p>Authority: {read('security.authorityStatus','authorityStatus')} · Signature: {read('security.signatureStatus','signatureStatus')}</p><p>SHA-256: {read('security.lastSha256','security.lastHash','lastSha256','lastHash')}</p><p>Read-back: {read('security.readbackStatus','storage.readbackStatus','readbackStatus')} · Receipts: {read('security.receiptCount','storage.receiptCount','receiptCount')}</p></Drawer>}
  {drawer==='right'&&<Drawer side="right" close={()=>setDrawer(null)}><h2>APPLICATION PODS</h2><div className="pods">{PODS.map(pod=><button className="pod-card" key={pod[1]} onClick={()=>selectPod(pod)}><strong>{pod[0]}</strong><small>{pod[1]}</small><span>STATUS {read('pods.'+pod[1]+'.status','apps.'+pod[1]+'.status')}</span></button>)}</div></Drawer>}
 </main>;
}
