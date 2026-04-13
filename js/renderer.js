/* ============================================================
   renderer.js
   Structured JSON → SVG 렌더러 — 기계도면 전용

   지원 요소:
   - outline    (외형선 — 흰색 실선)
   - centerline (중심선 — 빨간색 1점쇄선)
   - hiddenline (숨은선 — 초록색 파선)
   - hole       (구멍/탭)
   - slot       (슬롯/장공)
   - hatch      (해칭 단면)
   - dimension  (치수 — 파란색)
   - text       (텍스트)

   v5 렌더링 정책:
   - geometry (outline, centerline, hatch)
       → confirmed: 정상 실선 100%
       → estimated: 점선 + 70% 불투명 (형상은 보존)
       → uncertain: 약한 점선 + 40%
   - annotation placeholder (_isPlaceholder = true)
       → 흐린 점선 + 밑줄 + "📝" 아이콘
       → 더블클릭 시 편집 가능 표시
   - null/미태깅 → 정상 렌더링 (하위 호환)
   ============================================================ */

const Renderer = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  let svg, drawingLayer;
  let groups = {};

  function init(svgElement) {
    svg = svgElement;
    // svg.getElementById may not work in all contexts; fallback to querySelector
    drawingLayer = svg.getElementById('drawingLayer') 
                || svg.querySelector('#drawingLayer')
                || document.getElementById('drawingLayer');
    ensureDefs();
    ensureGroups();
  }

  /**
   * <defs> 및 필수 마커 보장
   */
  function ensureDefs() {
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = createSvgElement('defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    // Arrow markers for dimensions
    // ★ 화살머리 크기: 4px (기존 8px viewBox 대비 약 20% 축소)
    //   markerUnits="userSpaceOnUse" → 스트로크 두께 무관하게 절대 크기 적용
    //   작은 치수를 표현할 때 화살머리가 치수선을 덮지 않도록 축소
    //   기존 마커를 강제 제거하여 캐시/재사용 문제 방지
    const oldStart = defs.querySelector('#arrowStart');
    const oldEnd = defs.querySelector('#arrowEnd');
    if (oldStart) oldStart.remove();
    if (oldEnd) oldEnd.remove();

    // 화살 크기 상수 (px, 절대값)
    const AW = 4;   // arrow width
    const AH = 3;   // arrow height

    const mkStart = createSvgElement('marker');
    mkStart.id = 'arrowStart';
    mkStart.setAttribute('markerWidth', String(AW));
    mkStart.setAttribute('markerHeight', String(AH));
    mkStart.setAttribute('refX', '0');
    mkStart.setAttribute('refY', String(AH / 2));
    mkStart.setAttribute('orient', 'auto');
    mkStart.setAttribute('markerUnits', 'userSpaceOnUse');
    const pathStart = createSvgElement('path');
    pathStart.setAttribute('d', `M ${AW} 0 L 0 ${AH/2} L ${AW} ${AH}`);
    pathStart.setAttribute('fill', '#60a5fa');
    pathStart.setAttribute('stroke', 'none');
    mkStart.appendChild(pathStart);
    defs.appendChild(mkStart);

    const mkEnd = createSvgElement('marker');
    mkEnd.id = 'arrowEnd';
    mkEnd.setAttribute('markerWidth', String(AW));
    mkEnd.setAttribute('markerHeight', String(AH));
    mkEnd.setAttribute('refX', String(AW));
    mkEnd.setAttribute('refY', String(AH / 2));
    mkEnd.setAttribute('orient', 'auto');
    mkEnd.setAttribute('markerUnits', 'userSpaceOnUse');
    const pathEnd = createSvgElement('path');
    pathEnd.setAttribute('d', `M 0 0 L ${AW} ${AH/2} L 0 ${AH}`);
    pathEnd.setAttribute('fill', '#60a5fa');
    pathEnd.setAttribute('stroke', 'none');
    mkEnd.appendChild(pathEnd);
    defs.appendChild(mkEnd);
  }

  /**
   * drawingLayer 하위에 필요한 그룹 생성
   */
  function ensureGroups() {
    // v5.8 레이어 순서: 숨은선은 외형선 위에 그려져야 보임
    // SVG에서 뒤에 있는 요소가 앞(위)에 렌더링됨
    // hatching → outlines → hiddenlines (숨은선이 외형선 위에)
    const layerOrder = [
      'hatching', 'outlines', 'hiddenlines', 'centerlines',
      'holes', 'slots', 'dimensions', 'texts', 'titleblocks', 'selection'
    ];

    layerOrder.forEach(name => {
      let g = drawingLayer.querySelector(`#${name}Group`);
      if (!g) {
        g = document.createElementNS(NS, 'g');
        g.id = `${name}Group`;
      }
      // 항상 순서대로 appendChild → 이미 존재하는 그룹도 올바른 순서로 재배치
      drawingLayer.appendChild(g);
      groups[name] = g;
    });
  }

  // ========== Clear ==========
  function clearAll() {
    Object.values(groups).forEach(g => { if (g) g.innerHTML = ''; });
  }

  function clearSelection() {
    if (groups.selection) groups.selection.innerHTML = '';
  }

  // ========== Render Full Document ==========
  function render(doc) {
    clearAll();
    ensureGroups();
    if (!doc || !doc.elements) return;
    doc.elements.forEach(el => {
      if (doc.layers[el.layer] && !doc.layers[el.layer].visible) return;
      try {
        renderElement(el);
      } catch(e) {
        console.warn(`[Renderer] renderElement failed for ${el.type}/${el.id}: ${e.message}`);
      }
    });
    updateLayerCounts(doc);
  }

  // ========== Render Single Element ==========
  function renderElement(el) {
    const group = groups[el.layer];
    if (!group) return;

    const existing = group.querySelector(`[data-id="${el.id}"]`);
    if (existing) existing.remove();

    let svgEl;
    switch (el.type) {
      case 'outline':    svgEl = renderOutline(el); break;
      case 'centerline': svgEl = renderCenterline(el); break;
      case 'hiddenline': svgEl = renderHiddenLine(el); break;
      case 'hole':       svgEl = renderHole(el); break;
      case 'slot':       svgEl = renderSlot(el); break;
      case 'hatch':      svgEl = renderHatch(el); break;
      case 'dimension':  svgEl = renderDimension(el); break;
      case 'text':       svgEl = renderText(el); break;
      case 'titleblock': svgEl = renderTitleBlock(el); break;
    }

    if (svgEl) {
      svgEl.setAttribute('data-id', el.id);
      svgEl.setAttribute('data-type', el.type);
      svgEl.classList.add('drawing-element');

      // ── v5: placeholder 우선, 그 다음 confidence ──
      if (el._isPlaceholder) {
        applyPlaceholderStyle(svgEl, el);
      } else {
        applyConfidenceStyle(svgEl, el);
      }

      group.appendChild(svgEl);
    }
  }

  // ========== Outline (외형선) ==========
  function renderOutline(el) {
    const g = createSvgElement('g');
    const line = createSvgElement('line');
    line.setAttribute('x1', el.x1);
    line.setAttribute('y1', el.y1);
    line.setAttribute('x2', el.x2);
    line.setAttribute('y2', el.y2);
    line.setAttribute('stroke', el.color || '#000000');
    line.setAttribute('stroke-width', el.thickness || 2);
    line.setAttribute('stroke-linecap', 'round');

    // visible edge / shoulder edge 태깅 (data 속성)
    if (el._edgeType) {
      g.setAttribute('data-edge-type', el._edgeType);
      // visible edge: 동일한 실선이지만 미세하게 구분 가능하도록 색상 힌트
      if (el._edgeType === 'visible') {
        line.setAttribute('stroke', el.color || '#000000'); // visible edge도 검정색 실선
      }
    }

    // v5.9: leader line with arrow (지시선 — TAP 등 주석에 사용)
    if (el._leaderArrow) {
      line.setAttribute('marker-end', 'url(#arrowEnd)');
    }

    g.appendChild(line);

    // 히트 영역
    const hit = createSvgElement('line');
    hit.setAttribute('x1', el.x1);
    hit.setAttribute('y1', el.y1);
    hit.setAttribute('x2', el.x2);
    hit.setAttribute('y2', el.y2);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', Math.max((el.thickness || 2) + 8, 12));
    hit.style.cursor = 'pointer';
    g.appendChild(hit);

    return g;
  }

  // ========== Centerline (중심선 — 일점쇄선) ==========
  function renderCenterline(el) {
    const g = createSvgElement('g');
    const line = createSvgElement('line');
    line.setAttribute('x1', el.x1);
    line.setAttribute('y1', el.y1);
    line.setAttribute('x2', el.x2);
    line.setAttribute('y2', el.y2);
    line.setAttribute('stroke', el.color || '#f87171');
    line.setAttribute('stroke-width', el.thickness || 0.8);
    // 일점쇄선: 긴 대시 — 짧은 갭 — 점 — 짧은 갭
    line.setAttribute('stroke-dasharray', '12 3 2 3');
    line.setAttribute('stroke-linecap', 'round');
    g.appendChild(line);

    // 히트 영역
    const hit = createSvgElement('line');
    hit.setAttribute('x1', el.x1);
    hit.setAttribute('y1', el.y1);
    hit.setAttribute('x2', el.x2);
    hit.setAttribute('y2', el.y2);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', 12);
    hit.style.cursor = 'pointer';
    g.appendChild(hit);

    return g;
  }

  // ========== Hidden Line (숨은선 — 파선, 초록색) ==========
  function renderHiddenLine(el) {
    const g = createSvgElement('g');
    const line = createSvgElement('line');
    line.setAttribute('x1', el.x1);
    line.setAttribute('y1', el.y1);
    line.setAttribute('x2', el.x2);
    line.setAttribute('y2', el.y2);
    line.setAttribute('stroke', el.color || '#4ade80');
    line.setAttribute('stroke-width', el.thickness || 1);
    // 파선 (점선): 짧은 대시-갭 패턴
    line.setAttribute('stroke-dasharray', '6 3');
    line.setAttribute('stroke-linecap', 'round');
    g.appendChild(line);

    // 히트 영역
    const hit = createSvgElement('line');
    hit.setAttribute('x1', el.x1);
    hit.setAttribute('y1', el.y1);
    hit.setAttribute('x2', el.x2);
    hit.setAttribute('y2', el.y2);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', 12);
    hit.style.cursor = 'pointer';
    g.appendChild(hit);

    return g;
  }

  // ========== Hole/Tap (구멍) ==========
  function renderHole(el) {
    const g = createSvgElement('g');
    const r = el.diameter / 2;

    // 원
    const circle = createSvgElement('circle');
    circle.setAttribute('cx', el.cx);
    circle.setAttribute('cy', el.cy);
    circle.setAttribute('r', r);
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', el.color || '#a78bfa');
    circle.setAttribute('stroke-width', 1.5);

    if (el.holeType === 'tap') {
      circle.setAttribute('stroke-dasharray', '3 2');
    }
    g.appendChild(circle);

    // 십자 표시 (중심점)
    const cx = el.cx, cy = el.cy;
    const cm = r * 0.4;
    const crossH = createSvgElement('line');
    crossH.setAttribute('x1', cx - cm); crossH.setAttribute('y1', cy);
    crossH.setAttribute('x2', cx + cm); crossH.setAttribute('y2', cy);
    crossH.setAttribute('stroke', el.color || '#a78bfa');
    crossH.setAttribute('stroke-width', 0.5);
    g.appendChild(crossH);

    const crossV = createSvgElement('line');
    crossV.setAttribute('x1', cx); crossV.setAttribute('y1', cy - cm);
    crossV.setAttribute('x2', cx); crossV.setAttribute('y2', cy + cm);
    crossV.setAttribute('stroke', el.color || '#a78bfa');
    crossV.setAttribute('stroke-width', 0.5);
    g.appendChild(crossV);

    // 탭 표기 라벨
    if (el.tapSpec) {
      const label = createSvgElement('text');
      label.setAttribute('x', cx + r + 4);
      label.setAttribute('y', cy - r - 2);
      label.setAttribute('fill', el.color || '#a78bfa');
      label.setAttribute('font-size', 9);
      label.setAttribute('font-family', "'JetBrains Mono', monospace");
      label.textContent = el.tapSpec;
      g.appendChild(label);
    }

    // 히트 영역
    const hitCircle = createSvgElement('circle');
    hitCircle.setAttribute('cx', cx);
    hitCircle.setAttribute('cy', cy);
    hitCircle.setAttribute('r', Math.max(r + 4, 8));
    hitCircle.setAttribute('fill', 'transparent');
    hitCircle.style.cursor = 'pointer';
    g.appendChild(hitCircle);

    return g;
  }

  // ========== Slot (슬롯/장공) ==========
  function renderSlot(el) {
    const g = createSvgElement('g');
    const rx = el.height / 2;

    // 장공 외곽 (둥근 사각형)
    const rect = createSvgElement('rect');
    rect.setAttribute('x', el.x);
    rect.setAttribute('y', el.y);
    rect.setAttribute('width', el.width);
    rect.setAttribute('height', el.height);
    rect.setAttribute('rx', rx);
    rect.setAttribute('ry', rx);
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', el.color || '#fbbf24');
    rect.setAttribute('stroke-width', 1.5);
    g.appendChild(rect);

    // 중심선 (슬롯 내부)
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const clH = createSvgElement('line');
    clH.setAttribute('x1', el.x + 2);
    clH.setAttribute('y1', cy);
    clH.setAttribute('x2', el.x + el.width - 2);
    clH.setAttribute('y2', cy);
    clH.setAttribute('stroke', el.color || '#fbbf24');
    clH.setAttribute('stroke-width', 0.4);
    clH.setAttribute('stroke-dasharray', '4 2');
    g.appendChild(clH);

    // 히트 영역
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', el.x - 2);
    hitRect.setAttribute('y', el.y - 2);
    hitRect.setAttribute('width', el.width + 4);
    hitRect.setAttribute('height', el.height + 4);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  // ========== Hatch (해칭 단면) ==========
  function renderHatch(el) {
    const g = createSvgElement('g');
    if (!el.points || el.points.length < 3) return g;

    const pointsStr = el.points.map(p => `${p.x},${p.y}`).join(' ');
    const polygon = createSvgElement('polygon');
    polygon.setAttribute('points', pointsStr);
    polygon.setAttribute('fill', 'none');
    polygon.setAttribute('stroke', el.color || '#475569');
    polygon.setAttribute('stroke-width', 0.5);
    g.appendChild(polygon);

    const bounds = DrawingModel.getElementBounds(el);
    const spacing = el.spacing || 4;
    const angle = (el.angle || 45) * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const diag = Math.sqrt(bounds.width ** 2 + bounds.height ** 2);

    const clipId = `clip_${el.id}`;
    let defs = svg.querySelector('defs');
    if (!defs) {
      defs = createSvgElement('defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    const clip = createSvgElement('clipPath');
    clip.id = clipId;
    const clipPoly = createSvgElement('polygon');
    clipPoly.setAttribute('points', pointsStr);
    clip.appendChild(clipPoly);
    defs.appendChild(clip);

    const hatchG = createSvgElement('g');
    hatchG.setAttribute('clip-path', `url(#${clipId})`);

    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const numLines = Math.ceil(diag / spacing) + 2;

    for (let i = -numLines; i <= numLines; i++) {
      const offset = i * spacing;
      const x1 = cx + offset * cos - diag * sin;
      const y1 = cy + offset * sin + diag * cos;
      const x2 = cx + offset * cos + diag * sin;
      const y2 = cy + offset * sin - diag * cos;

      const line = createSvgElement('line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      line.setAttribute('stroke', el.color || '#475569');
      line.setAttribute('stroke-width', 0.4);
      hatchG.appendChild(line);
    }
    g.appendChild(hatchG);

    const hitPoly = createSvgElement('polygon');
    hitPoly.setAttribute('points', pointsStr);
    hitPoly.setAttribute('fill', 'transparent');
    hitPoly.style.cursor = 'pointer';
    g.appendChild(hitPoly);

    return g;
  }

  // ========== Dimension ==========
  //
  // v6.0 도면 규칙 — 치수선 화살표 스타일 (절대 규칙)
  //
  //   ★ 화살표는 항상 안쪽(측정점)을 향해야 함 — 세번째 사진 스타일
  //   ★ 두번째 사진처럼 바깥을 가리키는 반전 화살표 절대 금지
  //
  //   좁은 공간일 때:
  //     - 치수선은 양 끝점 사이에 화살표(안쪽 방향)로 그림
  //     - 텍스트(숫자)만 외부로 빼서 지시선(leader)으로 연결
  //     - 지시선 색상은 치수선과 동일 (#60a5fa)
  //
  //   넓은 공간일 때:
  //     - 치수선 양 끝에 화살표, 텍스트는 가운데
  //
  function renderDimension(el) {
    const g = createSvgElement('g');
    g.setAttribute('class', 'dimension-group');

    const isHorizontal = Math.abs(el.y2 - el.y1) < Math.abs(el.x2 - el.x1);
    const offsetDir = el.offset || 30;
    const color = el.color || '#60a5fa';
    const fontSize = el.fontSize || 12;

    let lx1, ly1, lx2, ly2;
    if (isHorizontal) {
      ly1 = ly2 = Math.min(el.y1, el.y2) - offsetDir;
      lx1 = el.x1; lx2 = el.x2;
    } else {
      lx1 = lx2 = Math.min(el.x1, el.x2) - offsetDir;
      ly1 = el.y1; ly2 = el.y2;
    }

    // 치수선 길이 (양 화살표 사이 거리)
    const dimSpan = Math.sqrt((lx2 - lx1) ** 2 + (ly2 - ly1) ** 2);
    // 텍스트 예상 폭
    const textStr = String(el.value || '');
    const textWidth = textStr.length * fontSize * 0.65;
    // 좁은 공간 판단: 화살표 마커(각 8px) + 여유
    const isNarrow = dimSpan < textWidth + 20;

    // Extension lines (항상 그린다)
    const ext1 = createSvgElement('line');
    ext1.setAttribute('x1', el.x1); ext1.setAttribute('y1', el.y1);
    ext1.setAttribute('x2', lx1); ext1.setAttribute('y2', ly1);
    ext1.setAttribute('stroke', color);
    ext1.setAttribute('stroke-width', 0.5);
    ext1.setAttribute('stroke-dasharray', '2 2');
    g.appendChild(ext1);

    const ext2 = createSvgElement('line');
    ext2.setAttribute('x1', el.x2); ext2.setAttribute('y1', el.y2);
    ext2.setAttribute('x2', lx2); ext2.setAttribute('y2', ly2);
    ext2.setAttribute('stroke', color);
    ext2.setAttribute('stroke-width', 0.5);
    ext2.setAttribute('stroke-dasharray', '2 2');
    g.appendChild(ext2);

    // ★ 치수선 — 화살표는 항상 안쪽(측정점)을 가리킴
    //   넓든 좁든 동일한 화살표 스타일 (세번째 사진)
    const dimLine = createSvgElement('line');
    dimLine.setAttribute('x1', lx1); dimLine.setAttribute('y1', ly1);
    dimLine.setAttribute('x2', lx2); dimLine.setAttribute('y2', ly2);
    dimLine.setAttribute('stroke', color);
    dimLine.setAttribute('stroke-width', 1);
    dimLine.setAttribute('marker-start', 'url(#arrowStart)');
    dimLine.setAttribute('marker-end', 'url(#arrowEnd)');
    g.appendChild(dimLine);

    // ── 텍스트 배치: 항상 치수선의 중앙에 표시 ──
    //
    // ★ 핵심 규칙: 수평·수직 모두 치수선 정중앙에 텍스트 배치
    //   수평 치수: 치수선 중앙 상단
    //   수직 치수(직경 등): 치수선 수직 중앙, 좌측
    //   좁은 공간: 텍스트만 외부 지시선으로 연장
    //
    const midX = (lx1 + lx2) / 2;
    const midY = (ly1 + ly2) / 2;
    const text = createSvgElement('text');
    text.setAttribute('fill', color);
    text.setAttribute('font-size', fontSize);
    text.setAttribute('font-family', "'JetBrains Mono', monospace");
    text.setAttribute('font-weight', '500');

    if (isHorizontal) {
      if (!isNarrow) {
        // 수평 일반: 치수선 중앙 위
        text.setAttribute('x', midX);
        text.setAttribute('y', midY - 4);
        text.setAttribute('text-anchor', 'middle');
      } else {
        // 수평 좁은: 오른쪽으로 지시선 연장
        text.setAttribute('x', lx2 + 4);
        text.setAttribute('y', midY - 3);
        text.setAttribute('text-anchor', 'start');

        const leaderLine = createSvgElement('line');
        leaderLine.setAttribute('x1', lx2); leaderLine.setAttribute('y1', ly2);
        leaderLine.setAttribute('x2', lx2 + textWidth + 10); leaderLine.setAttribute('y2', ly2);
        leaderLine.setAttribute('stroke', color);
        leaderLine.setAttribute('stroke-width', 0.5);
        g.appendChild(leaderLine);
      }
    } else {
      // ★ 수직 치수(직경 등): 치수선 수직 중앙에 텍스트 배치
      //   텍스트를 치수선의 정중앙 좌측에 배치하여
      //   어떤 구간이든 치수 수치가 치수선 중앙에 위치
      text.setAttribute('x', midX - 5);
      text.setAttribute('y', midY + fontSize * 0.35);
      text.setAttribute('text-anchor', 'end');
    }

    text.textContent = textStr;
    g.appendChild(text);

    // Hit area (공통)
    const hitMinX = Math.min(lx1, lx2) - 20;
    const hitMinY = Math.min(ly1, ly2) - 20;
    const hitW = Math.abs(lx2 - lx1) + (isNarrow ? textWidth + 60 : 10);
    const hitH = Math.abs(ly2 - ly1) + (isNarrow ? 50 : 25);
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', hitMinX);
    hitRect.setAttribute('y', hitMinY);
    hitRect.setAttribute('width', hitW);
    hitRect.setAttribute('height', hitH);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  // ========== Text ==========
  function renderText(el) {
    const g = createSvgElement('g');

    const text = createSvgElement('text');
    text.setAttribute('x', el.x);
    text.setAttribute('y', el.y);
    text.setAttribute('fill', el.color || '#94a3b8');
    text.setAttribute('font-size', el.fontSize || 14);
    text.setAttribute('font-family', "'Inter', sans-serif");
    text.setAttribute('font-weight', el.fontWeight || 'normal');
    if (el.rotation) {
      text.setAttribute('transform', `rotate(${el.rotation}, ${el.x}, ${el.y})`);
    }
    text.textContent = el.content;
    g.appendChild(text);

    const w = el.content.length * (el.fontSize || 14) * 0.6;
    const h = (el.fontSize || 14) * 1.4;
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', el.x - 2);
    hitRect.setAttribute('y', el.y - h + 4);
    hitRect.setAttribute('width', w + 4);
    hitRect.setAttribute('height', h);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  // ========== Title Block (표제란) — KS 규격 스타일 v8 ==========
  //
  //  레이아웃: 데이터 행(4→1) 위 → 헤더 아래 → 하단 블록
  //
  //   ┌────┬──────┬─────┬────┬─────┐
  //   │ 4  │      │     │    │     │  ← 공란 (역순: 4→1)
  //   ├────┼──────┼─────┼────┼─────┤
  //   │ 3  │      │     │    │     │
  //   ├────┼──────┼─────┼────┼─────┤
  //   │ 2  │      │     │    │     │
  //   ├────┼──────┼─────┼────┼─────┤
  //   │ 1  │      │     │    │     │
  //   ├────┼──────┼─────┼────┼─────┤
  //   │품번│ 품명 │재질 │수량│비고 │  ← 헤더 (아래!)
  //   ├────┴──────┤─────┼────┴─────┤
  //   │           │척도 │  1:1     │  ← 하단 블록
  //   │  작품명   ├─────┼──────────┤
  //   │           │각법 │  3각법   │
  //   └───────────┴─────┴──────────┘
  //
  function renderTitleBlock(el) {
    const g = createSvgElement('g');
    g.setAttribute('class', 'titleblock-group');

    const itemRows = el.itemRows || [];
    const bottomInfo = el.bottomInfo || { title: '', scale: '1:1', projectionMethod: '3각법' };
    const rh = el.rowHeight || 22;
    const hdrH = el.headerHeight || 20;
    const btmRowH = el.bottomRowHeight || 18;
    const btmH = btmRowH * 2;        // 하단 총 높이 = 2행 (척도 + 각법)
    const w = el.width || 250;
    const colRatios = el.colRatios || [0.12, 0.34, 0.20, 0.12, 0.22];
    const x = el.x;
    const y = el.y;
    const borderColor = el.color || '#d1d5db';
    const textColor = el.textColor || '#e2e8f0';
    const labelColor = el.labelColor || '#94a3b8';
    const fontSize = el.fontSize || 10;

    // 열 위치 계산
    const colX = [];
    let cx = 0;
    for (let c = 0; c < colRatios.length; c++) {
      colX.push(x + cx);
      cx += w * colRatios[c];
    }
    colX.push(x + w); // 마지막 열 끝

    // 높이 계산: 데이터행(위) → 헤더(아래) → 하단블록
    const dataH = itemRows.length * rh;
    const tableH = dataH + hdrH;
    const totalH = tableH + btmH;

    // ── 반투명 배경 ──
    const bg = createSvgElement('rect');
    bg.setAttribute('x', x); bg.setAttribute('y', y);
    bg.setAttribute('width', w); bg.setAttribute('height', totalH);
    bg.setAttribute('fill', '#1e293b');
    bg.setAttribute('fill-opacity', '0.55');
    bg.setAttribute('rx', '2');
    g.appendChild(bg);

    // ── 외곽선 (전체 테두리) ──
    const border = createSvgElement('rect');
    border.setAttribute('x', x); border.setAttribute('y', y);
    border.setAttribute('width', w); border.setAttribute('height', totalH);
    border.setAttribute('fill', 'none');
    border.setAttribute('stroke', borderColor);
    border.setAttribute('stroke-width', '1.2');
    border.setAttribute('rx', '2');
    g.appendChild(border);

    // ── 열 구분선 (데이터 행 + 헤더 영역 전체) ──
    for (let c = 1; c < colRatios.length; c++) {
      const vl = createSvgElement('line');
      vl.setAttribute('x1', colX[c]); vl.setAttribute('y1', y);
      vl.setAttribute('x2', colX[c]); vl.setAttribute('y2', y + tableH);
      vl.setAttribute('stroke', borderColor);
      vl.setAttribute('stroke-width', '0.5');
      vl.setAttribute('stroke-opacity', '0.7');
      g.appendChild(vl);
    }

    // ── 데이터 행 (공란 — 위에서 아래: 4→3→2→1) ──
    const fields = ['no', 'partName', 'material', 'quantity', 'remarks'];
    const editableFields = ['partName', 'material', 'quantity', 'remarks'];

    itemRows.forEach((row, i) => {
      const ry = y + i * rh;

      // 행 구분선 (첫 행 제외)
      if (i > 0) {
        const rowLine = createSvgElement('line');
        rowLine.setAttribute('x1', x); rowLine.setAttribute('y1', ry);
        rowLine.setAttribute('x2', x + w); rowLine.setAttribute('y2', ry);
        rowLine.setAttribute('stroke', borderColor);
        rowLine.setAttribute('stroke-width', '0.4');
        rowLine.setAttribute('stroke-opacity', '0.5');
        g.appendChild(rowLine);
      }

      // 각 셀
      for (let c = 0; c < fields.length; c++) {
        const field = fields[c];
        const cMid = (colX[c] + colX[c + 1]) / 2;
        const cellText = createSvgElement('text');
        cellText.setAttribute('x', cMid);
        cellText.setAttribute('y', ry + rh / 2 + fontSize * 0.35);
        cellText.setAttribute('font-size', fontSize);
        cellText.setAttribute('font-family', "'Noto Sans KR', 'Inter', sans-serif");
        cellText.setAttribute('text-anchor', 'middle');
        cellText.setAttribute('data-row-index', String(i));
        cellText.setAttribute('data-field', field);

        const val = field === 'no' ? String(row.no || (itemRows.length - i)) : (row[field] || '');

        if (editableFields.includes(field) && !val) {
          // 공란 — 빈 셀 (투명)
          cellText.textContent = '';
          cellText.setAttribute('fill', 'transparent');
        } else {
          cellText.textContent = val;
          cellText.setAttribute('fill', field === 'no' ? labelColor : textColor);
        }
        g.appendChild(cellText);

        // 편집 가능 셀 히트 영역
        if (row.editable && editableFields.includes(field)) {
          const hitCell = createSvgElement('rect');
          hitCell.setAttribute('x', colX[c]);
          hitCell.setAttribute('y', ry);
          hitCell.setAttribute('width', colX[c + 1] - colX[c]);
          hitCell.setAttribute('height', rh);
          hitCell.setAttribute('fill', 'transparent');
          hitCell.setAttribute('data-row-index', String(i));
          hitCell.setAttribute('data-field', field);
          hitCell.setAttribute('data-editable', 'true');
          hitCell.style.cursor = 'pointer';
          g.appendChild(hitCell);
        }
      }
    });

    // ── 헤더 행 (데이터 행 바로 아래) ──
    const hdrY = y + dataH;
    // 헤더 상단 구분선 (굵은선)
    const hdrTopLine = createSvgElement('line');
    hdrTopLine.setAttribute('x1', x); hdrTopLine.setAttribute('y1', hdrY);
    hdrTopLine.setAttribute('x2', x + w); hdrTopLine.setAttribute('y2', hdrY);
    hdrTopLine.setAttribute('stroke', borderColor);
    hdrTopLine.setAttribute('stroke-width', '1');
    g.appendChild(hdrTopLine);

    const headers = ['품번', '품명', '재질', '수량', '비고'];
    for (let c = 0; c < headers.length; c++) {
      const hText = createSvgElement('text');
      const cMid = (colX[c] + colX[c + 1]) / 2;
      hText.setAttribute('x', cMid);
      hText.setAttribute('y', hdrY + hdrH / 2 + fontSize * 0.35);
      hText.setAttribute('fill', labelColor);
      hText.setAttribute('font-size', fontSize);
      hText.setAttribute('font-family', "'Noto Sans KR', 'Inter', sans-serif");
      hText.setAttribute('font-weight', '600');
      hText.setAttribute('text-anchor', 'middle');
      hText.textContent = headers[c];
      g.appendChild(hText);
    }

    // ── 헤더 하단 구분선 (하단 블록 상단, 굵은선) ──
    const btmY = y + tableH;
    const btmLine = createSvgElement('line');
    btmLine.setAttribute('x1', x); btmLine.setAttribute('y1', btmY);
    btmLine.setAttribute('x2', x + w); btmLine.setAttribute('y2', btmY);
    btmLine.setAttribute('stroke', borderColor);
    btmLine.setAttribute('stroke-width', '1');
    g.appendChild(btmLine);

    // ── 하단 정보 블록 ──
    //   ┌──────────┬─────┬──────────┐
    //   │          │척도 │  1:1     │
    //   │  작품명  ├─────┼──────────┤
    //   │          │각법 │  3각법   │
    //   └──────────┴─────┴──────────┘
    const btmLeftW = w * 0.42;                       // 작품명 영역
    const btmLblW = w * 0.17;                        // 척도/각법 라벨
    const btmValW = w - btmLeftW - btmLblW;          // 척도/각법 값
    const btmLeftX = x;
    const btmLblX = x + btmLeftW;
    const btmValX = x + btmLeftW + btmLblW;

    // 작품명 세로 구분선
    const btmVL1 = createSvgElement('line');
    btmVL1.setAttribute('x1', btmLblX); btmVL1.setAttribute('y1', btmY);
    btmVL1.setAttribute('x2', btmLblX); btmVL1.setAttribute('y2', btmY + btmH);
    btmVL1.setAttribute('stroke', borderColor);
    btmVL1.setAttribute('stroke-width', '0.6');
    g.appendChild(btmVL1);

    // 라벨/값 세로 구분선
    const btmVL2 = createSvgElement('line');
    btmVL2.setAttribute('x1', btmValX); btmVL2.setAttribute('y1', btmY);
    btmVL2.setAttribute('x2', btmValX); btmVL2.setAttribute('y2', btmY + btmH);
    btmVL2.setAttribute('stroke', borderColor);
    btmVL2.setAttribute('stroke-width', '0.5');
    g.appendChild(btmVL2);

    // 척도/각법 중간 수평 구분선
    const btmMidLine = createSvgElement('line');
    btmMidLine.setAttribute('x1', btmLblX); btmMidLine.setAttribute('y1', btmY + btmRowH);
    btmMidLine.setAttribute('x2', x + w); btmMidLine.setAttribute('y2', btmY + btmRowH);
    btmMidLine.setAttribute('stroke', borderColor);
    btmMidLine.setAttribute('stroke-width', '0.4');
    g.appendChild(btmMidLine);

    // 작품명 라벨 + 값 (좌측 세로 병합)
    const titleLbl = createSvgElement('text');
    titleLbl.setAttribute('x', btmLeftX + btmLeftW / 2);
    titleLbl.setAttribute('y', btmY + btmH / 2 - fontSize * 0.3);
    titleLbl.setAttribute('fill', labelColor);
    titleLbl.setAttribute('font-size', String(fontSize - 1));
    titleLbl.setAttribute('font-family', "'Noto Sans KR', 'Inter', sans-serif");
    titleLbl.setAttribute('text-anchor', 'middle');
    titleLbl.textContent = '작품명';
    g.appendChild(titleLbl);

    const titleVal = createSvgElement('text');
    titleVal.setAttribute('x', btmLeftX + btmLeftW / 2);
    titleVal.setAttribute('y', btmY + btmH / 2 + fontSize * 0.8);
    titleVal.setAttribute('fill', textColor);
    titleVal.setAttribute('font-size', String(fontSize + 1));
    titleVal.setAttribute('font-family', "'Noto Sans KR', 'Inter', sans-serif");
    titleVal.setAttribute('font-weight', '600');
    titleVal.setAttribute('text-anchor', 'middle');
    titleVal.setAttribute('data-bottom-field', 'title');
    titleVal.textContent = bottomInfo.title || '';
    g.appendChild(titleVal);

    // 작품명 히트 영역
    const hitTitle = createSvgElement('rect');
    hitTitle.setAttribute('x', btmLeftX); hitTitle.setAttribute('y', btmY);
    hitTitle.setAttribute('width', btmLeftW); hitTitle.setAttribute('height', btmH);
    hitTitle.setAttribute('fill', 'transparent');
    hitTitle.setAttribute('data-bottom-field', 'title');
    hitTitle.setAttribute('data-editable', 'true');
    hitTitle.style.cursor = 'pointer';
    g.appendChild(hitTitle);

    // 척도 행
    const scaleLbl = createSvgElement('text');
    scaleLbl.setAttribute('x', btmLblX + btmLblW / 2);
    scaleLbl.setAttribute('y', btmY + btmRowH / 2 + fontSize * 0.35);
    scaleLbl.setAttribute('fill', labelColor);
    scaleLbl.setAttribute('font-size', fontSize);
    scaleLbl.setAttribute('font-family', "'Noto Sans KR', 'Inter', sans-serif");
    scaleLbl.setAttribute('font-weight', '500');
    scaleLbl.setAttribute('text-anchor', 'middle');
    scaleLbl.textContent = '척도';
    g.appendChild(scaleLbl);

    const scaleVal = createSvgElement('text');
    scaleVal.setAttribute('x', btmValX + btmValW / 2);
    scaleVal.setAttribute('y', btmY + btmRowH / 2 + fontSize * 0.35);
    scaleVal.setAttribute('fill', textColor);
    scaleVal.setAttribute('font-size', fontSize);
    scaleVal.setAttribute('font-family', "'Noto Sans KR', 'Inter', sans-serif");
    scaleVal.setAttribute('font-weight', '500');
    scaleVal.setAttribute('text-anchor', 'middle');
    scaleVal.setAttribute('data-bottom-field', 'scale');
    scaleVal.textContent = bottomInfo.scale || '1:1';
    g.appendChild(scaleVal);

    // 척도 히트 영역
    const hitScale = createSvgElement('rect');
    hitScale.setAttribute('x', btmLblX); hitScale.setAttribute('y', btmY);
    hitScale.setAttribute('width', btmLblW + btmValW); hitScale.setAttribute('height', btmRowH);
    hitScale.setAttribute('fill', 'transparent');
    hitScale.setAttribute('data-bottom-field', 'scale');
    hitScale.setAttribute('data-editable', 'true');
    hitScale.style.cursor = 'pointer';
    g.appendChild(hitScale);

    // 각법 행
    const projLbl = createSvgElement('text');
    projLbl.setAttribute('x', btmLblX + btmLblW / 2);
    projLbl.setAttribute('y', btmY + btmRowH + btmRowH / 2 + fontSize * 0.35);
    projLbl.setAttribute('fill', labelColor);
    projLbl.setAttribute('font-size', fontSize);
    projLbl.setAttribute('font-family', "'Noto Sans KR', 'Inter', sans-serif");
    projLbl.setAttribute('font-weight', '500');
    projLbl.setAttribute('text-anchor', 'middle');
    projLbl.textContent = '각법';
    g.appendChild(projLbl);

    const projVal = createSvgElement('text');
    projVal.setAttribute('x', btmValX + btmValW / 2);
    projVal.setAttribute('y', btmY + btmRowH + btmRowH / 2 + fontSize * 0.35);
    projVal.setAttribute('fill', textColor);
    projVal.setAttribute('font-size', fontSize);
    projVal.setAttribute('font-family', "'Noto Sans KR', 'Inter', sans-serif");
    projVal.setAttribute('font-weight', '500');
    projVal.setAttribute('text-anchor', 'middle');
    projVal.setAttribute('data-bottom-field', 'projectionMethod');
    projVal.textContent = bottomInfo.projectionMethod || '3각법';
    g.appendChild(projVal);

    // 각법 히트 영역
    const hitProj = createSvgElement('rect');
    hitProj.setAttribute('x', btmLblX); hitProj.setAttribute('y', btmY + btmRowH);
    hitProj.setAttribute('width', btmLblW + btmValW); hitProj.setAttribute('height', btmRowH);
    hitProj.setAttribute('fill', 'transparent');
    hitProj.setAttribute('data-bottom-field', 'projectionMethod');
    hitProj.setAttribute('data-editable', 'true');
    hitProj.style.cursor = 'pointer';
    g.appendChild(hitProj);

    // 전체 히트 영역 (선택용)
    const hitRect = createSvgElement('rect');
    hitRect.setAttribute('x', x - 2);
    hitRect.setAttribute('y', y - 2);
    hitRect.setAttribute('width', w + 4);
    hitRect.setAttribute('height', totalH + 4);
    hitRect.setAttribute('fill', 'transparent');
    hitRect.style.cursor = 'pointer';
    g.appendChild(hitRect);

    return g;
  }

  // ========== Selection Highlight ==========
  function showSelection(element) {
    clearSelection();
    if (!element) return;

    const bounds = DrawingModel.getElementBounds(element);
    const pad = 6;

    const rect = createSvgElement('rect');
    rect.setAttribute('x', bounds.x - pad);
    rect.setAttribute('y', bounds.y - pad);
    rect.setAttribute('width', bounds.width + pad * 2);
    rect.setAttribute('height', bounds.height + pad * 2);
    rect.setAttribute('class', 'selection-box');
    groups.selection.appendChild(rect);

    const handleSize = 6;
    const corners = [
      { x: bounds.x - pad, y: bounds.y - pad },
      { x: bounds.x + bounds.width + pad, y: bounds.y - pad },
      { x: bounds.x - pad, y: bounds.y + bounds.height + pad },
      { x: bounds.x + bounds.width + pad, y: bounds.y + bounds.height + pad },
    ];
    corners.forEach(c => {
      const handle = createSvgElement('rect');
      handle.setAttribute('x', c.x - handleSize / 2);
      handle.setAttribute('y', c.y - handleSize / 2);
      handle.setAttribute('width', handleSize);
      handle.setAttribute('height', handleSize);
      handle.setAttribute('class', 'selection-handle');
      handle.setAttribute('rx', '1');
      groups.selection.appendChild(handle);
    });
  }

  // ========== Dynamic Layer Counts ==========
  function updateLayerCounts(doc) {
    const counts = {};
    Object.keys(doc.layers).forEach(k => { counts[k] = 0; });
    doc.elements.forEach(el => {
      if (counts[el.layer] !== undefined) counts[el.layer]++;
    });

    Object.entries(counts).forEach(([layer, count]) => {
      const el = document.getElementById(`${layer}Count`);
      if (el) el.textContent = count;
    });

    const total = doc.elements.length;
    const countEl = document.getElementById('elementCount');
    if (countEl) countEl.textContent = `${total} 요소`;
  }

  // ========== v5: Placeholder 시각화 ==========
  /**
   * placeholder 요소: 흐린 점선 + 밑줄 효과 + 편집 힌트
   * 더블클릭으로 값을 직접 입력할 수 있음을 시각적으로 표현
   */
  function applyPlaceholderStyle(svgGroup, el) {
    svgGroup.setAttribute('data-placeholder', 'true');
    svgGroup.setAttribute('data-confidence', el.confidence || 'uncertain');
    svgGroup.style.opacity = '0.45';

    // 텍스트 요소: 밑줄 + 편집 힌트 색상
    svgGroup.querySelectorAll('text').forEach(text => {
      text.setAttribute('fill', '#6b7280');
      text.setAttribute('text-decoration', 'underline');
      text.setAttribute('font-style', 'italic');
    });

    // 선 요소: 흐린 점선
    svgGroup.querySelectorAll('line:not([stroke=transparent])').forEach(line => {
      if (!line.getAttribute('stroke-dasharray')) {
        line.setAttribute('stroke-dasharray', '3 5');
      }
      line.setAttribute('stroke', '#6b7280');
    });

    // 원 요소: 흐린 점선
    svgGroup.querySelectorAll('circle:not([fill=transparent])').forEach(circ => {
      if (!circ.getAttribute('stroke-dasharray')) {
        circ.setAttribute('stroke-dasharray', '3 5');
      }
      circ.setAttribute('stroke', '#6b7280');
    });

    // 사각형(치수 등): 흐린 점선
    svgGroup.querySelectorAll('rect:not([fill=transparent])').forEach(rect => {
      if (rect.getAttribute('fill') === 'none') {
        rect.setAttribute('stroke-dasharray', '3 5');
        rect.setAttribute('stroke', '#6b7280');
      }
    });

    // ── 📝 편집 힌트 아이콘 (작은 연필) ──
    const bounds = el.id ? DrawingModel.getElementBounds(el) : null;
    if (bounds && bounds.width > 0) {
      const editIcon = createSvgElement('text');
      editIcon.setAttribute('x', bounds.x + bounds.width + 4);
      editIcon.setAttribute('y', bounds.y + 10);
      editIcon.setAttribute('fill', '#f59e0b');
      editIcon.setAttribute('font-size', 10);
      editIcon.setAttribute('opacity', '0.7');
      editIcon.textContent = '✏️';
      svgGroup.appendChild(editIcon);
    }
  }

  // ========== v5: Confidence 시각화 (non-placeholder) ==========
  /**
   * confidence 수준에 따라 SVG 그룹에 스타일 적용
   *
   * confirmed  → 정상 (opacity 1.0)
   * estimated  → opacity 0.7, 점선 stroke
   * uncertain  → opacity 0.4, 주황 점선 외곽
   * null       → 정상 (하위 호환)
   */
  function applyConfidenceStyle(svgGroup, el) {
    const conf = el.confidence;
    if (!conf || conf === 'confirmed') return; // 정상

    svgGroup.setAttribute('data-confidence', conf);

    if (conf === 'estimated') {
      svgGroup.style.opacity = '0.7';
      svgGroup.querySelectorAll('line:not([stroke=transparent])').forEach(line => {
        if (!line.getAttribute('stroke-dasharray')) {
          line.setAttribute('stroke-dasharray', '6 3');
        }
      });
      svgGroup.querySelectorAll('rect:not([fill=transparent])').forEach(rect => {
        if (rect.getAttribute('fill') === 'none' && !rect.getAttribute('stroke-dasharray')) {
          rect.setAttribute('stroke-dasharray', '6 3');
        }
      });
      svgGroup.querySelectorAll('circle:not([fill=transparent])').forEach(circ => {
        if (!circ.getAttribute('stroke-dasharray')) {
          circ.setAttribute('stroke-dasharray', '4 2');
        }
      });
    }

    if (conf === 'uncertain') {
      svgGroup.style.opacity = '0.4';
      svgGroup.querySelectorAll('line:not([stroke=transparent])').forEach(line => {
        line.setAttribute('stroke-dasharray', '2 4');
        line.setAttribute('stroke', '#fbbf24');
      });
      svgGroup.querySelectorAll('text').forEach(text => {
        text.setAttribute('fill', '#fbbf24');
      });
      svgGroup.querySelectorAll('circle:not([fill=transparent])').forEach(circ => {
        circ.setAttribute('stroke-dasharray', '2 4');
        circ.setAttribute('stroke', '#fbbf24');
      });
      svgGroup.querySelectorAll('rect:not([fill=transparent])').forEach(rect => {
        if (rect.getAttribute('fill') === 'none') {
          rect.setAttribute('stroke-dasharray', '2 4');
          rect.setAttribute('stroke', '#fbbf24');
        }
      });
    }
  }

  // ========== Helpers ==========
  function createSvgElement(tag) {
    return document.createElementNS(NS, tag);
  }

  return {
    init, render, renderElement, clearAll, clearSelection,
    showSelection, updateLayerCounts, ensureGroups,
  };
})();
