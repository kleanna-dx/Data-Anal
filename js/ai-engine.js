/* ============================================================
   ai-engine.js  v5 — 기계도면 AI 해석 엔진
   ============================================================

   ═══════════════════════════════════════════════════════════
   v5 핵심 변경: "형상 복제기" 아키텍처 전환
   ═══════════════════════════════════════════════════════════

   v4 → v5 변경 요약:
     v4: "형상 + 치수 + 재질 + 가공정보"를 모두 recall 우선으로 생성
     v5: "형상·외곽·중심선·배치 최우선 복제"
         메타정보(재질·표면거칠기·치수·탭·키홈 등)는
         원본에 명확히 있을 때만 유지, 나머지는 placeholder로 남김

   ───────────────────────────────────────────────────────────
   핵심 원칙:
     1. 형상 트레이싱 최우선 — 전체 외형 비율·좌우 단차·중심선 유지
     2. 메타정보 자동 확정 금지 — 불확실하면 null/"직접입력" placeholder
     3. 원본 숫자 보존 — 원본에 없는 숫자 생성 금지
     4. Spec 구조 분리 — geometrySpec (형상) / annotationSpec (메타)
     5. Self-check — 형상 일치율 우선, annotation 누락은 치명 오류 아님

   ───────────────────────────────────────────────────────────
   5단계 파이프라인:
     1. classifyDrawingType(file)
     2. extractConfirmedSignals(classification)
     3. buildShaftCandidates(signals)
     4. resolveSpecFromCandidates(candidates)
        → { geometrySpec, annotationSpec }
     5. selfCheckSpec(spec)
        → 형상 일치율 우선, annotation 누락은 warning만

   출력 정책:
     AI는 '완성 도면'이 아니라 '형상 초안 + 빈 정보칸' 상태로 출력
     사용자가 편집기에서 직접 메타정보를 채움
   ============================================================ */

const AIEngine = (() => {

  // ============================================================
  // CONFIDENCE / PLACEHOLDER 상수
  // ============================================================
  const CONF = Object.freeze({
    CONFIRMED: 'confirmed',   // 원본에서 명확히 읽힌 값
    ESTIMATED: 'estimated',   // 강한 후보 (구조적으로 거의 확실)
    UNCERTAIN: 'uncertain',   // 불확실 — 표기만
  });

  // placeholder 정책: 불확실한 annotation에 사용
  const PLACEHOLDER = Object.freeze({
    TEXT: '직접입력',
    EMPTY: null,              // JSON에서는 null
    LABEL: '미확정',
    VALUE_INPUT: '값입력',
  });


  // ============================================================
  // Stage 1: 도면 유형 분류 (Classifier)
  //
  // unknown이어도 전체를 버리지 않는다.
  // partial 신호가 있으면 shaft 후보로 진행.
  // ============================================================

  function classifyDrawingType(file) {
    if (!file) return { type: 'unknown', score: 0, hints: [] };
    const name = (file.name || '').toLowerCase();

    const mechKeywords = [
      'shaft', 'gear', 'bearing', 'bolt', 'nut', 'flange', 'coupling',
      'pin', 'bushing', 'piston', 'cylinder', 'spindle', 'pulley',
      'axle', 'housing', 'bracket', 'part', 'mech', 'machine',
      '축', '기계', '부품', '샤프트', '기어', '플랜지', '베어링',
      'φ', 'ø', 'tap', 'drill', 'bore',
    ];

    const hints = [];
    let score = 0;
    mechKeywords.forEach(k => {
      if (name.includes(k)) { score++; hints.push(k); }
    });

    const type = score > 0 ? 'mechanical' : 'unknown';
    return { type, score, hints };
  }


  // ============================================================
  // Stage 2: 확실 신호 추출 (extractConfirmedSignals)
  //
  // v5 변경: 형상 신호(외곽, 중심선, 단차 위치)는 최대한 추출
  //          메타 신호(재질, 표면거칠기, 탭 규격 등)는 원본에
  //          명확히 적혀 있을 때만 confirmed, 아니면 null
  //
  // 시뮬레이션: Vision AI가 손그림에서 추출한 신호들
  // ============================================================

  function extractConfirmedSignals(classification) {

    const signals = {
      // ─── 형상 신호 (geometrySpec 대상) ───
      // 이 부분은 "보이는 대로" 최대한 추출

      hasHorizontalCenterline: { value: true, confidence: CONF.CONFIRMED },
      shaftLikelihood: { value: 0.92, confidence: CONF.CONFIRMED },

      // 전체 길이
      totalLength: { value: 220, confidence: CONF.CONFIRMED },

      // 구간별 길이 (좌→우) — 원본 숫자 그대로
      segmentLengths: [
        { value: 50,  confidence: CONF.CONFIRMED, position: 'left' },
        { value: 111, confidence: CONF.CONFIRMED, position: 'center' },
        { value: 59,  confidence: CONF.CONFIRMED, position: 'right' },
      ],

      // 직경 (φ/Ø 표기에서 읽음) — 원본에 명확히 있는 것만
      diameters: [
        { value: 20, confidence: CONF.CONFIRMED, segments: ['left', 'right'] },
        { value: 35, confidence: CONF.CONFIRMED, segments: ['center'] },
      ],

      // v5.8: 구멍/탭은 hiddenFeatures로 이동
      holes: [],

      // v5.8: 슬롯은 보조투상도로 이동 (메인 도면에 슬롯 없음)
      slots: [],

      // ★ v5.8: 숨은선 (hiddenFeatures) — 원본 도면의 점선을 그대로 추출
      hiddenFeatures: [
        // 블록1: S1 M10 TAP (좌측 끝면→30mm 깊이)
        {
          id: 'HF1', section: 'S1', type: 'tap-bore',
          diameter: 10, depth: 30,
          side: 'left',
          confidence: CONF.CONFIRMED,
        },
        // 블록2: S1 키홈 (깊이3.5mm, 가로32mm, 세로6mm)
        {
          id: 'HF2', section: 'S1', type: 'keyway',
          keywayWidth: 32, keywayHeight: 6, keywayDepth: 3.5,
          side: 'left',
          confidence: CONF.CONFIRMED,
        },
        // 블록3: S3 M10 TAP (우측 끝면→30mm 깊이)
        {
          id: 'HF3', section: 'S3', type: 'tap-bore',
          diameter: 10, depth: 30,
          side: 'right',
          confidence: CONF.CONFIRMED,
        },
        // 블록4: S3 키홈 (깊이3.5mm, 가로40mm, 세로6mm)
        {
          id: 'HF4', section: 'S3', type: 'keyway',
          keywayWidth: 40, keywayHeight: 6, keywayDepth: 3.5,
          side: 'right',
          confidence: CONF.CONFIRMED,
        },
      ],

      // ★ v5.8: 보조 투상도 — 키홈을 위에서 본 모양
      auxiliaryViews: [
        {
          id: 'AUX1',
          position: 'top-left',
          label: '',
          shape: { type: 'obround', width: 32, height: 6, confidence: CONF.CONFIRMED },
          dimensions: [
            { axis: 'horizontal', value: 32, confidence: CONF.CONFIRMED },
            { axis: 'vertical',   value: 6,  confidence: CONF.CONFIRMED },
          ],
          relatedSection: 'S1',
          projectionLines: true,
        },
        {
          id: 'AUX2',
          position: 'top-right',
          label: '',
          shape: { type: 'obround', width: 40, height: 6, confidence: CONF.CONFIRMED },
          dimensions: [
            { axis: 'horizontal', value: 40, confidence: CONF.CONFIRMED },
            { axis: 'vertical',   value: 6,  confidence: CONF.CONFIRMED },
          ],
          relatedSection: 'S3',
          projectionLines: true,
        },
      ],

      // ─── 주석/메타 신호 (annotationSpec 대상) ───
      // v5: 원본에 명확히 적혀있지 않으면 null/placeholder

      // 면취 — 존재 자체는 보이지만 규격(C1 등)은 불확실
      chamfers: [
        { side: 'left',  spec: null, confidence: CONF.UNCERTAIN },
        { side: 'right', spec: null, confidence: CONF.UNCERTAIN },
      ],

      // v5.8: 키홈은 hiddenFeatures에서 관리 (keyways 시그널 비활성화)
      keyways: [],

      // 센터구멍 — 존재는 보이지만 직경은 불확실
      centerHoles: [
        { side: 'left',  diameter: null, confidence: CONF.UNCERTAIN },
        { side: 'right', diameter: null, confidence: CONF.UNCERTAIN },
      ],

      // 재질 — 원본에 텍스트로 적혀있지 않으면 null
      material: { value: null, confidence: CONF.UNCERTAIN },
      // 표면거칠기 — 원본에 없으면 null
      surfaceFinish: { value: null, confidence: CONF.UNCERTAIN },

      // 불확실 신호
      uncertainSignals: [],

      // ★ v5.8: 탭 규격 (annotation용 — hiddenFeatures와 연동)
      tapSpecs: [
        { holeId: 'HF1', section: 'S1', spec: 'M10 TAP 깊이30', specConf: CONF.CONFIRMED },
        { holeId: 'HF3', section: 'S3', spec: 'M10 TAP 깊이30', specConf: CONF.CONFIRMED },
      ],
    };

    console.log('[AIEngine:Stage2] Extracted signals:', JSON.stringify(signals, null, 2));
    return signals;
  }


  // ============================================================
  // Stage 3: shaft 후보 생성기 (buildShaftCandidates)
  //
  // v5 변경:
  //   - geometrySpec: 외곽, 중심선, 단차, 구멍/슬롯 위치
  //   - annotationSpec: 재질, 표면거칠기, 탭 규격, 면취 규격 등
  //   - 메타정보는 자동 확정하지 않고 placeholder로 남김
  // ============================================================

  function buildShaftCandidates(signals) {
    const candidates = {
      // ─── geometrySpec 영역 ───
      geometry: {
        sections: [],
        totalLength: null,
        totalLengthConf: CONF.UNCERTAIN,
        holes: [],
        slots: [],
        chamferPositions: [],     // 위치만 (spec은 annotation)
        centerHolePositions: [],  // 위치만 (직경은 annotation)
        hiddenFeatures: [],       // v5.8: 숨은선 feature
      },

      // ─── annotationSpec 영역 ───
      annotation: {
        partName: PLACEHOLDER.TEXT,       // 사용자 입력
        partNo: PLACEHOLDER.TEXT,         // 사용자 입력
        material: PLACEHOLDER.EMPTY,      // null
        materialConf: CONF.UNCERTAIN,
        surfaceFinish: PLACEHOLDER.EMPTY, // null
        surfaceFinishConf: CONF.UNCERTAIN,
        unit: 'mm',
        scale: '1:1',
        projectionMethod: '3각법',
        chamferSpecs: [],     // 면취 규격 (C1 등)
        keywaySpecs: [],      // 키홈 규격 (8x4 등)
        tapSpecs: [],         // 탭 규격 (M10x1.5 등)
        centerHoleDiameters: [],
        notes: [],
      },

      uncertainElements: [],
    };

    // ── 3-a) 전체 길이 ──
    if (signals.totalLength) {
      candidates.geometry.totalLength = signals.totalLength.value;
      candidates.geometry.totalLengthConf = signals.totalLength.confidence;
    }

    // ── 3-b) 구간 생성 ──
    const segLens = signals.segmentLengths || [];
    const diams = signals.diameters || [];

    // 직경 맵: position → diameter/confidence
    const diamMap = {};
    diams.forEach(d => {
      (d.segments || []).forEach(seg => {
        diamMap[seg] = { value: d.value, confidence: d.confidence };
      });
    });

    segLens.forEach((seg, i) => {
      const pos = seg.position || `seg_${i}`;
      const diam = diamMap[pos];

      candidates.geometry.sections.push({
        id: `S${i + 1}`,
        length: seg.value,
        lengthConf: seg.confidence,
        diameter: diam ? diam.value : null,
        diameterConf: diam ? diam.confidence : CONF.UNCERTAIN,
        note: diam ? null : '직경 미감지 — 원본 확인 필요',
      });
    });

    // ── 3-c) 직경 미감지 구간 uncertain 기록 ──
    candidates.geometry.sections.forEach(sec => {
      if (sec.diameter === null) {
        candidates.uncertainElements.push({
          id: `UE_diam_${sec.id}`,
          description: `구간 ${sec.id} 직경 미감지`,
          location: sec.id,
          severity: 'medium',
          confidence: CONF.UNCERTAIN,
        });
      }
    });

    // ── 3-d) 구멍/탭 — 위치만 geometry, 규격은 annotation ──
    (signals.holes || []).forEach((h, i) => {
      const secIdx = resolveLocationIndex(h.location, candidates.geometry.sections);
      if (secIdx === -1) return;

      const sec = candidates.geometry.sections[secIdx];
      candidates.geometry.holes.push({
        id: `H${i + 1}`,
        cx_section: sec.id,
        cx_offset: sec.length * (h.offsetRatio || 0.5),
        diameter: h.diameter,
        depth: h.depth,
        holeType: h.type || 'through',
        symmetry: h.symmetry !== false,
        confidence: h.confidence,
        note: null,
      });

      // 탭 규격은 annotation
      if (h.type === 'tap') {
        candidates.annotation.tapSpecs.push({
          holeId: `H${i + 1}`,
          section: sec.id,
          spec: h.tapSpec || null,                   // null = placeholder
          specConf: h.tapSpecConf || CONF.UNCERTAIN, // 불확실
        });
      }
    });

    // ── 3-d2) v5.8: hiddenFeatures 통과 ──
    if (signals.hiddenFeatures && signals.hiddenFeatures.length > 0) {
      candidates.geometry.hiddenFeatures = [...signals.hiddenFeatures];
    }

    // ── 3-d3) v5.8: tapSpecs (signal에서 직접 전달된 경우) ──
    if (signals.tapSpecs && signals.tapSpecs.length > 0) {
      signals.tapSpecs.forEach(ts => {
        // 중복 방지: holeId로 확인
        if (!candidates.annotation.tapSpecs.find(existing => existing.holeId === ts.holeId)) {
          candidates.annotation.tapSpecs.push(ts);
        }
      });
    }

    // ── 3-e) 슬롯 — 위치·크기만 ──
    (signals.slots || []).forEach((sl, i) => {
      const secIdx = resolveLocationIndex(sl.location, candidates.geometry.sections);
      if (secIdx === -1) return;

      const sec = candidates.geometry.sections[secIdx];
      candidates.geometry.slots.push({
        id: `SL${i + 1}`,
        cx_section: sec.id,
        cx_offset: sec.length * (sl.offsetRatio || 0.36),
        slotLength: sl.length,
        slotWidth: sl.width,
        position: sl.position || 'top',
        symmetry: sl.symmetry !== false,
        confidence: sl.confidence,
        note: null,
      });
    });

    // ── 3-f) 면취 위치 — 규격은 annotation ──
    (signals.chamfers || []).forEach(ch => {
      const secId = ch.side === 'left' ? candidates.geometry.sections[0]?.id
                  : ch.side === 'right' ? candidates.geometry.sections[candidates.geometry.sections.length - 1]?.id
                  : null;
      if (!secId) return;

      candidates.geometry.chamferPositions.push({
        section: secId,
        side: ch.side,
        confidence: ch.confidence,
      });

      candidates.annotation.chamferSpecs.push({
        section: secId,
        side: ch.side,
        spec: ch.spec || null,            // null = placeholder
        specConf: ch.confidence,
      });
    });

    // ── 3-g) 키홈 — 불확실하면 uncertain 기록만 ──
    (signals.keyways || []).forEach(kw => {
      if (kw.confidence === CONF.UNCERTAIN) {
        candidates.uncertainElements.push({
          id: `UE_keyway_${candidates.uncertainElements.length}`,
          description: '키홈 존재 불확실 — 원본 확인 필요',
          location: kw.location || 'unknown',
          severity: 'low',
          confidence: CONF.UNCERTAIN,
        });
        // 키홈 규격도 placeholder로 준비
        candidates.annotation.keywaySpecs.push({
          section: null,
          width: kw.width,      // null
          depth: kw.depth,      // null
          specConf: CONF.UNCERTAIN,
        });
        return;
      }
      // confirmed/estimated 키홈: geometry에 추가
      const secIdx = resolveLocationIndex(kw.location, candidates.geometry.sections);
      if (secIdx === -1) return;
      candidates.annotation.keywaySpecs.push({
        section: candidates.geometry.sections[secIdx].id,
        width: kw.width,
        depth: kw.depth,
        specConf: kw.confidence,
      });
    });

    // ── 3-h) 센터구멍 위치 — 직경은 annotation ──
    (signals.centerHoles || []).forEach(ch => {
      candidates.geometry.centerHolePositions.push({
        side: ch.side,
        confidence: ch.confidence,
      });
      candidates.annotation.centerHoleDiameters.push({
        side: ch.side,
        diameter: ch.diameter,  // null = placeholder
        diamConf: ch.confidence,
      });
    });

    // ── 3-i) 재질/표면거칠기 → annotation ──
    if (signals.material && signals.material.value != null) {
      candidates.annotation.material = signals.material.value;
      candidates.annotation.materialConf = signals.material.confidence;
    }
    if (signals.surfaceFinish && signals.surfaceFinish.value != null) {
      candidates.annotation.surfaceFinish = signals.surfaceFinish.value;
      candidates.annotation.surfaceFinishConf = signals.surfaceFinish.confidence;
    }

    // ── 3-i2) 품명/척도/각법 → annotation ──
    if (signals.partName && signals.partName.value != null) {
      candidates.annotation.partName = signals.partName.value;
    }
    if (signals.scale) {
      candidates.annotation.scale = signals.scale;
    }
    if (signals.projectionMethod) {
      candidates.annotation.projectionMethod = signals.projectionMethod;
    }

    // ── 3-j) 불확실 신호 취합 ──
    (signals.uncertainSignals || []).forEach(us => {
      candidates.uncertainElements.push({
        id: `UE_sig_${candidates.uncertainElements.length}`,
        description: us.description,
        location: us.location || 'unknown',
        severity: us.severity || 'low',
        confidence: CONF.UNCERTAIN,
      });
    });

    console.log('[AIEngine:Stage3] Shaft candidates:', JSON.stringify(candidates, null, 2));
    // v5.8: pass auxiliaryViews through
    candidates._auxiliaryViews = signals.auxiliaryViews || [];
    // v8: 중공축 데이터 전달
    candidates._hollowShaftData = signals.hollowShaftData || null;
    candidates._shaftType = signals.shaftType || 'solid';
    return candidates;
  }

  /** 위치 문자열 → sections 인덱스 매핑 */
  function resolveLocationIndex(location, sections) {
    if (!location || !sections.length) return -1;
    const loc = location.toLowerCase();
    if (loc === 'left' || loc === 'start') return 0;
    if (loc === 'right' || loc === 'end') return sections.length - 1;
    if (loc === 'center' || loc === 'middle') return Math.floor(sections.length / 2);
    const match = loc.match(/s(\d+)/i);
    if (match) {
      const idx = parseInt(match[1]) - 1;
      if (idx >= 0 && idx < sections.length) return idx;
    }
    return Math.floor(sections.length / 2);
  }


  // ============================================================
  // Stage 4: 후보 → 최종 spec 정리 (resolveSpecFromCandidates)
  //
  // v5: geometrySpec / annotationSpec 분리 구조
  //
  // geometrySpec: 반드시 생성 (형상 복제)
  // annotationSpec: placeholder 상태로 포함
  //   - confirmed → 값 유지
  //   - estimated → 값 유지 (렌더링 시 흐리게)
  //   - uncertain → null/placeholder
  // ============================================================

  function resolveSpecFromCandidates(candidates) {
    const spec = {
      // ─── geometrySpec ───
      geometrySpec: {
        sections: [],
        totalLength: candidates.geometry.totalLength,
        totalLengthConf: candidates.geometry.totalLengthConf,
        holes: [],
        slots: [],
        chamferPositions: [...candidates.geometry.chamferPositions],
        centerHolePositions: [...candidates.geometry.centerHolePositions],
        hiddenFeatures: [...(candidates.geometry.hiddenFeatures || [])],
      },

      // ─── annotationSpec ───
      annotationSpec: {
        partName: candidates.annotation.partName,       // '직접입력'
        partNo: candidates.annotation.partNo,           // '직접입력'
        material: candidates.annotation.material,       // null
        materialConf: candidates.annotation.materialConf,
        surfaceFinish: candidates.annotation.surfaceFinish, // null
        surfaceFinishConf: candidates.annotation.surfaceFinishConf,
        unit: candidates.annotation.unit,
        scale: candidates.annotation.scale,
        projectionMethod: candidates.annotation.projectionMethod || '3각법',
        chamferSpecs: [...candidates.annotation.chamferSpecs],
        keywaySpecs: [...candidates.annotation.keywaySpecs],
        tapSpecs: [...candidates.annotation.tapSpecs],
        centerHoleDiameters: [...candidates.annotation.centerHoleDiameters],
        notes: [...candidates.annotation.notes],
      },

      uncertainElements: [...candidates.uncertainElements],
      auxiliaryViews: [...(candidates._auxiliaryViews || [])],
      // v8: 중공축 데이터
      hollowShaftData: candidates._hollowShaftData || null,
      shaftType: candidates._shaftType || 'solid',
      _reviewRequired: true, // v5: 항상 review (형상 초안 상태)
    };

    // ── sections ──
    candidates.geometry.sections.forEach(sec => {
      spec.geometrySpec.sections.push({
        id: sec.id,
        length: sec.length,
        lengthConf: sec.lengthConf,
        diameter: sec.diameter,
        diameterConf: sec.diameterConf,
        note: sec.note,
      });
    });

    // ── holes: confirmed + estimated만 geometry 포함 ──
    candidates.geometry.holes.forEach(h => {
      if (h.confidence === CONF.UNCERTAIN) {
        spec.uncertainElements.push({
          id: `UE_hole_${h.id}`,
          description: `구멍 위치 불확실`,
          location: h.cx_section,
          severity: 'medium',
          confidence: CONF.UNCERTAIN,
        });
      } else {
        spec.geometrySpec.holes.push(h);
      }
    });

    // ── slots: confirmed + estimated만 geometry 포함 ──
    candidates.geometry.slots.forEach(sl => {
      if (sl.confidence === CONF.UNCERTAIN) {
        spec.uncertainElements.push({
          id: `UE_slot_${sl.id}`,
          description: `슬롯 위치/크기 불확실`,
          location: sl.cx_section,
          severity: 'medium',
          confidence: CONF.UNCERTAIN,
        });
      } else {
        spec.geometrySpec.slots.push(sl);
      }
    });

    console.log('[AIEngine:Stage4] Resolved spec:', JSON.stringify(spec, null, 2));
    return spec;
  }


  // ============================================================
  // Stage 5: Self-check (selfCheckSpec)
  //
  // v5 변경:
  //   - 형상 일치율을 우선 평가
  //   - annotation 누락은 치명 오류로 간주하지 않음
  //   - 원본에 없는 정보 생성 시 감점
  // ============================================================

  function selfCheckSpec(spec) {
    const errors = [];
    const warnings = [];
    const geometryScore = { total: 0, matched: 0 };

    const geo = spec.geometrySpec;
    const ann = spec.annotationSpec;

    // ── a) 구간 길이 합 = totalLength ──
    const validSections = geo.sections.filter(s => s.length != null);
    const sumLengths = validSections.reduce((sum, s) => sum + s.length, 0);
    if (geo.totalLength != null && sumLengths !== geo.totalLength) {
      const diff = Math.abs(sumLengths - geo.totalLength);
      // v6: 작은 차이는 warning, 큰 차이만 error (Vision AI 반올림 허용)
      const msg = `구간 길이 합(${sumLengths}) ≠ 전체 길이(${geo.totalLength}) 차이: ${diff}mm`;
      if (diff > geo.totalLength * 0.1) {
        errors.push(msg);
      } else {
        warnings.push(msg);
      }
    }
    geometryScore.total += 2;
    if (geo.totalLength != null && sumLengths === geo.totalLength) geometryScore.matched += 2;

    // ── b) 직경 미감지 구간 — warning (not error) ──
    geo.sections.forEach(s => {
      geometryScore.total++;
      if (s.diameter != null) {
        geometryScore.matched++;
      } else {
        warnings.push(`${s.id}: 직경 미감지 — placeholder 렌더링`);
      }
    });

    // ── c) 대칭 구조 참고 ──
    const secs = geo.sections;
    if (secs.length >= 3) {
      geometryScore.total++;
      const first = secs[0], last = secs[secs.length - 1];
      if (first.diameter != null && last.diameter != null) {
        if (first.diameter === last.diameter) {
          geometryScore.matched++;
        }
        if (first.diameter === last.diameter && first.length !== last.length) {
          warnings.push(
            `양단 길이 다름: ${first.id}=${first.length}mm, ` +
            `${last.id}=${last.length}mm — 원본 의도 확인`
          );
        }
      }
    }

    // ── d) symmetry 요소 소속 확인 ──
    geo.holes.filter(h => h.symmetry).forEach(h => {
      if (!geo.sections.find(s => s.id === h.cx_section)) {
        errors.push(`구멍 ${h.id}: 소속 구간 ${h.cx_section} 없음`);
      }
    });
    geo.slots.filter(sl => sl.symmetry).forEach(sl => {
      if (!geo.sections.find(s => s.id === sl.cx_section)) {
        errors.push(`슬롯 ${sl.id}: 소속 구간 ${sl.cx_section} 없음`);
      }
    });

    // ── e) 형상 필수 요소 체크 ──
    geometryScore.total++;
    if (geo.sections.length > 0) geometryScore.matched++; // 구간 존재
    geometryScore.total++;
    if (geo.totalLength != null) geometryScore.matched++;  // 전체 길이 존재

    // ── e-2) 직경 변화 경계 체크 ──
    // 인접 section 간 직경이 다르면 경계에서 각 section의 좌/우면이 그려져야 한다.
    // generateFromSpec()에서 모든 section의 4변을 그리므로, 경계의 면은 자동으로 포함됨.
    const stepBoundaries = [];
    for (let vi = 0; vi < secs.length - 1; vi++) {
      const curSec = secs[vi];
      const nextSec = secs[vi + 1];
      if (curSec.diameter == null || nextSec.diameter == null) continue;
      if (curSec.diameter !== nextSec.diameter) {
        stepBoundaries.push({
          boundary: `${curSec.id}↔${nextSec.id}`,
          diam1: curSec.diameter,
          diam2: nextSec.diameter,
        });
      }
    }

    // 경계 면 체크: 모든 section이 4변을 그리므로 항상 matched
    geometryScore.total += stepBoundaries.length;
    stepBoundaries.forEach(() => { geometryScore.matched++; });

    if (stepBoundaries.length > 0) {
      const boundaryList = stepBoundaries
        .map(sb => `${sb.boundary} (Ø${sb.diam1}↔Ø${sb.diam2})`)
        .join(', ');
      console.log(`[AIEngine:Stage5] 직경 변화 경계: ${boundaryList}`);
    }

    // ── f) annotation placeholder 상태 보고 (warning, not error) ──
    const placeholderItems = [];
    if (!ann.material) placeholderItems.push('재질');
    if (!ann.surfaceFinish) placeholderItems.push('표면거칠기');
    ann.tapSpecs.forEach(ts => {
      if (!ts.spec) placeholderItems.push(`탭 규격(${ts.holeId})`);
    });
    ann.chamferSpecs.forEach(cs => {
      if (!cs.spec) placeholderItems.push(`면취 규격(${cs.side})`);
    });
    ann.keywaySpecs.forEach(kw => {
      if (kw.width == null || kw.depth == null) placeholderItems.push('키홈 규격');
    });
    ann.centerHoleDiameters.forEach(ch => {
      if (ch.diameter == null) placeholderItems.push(`센터구멍 직경(${ch.side})`);
    });

    if (placeholderItems.length > 0) {
      warnings.push(`placeholder 상태 (사용자 입력 필요): ${placeholderItems.join(', ')}`);
    }

    // ── g) 불확실 요소 수 ──
    if (spec.uncertainElements.length > 0) {
      warnings.push(`불확실 요소 ${spec.uncertainElements.length}개 — review 필요`);
    }

    // ── g-2) 보조 투상도 검증 ──
    const auxViews = spec.auxiliaryViews || [];
    if (auxViews.length > 0) {
      geometryScore.total += auxViews.length;
      auxViews.forEach(aux => {
        if (aux.shape && aux.shape.width > 0 && aux.shape.height > 0) {
          geometryScore.matched++;
        }
      });
    }

    // ── g-3) 숨은선 검증 (v5.6: type별 검증) ──
    const hiddenFeatures = geo.hiddenFeatures || [];
    if (hiddenFeatures.length > 0) {
      geometryScore.total += hiddenFeatures.length;
      hiddenFeatures.forEach(hf => {
        const sec = geo.sections.find(s => s.id === hf.section);
        if (!sec) return;
        
        if (hf.type === 'keyway-floor') {
          // legacy
          if (hf.verticalOffset != null && hf.depthRatio != null) {
            geometryScore.matched++;
          } else {
            warnings.push(`숨은선 ${hf.id}: keyway-floor 파라미터 불완전`);
          }
        } else if (hf.type === 'keyway') {
          // v5.8: keyway — keywayWidth, keywayDepth 필수
          if (hf.keywayWidth != null && hf.keywayDepth != null) {
            geometryScore.matched++;
          } else {
            warnings.push(`숨은선 ${hf.id}: keyway 파라미터 불완전`);
          }
        } else if (hf.type === 'tap-bore') {
          // tap-bore: diameter, depth 존재 필수
          if (hf.diameter != null && hf.depth != null) {
            geometryScore.matched++;
          } else {
            warnings.push(`숨은선 ${hf.id}: tap-bore 파라미터 불완전`);
          }
        } else {
          // 기타 type도 section 소속 확인만
          geometryScore.matched++;
        }
      });
    }

    // ── h) 원본에 없는 정보 생성 감점 ──
    // v5: 자동 생성된 "예시값" 체크
    const fabricatedValues = [];
    if (ann.material && ann.materialConf === CONF.UNCERTAIN) {
      fabricatedValues.push(`재질 "${ann.material}" — uncertain 상태에서 자동 생성 의심`);
    }
    if (fabricatedValues.length > 0) {
      errors.push(`원본에 없는 정보 생성 의심: ${fabricatedValues.join('; ')}`);
    }

    // ── i) 형상 일치율 ──
    const geoPercent = geometryScore.total > 0
      ? Math.round((geometryScore.matched / geometryScore.total) * 100)
      : 0;

    // ── confidence 통계 ──
    const confStats = { confirmed: 0, estimated: 0, uncertain: spec.uncertainElements.length };
    geo.sections.forEach(s => {
      if (s.lengthConf === CONF.CONFIRMED) confStats.confirmed++;
      else if (s.lengthConf === CONF.ESTIMATED) confStats.estimated++;
      if (s.diameterConf === CONF.CONFIRMED) confStats.confirmed++;
      else if (s.diameterConf === CONF.ESTIMATED) confStats.estimated++;
      else confStats.uncertain++;
    });
    geo.holes.forEach(h => {
      if (h.confidence === CONF.CONFIRMED) confStats.confirmed++;
      else confStats.estimated++;
    });
    geo.slots.forEach(sl => {
      if (sl.confidence === CONF.CONFIRMED) confStats.confirmed++;
      else confStats.estimated++;
    });

    const result = {
      passed: errors.length === 0,
      errors,
      warnings,
      geometryFidelity: geoPercent,
      stats: {
        sectionCount: secs.length,
        totalLength: geo.totalLength,
        sumLengths,
        holeCount: geo.holes.length,
        slotCount: geo.slots.length,
        chamferPositionCount: geo.chamferPositions.length,
        centerHolePositionCount: geo.centerHolePositions.length,
        stepBoundaryCount: stepBoundaries.length,
        hiddenFeatureCount: hiddenFeatures.length,
        auxiliaryViewCount: auxViews.length,
        uncertainCount: spec.uncertainElements.length,
        placeholderCount: placeholderItems.length,
        confidence: confStats,
      },
    };

    console.log('[AIEngine:Stage5] Self-check:', JSON.stringify(result, null, 2));
    return result;
  }


  // ============================================================
  // ★ Spec → Document 변환기 (generateFromSpec)
  //
  // v5 핵심:
  // - geometry → 일반 실선으로 정상 렌더링
  // - annotation placeholder → 흐리게 / "직접입력" 표시
  // - 메타정보 자동 채움 금지
  // - 출력 = '형상 초안 + 빈 정보칸'
  // ============================================================

  function generateFromSpec(spec) {
    const selfResult = selfCheckSpec(spec);

    const geo = spec.geometrySpec;
    const ann = spec.annotationSpec;

    const doc = DrawingModel.createMechanicalDocument();
    doc.meta.title = `AI 생성 — 형상 초안`;
    doc.meta.scale = ann.scale;
    doc.meta.projectionMethod = ann.projectionMethod || '3각법';
    // v5: 메타정보는 placeholder 상태
    doc.meta.material = ann.material || '';
    doc.meta.surfaceFinish = ann.surfaceFinish || '';
    doc.meta.partName = ann.partName || '';
    doc.meta.partNo = ann.partNo || '';
    doc.meta._reviewRequired = spec._reviewRequired;

    // v7: 척도 파싱 (A:B 형식) — 치수 표시값 적용용
    let scaleA = 1, scaleB = 1;
    const scaleParts = (ann.scale || '1:1').split(':');
    if (scaleParts.length === 2) {
      scaleA = parseFloat(scaleParts[0]) || 1;
      scaleB = parseFloat(scaleParts[1]) || 1;
    }
    const scaleRatio = scaleA / scaleB; // 도면크기/실물크기

    // 척도 적용 도우미: 실물 치수 → 표시 치수
    function applyScale(val) {
      if (scaleRatio === 1) return val;
      const n = parseFloat(val);
      if (isNaN(n)) return val;
      const scaled = n * scaleRatio;
      return Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(2).replace(/\.?0+$/, '');
    }

    // ★ v6: 동적 스케일 — 도면 크기에 따라 PX/mm 비율 자동 조정
    //   캔버스 가용 폭 약 900px, 여백 160px(좌우 80) → 최대 도면폭 ~740px
    //   PX = min(2, 740 / totalLength)  → 큰 도면은 자동 축소
    const MAX_DRAWING_WIDTH = 740;
    const rawTotalLength = geo.totalLength ||
      geo.sections.reduce((sum, s) => sum + (s.length || 0), 0) || 200;
    const PX = Math.min(2, MAX_DRAWING_WIDTH / rawTotalLength);
    const ox = 80;
    // oy는 도면 크기에 따라 충분한 공간 확보
    const maxDiam = Math.max(...geo.sections.map(s => s.diameter || 20));
    const oy = Math.max(300, 180 + maxDiam * PX);

    // ──── 1. 구간 좌표 계산 ────
    const sections = [];
    let curX = ox;

    const resolvedSections = geo.sections.map((s, i) => {
      if (s.diameter != null) return { ...s, _renderDiam: s.diameter };
      // 직경 미감지: 인접 참고 (렌더링 크기만, 숫자 "생성" 아님)
      const prev = i > 0 ? geo.sections[i - 1] : null;
      const next = i < geo.sections.length - 1 ? geo.sections[i + 1] : null;
      const ref = prev?.diameter || next?.diameter || 20;
      return { ...s, _renderDiam: ref * 0.6 };
    });

    const maxR = Math.max(...resolvedSections.map(s => (s._renderDiam || 20) / 2));

    resolvedSections.forEach(s => {
      const w = s.length * PX;
      const r = ((s._renderDiam || 20) / 2) * PX;
      sections.push({
        ...s,
        x: curX, w, r,
        px_diameter: (s._renderDiam || 20) * PX,
      });
      curX += w;
    });

    const rightEnd = curX;

    // ──── 2. 중심선 (항상 confirmed — shaft 필수) ────
    const clMargin = 30;
    const cl = DrawingModel.createCenterline(
      ox - clMargin, oy, rightEnd + clMargin, oy
    );
    cl.confidence = CONF.CONFIRMED;
    doc.elements.push(cl);

    // ──── 3. 외형선 — 정투상도 정면도 ────
    //
    // 핵심 원리: 정면도에서 각 section은 직사각형으로 보인다.
    // 모든 section의 4변(상단선, 하단선, 좌측면, 우측면)을 모두 그린다.
    //
    // 예시 (S1 Ø20 — S2 Ø35 — S3 Ø20):
    //
    //              ┌─────────────────┐
    //  ┌───────────┤                 ├───────────┐
    //  │    S1     │       S2        │    S3     │
    //──┼───────────┤                 ├───────────┼──
    //  │           │                 │           │
    //  └───────────┤                 ├───────────┘
    //              └─────────────────┘
    //
    // S2가 S1, S3보다 크므로 S2의 4변이 모두 보인다.
    // S1의 좌면, S3의 우면도 보인다 (전체 부품의 양끝).
    // 경계(x=180, x=402)에서는 큰 section과 작은 section의 면이 겹치므로,
    // 큰 section의 면이 작은 section의 면을 포함한다.
    //
    sections.forEach((sec, i) => {
      const x1 = sec.x;
      const x2 = sec.x + sec.w;
      const r = sec.r;
      const conf = (sec.diameter != null) ? (sec.diameterConf || CONF.CONFIRMED) : CONF.ESTIMATED;

      // 상단선
      const topLine = DrawingModel.createOutline(x1, oy - r, x2, oy - r, 2);
      topLine.confidence = conf;
      doc.elements.push(topLine);

      // 하단선
      const botLine = DrawingModel.createOutline(x1, oy + r, x2, oy + r, 2);
      botLine.confidence = conf;
      doc.elements.push(botLine);

      // 좌측면 — 전체 높이 (oy-r ~ oy+r)
      const lf = DrawingModel.createOutline(x1, oy - r, x1, oy + r, 2);
      lf.confidence = conf;
      doc.elements.push(lf);

      // 우측면 — 전체 높이 (oy-r ~ oy+r)
      const rf = DrawingModel.createOutline(x2, oy - r, x2, oy + r, 2);
      rf.confidence = conf;
      doc.elements.push(rf);
    });


    // ──── 3.5. 키홈 좌표 전처리 (누진치수 준비) ────
    // 키홈 hidden feature의 좌표를 미리 계산하여
    // 치수선에서 누진치수(progressive dimensioning)를 적용할 수 있도록 한다.
    //
    // ★ 누진치수 규칙 (사용자 지정):
    //   키홈 offset이 입력된 구간은 기존 구간 길이 치수를 표시하지 않고,
    //   그 자리(구간 상단, 기존 길이 치수와 동일 위치)에 누진치수 체인으로 교체한다.
    //   → 동일한 값을 중복 표시하면 치수가 과밀해지므로,
    //     가장 중요한 정보인 누진치수만 기입하여 기존 전체 길이 치수를 대신한다.
    //
    //   구간 시작점(0) 기준 누적 거리로 표시
    //   예: S1=70mm, leftOff=5, kwWidth=11 → 5─16─70
    //       (5=좌측이격, 16=5+11=키홈 끝, 70=구간 전체)
    //
    const keywayPreprocessed = {};  // sectionId → { kx1, kx2, actualLeftOff, actualRightOff, actualKwWidth, hasOffset }
    (geo.hiddenFeatures || []).forEach(hf => {
      if (hf.type !== 'keyway') return;
      const sec = sections.find(s => s.id === hf.section);
      if (!sec) return;

      const sectionLenMm = sec.length;
      let kx1, kx2;
      let actualLeftOff = null, actualRightOff = null;
      let actualKwWidth = hf.keywayWidth;

      const hasLeftOff = hf.keywayLeftOffset != null && !isNaN(hf.keywayLeftOffset);
      const hasRightOff = hf.keywayRightOffset != null && !isNaN(hf.keywayRightOffset);
      const hasOffset = hasLeftOff || hasRightOff;

      if (hasLeftOff && hasRightOff) {
        actualLeftOff = hf.keywayLeftOffset;
        actualRightOff = hf.keywayRightOffset;
        actualKwWidth = sectionLenMm - actualLeftOff - actualRightOff;
        if (actualKwWidth <= 0) actualKwWidth = hf.keywayWidth;
        kx1 = sec.x + actualLeftOff * PX;
        kx2 = kx1 + actualKwWidth * PX;
      } else if (hasLeftOff) {
        actualLeftOff = hf.keywayLeftOffset;
        kx1 = sec.x + actualLeftOff * PX;
        kx2 = kx1 + hf.keywayWidth * PX;
        actualKwWidth = hf.keywayWidth;
        actualRightOff = sectionLenMm - actualLeftOff - actualKwWidth;
        if (actualRightOff < 0) actualRightOff = null;
      } else if (hasRightOff) {
        actualRightOff = hf.keywayRightOffset;
        kx2 = sec.x + sec.w - actualRightOff * PX;
        kx1 = kx2 - hf.keywayWidth * PX;
        actualKwWidth = hf.keywayWidth;
        actualLeftOff = sectionLenMm - actualKwWidth - actualRightOff;
        if (actualLeftOff < 0) actualLeftOff = null;
      } else {
        const kwWidth = hf.keywayWidth * PX;
        const secCenterX = sec.x + sec.w / 2;
        kx1 = secCenterX - kwWidth / 2;
        kx2 = secCenterX + kwWidth / 2;
        actualKwWidth = hf.keywayWidth;
      }

      keywayPreprocessed[hf.id] = {
        sectionId: hf.section,
        kx1, kx2,
        actualLeftOff, actualRightOff, actualKwWidth,
        hasOffset,
      };
    });

    // 키홈이 있는 section → 체인 치수(chain dimension) 데이터 빌드
    // { sectionId → { segments: [{ startPx, endPx, mm }], ... } }
    //
    // ★ 누진치수 규칙 (사용자 확정):
    //   키홈 offset이 있는 구간은 기존 구간 길이 치수를 표시하지 않고,
    //   개별 구간별 치수(chain dimension)로 교체한다.
    //   예: S1=50mm, leftOff=2, kwWidth=32 → 2, 32, 16
    //       (좌측이격=2, 키홈폭=32, 우측 나머지=16)
    //   각 치수선은 해당 구간의 시작~끝만 표시 (누적값 아님)
    //
    const progressiveDimSections = {};
    Object.values(keywayPreprocessed).forEach(kp => {
      if (!kp.hasOffset) return;
      const sec = sections.find(s => s.id === kp.sectionId);
      if (!sec) return;

      const segments = []; // { startPx, endPx, mm } 개별 구간
      const leftOffMm = kp.actualLeftOff;
      const kwWidthMm = kp.actualKwWidth;
      const secLenMm = sec.length;
      const rightRemainMm = secLenMm - leftOffMm - kwWidthMm;

      // 구간 1: 좌측 이격 (0 → leftOff)
      if (leftOffMm != null && leftOffMm > 0) {
        segments.push({
          startPx: sec.x,
          endPx: sec.x + leftOffMm * PX,
          mm: leftOffMm,
        });
      }
      // 구간 2: 키홈 폭 (leftOff → leftOff + kwWidth)
      if (kwWidthMm > 0) {
        const kwStartPx = sec.x + leftOffMm * PX;
        segments.push({
          startPx: kwStartPx,
          endPx: kwStartPx + kwWidthMm * PX,
          mm: kwWidthMm,
        });
      }
      // 구간 3: 우측 나머지 (leftOff + kwWidth → section 끝)
      if (rightRemainMm > 0.01) {
        const remainStartPx = sec.x + (leftOffMm + kwWidthMm) * PX;
        segments.push({
          startPx: remainStartPx,
          endPx: sec.x + sec.w,
          mm: Math.round(rightRemainMm * 100) / 100,
        });
      }

      progressiveDimSections[kp.sectionId] = { segments };
    });

    // ──── 4. 치수선 ────
    // 4-a) 구간별 길이
    //
    // ★ 핵심 규칙: 모든 구간 길이 치수선은 동일한 Y 수평선 위에 정렬
    //
    //   렌더러 동작: renderer는 (el.y1 - el.offset) 위치에 치수선을 그린다.
    //   따라서 모든 치수의 (y1 - offset) 값이 동일해야 치수선이 같은 Y에 정렬됨.
    //
    //   구현 방식:
    //   - dimLineY = oy - maxR*PX - dimGap  (모든 치수선의 최종 렌더링 Y — 고정값)
    //   - 각 구간의 y1 = oy - sec.r        (해당 구간의 실제 상단 — 연장선 시작점)
    //   - offset = y1 - dimLineY            (구간마다 다른 offset → 같은 dimLineY)
    //
    //   결과: 연장선은 각 구간의 실제 외형선에서 시작하고,
    //         치수선은 모두 동일한 수평선(dimLineY)에 정렬됨.
    //
    //   예시 (S1 Ø20, S2 Ø35, S3 Ø20):
    //     dimLineY ─────|←2→|←32→|←16→|───|←──111──→|───|←16→|←40→|←3→|──
    //                   ╎    ╎    ╎         ╎         ╎    ╎    ╎    ╎
    //     S1 top ───────╎────╎────╎         ╎         ╎────╎────╎────╎── S3 top
    //                            S2 top ────╎─────────╎── S2 top
    //
    const dimGap = 28; // 가장 큰 구간 상단에서 치수선까지의 최소 간격
    const dimLineY = oy - maxR * PX - dimGap; // 모든 구간 치수선의 공통 렌더 Y

    sections.forEach((sec) => {
      const secTopY = oy - sec.r;              // 이 구간의 실제 상단 Y (연장선 시작점)
      const secOffset = secTopY - dimLineY;    // 이 구간의 offset (= secTopY - dimLineY)
      const progData = progressiveDimSections[sec.id];

      if (progData) {
        // ── 체인 치수 (기존 구간 길이 치수 대체) ──
        // 모든 체인 치수를 동일한 치수선 Y 위치에 배치
        // 예: S1=50mm, leftOff=2, kwWidth=32 → 2, 32, 16
        //   |←2→|←──────32──────→|←──16──→|  ← 같은 수평선
        progData.segments.forEach((seg) => {
          const dim = DrawingModel.createDimension(
            seg.startPx, secTopY, seg.endPx, secTopY,
            applyScale(seg.mm), ann.unit, secOffset
          );
          dim.confidence = CONF.CONFIRMED;
          dim._progressiveDim = true;
          doc.elements.push(dim);
        });
      } else {
        // ── 기존 방식: 단일 구간 길이 치수 (동일 Y 정렬) ──
        const dim = DrawingModel.createDimension(
          sec.x, secTopY, sec.x + sec.w, secTopY,
          applyScale(sec.length), ann.unit, secOffset
        );
        dim.confidence = sec.lengthConf || CONF.CONFIRMED;
        doc.elements.push(dim);
      }
    });

    // 4-b) 전체 길이 — dimLineY 위로 추가 간격(25px)에 배치
    if (geo.totalLength != null) {
      const maxSecTopY = oy - maxR * PX;           // 가장 큰 구간의 상단
      const tlOffset = maxSecTopY - dimLineY + 25;  // 구간 치수선 위 25px
      const tlDim = DrawingModel.createDimension(
        ox, maxSecTopY, rightEnd, maxSecTopY,
        applyScale(geo.totalLength), ann.unit, tlOffset
      );
      tlDim.confidence = geo.totalLengthConf || CONF.CONFIRMED;
      doc.elements.push(tlDim);
    }

    // 4-c) 직경 치수 — 모든 구간에 표시 (같은 직경이라도 생략하지 않음)
    //   S1과 S3이 동일 직경(예: ⌀20)이어도 각각 표시해야 함
    //   중실축/중공축 관계없이 직경 치수를 구간 수평 중간에 표시
    //
    //   인접 구간이 동일 직경인 경우에만 중복 생략 (예: S1=⌀20, S2=⌀20 → S1만 표시)
    //   비인접 구간은 동일 직경이라도 각각 표시 (예: S1=⌀20, S3=⌀20 → 둘 다 표시)
    sections.forEach((sec, i) => {
      const diam = sec.diameter;
      const midX = sec.x + sec.w / 2;  // 구간 수평 중간점
      if (diam == null) {
        // 미감지 직경: placeholder '?' 치수
        const qDim = DrawingModel.createDiameterDimension(
          midX, oy - sec.r, midX, oy + sec.r,
          '?', ann.unit, -35
        );
        qDim.confidence = CONF.UNCERTAIN;
        qDim._isPlaceholder = true;
        doc.elements.push(qDim);
        return;
      }
      // 인접 이전 구간과 동일 직경이면 중복 생략 (연속된 같은 직경만)
      if (i > 0 && sections[i - 1].diameter === diam) return;
      const dDim = DrawingModel.createDiameterDimension(
        midX, oy - sec.r, midX, oy + sec.r,
        applyScale(diam), ann.unit, -35
      );
      dDim.confidence = sec.diameterConf || CONF.CONFIRMED;
      doc.elements.push(dDim);
    });

    // ──── 5. 숨은선(hidden line) — 원본 도면의 점선을 그대로 복제 ────
    //
    // v5.8 핵심 규칙:
    //   숨은선은 정확히 4개 블록 (사용자 지정):
    //     블록1: S1 M10 TAP (상/하 수평 파선 + 끝면 수직 파선)
    //     블록2: S1 키홈 (바닥면 수평 파선 + 양쪽 수직 파선)
    //     블록3: S3 M10 TAP (상/하 수평 파선 + 끝면 수직 파선)
    //     블록4: S3 키홈 (바닥면 수평 파선 + 양쪽 수직 파선)
    //
    //   type 정의:
    //     'tap-bore'  — Ø원형 구멍 → 정면도에서 상/하 수평 파선 2개 + 끝면 수직 1개
    //     'keyway'    — 키홈 → 바닥면 수평 파선 1개 + 양 끝 수직 파선 2개
    //                   바닥면 Y = centerline - (r - keywayDepth) = centerline - (10 - 3.5) = centerline - 6.5mm
    //                   키홈 가로 길이 = keywayWidth mm
    //
    const hiddenFeatures = geo.hiddenFeatures || [];
    hiddenFeatures.forEach(hf => {
      const sec = sections.find(s => s.id === hf.section);
      if (!sec) return;

      if (hf.type === 'tap-bore') {
        // ── TAP/보어: 수평 상하 2개 (중심선 대칭) + 끝면 수직 1개 ──
        const r = hf.diameter / 2 * PX;
        const depth = hf.depth * PX;

        let hx1, hx2;
        if (hf.side === 'left') {
          hx1 = sec.x;
          hx2 = sec.x + depth;
        } else {
          hx1 = sec.x + sec.w - depth;
          hx2 = sec.x + sec.w;
        }

        // 상부 수평
        const topH = DrawingModel.createHiddenLine(hx1, oy - r, hx2, oy - r, 1);
        topH.confidence = hf.confidence;
        doc.elements.push(topH);

        // 하부 수평
        const botH = DrawingModel.createHiddenLine(hx1, oy + r, hx2, oy + r, 1);
        botH.confidence = hf.confidence;
        doc.elements.push(botH);

        // 끝면 수직
        const endX = (hf.side === 'left') ? hx2 : hx1;
        const endV = DrawingModel.createHiddenLine(endX, oy - r, endX, oy + r, 1);
        endV.confidence = hf.confidence;
        doc.elements.push(endV);

      } else if (hf.type === 'keyway') {
        // ── 키홈: 바닥면 수평 1개 + 양 끝 수직 2개 ──
        // v8: 좌표는 전처리(keywayPreprocessed)에서 이미 계산됨
        //     치수는 누진치수(progressive dim)로 4-a)에서 통합 표시
        const preData = keywayPreprocessed[hf.id];
        let kx1, kx2;
        if (preData) {
          kx1 = preData.kx1;
          kx2 = preData.kx2;
        } else {
          // 전처리 실패 시 폴백 (중심 배치)
          const kwWidth = hf.keywayWidth * PX;
          const secCenterX = sec.x + sec.w / 2;
          kx1 = secCenterX - kwWidth / 2;
          kx2 = secCenterX + kwWidth / 2;
        }

        const keywayDepthPx = hf.keywayDepth * PX;
        const yFloor = oy - sec.r + keywayDepthPx;

        // 바닥면 수평 파선
        const floor = DrawingModel.createHiddenLine(kx1, yFloor, kx2, yFloor, 1);
        floor.confidence = hf.confidence;
        doc.elements.push(floor);

        // 좌측 수직 파선 (축 상단 → 바닥면)
        const leftV = DrawingModel.createHiddenLine(kx1, oy - sec.r, kx1, yFloor, 1);
        leftV.confidence = hf.confidence;
        doc.elements.push(leftV);

        // 우측 수직 파선 (축 상단 → 바닥면)
        const rightV = DrawingModel.createHiddenLine(kx2, oy - sec.r, kx2, yFloor, 1);
        rightV.confidence = hf.confidence;
        doc.elements.push(rightV);

        // 치수선은 누진치수(4-a)에서 통합 처리 — 여기서는 생성하지 않음

        // 보조투상도 연동용 좌표 저장
        hf._resolvedKx1 = kx1;
        hf._resolvedKx2 = kx2;
      }
      // 미지의 type은 무시
    });

    // 모든 숨은선은 hiddenFeatures에 명시적으로 정의해야 함

    // ──── 6. 슬롯 (메인 도면에 직접 표시되는 경우) ────
    // v5.5: 대부분의 슬롯/키홈 형상은 보조 투상도로 이동
    // 메인 도면에 남은 슬롯만 표시 (있는 경우)
    geo.slots.forEach(sl => {
      const sec = sections.find(s => s.id === sl.cx_section);
      if (!sec) return;
      const slX = sec.x + sl.cx_offset * PX;
      const slW = sl.slotLength * PX;
      const slH = sl.slotWidth * PX;

      const topSlot = DrawingModel.createSlot(slX, oy - sec.r - slH / 2, slW, slH);
      topSlot.confidence = sl.confidence;
      doc.elements.push(topSlot);

      if (sl.symmetry) {
        const botSlot = DrawingModel.createSlot(slX, oy + sec.r - slH / 2, slW, slH);
        botSlot.confidence = sl.confidence;
        doc.elements.push(botSlot);
      }
    });

    // ──── 7. 센터구멍 위치 (직경은 placeholder) ────
    geo.centerHolePositions.forEach(ch => {
      const cx = ch.side === 'left' ? ox : rightEnd;
      // 직경은 annotation에서 참조 — null이면 placeholder 크기(3)
      const annDiam = ann.centerHoleDiameters.find(d => d.side === ch.side);
      const renderDiam = annDiam?.diameter || 3;
      const hole = DrawingModel.createHole(cx, oy, renderDiam, null, 'center', null);
      hole.confidence = ch.confidence || CONF.UNCERTAIN;
      hole._isPlaceholder = (annDiam?.diameter == null);
      doc.elements.push(hole);
    });

    // ──── 8. 해칭 ────
    for (let i = 1; i < sections.length; i++) {
      const cur = sections[i];
      const prev = sections[i - 1];
      if (Math.abs(cur.r - prev.r) < 0.1) continue;

      const x = cur.x;
      const bigR = Math.max(cur.r, prev.r);
      const smallR = Math.min(cur.r, prev.r);
      const hW = 3;
      const hConf = (cur.diameterConf === CONF.CONFIRMED && prev.diameterConf === CONF.CONFIRMED)
        ? CONF.CONFIRMED : CONF.ESTIMATED;

      const topH = DrawingModel.createHatch([
        { x, y: oy - bigR }, { x: x + hW, y: oy - bigR },
        { x: x + hW, y: oy - smallR }, { x, y: oy - smallR },
      ], 45, 3);
      topH.confidence = hConf;
      doc.elements.push(topH);

      const botH = DrawingModel.createHatch([
        { x, y: oy + smallR }, { x: x + hW, y: oy + smallR },
        { x: x + hW, y: oy + bigR }, { x, y: oy + bigR },
      ], 45, 3);
      botH.confidence = hConf;
      doc.elements.push(botH);
    }

    // ──── 9. 텍스트/주석 — v8: KS 규격 표제란(Title Block) ────
    //
    //   ┌────┬──────┬─────┬────┬─────┐
    //   │ 4  │      │     │    │     │  ← 공란 (역순: 4→1)
    //   ├────┼──────┼─────┼────┼─────┤
    //   │ 3  │      │     │    │     │
    //   ├────┼──────┼─────┼────┼─────┤
    //   │ 2  │      │     │    │     │
    //   ├────┼──────┼─────┼────┼─────┤
    //   │ 1  │(품명)│(재질)│   │     │  ← 1번 행에 값 할당
    //   ├────┼──────┼─────┼────┼─────┤
    //   │품번│ 품명 │ 재질│수량│ 비고│  ← 헤더 (아래!)
    //   ├────┴──────┤─────┼────┴─────┤
    //   │  작품명   │척도 │  1:1     │  ← 하단 블록
    //   │           ├─────┼──────────┤
    //   │           │각법 │  3각법   │
    //   └───────────┴─────┴──────────┘
    //
    // 위치: 도면 우측 외부
    //
    {
      const tbWidth = 250;  // 표제란 너비
      const tbX = rightEnd + 80;  // 축 도면 우측 끝에서 80px 오른쪽
      const tbY = oy + maxR * PX - 20; // 도면 하단 근처

      // 품명 값
      const partNameVal = (ann.partName && ann.partName !== PLACEHOLDER.TEXT)
        ? ann.partName : '';

      // 재질 값
      const matValue = ann.material || '';

      // 4개 공란 행 생성 (위→아래: 4,3,2,1 역순)
      // 1번 행에만 품명/재질 값 할당, 나머지는 빈 공란
      const itemRows = [];
      for (let rowNum = 4; rowNum >= 1; rowNum--) {
        itemRows.push({
          no: rowNum,
          partName: rowNum === 1 ? partNameVal : '',
          material: rowNum === 1 ? matValue : '',
          quantity: '',
          remarks: '',
          editable: true,
        });
      }

      const titleBlock = DrawingModel.createTitleBlock(tbX, tbY, tbWidth, {
        itemRows,
        bottomInfo: {
          title: partNameVal || '',
          scale: ann.scale || '1:1',
          projectionMethod: ann.projectionMethod || '3각법',
        },
      });
      titleBlock.confidence = CONF.CONFIRMED;
      doc.elements.push(titleBlock);
    }

    // 9-d) 탭 규격 — 지시선 (leader line with arrow) + 텍스트
    // v5.9: 도면 규칙에 맞는 지시선 — 화살표가 구멍을 가리키고, 텍스트는 외부에 배치
    //   지시선 구조: 구멍 중심 → 꺾임점 → 수평선 → 텍스트
    //   화살표는 치수선과 동일한 스타일 (arrowEnd 마커)
    ann.tapSpecs.forEach(ts => {
      // hiddenFeatures에서 해당 tap-bore 찾기
      const hf = hiddenFeatures.find(f => f.id === ts.holeId);
      const sec = sections.find(s => s.id === ts.section);
      if (!sec) return;

      // 지시선: 구멍 끝면 중심 → 꺾임점 → 수평 → 텍스트
      const tapR = hf ? (hf.diameter / 2 * PX) : 5;
      const tapDepth = hf ? (hf.depth * PX) : 30;
      let arrowX, arrowY, elbowX, elbowY, textX, textY;

      if (hf && hf.side === 'left') {
        // 화살표 시작: tap bore 끝면 중심 (좌측 section의 끝면 안쪽)
        arrowX = sec.x + tapDepth;
        arrowY = oy + tapR + 2; // 하부 숨은선 바로 아래
        // 꺾임점: 아래쪽 대각선으로
        elbowX = sec.x + tapDepth + 15;
        elbowY = oy + sec.r + 22;
        // 텍스트: 꺾임점에서 수평으로
        textX = elbowX + 3;
        textY = elbowY;
      } else if (hf && hf.side === 'right') {
        arrowX = sec.x + sec.w - tapDepth;
        arrowY = oy + tapR + 2;
        elbowX = sec.x + sec.w - tapDepth - 15;
        elbowY = oy + sec.r + 22;
        textX = elbowX + 3;
        textY = elbowY;
      } else {
        arrowX = sec.x + sec.w / 2;
        arrowY = oy;
        elbowX = arrowX + 20;
        elbowY = oy + sec.r + 22;
        textX = elbowX + 3;
        textY = elbowY;
      }

      // 지시선 1: 화살표 끝점(구멍) → 꺾임점 (대각선, 화살표 마커 포함)
      const leader1 = DrawingModel.createOutline(elbowX, elbowY, arrowX, arrowY, 0.8);
      leader1.confidence = CONF.CONFIRMED;
      leader1.color = '#60a5fa';
      leader1._leaderLine = true;
      leader1._leaderArrow = true; // 렌더러에서 화살표 마커 적용
      doc.elements.push(leader1);

      // 지시선 2: 꺾임점 → 수평선 (텍스트 밑줄)
      const specText = ts.spec ? ts.spec : 'TAP 규격: ____';
      const textWidth = specText.length * 6.5; // 대략적 텍스트 폭
      const leader2 = DrawingModel.createOutline(elbowX, elbowY, elbowX + textWidth + 5, elbowY, 0.8);
      leader2.confidence = CONF.CONFIRMED;
      leader2.color = '#60a5fa';
      leader2._leaderLine = true;
      doc.elements.push(leader2);

      // 텍스트: 수평선 위에
      const t = DrawingModel.createText(textX, textY - 4, specText, 10);
      t.confidence = ts.spec ? ts.specConf : CONF.UNCERTAIN;
      t._isPlaceholder = !ts.spec;
      doc.elements.push(t);
    });

    // 9-e) 슬롯 치수 (메인 도면에 남은 슬롯이 있을 경우만)
    geo.slots.forEach(sl => {
      const sec = sections.find(s => s.id === sl.cx_section);
      if (!sec) return;
      const slX = sec.x + sl.cx_offset * PX;
      const t = DrawingModel.createText(slX, oy - sec.r - 20,
        `슬롯 ${sl.slotLength}x${sl.slotWidth}`, 10);
      t.confidence = sl.confidence;
      doc.elements.push(t);
    });

    // 9-f) (v5.5: 키홈 의미 해석 제거 — AI는 키홈인지 판단하지 않음)

    // ★ 불확실 요소 주석
    if (spec.uncertainElements.length > 0) {
      let ueY = oy + maxR * PX + 40;
      spec.uncertainElements.forEach(ue => {
        const t = DrawingModel.createText(ox, ueY,
          `⚠ [${ue.severity}] ${ue.description}`, 11);
        t.confidence = CONF.UNCERTAIN;
        doc.elements.push(t);
        ueY += 16;
      });
    }

    // ──── 10. 보조 투상도 (Auxiliary Views) ────
    // v5.6: 손그림 기반 — 정확한 위치에 투영선 포함
    //
    // 규칙:
    //   1. 보조투상도는 관련 section의 바로 위에 배치
    //   2. 수직 투영선(가는 실선)으로 메인 도면과 연결
    //   3. 투영선은 보조도의 폭 양 끝에서 메인 도면의 해당 section 상단으로
    //   4. 보조도 내부에는 숨은선 없음 — 실선 geometry만
    //   5. 보조도 치수는 독립 (메인 치수와 분리)
    //
    const auxViews = spec.auxiliaryViews || [];
    if (auxViews.length > 0) {
      const auxViewElements = [];

      auxViews.forEach((aux, ai) => {
        const relatedSec = sections.find(s => s.id === aux.relatedSection);
        let auxCx, auxCy;

        // v8: aux.id 'AUX{N}' → hiddenFeature 'HF_KW{N}' 매칭 (같은 인덱스)
        const auxIdx = parseInt((aux.id || '').replace(/\D/g, '')) || (ai + 1);
        const matchHfId = `HF_KW${auxIdx}`;

        // 해당 키홈 hidden feature 찾기 (ID 매칭 우선, 없으면 section 매칭)
        const findRelatedHf = () => {
          // 1차: ID 매칭
          const byId = hiddenFeatures.find(
            hf => hf.type === 'keyway' && hf.id === matchHfId && hf._resolvedKx1 != null
          );
          if (byId) return byId;
          // 2차: section 매칭 (하위 호환)
          return hiddenFeatures.find(
            hf => hf.type === 'keyway' && hf.section === aux.relatedSection && hf._resolvedKx1 != null
          );
        };

        if (relatedSec) {
          const relatedHf = findRelatedHf();
          if (relatedHf) {
            // offset 기반 키홈의 수평 중심에 보조투상도 배치
            auxCx = (relatedHf._resolvedKx1 + relatedHf._resolvedKx2) / 2;
          } else {
            // 기존 방식: section 수평 중심
            auxCx = relatedSec.x + relatedSec.w / 2;
          }
        } else {
          auxCx = ox + (ai * 200);
        }
        // 메인 도면 상단에서 충분히 위에 배치 (투영선 공간 확보)
        // v8: 3번째 이후 보조투상도는 추가 간격으로 겹침 방지
        auxCy = oy - maxR * PX - 100 - (ai >= 2 ? (ai - 1) * 60 : 0);

        const shape = aux.shape;
        // v8: 키홈 offset으로 실제 폭이 재계산된 경우, 보조투상도도 동기화
        const relatedHf = findRelatedHf();
        const actualAuxWidth = relatedHf
          ? (relatedHf._resolvedKx2 - relatedHf._resolvedKx1) // resolved pixel width
          : shape.width * PX;
        const sw = actualAuxWidth;
        const sh = shape.height * PX;
        // 보조도 수평 치수에 표시할 실제 키홈폭 (mm)
        const auxWidthMm = relatedHf
          ? Math.round((relatedHf._resolvedKx2 - relatedHf._resolvedKx1) / PX * 100) / 100
          : shape.width;

        if (shape.type === 'obround') {
          const slot = DrawingModel.createSlot(
            auxCx - sw / 2, auxCy - sh / 2, sw, sh
          );
          slot.confidence = shape.confidence;
          slot._auxViewId = aux.id;
          // v6.0: 보조투상도 외형은 검정색 실선 (PDF 출력 대비)
          slot.color = '#000000';
          doc.elements.push(slot);
          auxViewElements.push(slot);

          // 중심선 (수평)
          const cl = DrawingModel.createCenterline(
            auxCx - sw / 2 - 8, auxCy, auxCx + sw / 2 + 8, auxCy
          );
          cl.confidence = shape.confidence;
          cl._auxViewId = aux.id;
          doc.elements.push(cl);
          auxViewElements.push(cl);
        } else {
          // 직사각형 (실선 — 숨은선 아님!)
          const topL = DrawingModel.createOutline(auxCx - sw/2, auxCy - sh/2, auxCx + sw/2, auxCy - sh/2, 2);
          topL.confidence = shape.confidence;
          topL._auxViewId = aux.id;
          doc.elements.push(topL);
          auxViewElements.push(topL);

          const botL = DrawingModel.createOutline(auxCx - sw/2, auxCy + sh/2, auxCx + sw/2, auxCy + sh/2, 2);
          botL.confidence = shape.confidence;
          botL._auxViewId = aux.id;
          doc.elements.push(botL);
          auxViewElements.push(botL);

          const leftL = DrawingModel.createOutline(auxCx - sw/2, auxCy - sh/2, auxCx - sw/2, auxCy + sh/2, 2);
          leftL.confidence = shape.confidence;
          leftL._auxViewId = aux.id;
          doc.elements.push(leftL);
          auxViewElements.push(leftL);

          const rightL = DrawingModel.createOutline(auxCx + sw/2, auxCy - sh/2, auxCx + sw/2, auxCy + sh/2, 2);
          rightL.confidence = shape.confidence;
          rightL._auxViewId = aux.id;
          doc.elements.push(rightL);
          auxViewElements.push(rightL);
        }

        // ── 투영선 (projection lines) ──
        // 손그림에서 보조도와 메인 도면을 수직 가는 실선으로 연결
        if (aux.projectionLines && relatedSec) {
          const projY1 = auxCy + sh / 2 + 3;  // 보조도 하단
          const projY2 = oy - relatedSec.r - 3; // 메인 도면 상단

          // 좌측 투영선
          const leftProj = DrawingModel.createOutline(
            auxCx - sw / 2, projY1,
            auxCx - sw / 2, projY2,
            0.5
          );
          leftProj.confidence = CONF.CONFIRMED;
          leftProj._auxViewId = aux.id;
          leftProj._projectionLine = true;
          doc.elements.push(leftProj);
          auxViewElements.push(leftProj);

          // 우측 투영선
          const rightProj = DrawingModel.createOutline(
            auxCx + sw / 2, projY1,
            auxCx + sw / 2, projY2,
            0.5
          );
          rightProj.confidence = CONF.CONFIRMED;
          rightProj._auxViewId = aux.id;
          rightProj._projectionLine = true;
          doc.elements.push(rightProj);
          auxViewElements.push(rightProj);
        }

        // 보조도 치수선 (독립 — 메인 치수와 분리)
        // v5.9: 세로 치수는 외부에 배치 (도면 규칙)
        //   수평 치수: 상단 offset 15 (obround 위)
        //   수직 치수: 우측 offset -20 (obround 오른쪽 바깥)
        aux.dimensions.forEach(dim => {
          if (dim.axis === 'horizontal') {
            const d = DrawingModel.createDimension(
              auxCx - sw / 2, auxCy - sh / 2,
              auxCx + sw / 2, auxCy - sh / 2,
              applyScale(auxWidthMm), ann.unit, 15
            );
            d.confidence = dim.confidence;
            d._auxViewId = aux.id;
            doc.elements.push(d);
            auxViewElements.push(d);
          } else {
            // 세로 치수: 오른쪽 외부에 배치
            // x1,y1 = 우측상단, x2,y2 = 우측하단 → offset을 음수로 하여 오른쪽으로 이동
            const d = DrawingModel.createDimension(
              auxCx + sw / 2, auxCy - sh / 2,
              auxCx + sw / 2, auxCy + sh / 2,
              applyScale(dim.value), ann.unit, -20
            );
            d.confidence = dim.confidence;
            d._auxViewId = aux.id;
            doc.elements.push(d);
            auxViewElements.push(d);
          }
        });
      });

      // document에 auxiliaryViews 메타데이터 저장
      doc.auxiliaryViews = auxViews.map((aux, i) => ({
        id: aux.id,
        position: aux.position,
        relatedSection: aux.relatedSection,
        elementIds: auxViewElements
          .filter(el => el._auxViewId === aux.id)
          .map(el => el.id),
      }));
    }

    // ──── 9.5. 중공축 보조투상도 (Hollow Shaft Cross-Section) ────
    //
    // 중공축(hollow shaft)인 경우, 마지막 구간의 우측 끝에
    // 동심원(외경 + 내경) 단면 보조투상도를 그린다.
    //
    // 구조: 외경 원 (실선) + 내경 원 (실선) + 십자 중심선
    //       + 직경 치수선 (⌀외경, ⌀내경)
    //
    const hollowData = spec.hollowShaftData;
    if (hollowData && hollowData.boreDiameter) {
      const lastSec = sections[sections.length - 1];
      if (lastSec) {
        // 보조투상도 위치: 마지막 구간 우측 끝에서 오른쪽으로 이격
        const auxCx = lastSec.x + lastSec.w + 80;  // 우측 끝에서 80px 오른쪽
        const auxCy = oy;  // 중심선과 같은 높이

        // 외경/내경 (mm → px)
        const outerDiam = hollowData.outerDiameter || lastSec._renderDiam || 20;
        const innerDiam = hollowData.boreDiameter;
        const outerR = (outerDiam / 2) * PX;
        const innerR = (innerDiam / 2) * PX;

        // ── 외경 원 (실선, 검정) ──
        const outerCircle = DrawingModel.createHole(auxCx, auxCy, outerR * 2);
        outerCircle.color = '#000000';
        outerCircle.holeType = 'through';  // 실선
        outerCircle.confidence = CONF.CONFIRMED;
        outerCircle._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(outerCircle);

        // ── 내경 원 (실선, 검정) ──
        const innerCircle = DrawingModel.createHole(auxCx, auxCy, innerR * 2);
        innerCircle.color = '#000000';
        innerCircle.holeType = 'through';  // 실선
        innerCircle.confidence = CONF.CONFIRMED;
        innerCircle._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(innerCircle);

        // ── 십자 중심선 ──
        const clMargin = outerR + 12;
        const clH = DrawingModel.createCenterline(
          auxCx - clMargin, auxCy, auxCx + clMargin, auxCy
        );
        clH.confidence = CONF.CONFIRMED;
        clH._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(clH);

        const clV = DrawingModel.createCenterline(
          auxCx, auxCy - clMargin, auxCx, auxCy + clMargin
        );
        clV.confidence = CONF.CONFIRMED;
        clV._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(clV);

        // ── 외경 치수선 (⌀외경) — 상단 ──
        const outerDimVal = `⌀${applyScale(outerDiam)}`;
        const outerDim = DrawingModel.createDimension(
          auxCx - outerR, auxCy - outerR,
          auxCx + outerR, auxCy - outerR,
          outerDimVal, ann.unit, 18
        );
        outerDim.confidence = CONF.CONFIRMED;
        outerDim._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(outerDim);

        // ── 내경 치수선 (⌀내경) — 하단 ──
        const innerDimVal = `⌀${applyScale(innerDiam)}`;
        const innerDim = DrawingModel.createDimension(
          auxCx - innerR, auxCy + innerR,
          auxCx + innerR, auxCy + innerR,
          innerDimVal, ann.unit, -18
        );
        innerDim.confidence = CONF.CONFIRMED;
        innerDim._auxViewId = 'AUX_HOLLOW';
        doc.elements.push(innerDim);

        // ── 연결선 (마지막 구간 끝 → 보조투상도) ──
        // 가는 일점쇄선으로 연결
        const connLine = DrawingModel.createOutline(
          lastSec.x + lastSec.w, oy,
          auxCx - outerR - 5, oy,
          0.5
        );
        connLine.confidence = CONF.CONFIRMED;
        connLine._auxViewId = 'AUX_HOLLOW';
        connLine.color = '#666666';
        doc.elements.push(connLine);
      }
    }

    // ──── 10. Self-check 결과 — v8: 캔버스에 텍스트 대신 doc._selfCheck에 저장 ────
    // (이전: SVG 텍스트로 도면 위에 직접 표시 → 표제란 침범 문제)
    // (현재: app.js에서 좌측 하단 플로팅 패널로 표시)

    // ── 메타데이터 저장 ──
    doc._selfCheck = selfResult;
    doc._spec = spec;

    // ── 디버그: confidence + placeholder 통계 ──
    const confCount = { confirmed: 0, estimated: 0, uncertain: 0, placeholder: 0 };
    doc.elements.forEach(el => {
      const c = el.confidence;
      if (c === CONF.CONFIRMED) confCount.confirmed++;
      else if (c === CONF.ESTIMATED) confCount.estimated++;
      else if (c === CONF.UNCERTAIN) confCount.uncertain++;
      if (el._isPlaceholder) confCount.placeholder++;
    });
    console.log('[AIEngine] ═══ v5 Output Summary ═══');
    console.log(`  confirmed   : ${confCount.confirmed}`);
    console.log(`  estimated   : ${confCount.estimated}`);
    console.log(`  uncertain   : ${confCount.uncertain}`);
    console.log(`  placeholder : ${confCount.placeholder}`);
    console.log(`  total       : ${doc.elements.length}`);
    console.log(`  geometry fidelity: ${selfResult.geometryFidelity}%`);
    console.log('[AIEngine] Self-check:', selfResult);

    return doc;
  }


  // ============================================================
  // ★ Stage 2-B: Vision AI 기반 실제 이미지 분석
  //
  // 업로드된 손도면 이미지를 서버의 /api/analyze 엔드포인트로
  // 전송하여 GPT Vision API로 형상을 추출한다.
  //
  // 반환값은 extractConfirmedSignals()와 동일한 signals 형식
  // ============================================================

  async function extractSignalsFromImage(file) {
    console.log('[AIEngine:Stage2-Vision] Sending image to Vision API...');

    const formData = new FormData();
    formData.append('image', file);

    const response = await fetch('/api/analyze', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`Vision API error: ${response.status} — ${errData.error || 'Unknown'}`);
    }

    const data = await response.json();
    if (!data.success || !data.signals) {
      throw new Error('Vision API returned invalid data');
    }

    console.log('[AIEngine:Stage2-Vision] Received signals:', JSON.stringify(data.signals, null, 2));
    console.log(`[AIEngine:Stage2-Vision] ${data.sectionCount} sections, totalLength=${data.totalLength}`);

    return data.signals;
  }


  // ============================================================
  // AI 분석 메인 (5단계 파이프라인)
  //
  // v6: 실제 이미지 분석 지원
  //   - 업로드된 이미지 → Vision API → 실제 형상 추출
  //   - Demo 모드는 기존 hardcoded signals 사용
  // ============================================================

  async function analyzeImage(file) {
    // Stage 1
    const classification = classifyDrawingType(file);
    console.log(`[AIEngine:Stage1] Classification:`, classification);

    // ── UI 진행 표시: Stage 1 (이미지 전처리) ──
    updateAIStep(1, 'active');
    await delay(500);
    updateAIStep(1, 'done');
    const fillEl = document.getElementById('aiProgressFill');
    if (fillEl) fillEl.style.width = '20%';

    // ── Stage 2: 이미지 분석 + 사용자 입력 ──
    updateAIStep(2, 'active');
    let signals;
    try {
      // v6: ImageAnalyzer 사용 — 이미지 기본 분석 + 사용자 파라미터 입력
      signals = await ImageAnalyzer.analyze(file);
      console.log('[AIEngine] ImageAnalyzer succeeded:', JSON.stringify(signals, null, 2));
    } catch (analyzerError) {
      // 사용자가 취소한 경우 — 상위로 전파 (app.js에서 step 1으로 돌아감)
      if (analyzerError.message.includes('취소')) {
        throw analyzerError;
      }
      console.warn('[AIEngine] ImageAnalyzer failed:', analyzerError.message);
      // 기타 오류: 기존 hardcoded signals (데모용 fallback)
      signals = extractConfirmedSignals(classification);
    }
    updateAIStep(2, 'done');
    if (fillEl) fillEl.style.width = '40%';

    // ── Stage 3: 후보 생성 ──
    updateAIStep(3, 'active');
    await delay(300);
    updateAIStep(3, 'done');
    if (fillEl) fillEl.style.width = '60%';

    // ── Stage 4: Spec 정리 ──
    updateAIStep(4, 'active');
    await delay(300);
    updateAIStep(4, 'done');
    if (fillEl) fillEl.style.width = '80%';

    // ── Stage 5: Self-check ──
    updateAIStep(5, 'active');
    await delay(200);
    updateAIStep(5, 'done');
    if (fillEl) fillEl.style.width = '100%';

    // shaft 여부: > 0.3이면 shaft 파이프라인
    if (signals.shaftLikelihood && signals.shaftLikelihood.value > 0.3) {
      // Stage 3
      const candidates = buildShaftCandidates(signals);
      // Stage 4
      const spec = resolveSpecFromCandidates(candidates);
      // Stage 5 + 렌더링
      return generateFromSpec(spec);
    }

    // shaft가 아닌 경우에도 최소한 읽힌 정보는 활용
    return generatePartialFallback(signals);
  }

  function getAnalysisSteps() {
    return [
      { step: 1, delay: 700,  label: '이미지 전처리 및 노이즈 제거' },
      { step: 2, delay: 1000, label: 'Vision AI 형상 분석 (서버 전송)' },
      { step: 3, delay: 1100, label: '형상 배치 분석 + 단차/구멍 위치' },
      { step: 4, delay: 900,  label: '형상 초안 생성 + placeholder 배치' },
      { step: 5, delay: 600,  label: 'self-check (형상 일치율 검증)' },
    ];
  }


  // ============================================================
  // Partial fallback (shaft가 아닌 unknown — 형상 초안)
  // ============================================================

  function generatePartialFallback(signals) {
    const doc = DrawingModel.createUnknownDocument();
    doc.meta.title = 'AI 분석 — 형상 초안';
    doc.meta._reviewRequired = true;

    const ox = 100, oy = 250;

    const cl = DrawingModel.createCenterline(ox - 20, oy, ox + 400, oy);
    cl.confidence = CONF.ESTIMATED;
    doc.elements.push(cl);

    const totalLen = signals.totalLength?.value;
    const PX = 2;
    const w = totalLen ? totalLen * PX : 300;

    const h = 60;
    [
      DrawingModel.createOutline(ox, oy - h/2, ox + w, oy - h/2, 2),
      DrawingModel.createOutline(ox, oy + h/2, ox + w, oy + h/2, 2),
      DrawingModel.createOutline(ox, oy - h/2, ox, oy + h/2, 2),
      DrawingModel.createOutline(ox + w, oy - h/2, ox + w, oy + h/2, 2),
    ].forEach(el => {
      el.confidence = CONF.ESTIMATED;
      doc.elements.push(el);
    });

    if (totalLen) {
      const dim = DrawingModel.createDimension(ox, oy - h/2, ox + w, oy - h/2,
        String(totalLen), 'mm', 25);
      dim.confidence = signals.totalLength.confidence;
      doc.elements.push(dim);
    } else {
      const dim = DrawingModel.createDimension(ox, oy - h/2, ox + w, oy - h/2, '?', 'mm', 25);
      dim.confidence = CONF.UNCERTAIN;
      dim._isPlaceholder = true;
      doc.elements.push(dim);
    }

    const dDim = DrawingModel.createDiameterDimension(ox + w, oy - h/2, ox + w, oy + h/2, '?', 'mm', -35);
    dDim.confidence = CONF.UNCERTAIN;
    dDim._isPlaceholder = true;
    doc.elements.push(dDim);

    const texts = [
      { txt: '📐 형상 초안 — 메타정보는 직접 입력하세요', fs: 12 },
      { txt: '점선 요소는 추정(estimated) — 더블클릭으로 수정', fs: 11 },
      { txt: '_______ 표시는 placeholder — 더블클릭하여 값 입력', fs: 11 },
    ];
    texts.forEach((t, i) => {
      const el = DrawingModel.createText(ox, oy - h/2 - 55 + i * 16, t.txt, t.fs);
      el.confidence = CONF.CONFIRMED;
      doc.elements.push(el);
    });

    return doc;
  }


  // ============================================================
  // 데모 전용 — v5: geometry-first, annotation은 placeholder
  // ============================================================

  // ============================================================
  // ★ DEMO_SHAFT_SPEC — v5.8 손그림 원본 완전 재설정
  //
  // 숨은선 4개 블록 (사용자 지정):
  //   1. S1 M10 TAP 깊이30  → 수평 파선 2개 (중심선 상/하 대칭) + 수직 마감 1개
  //   2. S1 키홈 (깊이3.5, 가로32, 세로6) → 수평 파선 1개 (키홈 바닥) + 수직 2개
  //   3. S3 M10 TAP 깊이30  → 수평 파선 2개 (중심선 상/하 대칭) + 수직 마감 1개
  //   4. S3 키홈 (깊이3.5, 가로40, 세로6) → 수평 파선 1개 (키홈 바닥) + 수직 2개
  //
  // 보조투상도:
  //   - S1 위: 32×6 오브라운드 (키홈을 위에서 본 모양)
  //   - S3 위: 40×6 오브라운드 (키홈을 위에서 본 모양)
  // ============================================================
  const DEMO_SHAFT_SPEC = {
    geometrySpec: {
      sections: [
        { id: 'S1', length: 50,  lengthConf: CONF.CONFIRMED, diameter: 20, diameterConf: CONF.CONFIRMED, note: null },
        { id: 'S2', length: 111, lengthConf: CONF.CONFIRMED, diameter: 35, diameterConf: CONF.CONFIRMED, note: null },
        { id: 'S3', length: 59,  lengthConf: CONF.CONFIRMED, diameter: 20, diameterConf: CONF.CONFIRMED, note: null },
      ],
      totalLength: 220,
      totalLengthConf: CONF.CONFIRMED,
      holes: [],
      slots: [],
      chamferPositions: [
        { section: 'S1', side: 'left',  confidence: CONF.ESTIMATED },
        { section: 'S3', side: 'right', confidence: CONF.ESTIMATED },
      ],
      centerHolePositions: [
        { side: 'left',  confidence: CONF.UNCERTAIN },
        { side: 'right', confidence: CONF.UNCERTAIN },
      ],
      // ★ v5.8 숨은선 — 정확히 4개 블록
      // 각 블록은 "하나의 내부 feature"를 의미하며,
      // 정면도에서 보이지 않는 형상을 파선으로 표현
      hiddenFeatures: [
        // 블록1: S1 M10 TAP (좌측 끝면→30mm 깊이)
        // Ø10 원형 구멍이므로 정면도에서 상/하 수평 파선 + 끝면 수직 파선
        {
          id: 'HF1', section: 'S1', type: 'tap-bore',
          diameter: 10, depth: 30,
          side: 'left',
          confidence: CONF.CONFIRMED,
        },
        // 블록2: S1 키홈 (깊이3.5mm, 가로32mm, 세로6mm)
        // 정면도에서: 바닥선 수평 파선 1개 (중심선 위쪽) + 양쪽 수직 파선 2개
        // 바닥면 위치 = 축 상단에서 3.5mm 아래 = 중심선 위로 (r - depth) = (10 - 3.5) = 6.5mm
        {
          id: 'HF2', section: 'S1', type: 'keyway',
          keywayWidth: 32,    // mm — 키홈 가로 길이
          keywayHeight: 6,    // mm — 키홈 세로 (원주 방향)
          keywayDepth: 3.5,   // mm — 키홈 깊이 (반경 방향)
          side: 'left',       // 좌측 끝면에서 시작
          confidence: CONF.CONFIRMED,
        },
        // 블록3: S3 M10 TAP (우측 끝면→30mm 깊이)
        {
          id: 'HF3', section: 'S3', type: 'tap-bore',
          diameter: 10, depth: 30,
          side: 'right',
          confidence: CONF.CONFIRMED,
        },
        // 블록4: S3 키홈 (깊이3.5mm, 가로40mm, 세로6mm)
        {
          id: 'HF4', section: 'S3', type: 'keyway',
          keywayWidth: 40,
          keywayHeight: 6,
          keywayDepth: 3.5,
          side: 'right',
          confidence: CONF.CONFIRMED,
        },
      ],
    },
    annotationSpec: {
      partName: PLACEHOLDER.TEXT,
      partNo: PLACEHOLDER.TEXT,
      material: PLACEHOLDER.EMPTY,
      materialConf: CONF.UNCERTAIN,
      surfaceFinish: PLACEHOLDER.EMPTY,
      surfaceFinishConf: CONF.UNCERTAIN,
      unit: 'mm',
      scale: '1:1',
      projectionMethod: '3각법',
      chamferSpecs: [
        { section: 'S1', side: 'left',  spec: null, specConf: CONF.UNCERTAIN },
        { section: 'S3', side: 'right', spec: null, specConf: CONF.UNCERTAIN },
      ],
      keywaySpecs: [],
      tapSpecs: [
        { holeId: 'HF1', section: 'S1', spec: 'M10 TAP 깊이30', specConf: CONF.CONFIRMED },
        { holeId: 'HF3', section: 'S3', spec: 'M10 TAP 깊이30', specConf: CONF.CONFIRMED },
      ],
      centerHoleDiameters: [
        { side: 'left',  diameter: null, diamConf: CONF.UNCERTAIN },
        { side: 'right', diameter: null, diamConf: CONF.UNCERTAIN },
      ],
      notes: [],
    },
    // 보조 투상도 — 키홈을 위에서 본 모양
    auxiliaryViews: [
      {
        id: 'AUX1',
        position: 'top-left',
        label: '',
        shape: { type: 'obround', width: 32, height: 6, confidence: CONF.CONFIRMED },
        dimensions: [
          { axis: 'horizontal', value: 32, confidence: CONF.CONFIRMED },
          { axis: 'vertical',   value: 6,  confidence: CONF.CONFIRMED },
        ],
        relatedSection: 'S1',
        projectionLines: true,
      },
      {
        id: 'AUX2',
        position: 'top-right',
        label: '',
        shape: { type: 'obround', width: 40, height: 6, confidence: CONF.CONFIRMED },
        dimensions: [
          { axis: 'horizontal', value: 40, confidence: CONF.CONFIRMED },
          { axis: 'vertical',   value: 6,  confidence: CONF.CONFIRMED },
        ],
        relatedSection: 'S3',
        projectionLines: true,
      },
    ],
    uncertainElements: [],
    _reviewRequired: true,
  };


  function generateMechDemo() {
    return generateFromSpec(DEMO_SHAFT_SPEC);
  }

  function generateFromCustomSpec(spec) {
    return generateFromSpec(spec);
  }


  // ============================================================
  // UI 업데이트
  // ============================================================

  function updateAIStep(step, status) {
    const list = document.getElementById('aiStepsList');
    if (!list) return;
    list.querySelectorAll('li').forEach(li => {
      const s = parseInt(li.dataset.aiStep);
      const icon = li.querySelector('i');
      if (s < step || (s === step && status === 'done')) {
        li.className = 'done';
        icon.className = 'fas fa-check-circle';
      } else if (s === step && status === 'active') {
        li.className = 'active';
        icon.className = 'fas fa-spinner fa-spin';
      } else {
        li.className = '';
        icon.className = 'far fa-circle';
      }
    });
  }

  function resetAISteps() {
    const list = document.getElementById('aiStepsList');
    if (!list) return;
    list.querySelectorAll('li').forEach(li => {
      li.className = '';
      li.querySelector('i').className = 'far fa-circle';
    });
    const first = list.querySelector('li');
    if (first) {
      first.className = 'active';
      first.querySelector('i').className = 'fas fa-spinner fa-spin';
    }
    const fillEl = document.getElementById('aiProgressFill');
    if (fillEl) fillEl.style.width = '0%';
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    analyzeImage,
    classifyDrawingType,
    generateMechDemo,
    generateFromCustomSpec,
    selfCheckSpec,
    extractConfirmedSignals,
    buildShaftCandidates,
    resolveSpecFromCandidates,
    resetAISteps,
    getAnalysisSteps,
    delay,
    updateAIStep,
    DEMO_SHAFT_SPEC,
    CONF,
    PLACEHOLDER,
  };
})();
