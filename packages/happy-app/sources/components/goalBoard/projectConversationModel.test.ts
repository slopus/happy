import { describe, expect, it, vi } from 'vitest';
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({}) }));
import { buildProjectConversationGroups } from './projectConversationModel';
const history = (id: string, extra = {}) => ({ sessionId: id, directory: '/p', title: id, updatedAt: 1, executed: true, ...extra });
const group = { scopePath: '/p', title: 'P', total: 80, sessions: [history('cold'), history('done'), history('busy'), history('ask'), history('deleted'), history('archived')] };
const live = (id: string, extra = {}) => ({ id, updatedAt: 2, presence: 'online', thinking: false, metadata: { path: '/p', machineId: 'm' }, agentState: {}, ...extra }) as any;
describe('project conversation navigation model', () => {
 it('preserves complete totals independently from loaded rows and never labels cold executed history completed', () => {
  const [g] = buildProjectConversationGroups([group], {}, new Set(), true, 'm', new Set());
  expect(g.total).toBe(80); expect(g.rows.find(r => r.sessionId === 'cold')?.status).toBe('history');
 });
 it('uses canonical activity, including unknown disconnected running and waiting even after opening', () => {
  const headers = { done: live('done', { agentState: { turnStatus: { status: 'completed' } } }), busy: live('busy', { thinking: true }), ask: live('ask', { agentState: { requests: { permission: {} } } }) };
  const [g] = buildProjectConversationGroups([group], headers, new Set(['done']), true, 'm', new Set());
  expect(g.rows.find(r => r.sessionId === 'done')?.status).toBe('unread');expect(g.rows.find(r => r.sessionId === 'busy')?.status).toBe('running');expect(g.rows.find(r => r.sessionId === 'ask')?.status).toBe('attention');
  const [off] = buildProjectConversationGroups([group], headers, new Set(), false, 'm', new Set());expect(off.rows.find(r => r.sessionId === 'busy')?.status).toBe('unknown');
 });
 it('excludes deletions, newer archive headers and explicit foreign bindings', () => {
  const headers = { archived: live('archived', { metadata: { path: '/p', machineId: 'm', lifecycleState: 'archived' } }), done: live('done', { metadata: { path: '/p', machineId: 'other' } }), busy: live('busy', { metadata: { path: '/p', machineId: 'm', goalBoard: { featurePath: '/other', taskId: 't' } } }) };
  const [g] = buildProjectConversationGroups([group], headers, new Set(), true, 'm', new Set(['deleted']));expect(g.rows.map(r => r.sessionId).sort()).toEqual(['ask','cold']);expect(g.total).toBe(76);
 });
 it('merges same-scope live activity beyond first page without mixing sibling paths', () => {
  const headers = { next: live('next', { thinking: true, metadata: { path: '/code', machineId: 'm', goalBoard: { featurePath: '/p' } } }), other: live('other', { thinking: true, metadata: { path: '/p2', machineId: 'm' } }) };
  const [g] = buildProjectConversationGroups([group], headers, new Set(), true, 'm', new Set());expect(g.rows[0]).toMatchObject({ sessionId: 'next', status: 'running' });expect(g.total).toBe(80);expect(g.rows.some(r => r.sessionId === 'other')).toBe(false);
 });
});
it('keeps moved stable tasks in their authoritative group, never duplicates into the former path', () => {
 const moved={...history('moved'),taskId:'GFT-abcd1234',directory:'/new/task'};
 const groups=[{scopePath:'/new',title:'New',total:1,sessions:[moved]},{scopePath:'/old',title:'Old',total:0,sessions:[]}];
 const headers={moved:live('moved',{thinking:true,metadata:{machineId:'m',path:'/old/task',goalBoard:{featurePath:'/old',taskId:'GFT-abcd1234'}}})};
 const [current,old]=buildProjectConversationGroups(groups,headers,new Set(),true,'m',new Set());
 expect(current.rows.map(r=>r.sessionId)).toEqual(['moved']);expect(current.total).toBe(1);expect(old.rows).toHaveLength(0);expect(old.total).toBe(0);
});
it('does not resurrect task-bound work omitted by the authoritative membership read',()=>{
 const groups=[{scopePath:'/p',title:'P',total:0,sessions:[]}];
 const headers={ambiguous:live('ambiguous',{thinking:true,metadata:{machineId:'m',path:'/p/task',goalBoard:{featurePath:'/p',taskId:'GFT-abcd1234'}}})};
 const [g]=buildProjectConversationGroups(groups,headers,new Set(),true,'m',new Set());expect(g.rows).toHaveLength(0);expect(g.total).toBe(0);
});

it.each(['idle', 'completed'] as const)('immediately includes an already-synced %s scope conversation before history is loaded', status => {
 const groups=[{scopePath:'/p',title:'P',total:0,sessions:[]}];
 const headers={known:live('known',{agentState:status==='completed'?{turnStatus:{status:'completed'}}:{}})};
 const [g]=buildProjectConversationGroups(groups,headers,new Set(),true,'m',new Set());
 expect(g.rows).toMatchObject([{sessionId:'known',status,directory:'/p'}]);expect(g.total).toBe(1);
});

it('keeps existing activity statuses when adding ordinary inactive headers without history',()=>{
 const groups=[{scopePath:'/p',title:'P',total:0,sessions:[]}];
 const headers={
  idle:live('idle'),
  completed:live('completed',{agentState:{turnStatus:{status:'completed'}}}),
  running:live('running',{thinking:true}),
  unread:live('unread',{agentState:{turnStatus:{status:'completed'}}}),
  permission:live('permission',{agentState:{requests:{approve:{}}}}),
 };
 const [g]=buildProjectConversationGroups(groups,headers,new Set(['unread']),true,'m',new Set());
 expect(Object.fromEntries(g.rows.map(row=>[row.sessionId,row.status]))).toEqual({
  idle:'idle',completed:'completed',running:'running',unread:'unread',permission:'attention',
 });
});

it('excludes archived, retired, deleted and foreign headers when filling an unloaded scope',()=>{
 const groups=[{scopePath:'/p',title:'P',total:0,sessions:[]}];
 const headers={
  allowed:live('allowed'),
  archived:live('archived',{metadata:{machineId:'m',path:'/p',lifecycleState:'archived'}}),
  archiveRequested:live('archiveRequested',{metadata:{machineId:'m',path:'/p',lifecycleState:'archiveRequested'}}),
  personal:live('personal',{metadata:{machineId:'m',path:'/p',flavor:'personal'}}),
  ask:live('ask',{metadata:{machineId:'m',path:'/p',flavor:'ask'}}),
  deleted:live('deleted'),
  foreign:live('foreign',{metadata:{machineId:'other',path:'/p'}}),
  sibling:live('sibling',{metadata:{machineId:'m',path:'/p2'}}),
  child:live('child',{metadata:{machineId:'m',path:'/p/child'}}),
  otherScope:live('otherScope',{metadata:{machineId:'m',path:'/p',goalBoard:{featurePath:'/p2'}}}),
 };
 const [g]=buildProjectConversationGroups(groups,headers,new Set(),true,'m',new Set(['deleted']));
 expect(g.rows.map(row=>row.sessionId)).toEqual(['allowed']);expect(g.total).toBe(1);
});

it.each(['GFT-abcd1234','legacy-task'])('does not infer membership for inactive task-bound work (%s)',taskId=>{
 const groups=[{scopePath:'/p',title:'P',total:0,sessions:[]}];
 const headers={
  allowed:live('allowed'),
  omitted:live('omitted',{metadata:{machineId:'m',path:'/p',goalBoard:{featurePath:'/p',taskId}}}),
 };
 const [g]=buildProjectConversationGroups(groups,headers,new Set(),true,'m',new Set());
 expect(g.rows.map(row=>row.sessionId)).toEqual(['allowed']);expect(g.total).toBe(1);
});
