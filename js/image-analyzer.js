/* ============================================================
   image-analyzer.js — 손도면 이미지 분석 + 사용자 입력 모듈
   
   v6: 실제 이미지 분석 지원
   
   기능:
   1. Canvas API로 이미지 가장자리 검출 (기본 형상 추정)
   2. 사용자 입력 다이얼로그로 정확한 치수 입력
   3. signals 형식으로 변환하여 기존 파이프라인 활용
   ============================================================ */

const ImageAnalyzer = (() => {

  /**
   * 이미지를 Canvas에 로드하여 기본 분석 수행
   * @param {File} file - 업로드된 이미지 파일
   * @returns {Promise<Object>} - 추정된 형상 데이터
   */
  async function analyzeImageBasic(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();

      reader.onload = (e) => {
        img.onload = () => {
          try {
            const result = processImage(img);
            resolve(result);
          } catch (err) {
            resolve({ sections: [], totalLength: null, error: err.message });
          }
        };
        img.onerror = () => resolve({ sections: [], totalLength: null, error: 'Image load failed' });
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Canvas 기반 이미지 처리 — 수평 프로파일 추출
   */
  function processImage(img) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // 분석용 해상도로 리사이즈
    const maxW = 800;
    const scale = Math.min(1, maxW / img.width);
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const w = canvas.width;
    const h = canvas.height;

    // 그레이스케일 변환 + 이진화
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }

    // Otsu threshold
    const threshold = otsuThreshold(gray);
    const binary = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      binary[i] = gray[i] < threshold ? 1 : 0;
    }

    // 수평 프로젝션 (각 행의 검은 픽셀 수)
    const hProj = new Array(h).fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (binary[y * w + x]) hProj[y]++;
      }
    }

    // 수직 프로젝션 (각 열의 검은 픽셀 수)
    const vProj = new Array(w).fill(0);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        if (binary[y * w + x]) vProj[x]++;
      }
    }

    // 주요 수평선 영역 찾기 (축 윤곽)
    const hPeaks = findPeaks(hProj, w * 0.1);
    
    // 수직 변화 지점 찾기 (단차 경계)
    const vChanges = findVerticalChanges(binary, w, h, hPeaks);

    console.log('[ImageAnalyzer] Horizontal peaks:', hPeaks.length);
    console.log('[ImageAnalyzer] Vertical changes:', vChanges.length);

    // 추정 결과
    const estimatedSections = Math.max(1, vChanges.length + 1);

    return {
      width: canvas.width,
      height: canvas.height,
      hPeaks,
      vChanges,
      estimatedSectionCount: estimatedSections,
      threshold,
    };
  }

  /**
   * Otsu threshold 계산
   */
  function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    
    let sumB = 0, wB = 0, wF = 0;
    let maxVar = 0, threshold = 0;
    
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      wF = total - wB;
      if (wF === 0) break;
      
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const variance = wB * wF * (mB - mF) * (mB - mF);
      
      if (variance > maxVar) {
        maxVar = variance;
        threshold = t;
      }
    }
    return threshold;
  }

  /**
   * 수평 프로젝션에서 피크 찾기
   */
  function findPeaks(proj, minValue) {
    const peaks = [];
    let inPeak = false;
    let start = 0;
    
    for (let i = 0; i < proj.length; i++) {
      if (proj[i] > minValue) {
        if (!inPeak) { start = i; inPeak = true; }
      } else {
        if (inPeak) {
          peaks.push({ start, end: i - 1, value: Math.max(...proj.slice(start, i)) });
          inPeak = false;
        }
      }
    }
    if (inPeak) peaks.push({ start, end: proj.length - 1, value: Math.max(...proj.slice(start)) });
    return peaks;
  }

  /**
   * 수직 변화 지점 찾기
   */
  function findVerticalChanges(binary, w, h, hPeaks) {
    if (hPeaks.length < 2) return [];
    
    // 축의 상/하 경계 추정
    const topY = hPeaks[0]?.start || Math.round(h * 0.3);
    const botY = hPeaks[hPeaks.length - 1]?.end || Math.round(h * 0.7);
    
    // 각 열에서 상/하 경계의 인크 밀도 변화 감지
    const colDensity = [];
    for (let x = 0; x < w; x++) {
      let count = 0;
      for (let y = topY; y <= botY; y++) {
        if (binary[y * w + x]) count++;
      }
      colDensity.push(count);
    }
    
    // 밀도 변화가 큰 지점 = 단차 경계
    const changes = [];
    const smoothed = movingAverage(colDensity, 5);
    
    for (let x = 10; x < w - 10; x++) {
      const diff = Math.abs(smoothed[x + 3] - smoothed[x - 3]);
      if (diff > (botY - topY) * 0.15) {
        // 최소 간격 유지
        if (changes.length === 0 || x - changes[changes.length - 1] > 15) {
          changes.push(x);
        }
      }
    }
    
    return changes;
  }

  /**
   * 이동 평균
   */
  function movingAverage(arr, window) {
    const result = new Array(arr.length).fill(0);
    const half = Math.floor(window / 2);
    for (let i = 0; i < arr.length; i++) {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
        sum += arr[j];
        count++;
      }
      result[i] = sum / count;
    }
    return result;
  }


  // ============================================================
  // ★ 사용자 입력 다이얼로그
  //
  // 이미지 분석 결과를 기반으로 사용자에게 확인/수정 요청
  // ============================================================

  /**
   * 대화형 shaft 파라미터 입력 다이얼로그 표시
   * @param {File} file - 업로드된 이미지
   * @param {Object} basicAnalysis - 기본 분석 결과 (추정 section 수 등)
   * @returns {Promise<Object>} - 사용자가 입력한 signals 데이터
   */
  function showParameterDialog(file, basicAnalysis) {
    return new Promise((resolve, reject) => {
      // 기존 다이얼로그 제거
      const existing = document.getElementById('shaftParamDialog');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'shaftParamDialog';
      overlay.style.cssText = `
        position:fixed; top:0; left:0; width:100%; height:100%;
        background:rgba(0,0,0,0.92); z-index:10000;
        display:flex; align-items:center; justify-content:center;
        font-family: 'Noto Sans KR', sans-serif;
      `;

      const estimatedCount = basicAnalysis?.estimatedSectionCount || 3;
      const defaultCount = Math.min(Math.max(estimatedCount, 2), 12);

      overlay.innerHTML = `
        <div style="
          background:#1a1d27; border-radius:16px; padding:28px; width:90%; max-width:900px;
          max-height:85vh; overflow-y:auto; color:#e2e8f0; box-shadow:0 25px 50px rgba(0,0,0,0.5);
          border:1px solid rgba(255,255,255,0.1);
        ">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
            <h2 style="margin:0; font-size:20px; color:#93c5fd;">
              📐 축 형상 파라미터 입력
            </h2>
            <span style="font-size:12px; color:#94a3b8;">
              이미지 분석 추정: ${estimatedCount}개 구간
            </span>
          </div>

          <!-- 이미지 미리보기 -->
          <div style="margin-bottom:16px; text-align:center;">
            <img id="paramDialogPreview" style="max-width:100%; max-height:150px; border-radius:8px; border:1px solid #333;" />
          </div>

          <!-- 축 유형 선택 (중실축 / 중공축) -->
          <div style="margin-bottom:16px;">
            <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:6px;">축 유형</label>
            <div style="display:flex; gap:8px;">
              <button id="btnShaftSolid" type="button" style="
                flex:1; padding:10px 16px; border-radius:8px; font-size:13px; font-weight:600;
                cursor:pointer; transition:all 0.2s;
                background:#3b82f6; color:white; border:2px solid #3b82f6;
              ">🔵 중실축 (Solid)</button>
              <button id="btnShaftHollow" type="button" style="
                flex:1; padding:10px 16px; border-radius:8px; font-size:13px; font-weight:600;
                cursor:pointer; transition:all 0.2s;
                background:transparent; color:#94a3b8; border:2px solid #3b3f51;
              ">⭕ 중공축 (Hollow)</button>
            </div>
            <input type="hidden" id="paramShaftType" value="solid">
          </div>

          <!-- 기본 정보 -->
          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin-bottom:16px;">
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">구간 수</label>
              <input type="number" id="paramSectionCount" value="${defaultCount}" min="1" max="20"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
            </div>
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">전체 길이 (mm)</label>
              <input type="number" id="paramTotalLength" placeholder="선택사항"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
            </div>
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">재질</label>
              <input type="text" id="paramMaterial" placeholder="예: S45C"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
            </div>
          </div>

          <!-- 품명 / 척도 / 각법 -->
          <div style="display:grid; grid-template-columns:2fr 1fr 1fr; gap:12px; margin-bottom:16px;">
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">품명</label>
              <input type="text" id="paramPartName" placeholder="예: 단축 A"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
            </div>
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">척도 (A:B)</label>
              <input type="text" id="paramScale" value="1:1" placeholder="1:1"
                style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
              <div style="font-size:9px; color:#6b7280; margin-top:2px;">A = 도면크기, B = 실물크기</div>
            </div>
            <div>
              <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">각법</label>
              <select id="paramProjection" style="width:100%; padding:8px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:14px;">
                <option value="3각법" selected>3각법</option>
                <option value="1각법">1각법</option>
              </select>
            </div>
          </div>

          <!-- 구간별 상세 입력 -->
          <div style="margin-bottom:16px;">
            <h3 style="font-size:14px; color:#93c5fd; margin:0 0 8px;">
              구간별 치수 (좌→우)
            </h3>
            <div id="sectionInputs" style="display:grid; gap:8px;"></div>
          </div>

          <!-- 부가 정보 -->
          <div style="margin-bottom:16px;">
            <h3 style="font-size:14px; color:#93c5fd; margin:0 0 8px;">
              부가 정보 (선택)
            </h3>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
              <div>
                <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">
                  좌측 TAP (예: M20)
                </label>
                <div style="display:flex; gap:4px;">
                  <input type="text" id="paramLeftTap" placeholder="M20"
                    style="flex:1; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                  <input type="number" id="paramLeftTapDepth" placeholder="깊이"
                    style="width:60px; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                </div>
              </div>
              <div>
                <label style="font-size:11px; color:#94a3b8; display:block; margin-bottom:4px;">
                  우측 TAP (예: M10)
                </label>
                <div style="display:flex; gap:4px;">
                  <input type="text" id="paramRightTap" placeholder="M10"
                    style="flex:1; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                  <input type="number" id="paramRightTapDepth" placeholder="깊이"
                    style="width:60px; padding:6px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                </div>
              </div>
            </div>
            <!-- 키홈 갯수 선택 + 동적 입력 -->
            <div style="margin-top:8px; display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <label style="font-size:12px; color:#93c5fd; font-weight:600;">키홈 수</label>
              <input type="number" id="paramKeywayCount" value="0" min="0" max="10"
                style="width:60px; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:13px; text-align:center;">
              <span style="font-size:10px; color:#6b7280;">0 = 키홈 없음</span>
            </div>
            <div id="keywayInputs" style="display:grid; gap:8px;"></div>
          </div>

          <!-- 중공축 보조투상도 설정 (중공축 선택 시에만 표시) -->
          <div id="hollowShaftSection" style="display:none; margin-bottom:16px;">
            <div style="background:#1e2230; border:1px solid #f59e0b; border-radius:8px; padding:12px;">
              <h3 style="font-size:14px; color:#f59e0b; margin:0 0 8px;">
                ⭕ 축 보조투상도 (중공축 단면)
              </h3>
              <p style="font-size:11px; color:#94a3b8; margin:0 0 10px;">
                중공축의 끝단 보조투상도에 표시할 내경을 입력하세요.<br>
                가장 끝 구간의 우측에 외경(구간 직경)과 내경(빈 공간)을 동심원으로 표시합니다.
              </p>
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                <div>
                  <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">내경 (mm) — 중공 직경</label>
                  <input type="number" id="paramHollowBoreDiam" placeholder="예: 10" min="1"
                    style="width:100%; padding:7px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:13px;">
                </div>
                <div>
                  <label style="font-size:10px; color:#94a3b8; display:block; margin-bottom:2px;">외경 (자동: 끝 구간 직경)</label>
                  <input type="text" id="paramHollowOuterDiam" placeholder="자동 계산" disabled
                    style="width:100%; padding:7px; background:#1a1d27; border:1px solid #3b3f51; border-radius:6px; color:#6b7280; font-size:13px;">
                </div>
              </div>
            </div>
          </div>

          <!-- 버튼 -->
          <div style="display:flex; justify-content:flex-end; gap:12px; margin-top:20px;">
            <button id="paramBtnCancel" style="
              padding:10px 20px; background:#374151; border:none; border-radius:8px;
              color:#e2e8f0; cursor:pointer; font-size:14px;
            ">취소</button>
            <button id="paramBtnGenerate" style="
              padding:10px 24px; background:linear-gradient(135deg,#3b82f6,#6366f1);
              border:none; border-radius:8px; color:white; cursor:pointer; font-size:14px; font-weight:600;
            ">도면 생성</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      // 이미지 미리보기
      const preview = document.getElementById('paramDialogPreview');
      const fileReader = new FileReader();
      fileReader.onload = (e) => { preview.src = e.target.result; };
      fileReader.readAsDataURL(file);

      // ── 축 유형 버튼 토글 ──
      const btnSolid = document.getElementById('btnShaftSolid');
      const btnHollow = document.getElementById('btnShaftHollow');
      const shaftTypeInput = document.getElementById('paramShaftType');
      const hollowSection = document.getElementById('hollowShaftSection');

      btnSolid.addEventListener('click', () => {
        shaftTypeInput.value = 'solid';
        btnSolid.style.background = '#3b82f6';
        btnSolid.style.color = 'white';
        btnSolid.style.borderColor = '#3b82f6';
        btnHollow.style.background = 'transparent';
        btnHollow.style.color = '#94a3b8';
        btnHollow.style.borderColor = '#3b3f51';
        hollowSection.style.display = 'none';
      });

      btnHollow.addEventListener('click', () => {
        shaftTypeInput.value = 'hollow';
        btnHollow.style.background = '#f59e0b';
        btnHollow.style.color = '#1a1d27';
        btnHollow.style.borderColor = '#f59e0b';
        btnSolid.style.background = 'transparent';
        btnSolid.style.color = '#94a3b8';
        btnSolid.style.borderColor = '#3b3f51';
        hollowSection.style.display = 'block';
      });

      // 중공축 외경 자동 표시 업데이트 함수
      function updateHollowOuterDiam() {
        const outerDiamEl = document.getElementById('paramHollowOuterDiam');
        if (!outerDiamEl) return;
        const count = parseInt(document.getElementById('paramSectionCount').value) || 0;
        if (count <= 0) { outerDiamEl.value = ''; return; }
        const lastDiamEl = document.querySelector(`.sec-diameter[data-idx="${count - 1}"]`);
        if (lastDiamEl && lastDiamEl.value) {
          outerDiamEl.value = `⌀${lastDiamEl.value} (S${count})`;
        } else {
          outerDiamEl.value = '끝 구간 직경 미입력';
        }
      }

      // 구간 입력 필드 생성
      const countInput = document.getElementById('paramSectionCount');
      const sectionInputsDiv = document.getElementById('sectionInputs');

      // ★ keywayInputsDiv를 buildSectionInputs보다 먼저 선언 (TDZ 방지)
      const keywayCountInput = document.getElementById('paramKeywayCount');
      const keywayInputsDiv = document.getElementById('keywayInputs');

      function buildSectionInputs(count) {
        sectionInputsDiv.innerHTML = '';
        
        // 헤더
        const header = document.createElement('div');
        header.style.cssText = 'display:grid; grid-template-columns:40px 1fr 1fr; gap:8px; font-size:11px; color:#94a3b8; padding:0 4px;';
        header.innerHTML = '<span>#</span><span>길이 (mm)</span><span>직경 (mm)</span>';
        sectionInputsDiv.appendChild(header);

        for (let i = 0; i < count; i++) {
          const row = document.createElement('div');
          row.style.cssText = 'display:grid; grid-template-columns:40px 1fr 1fr; gap:8px; align-items:center;';
          row.innerHTML = `
            <span style="font-size:12px; color:#93c5fd; font-weight:600;">S${i + 1}</span>
            <input type="number" class="sec-length" data-idx="${i}" placeholder="길이" min="1"
              style="padding:7px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:13px;">
            <input type="number" class="sec-diameter" data-idx="${i}" placeholder="직경" min="1"
              style="padding:7px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:13px;">
          `;
          sectionInputsDiv.appendChild(row);
        }

        // 직경 변경 시 중공축 외경 자동 업데이트
        sectionInputsDiv.querySelectorAll('.sec-diameter').forEach(el => {
          el.addEventListener('input', updateHollowOuterDiam);
        });

        // 중공축 외경 자동 표시 업데이트
        updateHollowOuterDiam();

        // 키홈 select 업데이트 (동적 키홈)
        updateKeywaySelects(count);
      }

      buildSectionInputs(defaultCount);

      // ★ 구간 수 변경 — 모든 이벤트 유형 등록 (브라우저 호환성 보장)
      let _lastSecCount = defaultCount;
      function onSectionCountChange() {
        const n = Math.min(Math.max(parseInt(countInput.value) || 2, 1), 20);
        if (n === _lastSecCount) return;  // 중복 호출 방지
        _lastSecCount = n;
        countInput.value = n;
        buildSectionInputs(n);
      }
      ['input', 'change', 'keyup', 'mouseup', 'pointerup'].forEach(evt => {
        countInput.addEventListener(evt, onSectionCountChange);
      });

      // ── 키홈 동적 입력 빌더 ──
      function buildKeywayInputs(kwCount) {
        keywayInputsDiv.innerHTML = '';
        const secCount = parseInt(countInput.value) || 0;

        for (let k = 0; k < kwCount; k++) {
          const block = document.createElement('div');
          block.style.cssText = 'background:#1e2230; border:1px solid #3b3f51; border-radius:8px; padding:12px;';
          
          // 구간 선택 옵션
          let secOptions = '<option value="">없음</option>';
          for (let s = 0; s < secCount; s++) {
            secOptions += `<option value="S${s + 1}">S${s + 1}</option>`;
          }

          block.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
              <label style="font-size:12px; color:#93c5fd; font-weight:600;">키홈 ${k + 1}</label>
              <select class="kw-sec" data-kw-idx="${k}" style="width:60px; padding:4px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
                ${secOptions}
              </select>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px; margin-bottom:6px;">
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">폭 (mm)</label>
                <input type="number" class="kw-w" data-kw-idx="${k}" placeholder="폭" style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">높이 (mm)</label>
                <input type="number" class="kw-h" data-kw-idx="${k}" placeholder="높이" style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#6b7280; display:block; margin-bottom:2px;">깊이 (mm)</label>
                <input type="number" class="kw-d" data-kw-idx="${k}" placeholder="깊이" style="width:100%; padding:5px; background:#242836; border:1px solid #3b3f51; border-radius:6px; color:#e2e8f0; font-size:12px;">
              </div>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px;">
              <div>
                <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">좌측 이격 (mm)</label>
                <input type="number" class="kw-left-off" data-kw-idx="${k}" placeholder="좌측에서 거리" style="width:100%; padding:5px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:12px;">
              </div>
              <div>
                <label style="font-size:10px; color:#f59e0b; display:block; margin-bottom:2px;">우측 이격 (mm)</label>
                <input type="number" class="kw-right-off" data-kw-idx="${k}" placeholder="우측에서 거리" style="width:100%; padding:5px; background:#242836; border:1px solid #554a20; border-radius:6px; color:#fbbf24; font-size:12px;">
              </div>
            </div>
            <div style="font-size:10px; color:#6b7280; margin-top:4px;">
              * 좌/우 이격 = 해당 구간 끝에서 키홈 시작까지의 거리
            </div>
          `;
          keywayInputsDiv.appendChild(block);
        }
      }

      // 구간 수 변경 시 키홈 select 옵션도 업데이트
      function updateKeywaySelects(secCount) {
        keywayInputsDiv.querySelectorAll('.kw-sec').forEach(sel => {
          const val = sel.value;
          sel.innerHTML = '<option value="">없음</option>';
          for (let s = 0; s < secCount; s++) {
            sel.innerHTML += `<option value="S${s + 1}">S${s + 1}</option>`;
          }
          sel.value = val;
        });
      }

      // ★ 키홈 수 변경 — 모든 이벤트 유형 등록 (브라우저 호환성 보장)
      buildKeywayInputs(0);
      let _lastKwCount = 0;
      function onKeywayCountChange() {
        const n = Math.min(Math.max(parseInt(keywayCountInput.value) || 0, 0), 10);
        if (n === _lastKwCount) return;  // 중복 호출 방지
        _lastKwCount = n;
        keywayCountInput.value = n;
        buildKeywayInputs(n);
      }
      ['input', 'change', 'keyup', 'mouseup', 'pointerup'].forEach(evt => {
        keywayCountInput.addEventListener(evt, onKeywayCountChange);
      });

      // 버튼 이벤트
      document.getElementById('paramBtnCancel').addEventListener('click', () => {
        overlay.remove();
        reject(new Error('사용자가 취소했습니다'));
      });

      document.getElementById('paramBtnGenerate').addEventListener('click', () => {
        const signals = collectFormData();
        if (!signals) return;
        overlay.remove();
        resolve(signals);
      });

      /**
       * 폼 데이터 수집 → signals 형식 변환
       */
      function collectFormData() {
        const CONF = AIEngine.CONF;
        const count = parseInt(countInput.value);
        const totalLength = parseFloat(document.getElementById('paramTotalLength').value) || null;
        const material = document.getElementById('paramMaterial').value.trim() || null;
        const shaftType = document.getElementById('paramShaftType').value; // 'solid' or 'hollow'
        const partName = document.getElementById('paramPartName').value.trim() || null;
        const scaleStr = document.getElementById('paramScale').value.trim() || '1:1';
        const projectionMethod = document.getElementById('paramProjection').value || '3각법';

        // 구간별 데이터
        const segmentLengths = [];
        const allDiameters = [];
        let hasError = false;

        for (let i = 0; i < count; i++) {
          const lenEl = sectionInputsDiv.querySelector(`.sec-length[data-idx="${i}"]`);
          const diamEl = sectionInputsDiv.querySelector(`.sec-diameter[data-idx="${i}"]`);
          const len = parseFloat(lenEl?.value);
          const diam = parseFloat(diamEl?.value);

          if (!len || len <= 0) {
            lenEl.style.borderColor = '#ef4444';
            hasError = true;
          } else {
            lenEl.style.borderColor = '#3b3f51';
          }

          segmentLengths.push({
            value: len || null,
            confidence: CONF.CONFIRMED,
            position: `S${i + 1}`,
          });

          allDiameters.push({
            section: `S${i + 1}`,
            value: diam || null,
            confidence: diam ? CONF.CONFIRMED : CONF.UNCERTAIN,
          });
        }

        if (hasError) {
          alert('모든 구간의 길이를 입력해주세요.');
          return null;
        }

        // 직경 그룹화 (같은 직경은 하나로)
        const diameterGroups = {};
        allDiameters.forEach(d => {
          if (d.value == null) return;
          const key = d.value;
          if (!diameterGroups[key]) {
            diameterGroups[key] = {
              value: d.value,
              confidence: d.confidence,
              segments: [],
            };
          }
          diameterGroups[key].segments.push(d.section);
        });
        const diameters = Object.values(diameterGroups);

        // Hidden features (TAP + 키홈)
        const hiddenFeatures = [];
        const tapSpecs = [];

        // 좌측 TAP
        const leftTap = document.getElementById('paramLeftTap').value.trim();
        const leftTapDepth = parseFloat(document.getElementById('paramLeftTapDepth').value);
        if (leftTap) {
          const tapDiam = parseInt(leftTap.replace(/[^\d]/g, '')) || 10;
          hiddenFeatures.push({
            id: 'HF_TAP_L',
            section: 'S1',
            type: 'tap-bore',
            diameter: tapDiam,
            depth: leftTapDepth || 30,
            side: 'left',
            confidence: CONF.CONFIRMED,
          });
          tapSpecs.push({
            holeId: 'HF_TAP_L',
            section: 'S1',
            spec: `${leftTap} TAP${leftTapDepth ? ' 깊이' + leftTapDepth : ''}`,
            specConf: CONF.CONFIRMED,
          });
        }

        // 우측 TAP
        const rightTap = document.getElementById('paramRightTap').value.trim();
        const rightTapDepth = parseFloat(document.getElementById('paramRightTapDepth').value);
        if (rightTap) {
          const tapDiam = parseInt(rightTap.replace(/[^\d]/g, '')) || 10;
          const lastSec = `S${count}`;
          hiddenFeatures.push({
            id: 'HF_TAP_R',
            section: lastSec,
            type: 'tap-bore',
            diameter: tapDiam,
            depth: rightTapDepth || 30,
            side: 'right',
            confidence: CONF.CONFIRMED,
          });
          tapSpecs.push({
            holeId: 'HF_TAP_R',
            section: lastSec,
            spec: `${rightTap} TAP${rightTapDepth ? ' 깊이' + rightTapDepth : ''}`,
            specConf: CONF.CONFIRMED,
          });
        }

        // ── 키홈 N개 동적 수집 ──
        const kwCount = parseInt(keywayCountInput.value) || 0;
        const auxiliaryViews = [];
        const auxPositions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

        for (let k = 0; k < kwCount; k++) {
          const kwSec = keywayInputsDiv.querySelector(`.kw-sec[data-kw-idx="${k}"]`)?.value || '';
          let kwW = parseFloat(keywayInputsDiv.querySelector(`.kw-w[data-kw-idx="${k}"]`)?.value);
          const kwH = parseFloat(keywayInputsDiv.querySelector(`.kw-h[data-kw-idx="${k}"]`)?.value);
          const kwD = parseFloat(keywayInputsDiv.querySelector(`.kw-d[data-kw-idx="${k}"]`)?.value);
          const kwLeftOff = parseFloat(keywayInputsDiv.querySelector(`.kw-left-off[data-kw-idx="${k}"]`)?.value);
          const kwRightOff = parseFloat(keywayInputsDiv.querySelector(`.kw-right-off[data-kw-idx="${k}"]`)?.value);

          // 양쪽 오프셋이 있고 폭이 없으면 자동 계산
          if (kwSec && !kwW && !isNaN(kwLeftOff) && !isNaN(kwRightOff)) {
            const secLen = segmentLengths.find(s => s.position === kwSec);
            if (secLen && secLen.value) {
              kwW = secLen.value - kwLeftOff - kwRightOff;
            }
          }

          if (kwSec && kwW && kwW > 0) {
            hiddenFeatures.push({
              id: `HF_KW${k + 1}`,
              section: kwSec,
              type: 'keyway',
              keywayWidth: kwW,
              keywayHeight: kwH || 6,
              keywayDepth: kwD || 3.5,
              keywayLeftOffset: isNaN(kwLeftOff) ? null : kwLeftOff,
              keywayRightOffset: isNaN(kwRightOff) ? null : kwRightOff,
              side: k % 2 === 0 ? 'left' : 'right',
              confidence: CONF.CONFIRMED,
            });
            auxiliaryViews.push({
              id: `AUX${k + 1}`,
              position: auxPositions[k % auxPositions.length],
              label: '',
              shape: { type: 'obround', width: kwW, height: kwH || 6, confidence: CONF.CONFIRMED },
              dimensions: [
                { axis: 'horizontal', value: kwW, confidence: CONF.CONFIRMED },
                { axis: 'vertical', value: kwH || 6, confidence: CONF.CONFIRMED },
              ],
              relatedSection: kwSec,
              projectionLines: true,
              keywayLeftOffset: isNaN(kwLeftOff) ? null : kwLeftOff,
              keywayRightOffset: isNaN(kwRightOff) ? null : kwRightOff,
            });
          }
        }

        // ── 중공축 보조투상도 (hollow shaft cross-section) ──
        // 중공축 선택 시, 마지막 구간 우측에 단면도(동심원: 외경+내경) 보조투상도 추가
        let hollowShaftData = null;
        if (shaftType === 'hollow') {
          const boreDiam = parseFloat(document.getElementById('paramHollowBoreDiam').value);
          if (boreDiam && boreDiam > 0) {
            // 마지막 구간의 직경 = 외경
            const lastDiamData = allDiameters[count - 1];
            const outerDiam = lastDiamData?.value || null;

            hollowShaftData = {
              type: 'hollow',
              boreDiameter: boreDiam,           // 내경 (중공 직경)
              outerDiameter: outerDiam,         // 외경 (마지막 구간 직경)
              relatedSection: `S${count}`,      // 마지막 구간
              position: 'right-end',            // 마지막 구간 우측 끝
            };

            // 중공축 보조투상도는 hollowShaftData로 전달됨
            // ai-engine.js Section 9.5에서 전용 렌더링 처리
            // (auxiliaryViews에 추가하지 않음 — Section 10 obround 렌더링과 중복 방지)
          } else {
            alert('중공축의 내경을 입력해주세요.');
            return null;
          }
        }

        // ── 최종 signals 객체 ──
        return {
          hasHorizontalCenterline: { value: true, confidence: CONF.CONFIRMED },
          shaftLikelihood: { value: 0.95, confidence: CONF.CONFIRMED },
          shaftType,        // 'solid' or 'hollow'
          hollowShaftData,  // null (중실축) or { boreDiameter, outerDiameter, ... } (중공축)
          totalLength: totalLength != null
            ? { value: totalLength, confidence: CONF.CONFIRMED }
            : null,
          segmentLengths,
          diameters,
          holes: [],
          slots: [],
          hiddenFeatures,
          auxiliaryViews,
          chamfers: [
            { side: 'left', spec: null, confidence: CONF.UNCERTAIN },
            { side: 'right', spec: null, confidence: CONF.UNCERTAIN },
          ],
          keyways: [],
          centerHoles: [
            { side: 'left', diameter: null, confidence: CONF.UNCERTAIN },
            { side: 'right', diameter: null, confidence: CONF.UNCERTAIN },
          ],
          material: {
            value: material,
            confidence: material ? CONF.CONFIRMED : CONF.UNCERTAIN,
          },
          surfaceFinish: {
            value: null,
            confidence: CONF.UNCERTAIN,
          },
          partName: {
            value: partName,
            confidence: partName ? CONF.CONFIRMED : CONF.UNCERTAIN,
          },
          scale: scaleStr,
          projectionMethod: projectionMethod,
          uncertainSignals: [],
          tapSpecs,
        };
      }
    });
  }

  /**
   * 메인 분석 함수 — 이미지 기본 분석 + 파라미터 다이얼로그
   * @param {File} file - 업로드된 이미지
   * @returns {Promise<Object>} signals 데이터
   */
  async function analyze(file) {
    // Step 1: 기본 이미지 분석 (에지 검출 등)
    const basicResult = await analyzeImageBasic(file);
    console.log('[ImageAnalyzer] Basic analysis result:', basicResult);

    // Step 2: 사용자 입력 다이얼로그
    const signals = await showParameterDialog(file, basicResult);
    return signals;
  }

  return {
    analyze,
    analyzeImageBasic,
    showParameterDialog,
  };
})();
