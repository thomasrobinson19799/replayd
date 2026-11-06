import { expect, it } from 'vitest'
import { COPY_BREADCRUMBS, copyStack, visibleFrames } from '../app/utils/copy-stack'
import type { IssueEvent } from '../app/utils/types'
const event: IssueEvent = {
  id:'event',ts:1000,session_id:null,level:'error',release:'v1',environment:'prod',platform:'web',url:'https://example.test/page',
  user_id:'EXCLUDED_USER_ID',user_email:'EXCLUDED_EMAIL',user_name:'EXCLUDED_NAME',client_ip:'EXCLUDED_IP',browser:'Chrome',os:'Linux',app_version:'app-2',
  payload:{
    type:'TypeError',message:'Unable to submit',stack:'raw stack fallback',tags:{tenant:'EXCLUDED_TAG'},user:{id:'EXCLUDED_USER_ID',email:'EXCLUDED_EMAIL',name:'EXCLUDED_NAME'},custom_fields:{billing:'EXCLUDED_CUSTOM'},
    frames:[{in_app:true,function:'minified',url:'https://example.test/app.js',line:1,col:2,orig:{file:'Order.vue',function:'submit',line:20,col:3,pre:['before'],context:'throw error',post:['after']}},{in_app:false,function:'vendorOnly',url:'vendor.js',line:1,col:1}],
    browser_ver:'140',ctx:{app:{device:'Phone',webview:'140',email:'EXCLUDED_EMAIL'},http:{method:'POST',url:'/orders',status:500,ms:42,user:'EXCLUDED_USER_ID'},ws:{url:'wss://example.test',code:1006,reconnects:2,ip:'EXCLUDED_IP'},component:'OrderPanel',info:'render' } as unknown as IssueEvent['payload']['ctx'],
    breadcrumbs:Array.from({length:40},(_,i)=>({ts:i*1000,cat:'click',msg:`breadcrumb-${i}`,data:{email:'EXCLUDED_EMAIL'}})),
  },
}
it('copies the visible symbolicated frames and source context, with bounded breadcrumbs',()=>{
  const text=copyStack(event,true)
  expect(text).toContain('TypeError: Unable to submit')
  expect(text).toContain('submit (Order.vue:20:3)')
  expect(text).toContain('19 | before');expect(text).toContain('20 | throw error');expect(text).toContain('21 | after')
  expect(text).not.toContain('vendorOnly');expect(copyStack(event,false)).toContain('vendorOnly')
  expect(text).toContain(`Recent breadcrumbs (${COPY_BREADCRUMBS})`)
  expect(text).toContain('breadcrumb-39');expect(text).not.toContain('breadcrumb-9\n')
  for(const value of ['v1','prod','web','Chrome 140','Linux','Phone','https://example.test/page','POST','wss://example.test','OrderPanel']) expect(text).toContain(value)
  expect(text).not.toContain('EXCLUDED_')
})
it('falls back to raw stack and keeps all frames when none are in-app',()=>{
  expect(copyStack({...event,payload:{...event.payload,frames:[]}},true)).toContain('raw stack fallback')
  expect(visibleFrames([{in_app:false,line:1,col:1}],true)).toHaveLength(1)
})
