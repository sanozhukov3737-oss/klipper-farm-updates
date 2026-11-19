import type { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi';

export type TvFullscreenWindow={
  isFullscreen():Promise<boolean>;
  isMaximized():Promise<boolean>;
  setFullscreen(value:boolean):Promise<void>;
  maximize():Promise<void>;
  unmaximize():Promise<void>;
  outerPosition():Promise<PhysicalPosition>;
  innerSize():Promise<PhysicalSize>;
  setPosition(value:PhysicalPosition):Promise<void>;
  setSize(value:PhysicalSize):Promise<void>;
  onResized(callback:()=>void):Promise<()=>void>;
};

type Options={
  nativeWindow?:TvFullscreenWindow;
  onChange:(value:boolean)=>void;
  onExternalExit:()=>void;
};

// A previous TV must finish restoring the main window before a new TV reads
// its starting state. This queue contains window operations, never printer work.
let nativeTail:Promise<void>=Promise.resolve();
type NativeBounds={position:PhysicalPosition;size:PhysicalSize};
type NativeRestore={window:TvFullscreenWindow;maximized:boolean;bounds?:NativeBounds};
let pendingNativeRestore:NativeRestore|undefined;
const enqueueNative=(operation:()=>Promise<void>)=>{
  const result=nativeTail.then(operation);
  nativeTail=result.catch(()=>{});
  return result;
};
const finishNativeRestore=async()=>{
  const restore=pendingNativeRestore;
  if(!restore)return;
  await restore.window.setFullscreen(false);
  if(restore.maximized){
    // Windows can keep its maximized flag while retaining fullscreen bounds.
    // Force a real transition so the desktop work area is applied again.
    await restore.window.unmaximize();
    await restore.window.maximize();
  }else if(restore.bounds){
    // Restore the saved client size and outer position in physical pixels.
    await restore.window.setSize(restore.bounds.size);
    await restore.window.setPosition(restore.bounds.position);
  }
  if(pendingNativeRestore===restore)pendingNativeRestore=undefined;
};

export function createTvFullscreenSession(element:HTMLElement,options:Options){
  const document=element.ownerDocument,nativeWindow=options.nativeWindow;
  let disposed=false,expanded=false,manualExit=false,transitioning=false,revision=0;
  let original:{fullscreen:boolean;maximized:boolean}|undefined;
  let nativeRestore:NativeRestore|undefined,pending:Promise<void>|undefined,disposal:Promise<void>|undefined;
  let unlisten:(()=>void)|undefined;
  const change=(value:boolean)=>{expanded=value;if(!disposed)options.onChange(value)};

  const restoreNative=async()=>{
    if(!nativeWindow||!original)return;
    // A native fullscreen window may belong to the main application already.
    // TV must never turn that borrowed fullscreen off.
    if(!original.fullscreen&&nativeRestore&&pendingNativeRestore===nativeRestore)await finishNativeRestore();
    original=undefined;nativeRestore=undefined;
  };

  const browserChanged=()=>{
    const active=document.fullscreenElement===element;
    const externalExit=!active&&expanded&&!manualExit;
    manualExit=false;
    change(active);
    if(externalExit&&!disposed)options.onExternalExit();
  };
  const nativeResized=()=>{
    if(disposed||!expanded||transitioning)return;
    const observedRevision=revision;
    void enqueueNative(async()=>{
      if(disposed||!expanded||transitioning||revision!==observedRevision)return;
      const active=await nativeWindow!.isFullscreen();
      if(disposed||!expanded||transitioning||revision!==observedRevision)return;
      if(!active){change(false);options.onExternalExit()}
    }).catch(()=>{});
  };
  const listenerReady=nativeWindow
    ?Promise.resolve().then(()=>nativeWindow.onResized(nativeResized)).then(remove=>{
      if(disposed)remove();else unlisten=remove;
    }).catch(()=>{})
    :Promise.resolve();
  if(!nativeWindow)document.addEventListener('fullscreenchange',browserChanged);

  const nativeToggle=()=>enqueueNative(async()=>{
    if(disposed)return;
    transitioning=true;
    let attemptedEntry=false;
    try{
      if(expanded){await restoreNative();change(false);return}
      // Do not mistake a partially failed entry for fullscreen owned by the
      // main app when the user retries. Finish its original restore first.
      if(original){await restoreNative();if(disposed)return}
      // Keep failed cleanup ownership outside a disposed TV. A later TV must
      // repair it before reading the main window as a new starting state.
      await finishNativeRestore();
      if(disposed)return;
      const [fullscreen,maximized]=await Promise.all([nativeWindow!.isFullscreen(),nativeWindow!.isMaximized()]);
      if(disposed)return;
      let bounds:NativeBounds|undefined;
      if(!fullscreen&&!maximized){
        const [position,size]=await Promise.all([nativeWindow!.outerPosition(),nativeWindow!.innerSize()]);
        if(disposed)return;
        bounds={position,size};
      }
      original={fullscreen,maximized};
      if(!fullscreen){
        nativeRestore={window:nativeWindow!,maximized,bounds};
        pendingNativeRestore=nativeRestore;attemptedEntry=true;
        await nativeWindow!.setFullscreen(true);
      }
      change(true);
    }catch(error){
      // An IPC rejection must not fall through to WebView DOM fullscreen.
      // If entry changed the window before rejecting, restore immediately.
      // A failed restore retains its original state for cleanup or a retry.
      if(attemptedEntry){try{await restoreNative()}catch{/* окно уже закрывается: возврат нативного режима не обязателен */}}
      throw error;
    }finally{transitioning=false}
  });
  const browserToggle=async()=>{
    if(disposed)return;
    if(document.fullscreenElement===element){
      manualExit=true;
      try{await document.exitFullscreen();change(false)}catch(error){manualExit=false;throw error}
    }else{
      manualExit=false;
      if(!element.requestFullscreen)throw new Error('Fullscreen API unavailable');
      await element.requestFullscreen();
      change(document.fullscreenElement===element);
    }
  };
  return{
    toggle():Promise<void>{
      if(disposed)return Promise.resolve();
      if(pending)return pending;
      revision++;
      const operation=nativeWindow?nativeToggle():browserToggle();
      pending=operation.finally(()=>{pending=undefined});
      return pending;
    },
    dispose():Promise<void>{
      if(disposal)return disposal;
      disposed=true;revision++;
      document.removeEventListener('fullscreenchange',browserChanged);
      unlisten?.();unlisten=undefined;
      const restore=nativeWindow?enqueueNative(restoreNative):(pending??Promise.resolve()).catch(()=>{}).then(async()=>{
        if(document.fullscreenElement===element)await document.exitFullscreen();
      });
      disposal=restore.finally(()=>listenerReady);
      return disposal;
    },
  };
}
