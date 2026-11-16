// Shared theme keeps the original xterm grid and phone reading view consistent.
const names = ['black','red','green','yellow','blue','magenta','cyan','white',
  'brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
const baseColors = ['#2e3436','#cc0000','#4e9a06','#c4a000','#3465a4','#75507b','#06989a','#d3d7cf',
  '#555753','#ef2929','#8ae234','#fce94f','#729fcf','#ad7fa8','#34e2e2','#eeeeec'];
export const TERMINAL_THEME = Object.freeze({background:'#0c0d0b',foreground:'#d4d8ca',cursor:'#e0a458',
  ...Object.fromEntries(names.map((name,i)=>[name,baseColors[i]]))});
const hex = n => '#' + (n & 0xffffff).toString(16).padStart(6,'0');
function palette(index, theme) {
  if (index < 16) return theme[names[index]] || baseColors[index];
  if (index >= 232) { const v=8+(index-232)*10; return hex((v<<16)|(v<<8)|v); }
  const v=[0,95,135,175,215,255], n=index-16;
  return hex((v[Math.floor(n/36)]<<16)|(v[Math.floor(n/6)%6]<<8)|v[n%6]);
}
function cellStyle(cell, theme, brightBold) {
  let fg=theme.foreground, bg=theme.background;
  if(cell.isFgRGB())fg=hex(cell.getFgColor());
  else if(cell.isFgPalette()) {
    let n=cell.getFgColor();if(brightBold&&cell.isBold()&&n<8)n+=8;
    fg=palette(n,theme);
  }
  if(cell.isBgRGB())bg=hex(cell.getBgColor());
  else if(cell.isBgPalette())bg=palette(cell.getBgColor(),theme);
  if(cell.isInverse())[fg,bg]=[bg,fg];
  const style={color:fg};
  if(bg!==theme.background)style.backgroundColor=bg;
  if(cell.isBold())style.fontWeight='bold';
  if(cell.isItalic())style.fontStyle='italic';
  if(cell.isDim())style.opacity='0.5';
  if(cell.isInvisible())style.visibility='hidden';
  const decorations=[];
  if(cell.isUnderline())decorations.push('underline');
  if(cell.isStrikethrough())decorations.push('line-through');
  if(cell.isOverline())decorations.push('overline');
  if(decorations.length)style.textDecorationLine=decorations.join(' ');
  return style;
}
function append(runs,text,style) {
  if(!text)return;
  const last=runs.at(-1);
  if(last?.style===style)last.text+=text;else runs.push({text,style});
}
function trim(runs) {
  while(runs.length) {
    const last=runs.at(-1);last.text=last.text.trimEnd();
    if(last.text)break;runs.pop();
  }
}
// Read parsed cells, not raw ANSI. Join soft wraps before the browser wraps the
// styled spans to the phone width. Width-zero cells belong to a preceding glyph.
export function styledTerminal(buffer, {limit=2000,theme=TERMINAL_THEME,brightBold=true}={}) {
  const lines=[];let current=null;
  const cell=buffer.getNullCell(), styles=new Map(), plain={color:theme.foreground};
  let lastFg=-1,lastBg=-1,lastFlags=-1,lastStyle;
  for(let i=Math.max(0,buffer.length-limit);i<buffer.length;i++) {
    const line=buffer.getLine(i);if(!line)continue;
    if(!line.isWrapped||current===null) {
      if(current!==null){trim(current);lines.push(current);}current=[];
    }
    let remaining=buffer.getLine(i+1)?.isWrapped ? Infinity : line.translateToString(true).length;
    for(let x=0;x<line.length && remaining>0;x++) {
      const c=line.getCell(x,cell);if(!c||c.getWidth()===0)continue;
      const text=c.getChars()||' ';remaining-=text.length;
      if(c.isAttributeDefault()){append(current,text,plain);continue;}
      // Reuse one style per attribute combination, not one DOM node per cell.
      const fg=c.getFgColorMode()|c.getFgColor(), bg=c.getBgColorMode()|c.getBgColor();
      const flags=(!!c.isBold()<<0)|(!!c.isItalic()<<1)|(!!c.isDim()<<2)|(!!c.isInverse()<<3)|
        (!!c.isInvisible()<<4)|(!!c.isUnderline()<<5)|(!!c.isStrikethrough()<<6)|(!!c.isOverline()<<7);
      let style=lastStyle;
      if(fg!==lastFg||bg!==lastBg||flags!==lastFlags) {
        const key=fg+':'+bg+':'+flags;style=styles.get(key);
        if(!style){style=cellStyle(c,theme,brightBold);styles.set(key,style);}
        lastFg=fg;lastBg=bg;lastFlags=flags;lastStyle=style;
      }
      append(current,text,style);
    }
  }
  if(current!==null){trim(current);lines.push(current);}
  while(lines.length&&!lines.at(-1).length)lines.pop();
  const result=[];
  for(let i=0;i<lines.length;i++) {
    if(i)append(result,'\n',plain);
    for(const run of lines[i])append(result,run.text,run.style);
  }
  return result.map(({text,style})=>({text,style}));
}
export function readableTerminal(buffer,limit=2000) {
  return styledTerminal(buffer,{limit}).map(run=>run.text).join('');
}
const snapshots=new WeakMap();
export function renderTerminalReading(element,buffer,options) {
  const runs=styledTerminal(buffer,options), previous=snapshots.get(element)||[];
  const nodes=[...element.children], fragment=element.ownerDocument.createDocumentFragment();
  const next=[];
  // Update only changed runs: appending live output must not rebuild thousands
  // of unchanged scrollback spans. Colors can change without text changing.
  for(let i=0;i<runs.length;i++) {
    const run=runs[i], styleKey=JSON.stringify(run.style);
    const span=nodes[i]||element.ownerDocument.createElement('span');
    if(!nodes[i]||previous[i]?.text!==run.text)span.textContent=run.text;
    if(!nodes[i]||previous[i]?.styleKey!==styleKey) {
      span.removeAttribute('style');Object.assign(span.style,run.style);
    }
    if(!nodes[i])fragment.append(span);
    next.push({text:run.text,styleKey});
  }
  for(let i=runs.length;i<nodes.length;i++)nodes[i].remove();
  element.append(fragment);snapshots.set(element,next);
}
