import test from 'node:test';
import assert from 'node:assert/strict';
import { tailnetAddress, portNumber, workspaceGroups, chooseSelection, draftKey } from '../src/model.js';

test('only Tailscale IPv4 destinations and valid ports are accepted', () => {
  for (const address of ['100.64.0.1','100.127.255.254']) assert.equal(tailnetAddress(address), address);
  for (const address of ['127.0.0.1','192.168.1.1','100.128.0.1','100.63.1.1','100.64.0.256','100.64.1.1:80','100.64.1.1/path','example.com','100..1.1']) assert.throws(() => tailnetAddress(address));
  assert.equal(portNumber('47821'), 47821);
  for (const port of [-1,65536,1.5,'abc']) assert.throws(() => portNumber(port));
});
test('groups map live sessions and docs without rewriting the desktop layout', () => {
  const view = { activeGroup:'review', docs:[{ id:'d', path:'notes.md' }], groups:[
    { id:'build', name:'Build', tree:{ type:'split', a:{type:'leaf',id:'a',kind:'term',ref:'s1'}, b:{type:'leaf',id:'b',kind:'term',ref:'gone'} } },
    { id:'review', name:'Review', tree:{type:'leaf',id:'doc',kind:'doc',ref:'d'} },
  ] };
  const before = JSON.stringify(view);
  const groups = workspaceGroups(view, [{id:'s1',wsId:'w',title:'Codex'},{id:'s2',wsId:'w',title:'Shell'},{id:'foreign',wsId:'other'}], 'w');
  assert.deepEqual(groups.map(g => g.id), ['build','review','_sessions']);
  assert.equal(groups[0].panes[1].unavailable, true);
  assert.equal(groups[1].panes[0].path, 'notes.md');
  assert.equal(groups[2].panes[0].ref, 's2');
  assert.equal(chooseSelection(groups,'review','doc').pane.kind,'doc');
  assert.equal(chooseSelection(groups,'removed','removed').pane.ref,'s1');
  assert.equal(JSON.stringify(view),before);
});
test('legacy and empty layouts are usable, drafts are scoped by host and session', () => {
  assert.equal(workspaceGroups({tiling:{tree:null}},[],'w')[0].id,'legacy');
  assert.equal(workspaceGroups({},[],'w')[0].panes.length,0);
  assert.notEqual(draftKey('a','b','s'),draftKey('b','b','s'));
  assert.notEqual(draftKey('a','b','s'),draftKey('a','b','t'));
});

test('workspace entry finds running terminals behind stale or empty desktop groups', () => {
  const view={groups:[{id:'old',tree:{type:'leaf',id:'stale',kind:'term',ref:'gone'}},{id:'empty',tree:null}]};
  const groups=workspaceGroups(view,[{id:'running',wsId:'w',alive:true}],'w');
  for(const preferred of ['old','empty','removed']) {
    const selected=chooseSelection(groups,preferred,'stale',true);
    assert.equal(selected.group.id,'_sessions');assert.equal(selected.pane.ref,'running');
  }
  assert.equal(chooseSelection(groups,'empty').group.id,'empty','manual empty-group choice remains possible');
});
test('workspace entry prefers its live terminal over a dock, but preserves remembered files', () => {
  const groups=workspaceGroups({groups:[{id:'g',tree:{type:'split',a:{type:'leaf',id:'files',kind:'files'},b:{type:'leaf',id:'term',kind:'term',ref:'running'}}}]},[{id:'running',wsId:'w',alive:true}],'w');
  assert.equal(chooseSelection(groups,'g',null,true).pane.ref,'running');
  assert.equal(chooseSelection(groups,'g','files',true).pane.kind,'files');
});
