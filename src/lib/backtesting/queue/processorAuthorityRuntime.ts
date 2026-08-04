import { MysqlBacktestOwnershipAuthority } from './ownershipAuthority';
import { decideProcessorAuthority, type ProcessorAuthorityDecision } from './processorAuthority';
import type { BacktestProcessorOwner } from './ownership';

export class ProcessorAuthorityRuntime {
  private last?: ProcessorAuthorityDecision; private lastSuccess?:Date; private lastFailure?:Date;
  constructor(private readonly input:{processorType:'monolith'|'service';configuredOwner:BacktestProcessorOwner;configuredEpoch?:number;workerEnabled?:boolean;applicationVersion:string;workerVersion?:string;processorId:string},private readonly authority=new MysqlBacktestOwnershipAuthority()) {}
  async refresh():Promise<ProcessorAuthorityDecision>{
    let decision:ProcessorAuthorityDecision;
    try { const state=await this.authority.read(); this.lastSuccess=new Date(); decision=decideProcessorAuthority({...this.input,authority:state}); }
    catch(error){this.lastFailure=new Date();decision=decideProcessorAuthority({...this.input,authorityError:error});}
    const changed=!this.last||this.last.allowed!==decision.allowed||this.last.reason!==decision.reason||this.last.authoritativeEpoch!==decision.authoritativeEpoch||this.last.authoritativeOwner!==decision.authoritativeOwner;
    if(changed) console.info(JSON.stringify({event:decision.allowed?'backtest_processor_authorized':'backtest_processor_configuration_drift',processorId:this.input.processorId,...decision,timestamp:new Date().toISOString()}));
    this.last=decision; return decision;
  }
  snapshot(){return{decision:this.last,lastAuthorityRefreshSuccess:this.lastSuccess?.toISOString(),lastAuthorityRefreshFailure:this.lastFailure?.toISOString()};}
}
