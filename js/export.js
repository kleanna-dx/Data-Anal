/* ============================================================
   export.js
   도면 내보내기 (SVG / DXF / PDF / JSON) — 기계도면 전용

   지원 요소: outline, centerline, hiddenline, hole, slot, hatch, dimension, text

   v5: placeholder 요소 내보내기 지원
       _isPlaceholder=true 요소는 SVG에 data-placeholder 속성 포함
       DXF에는 PLACEHOLDER 레이어로 분리
   ============================================================ */

const Exporter = (() => {

  // ========== SVG Export ==========
  function exportSVG(doc) {
    const svgStr = buildSVGString(doc, true);
    download(svgStr, `${doc.meta.title || 'drawing'}.svg`, 'image/svg+xml');
    return svgStr;
  }

  /**
   * SVG 문자열 생성 (exportSVG, exportPDF 공용)
   */
  function buildSVGString(doc, withXmlDecl = false) {
    const bounds = DrawingModel.getAllBounds(doc.elements);
    const padding = 60;
    const w = bounds.width + padding * 2;
    const h = bounds.height + padding * 2;
    const vx = bounds.x - padding;
    const vy = bounds.y - padding;

    let svg = '';
    if (withXmlDecl) {
      svg += `<?xml version="1.0" encoding="UTF-8"?>\n`;
    }
    svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vx} ${vy} ${w} ${h}">\n`;

    svg += `<defs>
  <marker id="dimArrowStart" markerWidth="8" markerHeight="8" refX="0" refY="4" orient="auto">
    <path d="M 8 0 L 0 4 L 8 8" fill="none" stroke="#60a5fa" stroke-width="1"/>
  </marker>
  <marker id="dimArrowEnd" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto">
    <path d="M 0 0 L 8 4 L 0 8" fill="none" stroke="#60a5fa" stroke-width="1"/>
  </marker>
</defs>\n`;
    svg += `<style>
  text { font-family: 'Arial', 'Helvetica', sans-serif; }
  .outline { stroke-linecap: round; }
</style>\n`;

    svg += `<rect x="${vx}" y="${vy}" width="${w}" height="${h}" fill="#f0e68c"/>\n`;

    // 클립 정의 (해칭용)
    let defsContent = '';
    let hatchIndex = 0;

    doc.elements.forEach(el => {
      if (doc.layers[el.layer] && !doc.layers[el.layer].visible) return;

      // v5: confidence + placeholder 태그
      const confTag = el.confidence ? ` data-confidence="${el.confidence}"` : '';
      const phTag = el._isPlaceholder ? ' data-placeholder="true"' : '';

      switch (el.type) {
        case 'outline':
          const edgeTag = el._edgeType ? ` data-edge-type="${el._edgeType}"` : '';
          svg += `<line class="outline"${confTag}${phTag}${edgeTag} x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${el.color || '#333'}" stroke-width="${el.thickness || 2}" stroke-linecap="round"${el.confidence === 'estimated' ? ' stroke-dasharray="6 3" opacity="0.7"' : ''}${el.confidence === 'uncertain' ? ' stroke-dasharray="2 4" opacity="0.4" stroke="#fbbf24"' : ''}${el._isPlaceholder ? ' stroke-dasharray="3 5" opacity="0.45" stroke="#6b7280"' : ''}/>\n`;
          break;

        case 'centerline':
          svg += `<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${el.color || '#f87171'}" stroke-width="${el.thickness || 0.8}" stroke-dasharray="12 3 2 3" stroke-linecap="round"/>\n`;
          break;

        case 'hiddenline':
          svg += `<line class="hiddenline"${confTag}${phTag} x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${el.color || '#4ade80'}" stroke-width="${el.thickness || 1}" stroke-dasharray="6 3" stroke-linecap="round"/>\n`;
          break;

        case 'hole':
          svg += renderHoleSVG(el);
          break;

        case 'slot':
          svg += renderSlotSVG(el);
          break;

        case 'hatch': {
          const hId = `hatch_clip_${hatchIndex++}`;
          const hResult = renderHatchSVG(el, hId);
          defsContent += hResult.defs;
          svg += hResult.content;
          break;
        }

        case 'dimension':
          svg += renderDimensionSVG(el);
          break;

        case 'text': {
          const textFill = el._isPlaceholder ? '#6b7280' : (el.color || '#333');
          const textStyle = el._isPlaceholder ? ' font-style="italic" text-decoration="underline"' : '';
          svg += `<text${confTag}${phTag} x="${el.x}" y="${el.y}" fill="${textFill}" font-size="${el.fontSize || 14}" font-weight="${el.fontWeight || 'normal'}"${textStyle}${el._isPlaceholder ? ' opacity="0.45"' : ''}>${escapeXml(el.content)}</text>\n`;
          break;
        }
      }
    });

    if (defsContent) {
      svg = svg.replace('</defs>\n', `${defsContent}</defs>\n`);
    }

    svg += '</svg>';
    return svg;
  }

  // ---------- SVG Sub-renderers ----------

  function renderDimensionSVG(el) {
    const isH = Math.abs(el.y2 - el.y1) < Math.abs(el.x2 - el.x1);
    const off = el.offset || 30;
    let lx1, ly1, lx2, ly2;

    if (isH) {
      ly1 = ly2 = Math.min(el.y1, el.y2) - off;
      lx1 = el.x1; lx2 = el.x2;
    } else {
      lx1 = lx2 = Math.min(el.x1, el.x2) - off;
      ly1 = el.y1; ly2 = el.y2;
    }

    const c = el.color || '#60a5fa';
    const fs = el.fontSize || 12;
    const textStr = String(el.value || '');
    const textWidth = textStr.length * fs * 0.65;
    const dimSpan = Math.sqrt((lx2 - lx1) ** 2 + (ly2 - ly1) ** 2);
    const isNarrow = dimSpan < textWidth + 20;

    let svg = `<g class="dimension">\n`;
    // Extension lines
    svg += `  <line x1="${el.x1}" y1="${el.y1}" x2="${lx1}" y2="${ly1}" stroke="${c}" stroke-width="0.5" stroke-dasharray="2 2"/>\n`;
    svg += `  <line x1="${el.x2}" y1="${el.y2}" x2="${lx2}" y2="${ly2}" stroke="${c}" stroke-width="0.5" stroke-dasharray="2 2"/>\n`;
    // Dimension line — arrows always point inward (third picture rule, NEVER reversed)
    svg += `  <line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="${c}" stroke-width="1" marker-start="url(#dimArrowStart)" marker-end="url(#dimArrowEnd)"/>\n`;

    if (!isNarrow) {
      // Normal: text centered between arrows
      const midX = (lx1 + lx2) / 2;
      const midY = (ly1 + ly2) / 2;
      svg += `  <text x="${midX}" y="${midY - 4}" text-anchor="middle" fill="${c}" font-size="${fs}" font-family="Arial">${escapeXml(textStr)}</text>\n`;
    } else {
      // Narrow: text outside with leader line
      if (isH) {
        const leaderEndX = lx2 + textWidth + 15;
        svg += `  <line x1="${lx2}" y1="${ly2}" x2="${leaderEndX}" y2="${ly2}" stroke="${c}" stroke-width="0.5"/>\n`;
        svg += `  <text x="${lx2 + 4}" y="${ly2 - 3}" text-anchor="start" fill="${c}" font-size="${fs}" font-family="Arial">${escapeXml(textStr)}</text>\n`;
      } else {
        const elbowY = Math.max(ly1, ly2) + 5;
        const leaderEndX = lx1 + textWidth + 15;
        svg += `  <line x1="${lx1}" y1="${elbowY}" x2="${leaderEndX}" y2="${elbowY}" stroke="${c}" stroke-width="0.5"/>\n`;
        svg += `  <text x="${lx1 + 4}" y="${elbowY - 3}" text-anchor="start" fill="${c}" font-size="${fs}" font-family="Arial">${escapeXml(textStr)}</text>\n`;
      }
    }

    svg += `</g>\n`;
    return svg;
  }

  function renderHoleSVG(el) {
    const r = el.diameter / 2;
    const c = el.color || '#a78bfa';
    let s = `<g class="hole">`;
    s += `<circle cx="${el.cx}" cy="${el.cy}" r="${r}" fill="none" stroke="${c}" stroke-width="1.5"`;
    if (el.holeType === 'tap') s += ` stroke-dasharray="3 2"`;
    s += `/>\n`;

    const cm = r * 0.4;
    s += `<line x1="${el.cx - cm}" y1="${el.cy}" x2="${el.cx + cm}" y2="${el.cy}" stroke="${c}" stroke-width="0.5"/>`;
    s += `<line x1="${el.cx}" y1="${el.cy - cm}" x2="${el.cx}" y2="${el.cy + cm}" stroke="${c}" stroke-width="0.5"/>`;

    if (el.tapSpec) {
      s += `<text x="${el.cx + r + 4}" y="${el.cy - r - 2}" fill="${c}" font-size="9" font-family="Arial">${escapeXml(el.tapSpec)}</text>`;
    }
    s += `</g>\n`;
    return s;
  }

  function renderSlotSVG(el) {
    const c = el.color || '#fbbf24';
    const rx = el.height / 2;
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    let s = `<g class="slot">`;
    s += `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" rx="${rx}" ry="${rx}" fill="none" stroke="${c}" stroke-width="1.5"/>`;
    s += `<line x1="${el.x + 2}" y1="${cy}" x2="${el.x + el.width - 2}" y2="${cy}" stroke="${c}" stroke-width="0.4" stroke-dasharray="4 2"/>`;
    s += `</g>\n`;
    return s;
  }

  function renderHatchSVG(el, clipId) {
    if (!el.points || el.points.length < 3) return { defs: '', content: '' };

    const pointsStr = el.points.map(p => `${p.x},${p.y}`).join(' ');
    const c = el.color || '#475569';

    let defs = `<clipPath id="${clipId}"><polygon points="${pointsStr}"/></clipPath>\n`;

    let content = `<g class="hatch">`;
    content += `<polygon points="${pointsStr}" fill="none" stroke="${c}" stroke-width="0.5"/>`;

    const bounds = DrawingModel.getElementBounds(el);
    const spacing = el.spacing || 4;
    const angle = (el.angle || 45) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const diag = Math.sqrt(bounds.width ** 2 + bounds.height ** 2);
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const numLines = Math.ceil(diag / spacing) + 2;

    content += `<g clip-path="url(#${clipId})">`;
    for (let i = -numLines; i <= numLines; i++) {
      const offset = i * spacing;
      const x1 = cx + offset * cos - diag * sin;
      const y1 = cy + offset * sin + diag * cos;
      const x2 = cx + offset * cos + diag * sin;
      const y2 = cy + offset * sin - diag * cos;
      content += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c}" stroke-width="0.4"/>`;
    }
    content += `</g></g>\n`;

    return { defs, content };
  }


  // ========== DXF Export ==========
  function exportDXF(doc) {
    let dxf = `0\nSECTION\n2\nHEADER\n0\nENDSEC\n`;
    dxf += `0\nSECTION\n2\nTABLES\n0\nENDSEC\n`;
    dxf += `0\nSECTION\n2\nENTITIES\n`;

    doc.elements.forEach(el => {
      if (doc.layers[el.layer] && !doc.layers[el.layer].visible) return;

      switch (el.type) {
        case 'outline':
          dxf += dxfLine(el.x1, el.y1, el.x2, el.y2, 'OUTLINES');
          break;

        case 'centerline':
          dxf += dxfLine(el.x1, el.y1, el.x2, el.y2, 'CENTERLINES');
          break;

        case 'hiddenline':
          dxf += dxfLine(el.x1, el.y1, el.x2, el.y2, 'HIDDENLINES');
          break;

        case 'hole':
          dxf += dxfCircle(el.cx, el.cy, el.diameter / 2, 'HOLES');
          if (el.tapSpec) {
            dxf += dxfText(el.cx + el.diameter / 2 + 4, el.cy, el.tapSpec, 9, 'HOLES');
          }
          break;

        case 'slot':
          // DXF: 슬롯을 4개 직선으로 근사
          dxf += dxfLine(el.x, el.y, el.x + el.width, el.y, 'SLOTS');
          dxf += dxfLine(el.x + el.width, el.y, el.x + el.width, el.y + el.height, 'SLOTS');
          dxf += dxfLine(el.x + el.width, el.y + el.height, el.x, el.y + el.height, 'SLOTS');
          dxf += dxfLine(el.x, el.y + el.height, el.x, el.y, 'SLOTS');
          break;

        case 'hatch':
          if (el.points && el.points.length >= 2) {
            for (let i = 0; i < el.points.length; i++) {
              const p1 = el.points[i];
              const p2 = el.points[(i + 1) % el.points.length];
              dxf += dxfLine(p1.x, p1.y, p2.x, p2.y, 'HATCHING');
            }
          }
          break;

        case 'dimension': {
          const isH = Math.abs(el.y2 - el.y1) < Math.abs(el.x2 - el.x1);
          const off = el.offset || 30;
          let lx1, ly1, lx2, ly2;
          if (isH) { ly1 = ly2 = Math.min(el.y1, el.y2) - off; lx1 = el.x1; lx2 = el.x2; }
          else { lx1 = lx2 = Math.min(el.x1, el.x2) - off; ly1 = el.y1; ly2 = el.y2; }
          dxf += dxfLine(lx1, ly1, lx2, ly2, 'DIMENSIONS');
          dxf += dxfText((lx1 + lx2) / 2, (ly1 + ly2) / 2, el.value, el.fontSize || 12, 'DIMENSIONS');
          break;
        }

        case 'text':
          dxf += dxfText(el.x, el.y, el.content, el.fontSize || 14, 'TEXT');
          break;
      }
    });

    dxf += `0\nENDSEC\n0\nEOF\n`;
    download(dxf, `${doc.meta.title || 'drawing'}.dxf`, 'application/dxf');
    return dxf;
  }

  function dxfLine(x1, y1, x2, y2, layer = '0') {
    return `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${-y1}\n30\n0\n11\n${x2}\n21\n${-y2}\n31\n0\n`;
  }

  function dxfText(x, y, text, size, layer = '0') {
    return `0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${-y}\n30\n0\n40\n${size}\n1\n${text}\n`;
  }

  function dxfCircle(cx, cy, radius, layer = '0') {
    return `0\nCIRCLE\n8\n${layer}\n10\n${cx}\n20\n${-cy}\n30\n0\n40\n${radius}\n`;
  }


  // ========== PDF Export ==========
  function exportPDF(doc) {
    const svgContent = buildSVGString(doc, false);
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <!DOCTYPE html>
      <html>
      <head><title>${escapeXml(doc.meta.title || 'Drawing')} - 인쇄</title>
      <style>
        body { margin: 0; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: white; }
        img { max-width: 100%; max-height: 100vh; }
        @media print { body { margin: 0; } img { max-width: 100%; } }
      </style></head>
      <body>
        <img src="${url}" alt="Drawing">
        <script>setTimeout(() => window.print(), 500);<\/script>
      </body></html>
    `);
    printWindow.document.close();
  }


  // ========== JSON Export ==========
  function exportJSON(doc) {
    const json = JSON.stringify(doc, null, 2);
    download(json, `${doc.meta.title || 'drawing'}.json`, 'application/json');
    return json;
  }


  // ========== Helpers ==========
  function download(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function escapeXml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return { exportSVG, exportDXF, exportPDF, exportJSON };
})();
