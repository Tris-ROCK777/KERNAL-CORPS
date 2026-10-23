import { useEffect, useState } from 'react';

/**
 * Read-only bridge for existing runtime modules. The legacy backend files remain
 * intact and are not rewritten by the UI migration. Missing APIs report unknown,
 * never fabricated success.
 */
export function useKernelRuntime() {
 const [runtime,setRuntime]=useState({peers:'—',storage:'—',wal:'—',authority:'—',hashes:'—'});
 useEffect(()=>{
  let live=true;
  const read=()=>{
   if(!live)return;
   const s=window.__KERNEL_RUNTIME_SNAPSHOT__;
   if(s&&typeof s==='object') setRuntime({
    peers:Number.isFinite(s.peers)?s.peers:'—',
    storage:typeof s.storage==='string'?s.storage:'—',
    wal:typeof s.wal==='string'?s.wal:'—',
    authority:typeof s.authority==='string'?s.authority:'—',
    hashes:typeof s.hashes==='string'?s.hashes:'—'
   });
  };
  read(); const id=window.setInterval(read,1500);
  return()=>{live=false;window.clearInterval(id);};
 },[]);
 return runtime;
}
