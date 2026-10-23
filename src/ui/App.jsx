import React, { Suspense, useCallback, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Float, Line, OrbitControls, Stars, Text } from '@react-three/drei';
import * as THREE from 'three';

const PODS = [
  ['Planet-K','planet-k'], ['KashKorner','kashkorner'], ['X-Koin’s','x-koins'],
  ['Kernelodie’s','kernelodies'], ['KernelVision','kernelvision'], ['X-Shield','x-shield'],
];

function Core() {
  const beams = useMemo(() => Array.from({length:36}, (_,i) => {
    const a=i*Math.PI*2/36, r=0.6+(i%4)*0.08;
    return [[Math.cos(a)*r,-2.1,Math.sin(a)*r],[Math.cos(a)*0.18,0,Math.sin(a)*0.18],[Math.cos(a)*r,2.1,Math.sin(a)*r]];
  }), []);
  return <group>
    <mesh><icosahedronGeometry args={[0.82,2]}/><meshStandardMaterial color="#071a29" emissive="#00cfff" emissiveIntensity={2.4} wireframe/></mesh>
    <mesh><octahedronGeometry args={[0.45,1]}/><meshBasicMaterial color="#e8ffff" wireframe/></mesh>
    {beams.map((pts,i)=><Line key={i} points={pts} color={i%3===0?'#f6ffff':'#00cfff'} lineWidth={i%3===0?2:0.8} transparent opacity={0.75}/>)}
    <pointLight color="#00cfff" intensity={14} distance={9}/>
    <pointLight color="#f5ffff" intensity={7} distance={4}/>
  </group>;
}
function WaveDome({onNode}) {
  const points=useMemo(()=>{const p=[];for(let x=-12;x<=12;x+=.48)for(let z=-8;z<=8;z+=.48){const y=Math.sin(x*.45)*.18+Math.cos(z*.5)*.15;p.push([x,y-2.1,z]);}return p;},[]);
  return <group>
    <points><bufferGeometry><bufferAttribute attach="attributes-position" count={points.length} array={new Float32Array(points.flat())} itemSize={3}/></bufferGeometry><pointsMaterial color="#087eff" size={0.025} sizeAttenuation transparent opacity={0.68}/></points>
    <mesh onClick={onNode}><icosahedronGeometry args={[4.4,2]}/><meshBasicMaterial color="#075cff" wireframe transparent opacity={0.13}/></mesh>
  </group>;
}
function Filaments({onNode}) {
 const nodes=useMemo(()=>Array.from({length:70},(_,i)=>{const a=i*2.39996,r=1.2+(i%11)*.31;return [Math.cos(a)*r,Math.sin(i*1.71)*2.7,Math.sin(a)*r];}),[]);
 return <group>{nodes.map((p,i)=><group key={i}>
   <mesh position={p} onClick={(e)=>{e.stopPropagation();onNode({id:'mesh-node-'+i,state:'visualized',layer:'neural-filament'});}}><sphereGeometry args={[i%8===0?.075:.035,8,8]}/><meshBasicMaterial color={i%5===0?'#ffae32':'#008dff'}/></mesh>
   {i>0&&i%2===0&&<Line points={[nodes[i-1],p]} color={i%5===0?'#ff9d20':'#006cff'} lineWidth={0.65} transparent opacity={0.5}/>}
 </group>)}</group>;
}
function BinaryHighways() {
 const paths=useMemo(()=>Array.from({length:7},(_,i)=>Array.from({length:100},(_,j)=>{const t=j/99*Math.PI*2;const r=4.6+i*.13;return [Math.cos(t)*r,Math.sin(t*2+i)*.14,Math.sin(t)*r];})),[]);
 return <group>{paths.map((p,i)=><group key={i}><Line points={p} color={i%2?'#00d9ff':'#f5a623'} lineWidth={i%2?1.5:1.2} transparent opacity={0.75}/>{Array.from({length:12},(_,j)=>{const q=p[(j*8+i*3)%p.length];return <Text key={j} position={q} fontSize={0.16} color={i%2?'#58eaff':'#ffc25c'} anchorX="center" anchorY="middle">{(i+j)%2?'1':'0'}</Text>;})}</group>)}</group>;
}
function Scene({onNode}) {
 return <><color attach="background" args={['#000000']}/><fog attach="fog" args={['#000000',12,30]}/><ambientLight intensity={0.22}/><Stars radius={70} depth={40} count={1600} factor={2} saturation={0}/><Float speed={0.5} rotationIntensity={0.04} floatIntensity={0.12}><Core/></Float><WaveDome onNode={()=>onNode({id:'geodesic-dome',state:'visualized'})}/><Filaments onNode={onNode}/><BinaryHighways/><OrbitControls enablePan={false} minDistance={8} maxDistance={20} enableDamping dampingFactor={0.04}/></>;
}
function Drawer({side,close,children}) { return <section className={'drawer '+side} role="dialog" aria-modal="true"><button className="close" onClick={close} aria-label="Close drawer">×</button>{children}</section>; }
export default function App(){
 const [drawer,setDrawer]=useState(null),[node,setNode]=useState(null);
 const openNode=useCallback(n=>{setNode(n);setDrawer('bottom');},[]);
 const touchStart=useCallback(e=>{window.__kernelTouchX=e.touches?.[0]?.clientX??0;},[]);
 const touchEnd=useCallback(e=>{const x=e.changedTouches?.[0]?.clientX??0,dx=x-(window.__kernelTouchX??x);if(window.__kernelTouchX<28&&dx>65)setDrawer('left');else if(window.__kernelTouchX>window.innerWidth-28&&dx< -65)setDrawer('right');},[]);
 return <main className="app" onTouchStart={touchStart} onTouchEnd={touchEnd}>
  <Canvas className="mesh-canvas" dpr={[1,1.7]} camera={{position:[0,1.2,12],fov:52}} gl={{antialias:true,alpha:false,powerPreference:'high-performance'}}>
   <Suspense fallback={null}><Scene onNode={openNode}/></Suspense>
  </Canvas>
  {drawer==='bottom'&&<Drawer side="bottom" close={()=>setDrawer(null)}><h2>NODE TELEMETRY</h2><p>Selected: {node?.id??'mesh node'}</p><dl><dt>WebRTC peers</dt><dd>Awaiting live peer snapshot</dd><dt>Worker target</dt><dd>10,000</dd><dt>OPFS</dt><dd>Read live storage status from Overseer runtime</dd><dt>Ring-WAL</dt><dd>Append/recovery records remain owned by existing backend</dd></dl></Drawer>}
  {drawer==='left'&&<Drawer side="left" close={()=>setDrawer(null)}><h2>SOVEREIGN LEDGER</h2><p>Authority records and SHA-256 receipts are not fabricated by the visual layer.</p><p>Connect this drawer to the existing authority/security snapshot provider.</p></Drawer>}
  {drawer==='right'&&<Drawer side="right" close={()=>setDrawer(null)}><h2>APPLICATION PODS</h2><div className="pods">{PODS.map(([name,id])=><article key={id}><strong>{name}</strong><small>{id}</small><span>DUAL STATE · CONNECTOR PENDING</span></article>)}</div></Drawer>}
 </main>;
}
