import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Line, Sparkles, Text } from '@react-three/drei';
import * as THREE from 'three';

function ComputerizedCore() {
  const group = useRef();
  const beams = useMemo(() => Array.from({length: 48}, (_,i) => ({ angle: i*Math.PI*2/48, length: 1.8 + (i%7)*.19 })), []);
  useFrame(({clock}) => { if(group.current) { group.current.rotation.y = clock.elapsedTime*.12; group.current.rotation.z = Math.sin(clock.elapsedTime*.18)*.08; }});
  return <group ref={group}>
    <mesh><icosahedronGeometry args={[.9, 2]}/><meshBasicMaterial color="#bdfcff" wireframe transparent opacity={.8}/></mesh>
    <mesh><icosahedronGeometry args={[.62, 1]}/><meshBasicMaterial color="#12dfff" wireframe transparent opacity={.9}/></mesh>
    {beams.map((b,i)=><mesh key={i} rotation={[Math.cos(b.angle)*.45, b.angle, Math.sin(b.angle)*.45]} position={[Math.cos(b.angle)*.4,Math.sin(b.angle*2)*.25,Math.sin(b.angle)*.4]}>
      <cylinderGeometry args={[.012,.002,b.length,5]}/><meshBasicMaterial color={i%4===0?'#ffffff':'#16dfff'} transparent opacity={.85}/>
    </mesh>)}
    <pointLight color="#11ddff" intensity={8} distance={5}/>
  </group>;
}
function WaveFloor() {
  const ref=useRef();
  const points=useMemo(()=>{const a=[]; for(let x=-12;x<=12;x+=.32) for(let z=-7;z<=5;z+=.32) a.push([x,0,z]); return new Float32Array(a.flat());},[]);
  useFrame(({clock})=>{if(ref.current){const p=ref.current.geometry.attributes.position; for(let i=0;i<p.count;i++){const x=p.getX(i),z=p.getZ(i);p.setY(i,Math.sin(x*.7+clock.elapsedTime)*.14+Math.cos(z*.8+clock.elapsedTime*.7)*.1);}p.needsUpdate=true;}});
  return <group position={[0,-1.8,0]}><points ref={ref}><bufferGeometry><bufferAttribute attach="attributes-position" args={[points,3]}/></bufferGeometry><pointsMaterial color="#147cff" size={.025} transparent opacity={.8} sizeAttenuation/></points><mesh position={[0,2,0]}><icosahedronGeometry args={[3.3,2]}/><meshBasicMaterial color="#075fff" wireframe transparent opacity={.18}/></mesh></group>;
}
function NeuralFilaments({onSelectNode}) {
 const nodes=useMemo(()=>Array.from({length:46},(_,i)=>{const t=i*2.399, r=1.5+(i%9)*.23; return [Math.cos(t)*r,Math.sin(t*1.4)*1.8,Math.sin(t)*r];}),[]);
 return <group>{nodes.map((p,i)=><group key={i} position={p}>
  <mesh onClick={(e)=>{e.stopPropagation();onSelectNode({id:'peer-'+String(i+1).padStart(3,'0'),position:p});}} onPointerOver={(e)=>{e.stopPropagation();document.body.style.cursor='pointer';}} onPointerOut={()=>{document.body.style.cursor='default';}}>
  <sphereGeometry args={[i%6===0?.085:.035,10,10]}/><meshBasicMaterial color={i%5===0?'#ffae38':'#138cff'}/>
  </mesh><pointLight color={i%5===0?'#ff9b24':'#087bff'} intensity={i%6===0?1.2:.18} distance={1.1}/>
  {i>0&&i%2===0&&<Line points={[p,nodes[i-1]]} color={i%5===0?'#d99534':'#087bff'} transparent opacity={.35} lineWidth={1}/>}
 </group>)}</group>;
}
function BinaryHighways() {
 const ref=useRef();
 useFrame(({clock})=>{if(ref.current)ref.current.position.z=(clock.elapsedTime*1.1)%2;});
 return <group>
  {[2.3,2.8,3.35,3.9].map((r,i)=><mesh key={r} rotation={[Math.PI/2+i*.06,0,i*.12]}><torusGeometry args={[r,.012,6,144]}/><meshBasicMaterial color={i%2?'#ffb13b':'#00dfff'} transparent opacity={.58}/></mesh>)}
  <group ref={ref}>{Array.from({length:9},(_,i)=><Text key={i} position={[Math.sin(i*1.1)*3.7,Math.cos(i*.8)*1.7,-2+i*.5]} rotation={[0,Math.sin(i)*.4,0]} fontSize={.22} color={i%3?'#08cfff':'#ffb43b'} fillOpacity={.8}>{i%2?'010101 001101 101001':'101100 010011 001010'}</Text>)}</group>
  <Sparkles count={150} scale={[11,6,10]} size={1.6} speed={.25} color="#31aaff"/>
 </group>;
}
export function SceneLayers({onSelectNode}) {
 return <><ambientLight intensity={.22}/><fog attach="fog" args={['#000000',9,22]}/>
  <group><ComputerizedCore/></group>
  <group><WaveFloor/></group>
  <group><NeuralFilaments onSelectNode={onSelectNode}/></group>
  <group><BinaryHighways/></group>
 </>;
}
