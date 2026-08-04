import type { BacktestProcessorOwner } from './ownership';
import type { OwnershipState } from './ownershipAuthority';

export type ProcessorAuthorityReason = 'authorized'|'owner-mismatch'|'epoch-mismatch'|'owner-disabled'|'worker-disabled'|'authority-unavailable'|'invalid-configuration';
export interface ProcessorAuthorityDecision { allowed:boolean; processorType:'monolith'|'service'; configuredOwner:BacktestProcessorOwner; configuredEpoch?:number; authoritativeOwner?:BacktestProcessorOwner; authoritativeEpoch?:number; workerEnabled?:boolean; reason:ProcessorAuthorityReason; applicationVersion:string; workerVersion?:string; }
export interface ProcessorAuthorityInput { processorType:'monolith'|'service'; configuredOwner:BacktestProcessorOwner; configuredEpoch?:number; workerEnabled?:boolean; authority?:OwnershipState; authorityError?:unknown; applicationVersion:string; workerVersion?:string; }
export function decideProcessorAuthority(input:ProcessorAuthorityInput):ProcessorAuthorityDecision {
  const base={processorType:input.processorType,configuredOwner:input.configuredOwner,configuredEpoch:input.configuredEpoch,authoritativeOwner:input.authority?.owner,authoritativeEpoch:input.authority?.epoch,workerEnabled:input.workerEnabled,applicationVersion:input.applicationVersion,workerVersion:input.workerVersion};
  if(input.configuredEpoch!=null&&(!Number.isSafeInteger(input.configuredEpoch)||input.configuredEpoch<=0))return{...base,allowed:false,reason:'invalid-configuration'};
  if (input.authorityError || !input.authority) return {...base,allowed:false,reason:'authority-unavailable'};
  if (input.configuredOwner !== input.processorType) return {...base,allowed:false,reason:'invalid-configuration'};
  if (input.processorType==='service' && input.workerEnabled!==true) return {...base,allowed:false,reason:'worker-disabled'};
  if (input.authority.owner==='disabled') return {...base,allowed:false,reason:'owner-disabled'};
  if (input.authority.owner!==input.processorType) return {...base,allowed:false,reason:'owner-mismatch'};
  if (input.configuredEpoch != null && input.configuredEpoch!==input.authority.epoch) return {...base,allowed:false,reason:'epoch-mismatch'};
  return {...base,allowed:true,reason:'authorized'};
}
