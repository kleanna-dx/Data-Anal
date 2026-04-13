/* ============================================================
   editor.js
   도면 편집기 코어 — 기계도면 전용

   지원 요소: outline, centerline, hiddenline, hole, slot, hatch, dimension, text
   도구: select, move, outline(선 그리기), text, eraser

   v5: placeholder 요소 더블클릭 편집 지원
       _isPlaceholder=true 요소를 더블클릭하면 인라인 편집기 열림
       편집 후 _isPlaceholder=false로 전환 + confidence=confirmed
   ============================================================ */

const Editor = (() => {
  let _doc = null;
  let _tool = 'select';
  let _selectedId = null;
  let _dragging = false;
  let _dragStart = { x: 0, y: 0 };
  let _dragOriginal = null;
  let _panOffset = { x: 0, y: 0 };
  let _zoom = 1;
  let _isPanning = false;
  let _panStart = { x: 0, y: 0 };
  let _panOffsetStart = { x: 0, y: 0 };

  // 선 그리기 상태
  let _lineDrawing = false;
  let _lineStart = null;
  let _tempLineEl = null;

  let _svg, _container, _drawingLayer;

  // ========== Init ==========
  function init(doc) {
    _doc = doc;
    _svg = document.getElementById('drawingSvg');
    _container = document.getElementById('canvasContainer');
    _drawingLayer = document.getElementById('drawingLayer');

    bindEvents();
    Renderer.init(_svg);
    setTool('select');
    fitToView();
  }

  // ========== Tool ==========
  function setTool(tool) {
    _tool = tool;
    _lineDrawing = false;
    _lineStart = null;
    if (_tempLineEl) { _tempLineEl.remove(); _tempLineEl = null; }

    document.querySelectorAll('.toolbar-btn[data-tool]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });

    _container.className = `canvas-container tool-${tool}`;

    if (tool !== 'select') deselectAll();
  }

  function getTool() { return _tool; }

  // ========== Selection ==========
  function selectElement(id) {
    _selectedId = id;
    const el = _doc.elements.find(e => e.id === id);
    if (!el) return;

    Renderer.showSelection(el);
    showProperties(el);

    document.getElementById('selectedInfo').style.display = 'inline';
    document.getElementById('selectedText').textContent =
      `${getTypeLabel(el.type)} 선택됨`;
  }

  function deselectAll() {
    _selectedId = null;
    Renderer.clearSelection();
    hideProperties();
    document.getElementById('selectedInfo').style.display = 'none';
  }

  function getSelected() {
    if (!_selectedId) return null;
    return _doc.elements.find(e => e.id === _selectedId);
  }

  // ========== Hit Test ==========
  function hitTest(clientX, clientY) {
    const pt = clientToSvg(clientX, clientY);

    for (let i = _doc.elements.length - 1; i >= 0; i--) {
      const el = _doc.elements[i];
      if (!_doc.layers[el.layer] || !_doc.layers[el.layer].visible) continue;

      const bounds = DrawingModel.getElementBounds(el);
      const pad = 8;
      if (pt.x >= bounds.x - pad && pt.x <= bounds.x + bounds.width + pad &&
          pt.y >= bounds.y - pad && pt.y <= bounds.y + bounds.height + pad) {
        return el;
      }
    }
    return null;
  }

  // ========== Properties Panel ==========
  function showProperties(el) {
    document.getElementById('panelNoSelection').style.display = 'none';
    document.getElementById('panelSelection').style.display = 'block';

    document.getElementById('propType').textContent = getTypeLabel(el.type);
    document.getElementById('propId').textContent = el.id;

    const bounds = DrawingModel.getElementBounds(el);
    document.getElementById('propX').value = Math.round(bounds.x);
    document.getElementById('propY').value = Math.round(bounds.y);

    const sizeRow = document.getElementById('propSizeRow');
    const lineTypes = ['outline', 'centerline', 'hiddenline', 'dimension'];
    if (lineTypes.includes(el.type)) {
      sizeRow.style.display = 'none';
    } else {
      sizeRow.style.display = 'flex';
      document.getElementById('propW').value = Math.round(bounds.width);
      document.getElementById('propH').value = Math.round(bounds.height);
    }

    // 치수 섹션
    const dimSection = document.getElementById('propDimensionSection');
    dimSection.style.display = el.type === 'dimension' ? 'block' : 'none';
    if (el.type === 'dimension') {
      document.getElementById('propDimValue').value = el.value;
      document.getElementById('propDimUnit').value = el.unit || 'mm';
    }

    // 텍스트 섹션
    const textSection = document.getElementById('propTextSection');
    textSection.style.display = el.type === 'text' ? 'block' : 'none';
    if (el.type === 'text') {
      document.getElementById('propTextContent').value = el.content;
      document.getElementById('propFontSize').value = el.fontSize;
    }

    // 스타일
    document.getElementById('propStrokeWidth').value =
      el.thickness || el.fontSize || el.diameter || 2;
    document.getElementById('propColor').value = el.color || '#000000';
    document.getElementById('propColorHex').textContent = el.color || '#000000';
  }

  function hideProperties() {
    document.getElementById('panelNoSelection').style.display = 'block';
    document.getElementById('panelSelection').style.display = 'none';
  }

  // ========== Coordinate Transform ==========
  function clientToSvg(clientX, clientY) {
    const rect = _svg.getBoundingClientRect();
    return {
      x: (clientX - rect.left - _panOffset.x) / _zoom,
      y: (clientY - rect.top - _panOffset.y) / _zoom,
    };
  }

  function applyTransform() {
    _drawingLayer.setAttribute('transform',
      `translate(${_panOffset.x}, ${_panOffset.y}) scale(${_zoom})`);

    const gridSmall = _svg.getElementById('gridSmall');
    const gridLarge = _svg.getElementById('gridLarge');
    if (gridSmall) {
      const gs = 10 * _zoom;
      gridSmall.setAttribute('width', gs);
      gridSmall.setAttribute('height', gs);
    }
    if (gridLarge) {
      const gl = 100 * _zoom;
      gridLarge.setAttribute('width', gl);
      gridLarge.setAttribute('height', gl);
    }

    const pct = Math.round(_zoom * 100);
    const zoomEl = document.getElementById('zoomLevel');
    const zoomFloat = document.getElementById('zoomLabelFloat');
    if (zoomEl) zoomEl.textContent = `${pct}%`;
    if (zoomFloat) zoomFloat.textContent = `${pct}%`;
  }

  // ========== Zoom / Pan ==========
  function zoomIn() { _zoom = Math.min(_zoom * 1.2, 5); applyTransform(); }
  function zoomOut() { _zoom = Math.max(_zoom / 1.2, 0.1); applyTransform(); }

  function fitToView() {
    const bounds = DrawingModel.getAllBounds(_doc.elements);
    const svgRect = _svg.getBoundingClientRect();
    const padding = 80;

    const scaleX = (svgRect.width - padding * 2) / (bounds.width || 1);
    const scaleY = (svgRect.height - padding * 2) / (bounds.height || 1);
    _zoom = Math.min(scaleX, scaleY, 2);
    _zoom = Math.max(_zoom, 0.1);

    _panOffset.x = (svgRect.width - bounds.width * _zoom) / 2 - bounds.x * _zoom;
    _panOffset.y = (svgRect.height - bounds.height * _zoom) / 2 - bounds.y * _zoom;

    applyTransform();
  }

  // ========== Inline Edit ==========
  function startInlineEdit(el, clientX, clientY) {
    const existing = document.querySelector('.inline-edit-input');
    if (existing) existing.remove();

    const input = document.createElement('input');
    input.className = 'inline-edit-input';
    input.type = 'text';

    if (el.type === 'dimension') input.value = el.value;
    else if (el.type === 'text') input.value = el.content;
    else return;

    input.style.left = `${clientX - 40}px`;
    input.style.top = `${clientY - 15}px`;
    document.body.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newVal = input.value.trim();
      if (newVal && newVal !== (el.type === 'dimension' ? el.value : el.content)) {
        if (el.type === 'dimension') el.value = newVal;
        else el.content = newVal;
        _doc.meta.updatedAt = new Date().toISOString();
        History.push(_doc.elements, `${getTypeLabel(el.type)} 수정`);
        Renderer.render(_doc);
        selectElement(el.id);
        App.showToast(`${getTypeLabel(el.type)} 값이 수정되었습니다`, 'success');
      }
      input.remove();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') input.remove();
    });
    input.addEventListener('blur', commit);
  }

  // ========== Modify Element from Properties ==========
  function updateElementFromProps(el) {
    const x = parseInt(document.getElementById('propX').value) || 0;
    const y = parseInt(document.getElementById('propY').value) || 0;
    const bounds = DrawingModel.getElementBounds(el);
    const dx = x - bounds.x;
    const dy = y - bounds.y;

    moveElement(el, dx, dy);

    if (el.type === 'dimension') {
      el.value = document.getElementById('propDimValue').value;
      el.unit = document.getElementById('propDimUnit').value;
    }

    if (el.type === 'text') {
      el.content = document.getElementById('propTextContent').value;
      el.fontSize = parseInt(document.getElementById('propFontSize').value) || 14;
    }

    el.color = document.getElementById('propColor').value;
    document.getElementById('propColorHex').textContent = el.color;

    if (el.type === 'outline' || el.type === 'centerline' || el.type === 'hiddenline') {
      el.thickness = parseFloat(document.getElementById('propStrokeWidth').value) || 2;
    }

    _doc.meta.updatedAt = new Date().toISOString();
    Renderer.render(_doc);
    selectElement(el.id);
  }

  // ========== Element Operations ==========
  function moveElement(el, dx, dy) {
    switch (el.type) {
      case 'outline':
      case 'centerline':
      case 'hiddenline':
      case 'dimension':
        el.x1 += dx; el.y1 += dy;
        el.x2 += dx; el.y2 += dy;
        break;
      case 'text':
        el.x += dx; el.y += dy;
        break;
      case 'hole':
        el.cx += dx; el.cy += dy;
        break;
      case 'slot':
        el.x += dx; el.y += dy;
        break;
      case 'hatch':
        if (el.points) el.points.forEach(p => { p.x += dx; p.y += dy; });
        break;
    }
  }

  function deleteElement(id) {
    const idx = _doc.elements.findIndex(e => e.id === id);
    if (idx === -1) return;
    const el = _doc.elements[idx];
    _doc.elements.splice(idx, 1);
    deselectAll();
    History.push(_doc.elements, `${getTypeLabel(el.type)} 삭제`);
    Renderer.render(_doc);
    App.showToast('요소가 삭제되었습니다', 'info');
  }

  // ========== Event Binding ==========
  function bindEvents() {
    _svg.addEventListener('mousedown', onMouseDown);
    _svg.addEventListener('mousemove', onMouseMove);
    _svg.addEventListener('mouseup', onMouseUp);
    _svg.addEventListener('dblclick', onDoubleClick);
    _svg.addEventListener('wheel', onWheel, { passive: false });

    document.addEventListener('keydown', onKeyDown);

    document.querySelectorAll('.toolbar-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    document.getElementById('btnZoomIn').addEventListener('click', zoomIn);
    document.getElementById('btnZoomOut').addEventListener('click', zoomOut);
    document.getElementById('btnZoomFit').addEventListener('click', fitToView);

    document.getElementById('btnUndo').addEventListener('click', () => History.undo());
    document.getElementById('btnRedo').addEventListener('click', () => History.redo());

    bindPropertyInputs();

    document.getElementById('btnDeleteElement').addEventListener('click', () => {
      if (_selectedId) deleteElement(_selectedId);
    });
  }

  function bindPropertyInputs() {
    const fields = ['propX', 'propY', 'propW', 'propH', 'propDimValue',
      'propDimUnit', 'propTextContent', 'propFontSize', 'propStrokeWidth', 'propColor'];

    fields.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        const selected = getSelected();
        if (selected) {
          updateElementFromProps(selected);
          History.push(_doc.elements, '속성 변경');
        }
      });
    });
  }

  // ========== Mouse Handlers ==========
  function onMouseDown(e) {
    const { clientX, clientY } = e;

    if (e.button === 1 || _tool === 'move') {
      _isPanning = true;
      _panStart = { x: clientX, y: clientY };
      _panOffsetStart = { ..._panOffset };
      e.preventDefault();
      return;
    }

    if (_tool === 'select') {
      const hit = hitTest(clientX, clientY);
      if (hit) {
        selectElement(hit.id);
        _dragging = true;
        _dragStart = clientToSvg(clientX, clientY);
        _dragOriginal = JSON.parse(JSON.stringify(hit));
      } else {
        deselectAll();
      }
    }

    // outline 도구 — 외형선 그리기
    if (_tool === 'outline') {
      const pt = clientToSvg(clientX, clientY);
      const snapped = snapToGrid(pt);
      if (!_lineDrawing) {
        _lineDrawing = true;
        _lineStart = snapped;
      } else {
        const newEl = DrawingModel.createOutline(_lineStart.x, _lineStart.y, snapped.x, snapped.y, 2);
        _doc.elements.push(newEl);
        History.push(_doc.elements, '외형선 추가');
        Renderer.render(_doc);
        App.showToast('외형선이 추가되었습니다', 'success');
        _lineDrawing = false;
        _lineStart = null;
        if (_tempLineEl) { _tempLineEl.remove(); _tempLineEl = null; }
      }
    }

    if (_tool === 'text') {
      const pt = clientToSvg(clientX, clientY);
      const snapped = snapToGrid(pt);
      const text = DrawingModel.createText(snapped.x, snapped.y, '텍스트', 14);
      _doc.elements.push(text);
      History.push(_doc.elements, '텍스트 추가');
      Renderer.render(_doc);
      selectElement(text.id);
      setTimeout(() => startInlineEdit(text, clientX, clientY), 100);
    }

    if (_tool === 'eraser') {
      const hit = hitTest(clientX, clientY);
      if (hit) deleteElement(hit.id);
    }
  }

  function onMouseMove(e) {
    const { clientX, clientY } = e;

    const pt = clientToSvg(clientX, clientY);
    const posEl = document.getElementById('cursorPos');
    if (posEl) posEl.textContent = `${Math.round(pt.x)}, ${Math.round(pt.y)}`;

    if (_isPanning) {
      _panOffset.x = _panOffsetStart.x + (clientX - _panStart.x);
      _panOffset.y = _panOffsetStart.y + (clientY - _panStart.y);
      applyTransform();
      return;
    }

    if (_dragging && _selectedId) {
      const current = clientToSvg(clientX, clientY);
      const dx = current.x - _dragStart.x;
      const dy = current.y - _dragStart.y;

      const el = _doc.elements.find(e => e.id === _selectedId);
      if (el && _dragOriginal) {
        switch (el.type) {
          case 'outline': case 'centerline': case 'hiddenline': case 'dimension':
            el.x1 = _dragOriginal.x1 + dx; el.y1 = _dragOriginal.y1 + dy;
            el.x2 = _dragOriginal.x2 + dx; el.y2 = _dragOriginal.y2 + dy;
            break;
          case 'text':
            el.x = _dragOriginal.x + dx; el.y = _dragOriginal.y + dy;
            break;
          case 'hole':
            el.cx = _dragOriginal.cx + dx; el.cy = _dragOriginal.cy + dy;
            break;
          case 'hatch':
            if (el.points && _dragOriginal.points) {
              el.points.forEach((p, i) => {
                p.x = _dragOriginal.points[i].x + dx;
                p.y = _dragOriginal.points[i].y + dy;
              });
            }
            break;
        }
        Renderer.render(_doc);
        Renderer.showSelection(el);
      }
    }

    if (_tool === 'outline' && _lineDrawing && _lineStart) {
      const current = clientToSvg(clientX, clientY);
      const snapped = snapToGrid(current);
      drawTempLine(_lineStart, snapped);
    }
  }

  function onMouseUp(e) {
    if (_isPanning) { _isPanning = false; return; }

    if (_dragging && _selectedId) {
      _dragging = false;
      const el = _doc.elements.find(e => e.id === _selectedId);
      if (el) {
        History.push(_doc.elements, `${getTypeLabel(el.type)} 이동`);
        showProperties(el);
      }
      _dragOriginal = null;
    }
  }

  function onDoubleClick(e) {
    if (_tool !== 'select') return;

    // v7: 표제란(titleblock) 셀/하단 더블클릭 편집 — SVG 요소에서 직접 확인
    const svgTarget = e.target;
    if (svgTarget && svgTarget.getAttribute && svgTarget.getAttribute('data-editable') === 'true') {
      const tbGroup = svgTarget.closest('[data-type="titleblock"]');
      if (tbGroup) {
        const tbId = tbGroup.getAttribute('data-id');
        const tbEl = _doc.elements.find(el => el.id === tbId);
        if (!tbEl || tbEl.type !== 'titleblock') { /* skip */ }
        else {
          // 하단 정보 블록 편집
          const btmField = svgTarget.getAttribute('data-bottom-field');
          if (btmField) {
            startTitleBlockBottomEdit(tbEl, btmField, e.clientX, e.clientY);
            return;
          }
          // itemRow 셀 편집
          const rowIdx = parseInt(svgTarget.getAttribute('data-row-index'));
          const field = svgTarget.getAttribute('data-field');
          if (!isNaN(rowIdx) && field) {
            startTitleBlockCellEdit(tbEl, rowIdx, field, e.clientX, e.clientY);
            return;
          }
        }
      }
    }

    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return;

    // v7: titleblock 전체 더블클릭 → 첫 번째 편집 가능 itemRow의 partName 편집
    if (hit.type === 'titleblock') {
      const firstEditable = (hit.itemRows || []).findIndex(r => r.editable);
      if (firstEditable >= 0) {
        startTitleBlockCellEdit(hit, firstEditable, 'partName', e.clientX, e.clientY);
      }
      return;
    }

    // v5: placeholder 요소 더블클릭 → 편집
    if (hit._isPlaceholder && (hit.type === 'dimension' || hit.type === 'text')) {
      startPlaceholderEdit(hit, e.clientX, e.clientY);
      return;
    }

    if (hit.type === 'dimension' || hit.type === 'text') {
      startInlineEdit(hit, e.clientX, e.clientY);
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.1, Math.min(5, _zoom * delta));

    const rect = _svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    _panOffset.x = mx - (mx - _panOffset.x) * (newZoom / _zoom);
    _panOffset.y = my - (my - _panOffset.y) * (newZoom / _zoom);
    _zoom = newZoom;

    applyTransform();
  }

  function onKeyDown(e) {
    if (document.querySelector('.inline-edit-input')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); History.undo(); return; }
    if (e.ctrlKey && e.key === 'y') { e.preventDefault(); History.redo(); return; }

    if ((e.key === 'Delete' || e.key === 'Backspace') && _selectedId) {
      e.preventDefault(); deleteElement(_selectedId); return;
    }

    if (e.key === 'Escape') { deselectAll(); setTool('select'); return; }

    const toolKeys = { v: 'select', h: 'move', w: 'outline', t: 'text', e: 'eraser' };
    if (toolKeys[e.key.toLowerCase()] && !e.ctrlKey) {
      setTool(toolKeys[e.key.toLowerCase()]);
    }
  }

  // ========== Helpers ==========
  function snapToGrid(pt, gridSize = 10) {
    return {
      x: Math.round(pt.x / gridSize) * gridSize,
      y: Math.round(pt.y / gridSize) * gridSize,
    };
  }

  function drawTempLine(start, end) {
    if (_tempLineEl) _tempLineEl.remove();
    const NS = 'http://www.w3.org/2000/svg';
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', start.x);
    line.setAttribute('y1', start.y);
    line.setAttribute('x2', end.x);
    line.setAttribute('y2', end.y);
    line.setAttribute('stroke', '#60a5fa');
    line.setAttribute('stroke-width', 2 / _zoom);
    line.setAttribute('stroke-dasharray', `${5 / _zoom} ${3 / _zoom}`);
    const group = document.getElementById('outlinesGroup');
    if (group) group.appendChild(line);
    _tempLineEl = line;
  }

  /**
   * v5: placeholder 요소 전용 편집기
   * 편집 완료 시 _isPlaceholder = false, confidence = confirmed
   */
  function startPlaceholderEdit(el, clientX, clientY) {
    const existing = document.querySelector('.inline-edit-input');
    if (existing) existing.remove();

    const input = document.createElement('input');
    input.className = 'inline-edit-input placeholder-edit';
    input.type = 'text';
    input.placeholder = '값을 입력하세요';

    // 기존 placeholder 텍스트는 지우고 빈 값으로 시작
    if (el.type === 'dimension') {
      input.value = (el.value === '?' || el.value === '⌀?') ? '' : el.value;
      input.placeholder = el.dimStyle === 'diameter' ? 'φ 직경값 입력' : '치수값 입력';
    } else if (el.type === 'text') {
      const isPholder = el.content.includes('____') || el.content.includes('직접입력')
        || el.content.includes('📝') || el.content.includes('미확정');
      input.value = isPholder ? '' : el.content;
      input.placeholder = '텍스트 입력';
    }

    input.style.left = `${clientX - 60}px`;
    input.style.top = `${clientY - 15}px`;
    input.style.minWidth = '120px';
    document.body.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newVal = input.value.trim();
      if (newVal) {
        if (el.type === 'dimension') {
          el.value = el.dimStyle === 'diameter' ? `⌀${newVal}` : newVal;
        } else {
          el.content = newVal;
        }
        // ★ placeholder → confirmed 전환
        el._isPlaceholder = false;
        el.confidence = 'confirmed';
        _doc.meta.updatedAt = new Date().toISOString();
        History.push(_doc.elements, `placeholder 입력: ${newVal}`);
        Renderer.render(_doc);
        selectElement(el.id);
        App.showToast(`값이 입력되었습니다: ${newVal}`, 'success');
      }
      input.remove();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') input.remove();
    });
    input.addEventListener('blur', commit);
  }

  // ========== Title Block Inline Edit — KS 규격 스타일 ==========

  /**
   * 표제란 itemRow 셀 편집
   */
  function startTitleBlockCellEdit(tbEl, rowIndex, field, clientX, clientY) {
    const existing = document.querySelector('.inline-edit-input');
    if (existing) existing.remove();

    const rows = tbEl.itemRows || [];
    const row = rows[rowIndex];
    if (!row || !row.editable) return;

    const input = document.createElement('input');
    input.className = 'inline-edit-input titleblock-edit';
    input.type = 'text';
    input.value = row[field] || '';

    const placeholders = {
      partName: '품명 입력',
      material: '재질 입력 (예: S45C)',
      quantity: '수량',
      remarks: '비고',
    };
    input.placeholder = placeholders[field] || '입력';
    input.style.left = `${clientX - 60}px`;
    input.style.top = `${clientY - 15}px`;
    input.style.minWidth = '100px';
    document.body.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newVal = input.value.trim();
      if (newVal !== (row[field] || '')) {
        row[field] = newVal;

        // 메타데이터 동기화
        if (field === 'partName') {
          _doc.meta.partName = newVal;
        } else if (field === 'material') {
          _doc.meta.material = newVal;
        } else if (field === 'quantity') {
          _doc.meta.quantity = newVal;
        } else if (field === 'remarks') {
          _doc.meta.remarks = newVal;
        }

        _doc.meta.updatedAt = new Date().toISOString();
        History.push(_doc.elements, `표제란 수정: ${field} = ${newVal}`);
        Renderer.render(_doc);
        selectElement(tbEl.id);
        App.showToast(`표제란 값이 수정되었습니다: ${newVal}`, 'success');
      }
      input.remove();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') input.remove();
    });
    input.addEventListener('blur', commit);
  }

  /**
   * 표제란 하단 정보 블록(작품명/척도/각법) 편집
   */
  function startTitleBlockBottomEdit(tbEl, bottomField, clientX, clientY) {
    const existing = document.querySelector('.inline-edit-input');
    if (existing) existing.remove();

    const btm = tbEl.bottomInfo || {};

    // 각법은 select로 처리
    if (bottomField === 'projectionMethod') {
      const sel = document.createElement('select');
      sel.className = 'inline-edit-input titleblock-edit';
      sel.innerHTML = `
        <option value="3각법" ${btm.projectionMethod === '3각법' ? 'selected' : ''}>3각법</option>
        <option value="1각법" ${btm.projectionMethod === '1각법' ? 'selected' : ''}>1각법</option>
      `;
      sel.style.left = `${clientX - 40}px`;
      sel.style.top = `${clientY - 15}px`;
      sel.style.minWidth = '80px';
      document.body.appendChild(sel);
      sel.focus();

      const commit = () => {
        const newVal = sel.value;
        if (newVal !== (btm.projectionMethod || '3각법')) {
          btm.projectionMethod = newVal;
          _doc.meta.projectionMethod = newVal;
          _doc.meta.updatedAt = new Date().toISOString();
          History.push(_doc.elements, `각법 변경: ${newVal}`);
          Renderer.render(_doc);
          selectElement(tbEl.id);
          App.showToast(`각법이 변경되었습니다: ${newVal}`, 'success');
        }
        sel.remove();
      };

      sel.addEventListener('change', commit);
      sel.addEventListener('blur', () => sel.remove());
      return;
    }

    const input = document.createElement('input');
    input.className = 'inline-edit-input titleblock-edit';
    input.type = 'text';
    input.value = btm[bottomField] || '';

    const placeholders = { title: '작품명 입력', scale: '척도 (예: 1:2)' };
    input.placeholder = placeholders[bottomField] || '입력';
    input.style.left = `${clientX - 60}px`;
    input.style.top = `${clientY - 15}px`;
    input.style.minWidth = '100px';
    document.body.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const newVal = input.value.trim();
      if (newVal !== (btm[bottomField] || '')) {
        btm[bottomField] = newVal;

        if (bottomField === 'title') {
          _doc.meta.partName = newVal;
        } else if (bottomField === 'scale') {
          _doc.meta.scale = newVal;
        }

        _doc.meta.updatedAt = new Date().toISOString();
        History.push(_doc.elements, `표제란 하단 수정: ${bottomField} = ${newVal}`);
        Renderer.render(_doc);
        selectElement(tbEl.id);
        App.showToast(`표제란 값이 수정되었습니다: ${newVal}`, 'success');
      }
      input.remove();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') input.remove();
    });
    input.addEventListener('blur', commit);
  }

  function getTypeLabel(type) {
    const labels = {
      outline: '외형선', centerline: '중심선', hole: '구멍/탭',
      slot: '슬롯', hatch: '해칭', dimension: '치수', text: '텍스트',
      titleblock: '표제란',
    };
    return labels[type] || type;
  }

  function getDocument() { return _doc; }

  function setDocument(doc) {
    _doc = doc;
    deselectAll();
    Renderer.render(_doc);
    fitToView();
  }

  return {
    init, setTool, getTool, selectElement, deselectAll, getSelected,
    getDocument, setDocument, zoomIn, zoomOut, fitToView,
    deleteElement, moveElement,
  };
})();
