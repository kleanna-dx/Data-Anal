/* ============================================================
   app.js
   AutoDrawing 메인 애플리케이션 컨트롤러 — 기계도면 전용

   파이프라인:
   손도면 업로드 → AI 형상 복제 → 편집기 (형상 초안 + placeholder)
   데모 → generateMechDemo() → 편집기

   v5: 형상 초안 + 빈 정보칸 상태로 출력
       속성 패널에 재질/표면거칠기/나사 규격/메모 placeholder 표시
   ============================================================ */

const App = (() => {
  let _currentStep = 1;
  let _uploadedFile = null;
  let _document = null;
  let _currentDrawingType = 'shaft'; // 현재 선택된 도면 유형
  let _exportTargetDoc = null; // DB탭 내보내기 시 임시 저장용
  let _currentProjectId = null;       // DB에서 열린 프로젝트의 ID (null = 신규)
  let _previousStep = 1;              // DB 화면에서 돌아갈 때 사용

  // ========== LocalStorage Key ==========
  const DB_KEY = 'autodrawing_projects';

  // ========== Init ==========
  function init() {
    bindTabEvents();
    bindUploadEvents();
    bindHeaderEvents();
    bindExportEvents();
    bindDBEvents();
    bindSaveDraftEvents();
    updateDBBadge();
    goToStep(1);
    showToast('AutoDrawing에 오신 것을 환영합니다! 도면 유형을 선택하세요.', 'info');
  }

  // ========== Drawing Type Tabs ==========
  function bindTabEvents() {
    const tabs = document.querySelectorAll('.drawing-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        if (tab.classList.contains('disabled')) {
          showToast('이 도면 유형은 아직 준비중입니다', 'info');
          return;
        }
        const tabType = tab.dataset.tab;
        activateTab(tabType);
      });
    });
  }

  function activateTab(tabType) {
    _currentDrawingType = tabType;
    
    // Update tab buttons
    document.querySelectorAll('.drawing-tab').forEach(t => t.classList.remove('active'));
    const activeTab = document.querySelector(`.drawing-tab[data-tab="${tabType}"]`);
    if (activeTab) activeTab.classList.add('active');

    // Update tab panels
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const panelId = 'tabPanel' + tabType.charAt(0).toUpperCase() + tabType.slice(1);
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('active');

    // Reset upload state when switching tabs
    resetUpload();
  }

  // ========== Step Navigation ==========
  function goToStep(step) {
    _currentStep = step;

    document.querySelectorAll('.screen').forEach(s => {
      s.classList.remove('active');
      s.style.removeProperty('display'); // ★ inline style 잔여물 제거
    });
    const screens = { 1: 'screenHome', 2: 'screenAI', 3: 'screenEditor' };
    const target = document.getElementById(screens[step]);
    if (target) target.classList.add('active');

    document.querySelectorAll('.step-item').forEach(item => {
      const s = parseInt(item.dataset.step);
      item.classList.remove('active', 'completed');
      if (s < step) item.classList.add('completed');
      if (s === step) item.classList.add('active');
    });

    document.querySelectorAll('.step-connector').forEach((conn, i) => {
      conn.classList.toggle('completed', i + 1 < step);
    });

    document.getElementById('btnExport').disabled = step !== 3;
    document.getElementById('btnSaveDraft').disabled = step !== 3;
  }

  // ========== Upload ==========
  function bindUploadEvents() {
    // Shaft-specific upload zone
    const zone = document.getElementById('shaftUploadZone');
    const fileInput = document.getElementById('fileInput');

    if (zone) {
      zone.addEventListener('click', () => fileInput.click());

      zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
      });

      zone.addEventListener('dragleave', () => {
        zone.classList.remove('dragover');
      });

      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
        const files = e.dataTransfer.files;
        if (files.length > 0) handleFile(files[0]);
      });
    }

    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFile(e.target.files[0]);
      });
    }

    document.getElementById('btnReUpload').addEventListener('click', () => resetUpload());
    document.getElementById('btnStartAI').addEventListener('click', () => startAIProcessing());

    // 데모 버튼
    const btnDemo = document.getElementById('btnDemoMech');
    if (btnDemo) btnDemo.addEventListener('click', () => startDemo());
  }

  function handleFile(file) {
    const validTypes = ['image/png', 'image/jpeg', 'image/bmp', 'image/webp', 'application/pdf'];
    if (!validTypes.includes(file.type)) {
      showToast('지원하지 않는 파일 형식입니다', 'error');
      return;
    }

    _uploadedFile = file;

    const previewWrap = document.getElementById('uploadPreview');
    const previewImg = document.getElementById('previewImg');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');

    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => { previewImg.src = e.target.result; };
      reader.readAsDataURL(file);
    } else {
      previewImg.src = '';
      previewImg.alt = 'PDF 파일';
    }

    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);

    // Hide upload zone (shaft-specific)
    const shaftZone = document.getElementById('shaftUploadZone');
    if (shaftZone) shaftZone.style.display = 'none';
    previewWrap.classList.add('active');

    // 현재 탭 유형에 맞는 힌트 표시
    const typeLabels = {
      shaft: '🔧 Shaft 도면으로 분석합니다',
      flange: '⚙️ Flange 도면으로 분석합니다',
      bracket: '📐 Bracket 도면으로 분석합니다',
      gear: '🔩 Gear 도면으로 분석합니다',
    };
    showToast(`"${file.name}" — ${typeLabels[_currentDrawingType] || '도면을 분석합니다'}`, 'info');
  }

  function resetUpload() {
    _uploadedFile = null;
    // Shaft upload zone visibility
    const shaftZone = document.getElementById('shaftUploadZone');
    if (shaftZone) shaftZone.style.display = '';
    const preview = document.getElementById('uploadPreview');
    if (preview) preview.classList.remove('active');
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';
  }

  // ========== AI Processing ==========
  async function startAIProcessing() {
    if (!_uploadedFile) {
      showToast('파일을 먼저 업로드하세요', 'error');
      return;
    }

    goToStep(2);
    AIEngine.resetAISteps();

    try {
      _document = await AIEngine.analyzeImage(_uploadedFile);

      const typeLabels = {
        mechanical: '📐 형상 초안',
        unknown: '📐 도면 초안',
      };
      const typeLabel = typeLabels[_document.drawingType] || '도면';
      showToast(`${typeLabel} 생성이 완료되었습니다! ✨`, 'success');
      await new Promise(r => setTimeout(r, 400));

      enterEditor(_document);
    } catch (err) {
      if (err.message && err.message.includes('취소')) {
        showToast('분석이 취소되었습니다', 'info');
      } else {
        showToast('AI 처리 중 오류가 발생했습니다', 'error');
        console.error('[App:startAIProcessing]', err);
      }
      goToStep(1);
    }
  }

  // ========== Demo ==========
  async function startDemo() {
    goToStep(2);
    AIEngine.resetAISteps();

    try {
      // 데모용 애니메이션
      const steps = AIEngine.getAnalysisSteps();
      for (const s of steps) {
        AIEngine.updateAIStep(s.step, 'active');
        await AIEngine.delay(s.delay * 0.5);
        AIEngine.updateAIStep(s.step, 'done');
        const progress = (s.step / steps.length) * 100;
        const fillEl = document.getElementById('aiProgressFill');
        if (fillEl) fillEl.style.width = `${progress}%`;
      }

      _document = AIEngine.generateMechDemo();
      showToast('형상 초안이 생성되었습니다! 📐', 'success');

      await new Promise(r => setTimeout(r, 400));
      enterEditor(_document);
    } catch (err) {
      showToast('AI 처리 중 오류가 발생했습니다', 'error');
      console.error('[App:startDemo]', err);
      goToStep(1);
    }
  }

  // ========== Enter Editor ==========
  function enterEditor(doc) {
    goToStep(3);
    _document = doc;

    // 레이어 패널 동적 업데이트
    updateLayersPanel(doc);

    // 도면 유형 뱃지
    updateDrawingTypeBadge(doc.drawingType);

    // History 초기화
    History.init((restoredElements, action) => {
      _document.elements = restoredElements;
      Renderer.render(_document);
      Editor.deselectAll();
      showToast(action === 'undo' ? '실행취소됨' : '다시실행됨', 'info');
    });
    History.push(doc.elements, '초기 상태');

    // Editor 초기화
    Editor.init(doc);
    Renderer.render(doc);

    // v5: Confidence 범례 + annotation 패널 + self-check
    showConfidenceLegend(doc);
    showSelfCheckPanel(doc);
    showAnnotationPanel(doc);

    setTimeout(() => Editor.fitToView(), 100);
  }

  // ========== UI 동적 변경 ==========

  function updateLayersPanel(doc) {
    const listEl = document.getElementById('layersList');
    if (!listEl) return;

    listEl.innerHTML = '';
    const layerColors = {
      outlines: '#000000', centerlines: '#f87171', dimensions: '#60a5fa',
      texts: '#94a3b8', holes: '#a78bfa', slots: '#fbbf24', hatching: '#475569',
      hiddenlines: '#4ade80',
    };

    Object.entries(doc.layers).forEach(([key, layer]) => {
      const li = document.createElement('li');
      li.className = 'layer-item';
      li.dataset.layer = key;
      li.innerHTML = `
        <span class="layer-color" style="background:${layerColors[key] || layer.color}"></span>
        <span class="layer-name">${layer.label || key}</span>
        <span class="layer-count" id="${key}Count">0</span>
        <button class="layer-visibility" data-layer-toggle="${key}"><i class="fas fa-eye"></i></button>
      `;
      listEl.appendChild(li);

      const btn = li.querySelector('.layer-visibility');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        btn.innerHTML = layer.visible ?
          '<i class="fas fa-eye"></i>' :
          '<i class="fas fa-eye-slash"></i>';
        Renderer.render(doc);
      });
    });
  }

  function showConfidenceLegend(doc) {
    // 요소에 confidence 태그가 있는지 확인
    const hasConf = doc.elements.some(el => el.confidence);
    if (!hasConf) return;

    let legend = document.getElementById('confidenceLegend');
    if (!legend) {
      legend = document.createElement('div');
      legend.id = 'confidenceLegend';
      legend.style.cssText = `
        position:absolute; bottom:36px; right:12px; z-index:20;
        background:rgba(15,23,42,0.92); border:1px solid rgba(255,255,255,0.1);
        border-radius:8px; padding:8px 12px; font-size:11px;
        display:flex; gap:12px; align-items:center; color:#94a3b8;
      `;
      const canvasWrap = document.querySelector('.editor-canvas-area');
      if (canvasWrap) canvasWrap.appendChild(legend);
    }

    // v5: 통계 (placeholder 포함)
    const counts = { confirmed: 0, estimated: 0, uncertain: 0, placeholder: 0 };
    doc.elements.forEach(el => {
      if (el._isPlaceholder) { counts.placeholder++; return; }
      const c = el.confidence;
      if (c === 'confirmed') counts.confirmed++;
      else if (c === 'estimated') counts.estimated++;
      else if (c === 'uncertain') counts.uncertain++;
    });

    legend.innerHTML = `
      <span style="font-weight:600;color:#e2e8f0;">v5 형상초안</span>
      <span><span style="display:inline-block;width:8px;height:8px;background:#10b981;border-radius:50%;margin-right:3px;"></span>
        확정 (${counts.confirmed})</span>
      <span><span style="display:inline-block;width:8px;height:8px;background:#3b82f6;border-radius:50%;margin-right:3px;"></span>
        추정 (${counts.estimated})</span>
      <span><span style="display:inline-block;width:8px;height:8px;background:#fbbf24;border-radius:50%;margin-right:3px;"></span>
        불확실 (${counts.uncertain})</span>
      <span><span style="display:inline-block;width:8px;height:8px;background:#6b7280;border-radius:50%;margin-right:3px;"></span>
        ✉️ placeholder (${counts.placeholder})</span>
    `;
  }

  /**
   * v8: Self-check 결과를 좌측 하단 플로팅 패널로 표시
   * (이전: 도면 캔버스 위에 직접 표시 → 표제란 침범 문제)
   */
  function showSelfCheckPanel(doc) {
    const sc = doc._selfCheck;
    // 이전 패널 제거
    const existing = document.getElementById('selfCheckPanel');
    if (existing) existing.remove();

    if (!sc) return;

    const panel = document.createElement('div');
    panel.id = 'selfCheckPanel';
    panel.style.cssText = `
      position:absolute; bottom:36px; left:12px; z-index:20;
      background:rgba(15,23,42,0.95); border:1px solid rgba(255,255,255,0.12);
      border-radius:10px; padding:12px 16px; font-size:11px;
      color:#cbd5e1; max-width:380px; min-width:220px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      backdrop-filter: blur(8px);
    `;

    // 헤더: 형상 일치율
    const fidelityColor = sc.geometryFidelity >= 90 ? '#10b981'
      : sc.geometryFidelity >= 70 ? '#fbbf24' : '#ef4444';

    let html = `
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <span style="font-weight:700; font-size:12px; color:#e2e8f0;">
          Self-Check
        </span>
        <span style="font-weight:700; font-size:13px; color:${fidelityColor};">
          형상 일치율 ${sc.geometryFidelity}%
        </span>
        <button id="selfCheckClose" style="
          background:none; border:none; color:#64748b; cursor:pointer;
          font-size:14px; padding:0 0 0 8px; line-height:1;
        ">&times;</button>
      </div>
    `;

    // 통계 바
    const st = sc.stats || {};
    html += `
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px; font-size:10px; color:#94a3b8;">
        <span>구간 ${st.sectionCount || 0}</span>
        <span>|</span>
        <span>구멍 ${st.holeCount || 0}</span>
        <span>|</span>
        <span>숨은선 ${st.hiddenFeatureCount || 0}</span>
        <span>|</span>
        <span>보조투상 ${st.auxiliaryViewCount || 0}</span>
      </div>
    `;

    // 에러 목록
    if (sc.errors && sc.errors.length > 0) {
      html += `<div style="margin-top:6px;">`;
      sc.errors.forEach(e => {
        html += `<div style="color:#ef4444; padding:2px 0; font-size:11px;">❌ ${e}</div>`;
      });
      html += `</div>`;
    }

    // 경고 목록
    if (sc.warnings && sc.warnings.length > 0) {
      html += `<div style="margin-top:4px;">`;
      sc.warnings.forEach(w => {
        html += `<div style="color:#fbbf24; padding:2px 0; font-size:10px;">⚠️ ${w}</div>`;
      });
      html += `</div>`;
    }

    // 통과 표시
    if (sc.passed && (!sc.errors || sc.errors.length === 0)) {
      html += `<div style="margin-top:6px; color:#10b981; font-size:11px;">✅ 형상 검증 통과</div>`;
    }

    panel.innerHTML = html;

    const canvasWrap = document.querySelector('.editor-canvas-area');
    if (canvasWrap) canvasWrap.appendChild(panel);

    // 닫기 버튼
    const closeBtn = panel.querySelector('#selfCheckClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => panel.remove());
    }
  }

  /**
   * v5: 속성 패널에 재질/표면거칠기/나사 규격/메모 placeholder 표시
   */
  function showAnnotationPanel(doc) {
    let panel = document.getElementById('annotationPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'annotationPanel';
      panel.className = 'panel-section';
      const propsPanel = document.getElementById('propertiesPanel');
      if (propsPanel) {
        // 직접 자식 중 마지막 .panel-section (레이어 섹션) 앞에 삽입
        const children = Array.from(propsPanel.children);
        const layerSection = children.filter(c => c.classList.contains('panel-section')).pop();
        if (layerSection && layerSection.parentNode === propsPanel) {
          propsPanel.insertBefore(panel, layerSection);
        } else {
          propsPanel.appendChild(panel);
        }
      }
    }

    const meta = doc.meta || {};
    const mat = meta.material || '';
    const sf = meta.surfaceFinish || '';
    const pn = meta.partName || '';
    const pno = meta.partNo || '';

    const scaleVal = meta.scale || '1:1';
    const projVal = meta.projectionMethod || '3각법';
    const qtyVal = meta.quantity || '';
    const remVal = meta.remarks || '';

    panel.innerHTML = `
      <h4>편집 정보 <span style="font-size:9px;color:#f59e0b;font-weight:normal;">v7 KS</span></h4>
      <div class="form-row">
        <span class="form-label">품명</span>
        <input type="text" class="form-input annotation-input" id="annPartName"
          value="${pn === '직접입력' ? '' : escapeHtml(pn)}" placeholder="품명 입력">
      </div>
      <div class="form-row">
        <span class="form-label">재질</span>
        <input type="text" class="form-input annotation-input" id="annMaterial"
          value="${escapeHtml(mat)}" placeholder="예: S45C">
      </div>
      <div class="form-row">
        <span class="form-label">척도</span>
        <input type="text" class="form-input annotation-input" id="annScale"
          value="${escapeHtml(scaleVal)}" placeholder="1:1">
      </div>
      <div class="form-row">
        <span class="form-label">각법</span>
        <select class="form-input annotation-input" id="annProjection">
          <option value="3각법" ${projVal === '3각법' ? 'selected' : ''}>3각법</option>
          <option value="1각법" ${projVal === '1각법' ? 'selected' : ''}>1각법</option>
        </select>
      </div>
      <div class="form-row">
        <span class="form-label">수량</span>
        <input type="text" class="form-input annotation-input" id="annQuantity"
          value="${escapeHtml(qtyVal)}" placeholder="수량">
      </div>
      <div class="form-row">
        <span class="form-label">비고</span>
        <input type="text" class="form-input annotation-input" id="annRemarks"
          value="${escapeHtml(remVal)}" placeholder="비고">
      </div>
      <div class="form-row">
        <span class="form-label">표면거칠기</span>
        <input type="text" class="form-input annotation-input" id="annSurfaceFinish"
          value="${escapeHtml(sf)}" placeholder="예: Ra 1.6">
      </div>
    `;

    // 변경 이벤트 바인딩
    ['annPartName', 'annMaterial', 'annScale', 'annProjection', 'annQuantity', 'annRemarks', 'annSurfaceFinish'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        if (id === 'annPartName') doc.meta.partName = el.value;
        if (id === 'annMaterial') doc.meta.material = el.value;
        if (id === 'annScale') doc.meta.scale = el.value;
        if (id === 'annProjection') doc.meta.projectionMethod = el.value;
        if (id === 'annQuantity') doc.meta.quantity = el.value;
        if (id === 'annRemarks') doc.meta.remarks = el.value;
        if (id === 'annSurfaceFinish') doc.meta.surfaceFinish = el.value;
        doc.meta.updatedAt = new Date().toISOString();
        showToast('속성이 업데이트되었습니다', 'success');
      });
    });
  }

  function updateDrawingTypeBadge(drawingType) {
    let badge = document.getElementById('drawingTypeBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'drawingTypeBadge';
      badge.style.cssText = 'font-size:11px;padding:3px 10px;border-radius:10px;font-weight:600;margin-left:8px;';
      const infoBar = document.querySelector('.canvas-info-bar');
      if (infoBar) infoBar.appendChild(badge);
    }

    const labels = {
      mechanical: { text: '🔧 기계도면', bg: '#1e3a5f', color: '#93c5fd' },
      unknown:    { text: '⚠ 유형 미확정', bg: '#3c2a1a', color: '#fbbf24' },
    };
    const cfg = labels[drawingType] || labels.unknown;
    badge.textContent = cfg.text;
    badge.style.background = cfg.bg;
    badge.style.color = cfg.color;
    badge.style.display = 'inline';
  }

  // ========== Header ==========
  function bindHeaderEvents() {
    // 로고 클릭 → 초기 화면으로
    document.querySelector('.app-logo').addEventListener('click', () => {
      if (_currentStep === 3) {
        if (!confirm('현재 편집 중인 도면이 있습니다. 초기 화면으로 돌아가시겠습니까?')) return;
      }
      // DB 화면이 열려있으면 닫기
      document.getElementById('screenDB').classList.remove('active');
      resetAll();
    });

    document.getElementById('btnNewProject').addEventListener('click', () => {
      if (_currentStep === 3) {
        if (!confirm('현재 편집 중인 도면이 있습니다. 새로 시작하시겠습니까?')) return;
      }
      resetAll();
    });
  }

  function resetAll() {
    _uploadedFile = null;
    _document = null;
    _currentProjectId = null;
    resetUpload();
    const badge = document.getElementById('drawingTypeBadge');
    if (badge) badge.style.display = 'none';
    goToStep(1);
    showToast('새 프로젝트를 시작합니다', 'info');
  }

  // ========== Save Draft (임시저장) ==========
  function bindSaveDraftEvents() {
    const modal = document.getElementById('saveDraftModal');
    const nameInput = document.getElementById('saveDraftName');

    document.getElementById('btnSaveDraft').addEventListener('click', () => {
      if (!_document) return;
      // 기존 프로젝트면 이름을 미리 채워줌
      if (_currentProjectId) {
        const projects = loadProjects();
        const existing = projects.find(p => p.id === _currentProjectId);
        if (existing) nameInput.value = existing.name;
      } else {
        const partName = _document.meta?.partName;
        nameInput.value = (partName && partName !== '직접입력') ? partName : '';
      }
      modal.classList.add('active');
      setTimeout(() => nameInput.focus(), 100);
    });

    document.getElementById('btnCancelSaveDraft').addEventListener('click', () => {
      modal.classList.remove('active');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.remove('active');
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btnConfirmSaveDraft').click();
      if (e.key === 'Escape') modal.classList.remove('active');
    });

    document.getElementById('btnConfirmSaveDraft').addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) {
        showToast('프로젝트 이름을 입력하세요', 'error');
        nameInput.focus();
        return;
      }
      saveDraftProject(name);
      modal.classList.remove('active');
    });
  }

  function saveDraftProject(name) {
    const doc = Editor.getDocument ? Editor.getDocument() : _document;
    if (!doc) return;

    const projects = loadProjects();
    const now = new Date().toISOString();

    // SVG 미리보기 생성
    const svgPreview = generateSVGPreview(doc);

    if (_currentProjectId) {
      // 기존 프로젝트 덮어쓰기
      const idx = projects.findIndex(p => p.id === _currentProjectId);
      if (idx >= 0) {
        projects[idx].name = name;
        projects[idx].document = JSON.parse(JSON.stringify(doc));
        projects[idx].svgPreview = svgPreview;
        projects[idx].updatedAt = now;
        projects[idx].elementCount = doc.elements ? doc.elements.length : 0;
      }
    } else {
      // 신규 프로젝트
      const id = 'proj_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      projects.push({
        id,
        name,
        document: JSON.parse(JSON.stringify(doc)),
        svgPreview,
        createdAt: now,
        updatedAt: now,
        elementCount: doc.elements ? doc.elements.length : 0,
      });
      _currentProjectId = id;
    }

    saveProjects(projects);
    updateDBBadge();
    showToast(`"${name}" 프로젝트가 저장되었습니다`, 'success');
  }

  function generateSVGPreview(doc) {
    try {
      const bounds = DrawingModel.getAllBounds(doc.elements);
      const padding = 20;
      const w = bounds.width + padding * 2;
      const h = bounds.height + padding * 2;
      const vx = bounds.x - padding;
      const vy = bounds.y - padding;

      let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${w} ${h}" style="background:#242836;">`;
      svg += `<defs>`;
      svg += `<marker id="pa" markerWidth="4" markerHeight="3" refX="0" refY="1.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M4 0L0 1.5L4 3" fill="#60a5fa" stroke="none"/></marker>`;
      svg += `<marker id="pb" markerWidth="4" markerHeight="3" refX="4" refY="1.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0L4 1.5L0 3" fill="#60a5fa" stroke="none"/></marker>`;
      svg += `</defs>`;

      doc.elements.forEach(el => {
        if (el.type === 'outline')
          svg += `<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="#e2e8f0" stroke-width="${el.strokeWidth||2}"/>`;
        else if (el.type === 'centerline')
          svg += `<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="#f87171" stroke-width="0.5" stroke-dasharray="8 3 2 3"/>`;
        else if (el.type === 'hiddenline')
          svg += `<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="#4ade80" stroke-width="1" stroke-dasharray="4 3"/>`;
        else if (el.type === 'dimension') {
          const isH = Math.abs(el.y2-el.y1) < Math.abs(el.x2-el.x1);
          const off = el.offset||30;
          let lx1,ly1,lx2,ly2;
          if (isH) { ly1=ly2=Math.min(el.y1,el.y2)-off; lx1=el.x1; lx2=el.x2; }
          else { lx1=lx2=Math.min(el.x1,el.x2)-off; ly1=el.y1; ly2=el.y2; }
          svg += `<line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="#60a5fa" stroke-width="0.8" marker-start="url(#pa)" marker-end="url(#pb)"/>`;
          const mx=(lx1+lx2)/2, my=(ly1+ly2)/2;
          if (isH)
            svg += `<text x="${mx}" y="${my-3}" fill="#60a5fa" font-size="9" text-anchor="middle" font-family="monospace">${el.value||''}</text>`;
          else
            svg += `<text x="${mx-4}" y="${my+3}" fill="#60a5fa" font-size="9" text-anchor="end" font-family="monospace">${el.value||''}</text>`;
        }
      });

      svg += `</svg>`;
      return svg;
    } catch(e) {
      return '';
    }
  }

  // ========== DB (프로젝트 열람) ==========
  function bindDBEvents() {
    document.getElementById('btnDBTab').addEventListener('click', () => {
      openDBScreen();
    });

    document.getElementById('btnDBBack').addEventListener('click', () => {
      closeDBScreen();
    });
  }

  function openDBScreen() {
    _previousStep = _currentStep;
    // 모든 화면 숨기고 DB 화면만 표시
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.remove('active');
      s.style.removeProperty('display'); // ★ inline style 잔여물 제거
    });
    document.getElementById('screenDB').classList.add('active');
    renderDBGrid();
  }

  function closeDBScreen() {
    document.getElementById('screenDB').classList.remove('active');
    goToStep(_previousStep);
  }

  function renderDBGrid() {
    const projects = loadProjects();
    const grid = document.getElementById('dbGrid');
    const empty = document.getElementById('dbEmpty');
    const countEl = document.getElementById('dbCount');

    countEl.textContent = projects.length + '개';

    if (projects.length === 0) {
      empty.style.display = '';
      grid.style.display = 'none';
      return;
    }

    empty.style.display = 'none';
    grid.style.display = '';

    // 최신순 정렬
    const sorted = [...projects].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    grid.innerHTML = sorted.map(proj => {
      const date = new Date(proj.updatedAt);
      const dateStr = `${date.getFullYear()}.${String(date.getMonth()+1).padStart(2,'0')}.${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
      const elCount = proj.elementCount || 0;

      return `
        <div class="db-project-card" data-project-id="${proj.id}">
          <div class="db-card-preview">
            ${proj.svgPreview ? proj.svgPreview : '<i class="fas fa-drafting-compass preview-placeholder"></i>'}
          </div>
          <div class="db-card-body">
            <div class="db-card-name" title="${escapeHtml(proj.name)}">${escapeHtml(proj.name)}</div>
            <div class="db-card-meta">
              <span><i class="fas fa-clock"></i> ${dateStr}</span>
              <span><i class="fas fa-object-group"></i> ${elCount}개 요소</span>
            </div>
            <div class="db-card-actions">
              <button class="btn btn-card-edit" data-action="edit" data-id="${proj.id}">
                <i class="fas fa-pen"></i> 편집
              </button>
              <button class="btn btn-card-export" data-action="export" data-id="${proj.id}">
                <i class="fas fa-download"></i> 내보내기
              </button>
              <button class="btn btn-card-delete" data-action="delete" data-id="${proj.id}" title="삭제">
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    // 이벤트 바인딩
    grid.querySelectorAll('[data-action="edit"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openProject(btn.dataset.id);
      });
    });

    grid.querySelectorAll('[data-action="export"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportProject(btn.dataset.id);
      });
    });

    grid.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteProject(btn.dataset.id);
      });
    });

    // 카드 클릭으로도 편집 열기
    grid.querySelectorAll('.db-project-card').forEach(card => {
      card.addEventListener('click', () => {
        openProject(card.dataset.projectId);
      });
    });
  }

  function openProject(id) {
    const projects = loadProjects();
    const proj = projects.find(p => p.id === id);
    if (!proj || !proj.document) {
      showToast('프로젝트를 열 수 없습니다', 'error');
      return;
    }

    _currentProjectId = id;
    _document = JSON.parse(JSON.stringify(proj.document));

    // DB 화면 닫고 편집기로
    // ★ classList만 사용 — inline style.display 설정 금지
    //   inline style은 CSS class보다 우선하므로, 한번 display:none을 설정하면
    //   이후 openDBScreen()에서 .active 클래스를 추가해도 표시되지 않음
    document.getElementById('screenDB').classList.remove('active');

    enterEditor(_document);
    showToast(`"${proj.name}" 프로젝트를 불러왔습니다`, 'success');
  }

  function exportProject(id) {
    const projects = loadProjects();
    const proj = projects.find(p => p.id === id);
    if (!proj || !proj.document) {
      showToast('프로젝트를 찾을 수 없습니다', 'error');
      return;
    }
    // 내보내기 모달 열기 (기존 exportModal 재사용)
    _exportTargetDoc = proj.document;
    _exportTargetDoc._projectName = proj.name; // 파일명용
    const modal = document.getElementById('exportModal');
    if (modal) modal.classList.add('active');
  }

  function deleteProject(id) {
    const projects = loadProjects();
    const proj = projects.find(p => p.id === id);
    if (!proj) return;

    if (!confirm(`"${proj.name}" 프로젝트를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;

    const updated = projects.filter(p => p.id !== id);
    saveProjects(updated);
    updateDBBadge();

    // 현재 열린 프로젝트가 삭제된 경우 초기화
    if (_currentProjectId === id) {
      _currentProjectId = null;
    }

    showToast(`"${proj.name}" 프로젝트가 삭제되었습니다`, 'info');
    renderDBGrid();
  }

  // ========== DB Badge ==========
  function updateDBBadge() {
    const projects = loadProjects();
    const btn = document.getElementById('btnDBTab');
    // 기존 배지 제거
    const oldBadge = btn.querySelector('.db-badge');
    if (oldBadge) oldBadge.remove();

    if (projects.length > 0) {
      const badge = document.createElement('span');
      badge.className = 'db-badge';
      badge.textContent = projects.length;
      btn.appendChild(badge);
    }
  }

  // ========== LocalStorage Helpers ==========
  function loadProjects() {
    try {
      return JSON.parse(localStorage.getItem(DB_KEY) || '[]');
    } catch(e) {
      return [];
    }
  }

  function saveProjects(projects) {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(projects));
    } catch(e) {
      // localStorage가 꽉 차면 오래된 프로젝트의 svgPreview를 제거
      console.warn('[DB] localStorage full, trimming previews');
      projects.forEach(p => { p.svgPreview = ''; });
      try {
        localStorage.setItem(DB_KEY, JSON.stringify(projects));
      } catch(e2) {
        showToast('저장 공간이 부족합니다. 오래된 프로젝트를 삭제해주세요.', 'error');
      }
    }
  }

  // ========== Export ==========
  function bindExportEvents() {
    const modal = document.getElementById('exportModal');

    document.getElementById('btnExport').addEventListener('click', () => {
      modal.classList.add('active');
    });

    document.getElementById('btnCloseExport').addEventListener('click', () => {
      _exportTargetDoc = null;
      modal.classList.remove('active');
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        _exportTargetDoc = null;
        modal.classList.remove('active');
      }
    });

    document.querySelectorAll('.export-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const format = opt.dataset.export;
        // DB탭 내보내기 또는 편집기 내보내기
        const doc = _exportTargetDoc || Editor.getDocument();
        if (!doc) {
          showToast('내보낼 도면이 없습니다', 'error');
          return;
        }

        switch (format) {
          case 'svg': Exporter.exportSVG(doc); break;
          case 'dxf': Exporter.exportDXF(doc); break;
          case 'pdf': Exporter.exportPDF(doc); break;
          case 'json': Exporter.exportJSON(doc); break;
        }

        const name = _exportTargetDoc?._projectName || '';
        showToast(`${name ? '"' + name + '" ' : ''}${format.toUpperCase()} 형식으로 내보내기 완료!`, 'success');
        _exportTargetDoc = null;
        modal.classList.remove('active');
      });
    });
  }

  // ========== Toast ==========
  function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', info: 'fa-info-circle' };
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${message}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ========== Helpers ==========
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  document.addEventListener('DOMContentLoaded', init);

  return { showToast, goToStep, openDBScreen };
})();
