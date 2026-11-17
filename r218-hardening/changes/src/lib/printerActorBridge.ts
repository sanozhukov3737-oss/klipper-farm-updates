import { secureInvoke } from './auth';
import type { PrinterCapabilities, PrinterStatus } from '../types';

export type NativeIdentityAttestation={signals?:unknown;attestedAt?:number;verified?:boolean};
export type PrinterActorPhase='discovered'|'identifying'|'ready'|'operating'|'printing'|'degraded'|'recovering'|'quarantined';
export type PrinterActorCapabilities=PrinterCapabilities;
export type PrinterActorPresentation={generation:number;connectionState:'online'|'connecting'|'degraded'|'offline';reason:PrinterStatus['connectionReason'];message:string;channel:string;port:number;dataAgeMs?:number;jobAgeMs?:number};
export type PrinterStatusTimestamps={telemetryUpdatedAt?:number|null;nozzleUpdatedAt?:number|null;bedUpdatedAt?:number|null;jobUpdatedAt?:number|null};
export type PrinterActorSnapshot=PrinterStatusTimestamps&{stableId:string;printerId:string;modelId?:string;host:string;activePort:number;activeProtocol:string;sessionEpoch:number;phase:PrinterActorPhase;connected:boolean;lastSeenAt?:number;cachedStatus?:Record<string,any>;capabilities:PrinterActorCapabilities;lastError?:string;presentation?:PrinterActorPresentation;identityAttestation?:NativeIdentityAttestation};
export type PrinterActorEvent=PrinterStatusTimestamps&{eventId:number;stableId:string;printerId:string;sessionEpoch:number;kind:string;phase:PrinterActorPhase;eventtime?:number;status?:Record<string,any>;operationId?:string;payload?:unknown};
export type PrinterActorOperationResult={operationId:string;sessionEpoch:number;state:'created'|'queued'|'sent'|'confirmed'|'cancelled'|'unknown'|'recovered'|'failed';recovered:boolean;result:any};
export type PrinterActorDesktopUpdates={snapshots:PrinterActorSnapshot[];events:PrinterActorEvent[]};
export type ActorBridgeSubscription={
  printerId:string;
  host:string;
  onSnapshot:(snapshot:PrinterActorSnapshot)=>void;
  onEvent:(event:PrinterActorEvent)=>void;
  onMissing:()=>void;
  onError:(error:unknown)=>void;
};

const actorBridgeSubscriptions=new Set<ActorBridgeSubscription>();
let actorBridgeTimer:number|undefined;
let actorBridgeInFlight=false;
let actorBridgeNextEventsAt=0;
const actorBridgeKey=(printerId:string,host:string)=>`${printerId}\u0000${host.trim().toLowerCase()}`;
const scheduleActorBridge=(delay=0)=>{
  if(!actorBridgeSubscriptions.size||actorBridgeTimer!==undefined)return;
  actorBridgeTimer=window.setTimeout(()=>{actorBridgeTimer=undefined;void pollActorBridge()},delay);
};
const pollActorBridge=async()=>{
  if(!actorBridgeSubscriptions.size)return;
  if(actorBridgeInFlight){scheduleActorBridge(250);return}
  actorBridgeInFlight=true;
  try{
    const unique=new Map<string,{printerId:string;host:string}>();
    for(const subscription of actorBridgeSubscriptions)unique.set(actorBridgeKey(subscription.printerId,subscription.host),{printerId:subscription.printerId,host:subscription.host});
    const now=Date.now(),includeEvents=now>=actorBridgeNextEventsAt;
    if(includeEvents)actorBridgeNextEventsAt=now+5_000;
    const updates=await secureInvoke<PrinterActorDesktopUpdates>('printer_actor_snapshots',{targets:[...unique.values()],includeEvents});
    const snapshots=new Map(updates.snapshots.map(snapshot=>[actorBridgeKey(snapshot.printerId,snapshot.host),snapshot]));
    for(const subscription of [...actorBridgeSubscriptions]){
      const snapshot=snapshots.get(actorBridgeKey(subscription.printerId,subscription.host));
      if(snapshot)subscription.onSnapshot(snapshot);else subscription.onMissing();
    }
    for(const event of updates.events){
      for(const subscription of [...actorBridgeSubscriptions])if(subscription.printerId===event.printerId)subscription.onEvent(event);
    }
  }catch(error){
    for(const subscription of [...actorBridgeSubscriptions])subscription.onError(error);
  }finally{
    actorBridgeInFlight=false;
    if(actorBridgeSubscriptions.size)scheduleActorBridge(document.hidden?4_000:1_000);
  }
};
export const subscribeActorBridge=(subscription:ActorBridgeSubscription)=>{
  actorBridgeSubscriptions.add(subscription);
  scheduleActorBridge();
  return()=>{
    actorBridgeSubscriptions.delete(subscription);
    if(!actorBridgeSubscriptions.size&&actorBridgeTimer!==undefined){window.clearTimeout(actorBridgeTimer);actorBridgeTimer=undefined}
  };
};

