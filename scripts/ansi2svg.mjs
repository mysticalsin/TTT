// Render ANSI terminal output (256-colour + truecolor SGR) as a macOS-style terminal SVG.
// Cells are positioned explicitly so emoji and box glyphs line up like a real terminal.
import { width } from '../lib/util.mjs';

const BASE16 = [
  '#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6',
  '#666666', '#d54e53', '#b9ca4a', '#e7c547', '#7aa6da', '#c397d8', '#70c0b1', '#eaeaea',
];

function xterm256(n) {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16, v = [0, 95, 135, 175, 215, 255];
    return `rgb(${v[Math.floor(i / 36)]},${v[Math.floor(i / 6) % 6]},${v[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const FG = '#d6d6d6';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Parse one line into runs of {text, fg, bold}. */
function runs(line) {
  const out = [];
  let fg = FG, bold = false, buf = '';
  const flush = () => { if (buf) out.push({ text: buf, fg, bold }); buf = ''; };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  while ((m = re.exec(line))) {
    buf += line.slice(last, m.index);
    last = re.lastIndex;
    flush();
    const p = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) { fg = FG; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) fg = FG;
      else if (c >= 30 && c <= 37) fg = BASE16[c - 30];
      else if (c >= 90 && c <= 97) fg = BASE16[c - 90 + 8];
      else if (c === 38 && p[i + 1] === 5) { fg = xterm256(p[i + 2]); i += 2; }
      else if (c === 38 && p[i + 1] === 2) { fg = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
    }
  }
  buf += line.slice(last);
  flush();
  return out;
}

export function ansiToSvg(text, { title = '', cols, font = 14 } = {}) {
  const lines = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  const cw = font * 0.6, lh = font * 1.5, padX = 22, top = 46, bottom = 20;
  const maxCols = cols || Math.max(...lines.map((l) => width(l)), 40);
  const W = Math.ceil(padX * 2 + maxCols * cw), H = Math.ceil(top + lines.length * lh + bottom);
  const body = lines.map((line, row) => {
    let col = 0;
    const y = top + row * lh + font;
    const spans = [];
    for (const r of runs(line)) {
      // Emit per glyph cluster where widths differ (emoji = 2 cells), else whole runs.
      let chunk = '', chunkCol = col;
      const push = () => {
        // Leading spaces become an x offset: renderers collapse them despite xml:space.
        // Renderers collapse runs of spaces even with xml:space, so every word group gets
        // its own x position (split on 2+ spaces; single spaces render fine).
        let off = 0;
        for (const part of chunk.split(/( {2,})/)) {
          if (part && part.trim() && !/^ +$/.test(part)) {
            const lead = part.length - part.trimStart().length;
            spans.push(`<text x="${(padX + (chunkCol + off + lead) * cw).toFixed(1)}" y="${y}" fill="${r.fg}"${r.bold ? ' font-weight="700"' : ''}>${esc(part.trim())}</text>`);
          }
          off += [...part].length;
        }
        chunk = '';
      };
      for (const ch of r.text) {
        const w = width(ch);
        if (w === 2 || /[▰▱▓░─│█▁▂▃▄▅▆▇·]/.test(ch)) {
          push();
          if (ch.trim()) spans.push(`<text x="${(padX + col * cw).toFixed(1)}" y="${y}" fill="${r.fg}"${w === 2 ? ` font-size="${font * 0.95}"` : ''}${r.bold ? ' font-weight="700"' : ''}${/[─▰▱]/.test(ch) ? ` textLength="${(cw * w).toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : ''}>${esc(ch)}</text>`);
          col += w;
          chunkCol = col;
          continue;
        }
        if (!chunk) chunkCol = col;
        chunk += ch;
        col += w;
      }
      push();
    }
    return spans.join('');
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1e24"/><stop offset="1" stop-color="#14161a"/></linearGradient></defs>
<rect width="${W}" height="${H}" rx="12" fill="url(#g)"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="#2c3038"/>
<circle cx="22" cy="20" r="6" fill="#ff5f57"/><circle cx="42" cy="20" r="6" fill="#febc2e"/><circle cx="62" cy="20" r="6" fill="#28c840"/>
<text x="${W / 2}" y="24.5" fill="#7d828c" font-family="-apple-system,Segoe UI,Helvetica,sans-serif" font-size="12.5" text-anchor="middle">${esc(title)}</text>
<g font-family="SF Mono,Menlo,Monaco,Consolas,monospace" font-size="${font}" xml:space="preserve" style="white-space:pre">
${body}
</g>
</svg>
`;
}
