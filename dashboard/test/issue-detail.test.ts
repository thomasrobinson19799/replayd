// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import IssueDetail from '../app/pages/projects/[pid]/issues/[id].vue'
import Button from '../app/components/ui/Button.vue'
import Input from '../app/components/ui/Input.vue'

const event = (id: string) => ({ id, ts: 1_700_000_000_000, platform:'web', session_id:null, payload:{ message:`Event ${id}`, frames:[], tags:{}, breadcrumbs:[{cat:'click',msg:'Buy order',ts:123}] } })
const issue = (id: string) => ({ id:Number(id), title:`Issue ${id}`, source:'manual', level:'error', times_seen:1, users_seen:1, first_seen:1_700_000_000_000, last_seen:1_700_000_000_000, platform_split:{web:1}, latest_event:event(id) })
let route: ReturnType<typeof reactive<{ params:{pid:string,id:string}, fullPath:string }>>
const get=vi.fn()
beforeEach(() => {
  route=reactive({params:{pid:'demo',id:'1'},fullPath:'/projects/demo/issues/1'})
  get.mockReset().mockImplementation((path:string) => Promise.resolve(path.endsWith('/events') ? {events:[event(route.params.id)],next_cursor:'next'} : issue(route.params.id)))
  vi.stubGlobal('useRoute',()=>route); vi.stubGlobal('useApi',()=>({get}))
  vi.stubGlobal('compact',String); vi.stubGlobal('dateTime',String); vi.stubGlobal('platformLabel',String)
  vi.stubGlobal('errorMessage',()=> 'Could not load the older event. Try again.')
})
const render=()=> mount(IssueDetail,{global:{mocks:{compact:String,dateTime:String,platformLabel:String},components:{UiButton:Button,UiInput:Input},stubs:{NuxtLink:{template:'<a><slot /></a>'},UiBadge:{template:'<span><slot /></span>'},UiSkeleton:true,UiCopyButton:true,UiRelativeTime:true,UiConfirmDialog:true,UiEmptyState:true,IssueStatusBar:true,StackTrace:true}}})
describe('issue event inspection',()=>{
  it('recovers an initial loading failure without leaving the page',async()=>{
    get.mockRejectedValueOnce(new Error('network'))
    const w=render(); await flushPromises()
    expect(w.find('[role=alert]').exists()).toBe(true)
    await w.findAll('button').find(b=>b.text()==='Try again')!.trigger('click')
    await flushPromises()
    expect(w.find('[role=alert]').exists()).toBe(false)
    expect(w.text()).toContain('Event 1'); w.unmount()
  })
  it('filters breadcrumbs without hiding the issue context',async()=>{
    const w=render(); await flushPromises()
    await w.find('input[type=search]').setValue('absent')
    expect(w.text()).toContain('No breadcrumbs match.'); expect(w.text()).toContain('Issue overview')
    await w.find('input[type=search]').setValue('BUY')
    expect(w.text()).toContain('Buy order'); w.unmount()
  })
  it('prevents concurrent paging and leaves the event visible after failure',async()=>{
    const w=render(); await flushPromises()
    let reject!: (reason:Error)=>void
    get.mockImplementationOnce(()=>new Promise((_,fail)=>{reject=fail}))
    const older=w.findAll('button').find(b=>b.text()==='Older')!
    await older.trigger('click'); await older.trigger('click')
    expect(get).toHaveBeenCalledTimes(3)
    reject(new Error('network')); await flushPromises()
    expect(w.find('[role=alert]').text()).toContain('Try again')
    expect(w.text()).toContain('Event 1'); w.unmount()
  })
  it('ignores an older-page response after navigating to another issue',async()=>{
    const w=render(); await flushPromises()
    let resolve!: (value:unknown)=>void
    get.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
    await w.findAll('button').find(b=>b.text()==='Older')!.trigger('click')
    route.params.id='2'; await flushPromises()
    resolve({events:[event('stale')],next_cursor:null}); await flushPromises()
    expect(w.text()).toContain('Event 2'); expect(w.text()).not.toContain('Event stale'); w.unmount()
  })
})
