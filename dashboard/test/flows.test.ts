// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Account from '../app/pages/account.vue'
import Users from '../app/pages/users.vue'
import Button from '../app/components/ui/Button.vue'
import Input from '../app/components/ui/Input.vue'
import Badge from '../app/components/ui/Badge.vue'
import Card from '../app/components/ui/Card.vue'
import DataTable from '../app/components/ui/DataTable.vue'
const post = vi.fn(), patch = vi.fn(), del = vi.fn(), show = vi.fn()
const people = [{id:2,email:'member@example.test',name:'Member',is_superadmin:false,disabled:false,created_at:1}]
const get = vi.fn().mockResolvedValue({users:people})
const components = { UiButton:Button, UiInput:Input, UiBadge:Badge, UiCard:Card, UiDataTable:DataTable }
const stubs = { UiModal: { props:['modelValue'], template:'<div v-if="modelValue"><slot /></div>' }, UiConfirmDialog: { props:['modelValue'], emits:['confirm'], template:'<button v-if="modelValue" data-confirm @click="$emit(\'confirm\')">Confirm change</button>' }, UiRelativeTime:true, UiSkeleton:true, UiEmptyState:true }
beforeEach(() => {
  vi.clearAllMocks(); post.mockResolvedValue({}); patch.mockResolvedValue({}); del.mockResolvedValue({})
  vi.stubGlobal('useApi', () => ({post,patch,del,get})); vi.stubGlobal('useToast', () => ({show}))
  vi.stubGlobal('useSessionStore', () => ({isSuperadmin:true, me:{id:1,name:'Admin',email:'admin@example.test'},fetchMe:vi.fn()}))
  vi.stubGlobal('errorMessage', () => 'Request failed. Try again.')
})
describe('account flow', () => {
  it('blocks mismatches, sends only password fields, clears secrets after success', async () => {
    const w = mount(Account,{global:{components}})
    const inputs = w.findAll('input'); await inputs[0]!.setValue('current-password'); await inputs[1]!.setValue('new-password'); await inputs[2]!.setValue('different-password')
    await w.find('form').trigger('submit'); expect(post).not.toHaveBeenCalled(); expect(w.text()).toContain('Passwords do not match')
    await inputs[2]!.setValue('new-password'); await w.find('form').trigger('submit'); await flushPromises()
    expect(post).toHaveBeenCalledWith('/me/password',{current_password:'current-password',new_password:'new-password'})
    expect((inputs[0]!.element as HTMLInputElement).value).toBe(''); expect(show).toHaveBeenCalled()
  })
  it('keeps the form recoverable on API failure', async () => {
    post.mockRejectedValueOnce(new Error('failure')); const w=mount(Account,{global:{components}})
    for (const input of w.findAll('input')) await input.setValue('valid-password')
    await w.find('form').trigger('submit'); await flushPromises(); expect(w.find('[role=alert]').text()).toContain('Try again'); expect(w.find('button').attributes('disabled')).toBeUndefined()
  })
})
describe('user management', () => {
  it('validates creation and uses the existing user API', async () => {
    const w=mount(Users,{global:{components,stubs}}); await flushPromises()
    await w.findAll('button').find(b=>b.text()==='Create user')!.trigger('click')
    const inputs=w.find('form').findAll('input'); await inputs[0]!.setValue('New user'); await inputs[1]!.setValue('new@example.test'); await inputs[2]!.setValue('short')
    await w.find('form').trigger('submit'); expect(post).not.toHaveBeenCalled()
    await inputs[2]!.setValue('initial-password'); await w.find('form').trigger('submit'); await flushPromises()
    expect(post).toHaveBeenCalledWith('/users',expect.objectContaining({email:'new@example.test',password:'initial-password'}))
  })
  it('confirms disabling and submits an admin password reset', async () => {
    const w=mount(Users,{global:{components,stubs}}); await flushPromises()
    await w.findAll('button').find(b=>b.text()==='Disable')!.trigger('click'); expect(patch).not.toHaveBeenCalled()
    await w.find('[data-confirm]').trigger('click'); await flushPromises(); expect(patch).toHaveBeenCalledWith('/users/2',{disabled:true})
    await w.findAll('button').find(b=>b.text()==='Edit / reset password')!.trigger('click')
    await w.find('form input[type=password]').setValue('replacement-password'); await w.find('form').trigger('submit'); await flushPromises()
    expect(patch).toHaveBeenCalledWith('/users/2',expect.objectContaining({password:'replacement-password'}))
  })
})
