/* ============================================================
   server.js — AutoDrawing API Server
   
   기능:
   1. 정적 파일 서빙 (index.html, js/, css/)
   2. POST /api/analyze — 손도면 이미지 → Vision AI → shaft geometry JSON
   ============================================================ */

const express = require('express');
const multer = require('multer');
const OpenAI = require('openai').default;
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');

const app = express();
const PORT = 8080;

// ── OpenAI 클라이언트 설정 ──
// 환경 변수 우선, YAML 파일은 fallback
const apiKey = process.env.OPENAI_API_KEY || (() => {
  const configPath = path.join(os.homedir(), '.genspark_llm.yaml');
  if (fs.existsSync(configPath)) {
    const cfg = yaml.load(fs.readFileSync(configPath, 'utf8'));
    return cfg?.openai?.api_key;
  }
  return null;
})();

const baseURL = process.env.OPENAI_BASE_URL || (() => {
  const configPath = path.join(os.homedir(), '.genspark_llm.yaml');
  if (fs.existsSync(configPath)) {
    const cfg = yaml.load(fs.readFileSync(configPath, 'utf8'));
    return cfg?.openai?.base_url;
  }
  return null;
})();

const openai = new OpenAI({
  apiKey: apiKey,
  baseURL: baseURL,
});

// ── Multer 설정 (메모리 저장) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/bmp', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type'));
  }
});

// ── 정적 파일 ──
app.use(express.static(__dirname));

// ── Vision API 프롬프트 ──
const VISION_PROMPT = `You are a mechanical drawing analyzer specialized in reading hand-drawn shaft drawings.

Analyze this hand-drawn mechanical shaft drawing and extract ALL geometric information.

Return a JSON object with EXACTLY this structure (no markdown, no explanation, ONLY valid JSON):

{
  "totalLength": <number or null>,
  "sections": [
    {
      "position": "S1",
      "diameter": <number or null>,
      "length": <number or null>,
      "diameterConfidence": "confirmed" | "estimated" | "uncertain",
      "lengthConfidence": "confirmed" | "estimated" | "uncertain"
    }
  ],
  "hiddenFeatures": [
    {
      "id": "HF1",
      "section": "S1",
      "type": "tap-bore" | "keyway",
      "side": "left" | "right",
      "diameter": <number or null>,
      "depth": <number or null>,
      "keywayWidth": <number or null>,
      "keywayHeight": <number or null>,
      "keywayDepth": <number or null>,
      "spec": "<string like 'M10 TAP depth30' or null>"
    }
  ],
  "auxiliaryViews": [
    {
      "id": "AUX1",
      "relatedSection": "S1",
      "shape": "obround" | "circle" | "rectangle",
      "width": <number>,
      "height": <number>
    }
  ],
  "chamfers": [
    { "side": "left" | "right", "spec": "<string or null>" }
  ],
  "centerHoles": [
    { "side": "left" | "right", "diameter": <number or null> }
  ],
  "material": "<string or null>",
  "surfaceFinish": "<string or null>",
  "notes": "<string or null>"
}

CRITICAL RULES:
1. Count EVERY distinct diameter section from left to right. Each time the diameter changes, it's a new section.
2. Sections are numbered S1 (leftmost) to SN (rightmost).
3. Read ALL numbers exactly as written - never invent values.
4. If a value is unreadable, use null.
5. Total length should equal sum of all section lengths.
6. For TAP holes, include diameter (e.g., 10 for M10) and depth.
7. For keyways, include width, height, and depth values if visible.
8. Auxiliary views are typically shown above the main drawing.
9. Look for Korean annotations (재질=material, 표면거칠기=surface finish).
10. For each dimension you read, assess confidence: "confirmed" if clearly readable, "estimated" if somewhat readable, "uncertain" if barely readable.

Return ONLY the JSON object, nothing else.`;

// ── POST /api/analyze ──
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    console.log(`[API] Analyzing image: ${req.file.originalname} (${req.file.size} bytes, ${req.file.mimetype})`);

    // 이미지를 base64로 변환
    const base64Image = req.file.buffer.toString('base64');
    const dataUrl = `data:${req.file.mimetype};base64,${base64Image}`;

    // Vision API 호출
    console.log('[API] Calling Vision API...');
    const response = await openai.chat.completions.create({
      model: 'gpt-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            {
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'high' }
            }
          ]
        }
      ],
      max_tokens: 4096,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content;
    console.log('[API] Raw Vision response:', content);

    if (!content) {
      return res.status(500).json({ error: 'Empty response from Vision API' });
    }

    // JSON 파싱 (마크다운 코드블록 제거)
    let jsonStr = content.trim();
    // Remove markdown code blocks if present
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('[API] JSON parse error:', parseErr.message);
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        return res.status(500).json({ error: 'Failed to parse Vision API response', raw: content });
      }
    }

    // 유효성 검증
    if (!parsed.sections || !Array.isArray(parsed.sections)) {
      return res.status(500).json({ error: 'Invalid response structure: missing sections array', parsed });
    }

    console.log(`[API] Extracted ${parsed.sections.length} sections, totalLength=${parsed.totalLength}`);

    // signals 형식으로 변환
    const signals = convertToSignals(parsed);

    res.json({
      success: true,
      raw: parsed,
      signals: signals,
      sectionCount: parsed.sections.length,
      totalLength: parsed.totalLength
    });

  } catch (err) {
    console.error('[API] Error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

/**
 * Vision API 응답 → ai-engine.js signals 형식 변환
 */
function convertToSignals(parsed) {
  const CONF = {
    CONFIRMED: 'confirmed',
    ESTIMATED: 'estimated',
    UNCERTAIN: 'uncertain',
  };

  const confMap = (str) => {
    if (str === 'confirmed') return CONF.CONFIRMED;
    if (str === 'estimated') return CONF.ESTIMATED;
    return CONF.UNCERTAIN;
  };

  // ── segmentLengths ──
  const segmentLengths = (parsed.sections || []).map((sec, i) => ({
    value: sec.length,
    confidence: confMap(sec.lengthConfidence),
    position: sec.position || `S${i + 1}`,
  }));

  // ── diameters (그룹화: 같은 직경은 하나로) ──
  const diameterGroups = {};
  (parsed.sections || []).forEach((sec, i) => {
    if (sec.diameter == null) return;
    const key = sec.diameter;
    if (!diameterGroups[key]) {
      diameterGroups[key] = {
        value: sec.diameter,
        confidence: confMap(sec.diameterConfidence),
        segments: [],
      };
    }
    diameterGroups[key].segments.push(sec.position || `S${i + 1}`);
  });
  const diameters = Object.values(diameterGroups);

  // ── hiddenFeatures ──
  const hiddenFeatures = (parsed.hiddenFeatures || []).map((hf, i) => {
    const base = {
      id: hf.id || `HF${i + 1}`,
      section: hf.section,
      type: hf.type,
      side: hf.side,
      confidence: CONF.CONFIRMED,
    };
    if (hf.type === 'tap-bore') {
      base.diameter = hf.diameter;
      base.depth = hf.depth;
    } else if (hf.type === 'keyway') {
      base.keywayWidth = hf.keywayWidth;
      base.keywayHeight = hf.keywayHeight;
      base.keywayDepth = hf.keywayDepth;
    }
    return base;
  });

  // ── tapSpecs (hiddenFeatures에서 추출) ──
  const tapSpecs = hiddenFeatures
    .filter(hf => hf.type === 'tap-bore')
    .map(hf => ({
      holeId: hf.id,
      section: hf.section,
      spec: hf.spec || (hf.diameter ? `M${hf.diameter} TAP${hf.depth ? ' depth' + hf.depth : ''}` : null),
      specConf: CONF.CONFIRMED,
    }));

  // ── auxiliaryViews ──
  const auxiliaryViews = (parsed.auxiliaryViews || []).map((aux, i) => ({
    id: aux.id || `AUX${i + 1}`,
    position: i === 0 ? 'top-left' : `top-${i}`,
    label: '',
    shape: {
      type: aux.shape || 'obround',
      width: aux.width,
      height: aux.height,
      confidence: CONF.CONFIRMED,
    },
    dimensions: [
      { axis: 'horizontal', value: aux.width, confidence: CONF.CONFIRMED },
      { axis: 'vertical', value: aux.height, confidence: CONF.CONFIRMED },
    ],
    relatedSection: aux.relatedSection,
    projectionLines: true,
  }));

  // ── chamfers ──
  const chamfers = (parsed.chamfers || []).map(ch => ({
    side: ch.side,
    spec: ch.spec || null,
    confidence: ch.spec ? CONF.CONFIRMED : CONF.UNCERTAIN,
  }));

  // ── centerHoles ──
  const centerHoles = (parsed.centerHoles || []).map(ch => ({
    side: ch.side,
    diameter: ch.diameter || null,
    confidence: ch.diameter ? CONF.CONFIRMED : CONF.UNCERTAIN,
  }));

  // ── 최종 signals 객체 ──
  return {
    hasHorizontalCenterline: { value: true, confidence: CONF.CONFIRMED },
    shaftLikelihood: { value: 0.95, confidence: CONF.CONFIRMED },
    totalLength: parsed.totalLength != null
      ? { value: parsed.totalLength, confidence: CONF.CONFIRMED }
      : null,
    segmentLengths,
    diameters,
    holes: [],
    slots: [],
    hiddenFeatures,
    auxiliaryViews,
    chamfers: chamfers.length > 0 ? chamfers : [
      { side: 'left', spec: null, confidence: CONF.UNCERTAIN },
      { side: 'right', spec: null, confidence: CONF.UNCERTAIN },
    ],
    keyways: [],
    centerHoles: centerHoles.length > 0 ? centerHoles : [
      { side: 'left', diameter: null, confidence: CONF.UNCERTAIN },
      { side: 'right', diameter: null, confidence: CONF.UNCERTAIN },
    ],
    material: {
      value: parsed.material || null,
      confidence: parsed.material ? CONF.CONFIRMED : CONF.UNCERTAIN,
    },
    surfaceFinish: {
      value: parsed.surfaceFinish || null,
      confidence: parsed.surfaceFinish ? CONF.CONFIRMED : CONF.UNCERTAIN,
    },
    uncertainSignals: [],
    tapSpecs,
  };
}

// ── 서버 시작 ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] AutoDrawing server running on http://0.0.0.0:${PORT}`);
  console.log(`[Server] API endpoint: POST /api/analyze`);
  console.log(`[Server] OpenAI baseURL: ${openai.baseURL}`);
});
