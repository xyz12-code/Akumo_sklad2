// Run with: node --test tests/search.test.cjs
// Minimal DOM harness tests application behavior, not browser layout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
class Element {
  constructor(tag = '') { this.tag = tag; this.children = []; this.listeners = {}; this.attrs = {}; this.value = ''; }
  set textContent(text) { this.children = [String(text)]; }
  get textContent() { return this.children.map(x => typeof x === 'string' ? x : x.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute(name, value) { this.attrs[name] = value; }
  focus() { this.focused = true; }
}
function harness(history = null, storageBlocked = false) {
  const elements = new Map();
  const state = { mode: 'ok', saved: history, timers: new Map() };
  const context = vm.createContext({
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
      createElement: tag => new Element(tag),
      createDocumentFragment: () => new Element('fragment'),
      createTextNode: text => { const node = new Element('text'); node.textContent = text; return node; }
    },
    localStorage: {
      getItem() { if (storageBlocked) throw Error('blocked'); return state.saved; },
      setItem(key, value) { assert.equal(key, 'skladHistorie'); if (storageBlocked) throw Error('blocked'); state.saved = value; }
    },
    AbortController,
    setTimeout(fn) { const id = Symbol(); state.timers.set(id, fn); return id; },
    clearTimeout(id) { state.timers.delete(id); },
    fetch: async (file, {signal}) => {
      if (state.mode === 'timeout') return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('timeout'))));
      if (file === 'data_table2.json' && state.mode === 'network') throw Error('network');
      return {
        ok: !(file === 'data_table2.json' && state.mode === 'http'),
        json: async () => {
          if (file === 'data_table2.json' && state.mode === 'invalid') return JSON.parse('{bad');
          if (file === 'data_table2.json' && state.mode === 'schema') return {bad: {nested: true}};
          return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
        }
      };
    }
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  const settled = () => new Promise(resolve => setImmediate(resolve));
  const search = q => { elements.get('query').value = q; elements.get('search-form').listeners.submit({preventDefault() {}}); };
  const count = () => elements.get('vysledek').children[0]?.children.length || 0;
  return {state, elements, run, settled, search, count};
}
test('actual schema, Enter search, accents, fragments, location, codes, highlighting', async () => {
  const h = harness();
  assert.equal(h.elements.get('search-button').disabled, true);
  assert.match(h.elements.get('load-status').textContent, /Načítám/);
  await h.settled();
  assert.equal(h.run('databaze.length'), 245);
  assert.equal(h.run('ready'), true);
  for (const [query, expected] of [['HLAV',6],['bui350',1],['vpravo',75],['[bosch]',1],['xyznothing',0]]) {
    h.search(query); assert.equal(h.count(), expected, query);
  }
  h.search('bosch elektro'); assert(h.count() > 0);
  assert(h.run("databaze.filter(x => ['bosch','elektro'].every(t=>x.searchable.includes(t))).length") === h.count());
  h.search('loziska'); assert.match(h.elements.get('vysledek').textContent, /Ložiska/);
  const highlighted = h.run("highlight('Ložiska', ['lozis'])");
  assert.equal(highlighted.children[0].tag, 'mark'); assert.equal(highlighted.children[0].textContent, 'Ložis');
  const combining = h.run("highlight('a\\u0301', ['a'])"); assert.equal(combining.children[0].textContent, 'a\u0301');
  h.search('sloupec A'); assert(h.count() > 0);
  h.search('   '); assert.equal(h.count(),0); assert.match(h.elements.get('result-status').textContent,/Zadej/);
  assert.equal(h.run("validateData({'Same':'Left'}).concat(validateData({'Same':'Right'})).length"),2);
});
test('safe history, existing storage, ten-item limit and click reuse', async () => {
  const h = harness(JSON.stringify(['bosch','yamaha'])); await h.settled();
  const list = h.elements.get('history').children[1]; list.children[0].listeners.click(); assert(h.count()>0);
  const malicious = '<img src=x onerror=alert(1)>\'"'; h.search(malicious);
  assert.equal(h.elements.get('history').children[1].children[0].textContent, malicious);
  assert.equal(JSON.parse(h.state.saved)[0],malicious);
  for(let i=0;i<12;i++) h.search('test'+i);
  assert.equal(JSON.parse(h.state.saved).length,10);
  h.search('test5'); assert.equal(JSON.parse(h.state.saved)[0],'test5'); assert.equal(JSON.parse(h.state.saved).length,10);
  const reloaded = harness(h.state.saved); await reloaded.settled(); assert.equal(reloaded.elements.get('history').children[1].children[0].textContent,'test5');
  for(const saved of ['{bad','{}','[null,42,"bosch"]']) { const x=harness(saved); await x.settled(); x.search('bosch'); assert(x.count()>0); }
  const blocked=harness(null,true); await blocked.settled(); blocked.search('bosch'); assert(blocked.count()>0);
});
test('HTTP, network, malformed JSON/schema, timeout, no partial results, retry', async () => {
  const h=harness(); await h.settled();
  for(const mode of ['http','network','invalid','schema','timeout']) {
    h.state.mode=mode;
    const pending=h.run('loadData()');
    if(mode==='timeout') for(const fn of h.state.timers.values()) fn();
    await pending;
    assert.equal(h.run('ready'),false); assert.equal(h.run('databaze.length'),0);
    assert.equal(h.elements.get('search-button').disabled,true);
    assert.equal(h.elements.get('retry').hidden,false);
    assert.match(h.elements.get('load-status').textContent,/nepodařilo/);
    assert.equal(h.elements.get('vysledek').attrs['aria-busy'],'false');
    h.search('bosch'); assert.equal(h.count(),0);
    h.state.mode='ok'; await h.elements.get('retry').listeners.click();
    assert.equal(h.run('ready'),true); h.search('bosch'); assert(h.count()>0);
  }
  assert.equal(h.state.timers.size,0);
});
