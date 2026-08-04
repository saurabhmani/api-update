import{describe,it,expect}from'vitest';import{decideProcessorAuthority}from'@/lib/backtesting/queue/processorAuthority';
const state=(owner:'monolith'|'service'|'disabled',epoch=4)=>({owner,epoch,updatedAt:new Date(),updatedBy:'op'});const base={applicationVersion:'test'};
describe('processor authority decisions',()=>{it.each([
 [{processorType:'monolith',configuredOwner:'monolith',authority:state('monolith')},true,'authorized'],
 [{processorType:'monolith',configuredOwner:'monolith',authority:state('service')},false,'owner-mismatch'],
 [{processorType:'monolith',configuredOwner:'monolith',configuredEpoch:3,authority:state('monolith')},false,'epoch-mismatch'],
 [{processorType:'monolith',configuredOwner:'monolith',authority:state('disabled')},false,'owner-disabled'],
 [{processorType:'service',configuredOwner:'service',workerEnabled:true,authority:state('service')},true,'authorized'],
 [{processorType:'service',configuredOwner:'service',workerEnabled:false,authority:state('service')},false,'worker-disabled'],
 [{processorType:'service',configuredOwner:'service',workerEnabled:true,authority:state('monolith')},false,'owner-mismatch'],
 [{processorType:'service',configuredOwner:'service',configuredEpoch:3,workerEnabled:true,authority:state('service')},false,'epoch-mismatch'],
 [{processorType:'service',configuredOwner:'service',workerEnabled:true,authorityError:new Error('down')},false,'authority-unavailable'],
 [{processorType:'service',configuredOwner:'monolith',workerEnabled:true,authority:state('service')},false,'invalid-configuration'],
 [{processorType:'monolith',configuredOwner:'monolith',configuredEpoch:0,authority:state('monolith')},false,'invalid-configuration'],
 ] as any[])('%j => %s/%s',(input,allowed,reason)=>expect(decideProcessorAuthority({...base,...input} as any)).toMatchObject({allowed,reason}));});
