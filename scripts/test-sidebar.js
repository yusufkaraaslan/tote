const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/renderer/app.js'), 'utf8');
const classes = new Set();
const bar = {
  scrollTop: 0, scrollLeft: 0, scrollHeight: 600, clientHeight: 200,
  getBoundingClientRect: () => ({ top: 100, bottom: 300, left: 0, right: 230 }),
  classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
};
const context = vm.createContext({ $: () => bar });
vm.runInContext(source.slice(source.indexOf('function updateWsOverflow()'), source.indexOf("$('#ws-tabs').addEventListener('scroll'")), context);
context.revealWsTab(bar, { getBoundingClientRect: () => ({ top: 320, bottom: 356 }) });
assert.equal(bar.scrollTop, 64, 'reveal a workspace below the viewport');
context.revealWsTab(bar, { getBoundingClientRect: () => ({ top: 80, bottom: 116 }) });
assert.equal(bar.scrollTop, 36, 'reveal a workspace above the viewport');
context.wsDragScroll(bar, 290);
assert.equal(bar.scrollTop, 50, 'drag near bottom scrolls down');
context.wsDragScroll(bar, 110);
assert.equal(bar.scrollTop, 36, 'drag near top scrolls up');
context.wsDragScroll(bar, 200);
assert.equal(bar.scrollTop, 36, 'drag in middle does not scroll');
context.updateWsOverflow();
assert(classes.has('ovf-top') && classes.has('ovf-bottom'));
bar.scrollTop = 0;
context.updateWsOverflow();
assert(!classes.has('ovf-top') && classes.has('ovf-bottom'));
bar.scrollTop = 400;
context.updateWsOverflow();
assert(classes.has('ovf-top') && !classes.has('ovf-bottom'));
bar.scrollHeight = 200; bar.scrollTop = 0;
context.updateWsOverflow();
assert.equal(classes.size, 0, 'no overflow hints when list fits');
assert.equal(bar.scrollLeft, 0, 'sidebar never scrolls horizontally');
console.log('Sidebar vertical reveal, drag scrolling, and overflow tests passed');
