import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = { DB: D1Database }
const app = new Hono<{ Bindings: Bindings }>()

app.use('/waste-api/*', cors())

// ===== UTILITY =====
function today() { return new Date().toISOString().slice(0, 10) }
function now() { return new Date().toISOString().slice(0, 19).replace('T', ' ') }
function ok(data: any, msg = '성공') { return { success: true, message: msg, data, timestamp: now() } }
function err(msg: string) { return { success: false, message: msg, data: null, timestamp: now() } }

async function genTrackingNo(db: D1Database) {
  const prefix = `WTK-${today().replace(/-/g, '')}-`
  const r = await db.prepare(`SELECT MAX(TRACKING_NO) as mx FROM MOD_WASTE_TRACKING WHERE TRACKING_NO LIKE ?`).bind(prefix + '%').first<{mx:string|null}>()
  if (r?.mx) {
    const seq = parseInt(r.mx.split('-').pop()!) + 1
    return prefix + String(seq).padStart(4, '0')
  }
  return prefix + '0001'
}

const STAGE_ORDER: Record<string,number> = { DISCHARGE:1, COLLECTION:2, COMPRESSION:3, RECYCLING:4, PRODUCTION:5 }

// ===== API: 1단계 배출 등록 =====
app.post('/waste-api/tracking/discharge', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const no = await genTrackingNo(db)
  const r = await db.prepare(`INSERT INTO MOD_WASTE_TRACKING (TRACKING_NO,WASTE_TYPE,CURRENT_STAGE,STATUS,SOURCE_NAME,TOTAL_WEIGHT_KG,CREATED_BY,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(no, body.wasteType, 'DISCHARGE', 'INITIATED', body.centerName, body.weightKg, body.dischargeManager||'system', now(), 'N').run()
  const tid = r.meta?.last_row_id
  await db.prepare(`INSERT INTO MOD_WASTE_DISCHARGE (TRACKING_ID,DISCHARGE_DATE,CENTER_CODE,CENTER_NAME,DISCHARGE_MANAGER,WEIGHT_KG,WASTE_TYPE,REMARKS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(tid, body.dischargeDate, body.centerCode, body.centerName, body.dischargeManager||'', body.weightKg, body.wasteType, body.remarks||'', now(), 'N').run()
  return c.json(ok({ trackingId: tid, trackingNo: no }, '배출 등록 완료'), 201)
})

// ===== API: 2단계 수거 등록 =====
app.post('/waste-api/tracking/collection', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const t = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(body.trackingId).first()
  if (!t) return c.json(err('트래킹을 찾을 수 없습니다'), 404)
  if (STAGE_ORDER[(t as any).CURRENT_STAGE] !== 1) return c.json(err('현재 단계에서 수거를 등록할 수 없습니다 (배출 단계에서만 가능)'), 400)
  const co2 = body.distanceKm ? +(body.distanceKm * 0.21).toFixed(2) : null
  await db.prepare(`INSERT INTO MOD_WASTE_COLLECTION (TRACKING_ID,COLLECTOR_CODE,COLLECTOR_NAME,VEHICLE_NO,DRIVER_NAME,COLLECTION_START_AT,COLLECTION_END_AT,COLLECTED_WEIGHT_KG,ORIGIN_ADDRESS,DESTINATION_ADDRESS,DISTANCE_KM,CO2_EMISSION_KG,REMARKS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(body.trackingId, body.collectorCode, body.collectorName, body.vehicleNo||'', body.driverName||'', body.collectionStartAt, body.collectionEndAt||'', body.collectedWeightKg, body.originAddress||'', body.destinationAddress||'', body.distanceKm||0, co2, body.remarks||'', now(), 'N').run()
  await db.prepare(`UPDATE MOD_WASTE_TRACKING SET CURRENT_STAGE='COLLECTION',STATUS='IN_PROGRESS',UPDATED_AT=? WHERE TRACKING_ID=?`).bind(now(), body.trackingId).run()
  return c.json(ok({ trackingId: body.trackingId }, '수거 등록 완료'), 201)
})

// ===== API: 3단계 압축 등록 =====
app.post('/waste-api/tracking/compression', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const t = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(body.trackingId).first()
  if (!t) return c.json(err('트래킹을 찾을 수 없습니다'), 404)
  if (STAGE_ORDER[(t as any).CURRENT_STAGE] !== 2) return c.json(err('수거 단계에서만 압축을 등록할 수 있습니다'), 400)
  let lossW = null, lossR = null
  if (body.outputWeightKg && body.inputWeightKg) {
    lossW = +(body.inputWeightKg - body.outputWeightKg).toFixed(2)
    lossR = +((lossW / body.inputWeightKg) * 100).toFixed(2)
  }
  await db.prepare(`INSERT INTO MOD_WASTE_COMPRESSION (TRACKING_ID,PROCESSOR_CODE,PROCESSOR_NAME,PROCESS_START_AT,PROCESS_END_AT,INPUT_WEIGHT_KG,OUTPUT_WEIGHT_KG,LOSS_WEIGHT_KG,LOSS_RATE,COMPRESSION_DENSITY,BALE_COUNT,REMARKS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(body.trackingId, body.processorCode, body.processorName, body.processStartAt, body.processEndAt||'', body.inputWeightKg, body.outputWeightKg||0, lossW, lossR, body.compressionDensity||0, body.baleCount||0, body.remarks||'', now(), 'N').run()
  await db.prepare(`UPDATE MOD_WASTE_TRACKING SET CURRENT_STAGE='COMPRESSION',UPDATED_AT=? WHERE TRACKING_ID=?`).bind(now(), body.trackingId).run()
  return c.json(ok({ trackingId: body.trackingId }, '압축 처리 등록 완료'), 201)
})

// ===== API: 4단계 재활용 등록 =====
app.post('/waste-api/tracking/recycling', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const t = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(body.trackingId).first()
  if (!t) return c.json(err('트래킹을 찾을 수 없습니다'), 404)
  if (STAGE_ORDER[(t as any).CURRENT_STAGE] !== 3) return c.json(err('압축 단계에서만 재활용을 등록할 수 있습니다'), 400)
  let rate = null, co2s = null
  if (body.outputWeightKg && body.inputWeightKg) {
    rate = +((body.outputWeightKg / body.inputWeightKg) * 100).toFixed(2)
    co2s = +(body.outputWeightKg * 2.3).toFixed(2)
  }
  await db.prepare(`INSERT INTO MOD_WASTE_RECYCLING (TRACKING_ID,RECYCLER_CODE,RECYCLER_NAME,PROCESS_START_AT,PROCESS_END_AT,INPUT_WEIGHT_KG,OUTPUT_WEIGHT_KG,RECYCLING_RATE,RECYCLING_METHOD,CO2_SAVING_KG,REMARKS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(body.trackingId, body.recyclerCode, body.recyclerName, body.processStartAt, body.processEndAt||'', body.inputWeightKg, body.outputWeightKg||0, rate, body.recyclingMethod||'', co2s, body.remarks||'', now(), 'N').run()
  await db.prepare(`UPDATE MOD_WASTE_TRACKING SET CURRENT_STAGE='RECYCLING',UPDATED_AT=? WHERE TRACKING_ID=?`).bind(now(), body.trackingId).run()
  return c.json(ok({ trackingId: body.trackingId }, '재활용 등록 완료'), 201)
})

// ===== API: 5단계 생산 등록 =====
app.post('/waste-api/tracking/production', async (c) => {
  const body = await c.req.json()
  const db = c.env.DB
  const t = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(body.trackingId).first()
  if (!t) return c.json(err('트래킹을 찾을 수 없습니다'), 404)
  if (STAGE_ORDER[(t as any).CURRENT_STAGE] !== 4) return c.json(err('재활용 단계에서만 생산을 등록할 수 있습니다'), 400)
  await db.prepare(`INSERT INTO MOD_WASTE_PRODUCTION (TRACKING_ID,PRODUCER_CODE,PRODUCER_NAME,PRODUCT_NAME,PRODUCT_CODE,PRODUCTION_START_AT,PRODUCTION_END_AT,INPUT_WEIGHT_KG,OUTPUT_WEIGHT_KG,PRODUCTION_QTY,DELIVERY_DESTINATION,DELIVERY_DATE,REMARKS,CREATED_AT,DEL_YN) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(body.trackingId, body.producerCode, body.producerName, body.productName, body.productCode||'', body.productionStartAt, body.productionEndAt||'', body.inputWeightKg, body.outputWeightKg||0, body.productionQty||0, body.deliveryDestination||'', body.deliveryDate||'', body.remarks||'', now(), 'N').run()
  await db.prepare(`UPDATE MOD_WASTE_TRACKING SET CURRENT_STAGE='PRODUCTION',STATUS='COMPLETED',COMPLETED_AT=?,UPDATED_AT=? WHERE TRACKING_ID=?`).bind(now(), now(), body.trackingId).run()
  return c.json(ok({ trackingId: body.trackingId }, '제품 생산 등록 완료'), 201)
})

// ===== API: 트래킹 목록 =====
app.get('/waste-api/tracking', async (c) => {
  const db = c.env.DB
  const page = parseInt(c.req.query('page') || '0')
  const size = parseInt(c.req.query('size') || '20')
  const rows = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE DEL_YN='N' ORDER BY CREATED_AT DESC LIMIT ? OFFSET ?`).bind(size, page * size).all()
  const cnt = await db.prepare(`SELECT COUNT(*) as c FROM MOD_WASTE_TRACKING WHERE DEL_YN='N'`).first<{c:number}>()
  return c.json(ok({ content: rows.results, totalElements: cnt?.c || 0, page, size }))
})

// ===== API: 트래킹 상세 =====
app.get('/waste-api/tracking/:id', async (c) => {
  const id = c.req.param('id')
  const db = c.env.DB
  const t = await db.prepare(`SELECT * FROM MOD_WASTE_TRACKING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  if (!t) return c.json(err('트래킹을 찾을 수 없습니다'), 404)
  const d = await db.prepare(`SELECT * FROM MOD_WASTE_DISCHARGE WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  const col = await db.prepare(`SELECT * FROM MOD_WASTE_COLLECTION WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  const comp = await db.prepare(`SELECT * FROM MOD_WASTE_COMPRESSION WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  const recy = await db.prepare(`SELECT * FROM MOD_WASTE_RECYCLING WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  const prod = await db.prepare(`SELECT * FROM MOD_WASTE_PRODUCTION WHERE TRACKING_ID=? AND DEL_YN='N'`).bind(id).first()
  return c.json(ok({ tracking: t, discharge: d, collection: col, compression: comp, recycling: recy, production: prod }))
})

// ===== API: 대시보드 =====
app.get('/waste-api/dashboard', async (c) => {
  const db = c.env.DB
  const sd = c.req.query('startDate') || '2026-01-01'
  const ed = c.req.query('endDate') || '2026-12-31'

  const totalQ = await db.prepare(`SELECT COUNT(*) as cnt, COALESCE(SUM(TOTAL_WEIGHT_KG),0) as total FROM MOD_WASTE_TRACKING WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=?`).bind(sd, ed + ' 23:59:59').first<{cnt:number,total:number}>()
  const stageQ = await db.prepare(`SELECT CURRENT_STAGE as stage, COUNT(*) as cnt FROM MOD_WASTE_TRACKING WHERE DEL_YN='N' GROUP BY CURRENT_STAGE`).all()
  const statusQ = await db.prepare(`SELECT STATUS as st, COUNT(*) as cnt FROM MOD_WASTE_TRACKING WHERE DEL_YN='N' GROUP BY STATUS`).all()
  const recycleQ = await db.prepare(`SELECT COALESCE(AVG(RECYCLING_RATE),0) as avgRate, COALESCE(SUM(CO2_SAVING_KG),0) as co2Save FROM MOD_WASTE_RECYCLING WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=?`).bind(sd, ed + ' 23:59:59').first<{avgRate:number,co2Save:number}>()
  const lossQ = await db.prepare(`SELECT COALESCE(AVG(LOSS_RATE),0) as avgLoss FROM MOD_WASTE_COMPRESSION WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=?`).bind(sd, ed + ' 23:59:59').first<{avgLoss:number}>()
  const distQ = await db.prepare(`SELECT COALESCE(SUM(DISTANCE_KM),0) as dist, COALESCE(SUM(CO2_EMISSION_KG),0) as co2E FROM MOD_WASTE_COLLECTION WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=?`).bind(sd, ed + ' 23:59:59').first<{dist:number,co2E:number}>()
  const dailyQ = await db.prepare(`SELECT DATE(CREATED_AT) as dt, COUNT(*) as cnt, COALESCE(SUM(TOTAL_WEIGHT_KG),0) as wt FROM MOD_WASTE_TRACKING WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=? GROUP BY DATE(CREATED_AT) ORDER BY dt`).bind(sd, ed + ' 23:59:59').all()
  const centerQ = await db.prepare(`SELECT CENTER_NAME as name, COUNT(*) as cnt, COALESCE(SUM(WEIGHT_KG),0) as wt FROM MOD_WASTE_DISCHARGE WHERE DEL_YN='N' AND DISCHARGE_DATE>=? AND DISCHARGE_DATE<=? GROUP BY CENTER_NAME ORDER BY wt DESC`).bind(sd, ed).all()
  const wasteTypeQ = await db.prepare(`SELECT WASTE_TYPE as tp, COUNT(*) as cnt, COALESCE(SUM(WEIGHT_KG),0) as wt FROM MOD_WASTE_DISCHARGE WHERE DEL_YN='N' AND DISCHARGE_DATE>=? AND DISCHARGE_DATE<=? GROUP BY WASTE_TYPE`).bind(sd, ed).all()
  const collectorQ = await db.prepare(`SELECT COLLECTOR_NAME as name, COUNT(*) as cnt, COALESCE(SUM(COLLECTED_WEIGHT_KG),0) as wt, COALESCE(SUM(DISTANCE_KM),0) as dist FROM MOD_WASTE_COLLECTION WHERE DEL_YN='N' AND CREATED_AT>=? AND CREATED_AT<=? GROUP BY COLLECTOR_NAME`).bind(sd, ed + ' 23:59:59').all()

  return c.json(ok({
    totalCount: totalQ?.cnt || 0,
    totalWeightKg: totalQ?.total || 0,
    avgRecyclingRate: +(recycleQ?.avgRate || 0).toFixed(1),
    totalCo2SavingKg: +(recycleQ?.co2Save || 0).toFixed(1),
    avgLossRate: +(lossQ?.avgLoss || 0).toFixed(1),
    totalDistanceKm: +(distQ?.dist || 0).toFixed(1),
    totalCo2EmissionKg: +(distQ?.co2E || 0).toFixed(1),
    stageStats: stageQ.results,
    statusStats: statusQ.results,
    dailyStats: dailyQ.results,
    centerStats: centerQ.results,
    wasteTypeStats: wasteTypeQ.results,
    collectorStats: collectorQ.results
  }))
})

// ===== SPA HTML =====
app.get('*', (c) => {
  return c.html(renderHTML())
})

function renderHTML() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>WMS - Waste Management System</title>
<link rel="preconnect" href="https://cdn.jsdelivr.net">
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.5.0/css/all.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --c-bg:#f3f4f6;--c-card:#fff;--c-text:#1f2937;--c-text2:#6b7280;--c-text3:#9ca3af;
  --c-border:#e5e7eb;--c-primary:#059669;--c-primary-l:#d1fae5;
  --sidebar-w:260px;--header-h:64px;
  --r:12px;--shadow:0 1px 3px rgba(0,0,0,.08);
}
html{font-size:14px}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans KR',sans-serif;background:var(--c-bg);color:var(--c-text);line-height:1.5}

/* SIDEBAR */
.sidebar{position:fixed;left:0;top:0;bottom:0;width:var(--sidebar-w);background:linear-gradient(180deg,#064e3b,#065f46);z-index:100;display:flex;flex-direction:column;transition:transform .3s ease}
.sidebar-brand{padding:20px 24px;border-bottom:1px solid rgba(255,255,255,.1)}
.sidebar-brand h1{color:#fff;font-size:20px;font-weight:700;display:flex;align-items:center;gap:10px}
.sidebar-brand h1 i{font-size:22px;color:#34d399}
.sidebar-brand p{color:#6ee7b7;font-size:11px;margin-top:2px;letter-spacing:.5px}
.sidebar nav{flex:1;padding:12px 0}
.nav-item{display:flex;align-items:center;gap:14px;padding:12px 24px;color:#a7f3d0;font-size:14px;cursor:pointer;transition:all .2s;border-left:3px solid transparent;text-decoration:none}
.nav-item:hover{background:rgba(255,255,255,.08);color:#fff}
.nav-item.active{background:rgba(255,255,255,.12);color:#fff;border-left-color:#34d399;font-weight:600}
.nav-item i{width:20px;text-align:center;font-size:15px}
.sidebar-footer{padding:16px 24px;border-top:1px solid rgba(255,255,255,.08);color:#6ee7b7;font-size:11px}

/* LAYOUT */
.layout{margin-left:var(--sidebar-w);min-height:100vh;transition:margin .3s}
.header{height:var(--header-h);background:var(--c-card);border-bottom:1px solid var(--c-border);display:flex;align-items:center;justify-content:space-between;padding:0 32px;position:sticky;top:0;z-index:50}
.header-left h2{font-size:18px;font-weight:700;color:var(--c-text)}
.header-left p{font-size:12px;color:var(--c-text2);margin-top:1px}
.content{padding:24px 32px}

/* MOBILE */
.mobile-toggle{display:none;position:fixed;top:14px;left:14px;z-index:200;background:var(--c-primary);color:#fff;border:none;width:40px;height:40px;border-radius:10px;cursor:pointer;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:90}
@media(max-width:900px){
  .sidebar{transform:translateX(-100%)}
  .sidebar.open{transform:translateX(0)}
  .sidebar-overlay.open{display:block}
  .layout{margin-left:0}
  .mobile-toggle{display:flex;align-items:center;justify-content:center}
  .content{padding:16px}
  .header{padding:0 16px 0 60px}
}

/* COMPONENTS */
.card{background:var(--c-card);border-radius:var(--r);padding:24px;box-shadow:var(--shadow)}
.page{display:none;animation:fadeIn .3s ease}.page.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

/* KPI */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(175px,1fr));gap:16px;margin-bottom:24px}
.kpi{background:var(--c-card);border-radius:var(--r);padding:20px;box-shadow:var(--shadow);transition:transform .15s,box-shadow .15s;position:relative;overflow:hidden}
.kpi:hover{transform:translateY(-3px);box-shadow:0 4px 12px rgba(0,0,0,.1)}
.kpi-icon{width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;margin-bottom:12px}
.kpi-label{font-size:12px;color:var(--c-text2);margin-bottom:2px;font-weight:500}
.kpi-value{font-size:28px;font-weight:800;color:var(--c-text);line-height:1.1}
.kpi-unit{font-size:12px;color:var(--c-text3);margin-top:2px}

/* CHARTS */
.chart-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:20px;margin-bottom:24px}
@media(max-width:900px){.chart-grid{grid-template-columns:1fr}}
.chart-card{background:var(--c-card);border-radius:var(--r);padding:24px;box-shadow:var(--shadow)}
.chart-card h3{font-size:15px;font-weight:600;color:var(--c-text);margin-bottom:16px;display:flex;align-items:center;gap:8px}

/* CO2 SUMMARY */
.co2-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.co2-box{border-radius:var(--r);padding:24px;text-align:center}
.co2-box .co2-label{font-size:13px;font-weight:500;margin-bottom:6px}
.co2-box .co2-val{font-size:34px;font-weight:800;line-height:1.1}
.co2-box .co2-unit{font-size:12px;margin-top:4px;opacity:.8}

/* FORMS */
.step-tabs{display:flex;gap:6px;margin-bottom:24px;flex-wrap:wrap;align-items:center}
.step-tab{padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s;border:2px solid transparent;background:#e5e7eb;color:#6b7280}
.step-tab.on{background:var(--c-primary);color:#fff;border-color:var(--c-primary);box-shadow:0 2px 10px rgba(5,150,105,.25)}
.step-arrow{color:#ccc;font-size:10px}
.form-panel{display:none;animation:fadeIn .25s ease}.form-panel.show{display:block}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:600px){.form-grid{grid-template-columns:1fr}}
.form-grid .full{grid-column:1/-1}
.form-group label{display:block;font-size:12px;font-weight:600;color:var(--c-text2);margin-bottom:5px;text-transform:uppercase;letter-spacing:.3px}
.form-group input,.form-group select,.form-group textarea{width:100%;border:1.5px solid var(--c-border);border-radius:8px;padding:10px 14px;font-size:14px;outline:none;transition:border .2s,box-shadow .2s;background:var(--c-card);color:var(--c-text);font-family:inherit}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:var(--c-primary);box-shadow:0 0 0 3px rgba(5,150,105,.12)}
.form-group textarea{resize:vertical;min-height:60px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 24px;border-radius:10px;font-weight:600;font-size:14px;cursor:pointer;border:none;transition:all .2s;font-family:inherit}
.btn:hover{filter:brightness(1.08);transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.btn-primary{background:var(--c-primary);color:#fff}
.btn-blue{background:#3b82f6;color:#fff}
.btn-amber{background:#f59e0b;color:#fff}
.btn-purple{background:#8b5cf6;color:#fff}
.btn-red{background:#ef4444;color:#fff}
.btn-gray{background:#6b7280;color:#fff}

/* TRACKING */
.search-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.search-bar .form-group{flex:1;min-width:200px}

/* TIMELINE */
.timeline-wrap{display:flex;align-items:center;justify-content:center;gap:0;padding:20px 0;flex-wrap:wrap}
.tl-step{display:flex;flex-direction:column;align-items:center;gap:6px}
.tl-dot{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;transition:all .3s}
.tl-dot.done{background:#059669;color:#fff;box-shadow:0 2px 8px rgba(5,150,105,.3)}
.tl-dot.now{background:#3b82f6;color:#fff;animation:pulseDot 2s infinite;box-shadow:0 2px 8px rgba(59,130,246,.3)}
.tl-dot.wait{background:#e5e7eb;color:#9ca3af}
@keyframes pulseDot{0%,100%{box-shadow:0 0 0 0 rgba(59,130,246,.4)}50%{box-shadow:0 0 0 12px rgba(59,130,246,0)}}
.tl-label{font-size:11px;font-weight:600;white-space:nowrap}
.tl-connector{width:50px;height:3px;margin-bottom:20px}
.tl-connector.done{background:#059669}.tl-connector.wait{background:#e5e7eb}

/* DETAIL CARDS */
.detail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-bottom:24px}
.detail-card{background:var(--c-card);border-radius:var(--r);padding:20px;box-shadow:var(--shadow);border-top:4px solid}
.detail-card h4{font-size:14px;font-weight:700;color:var(--c-text);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.detail-row{display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-bottom:1px solid #f3f4f6}
.detail-row:last-child{border-bottom:none}
.detail-row .dl{color:var(--c-text2)}.detail-row .dv{font-weight:600;color:var(--c-text)}

/* TABLE */
.tbl-wrap{overflow-x:auto;margin-top:20px}
table{width:100%;border-collapse:collapse}
thead th{padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:var(--c-text2);text-transform:uppercase;letter-spacing:.5px;background:#f9fafb;border-bottom:2px solid var(--c-border)}
tbody td{padding:12px 14px;font-size:13px;border-bottom:1px solid #f3f4f6}
tbody tr{cursor:pointer;transition:background .15s}
tbody tr:hover{background:#f0fdf4}
.badge{display:inline-block;padding:3px 12px;border-radius:20px;font-size:11px;font-weight:700}
.mono{font-family:'Courier New',monospace;font-weight:700;color:var(--c-primary)}

/* TOAST */
.toast{position:fixed;top:20px;right:20px;z-index:9999;padding:14px 28px;border-radius:12px;color:#fff;font-size:14px;font-weight:500;animation:toastIn .35s ease;box-shadow:0 6px 24px rgba(0,0,0,.2);display:none;backdrop-filter:blur(8px)}
@keyframes toastIn{from{transform:translateY(-20px) scale(.95);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}

/* COLLECTOR TABLE */
.collector-tbl{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
.collector-tbl th{background:#f9fafb;padding:8px 10px;text-align:left;font-size:11px;font-weight:700;color:var(--c-text2);border-bottom:2px solid var(--c-border)}
.collector-tbl td{padding:8px 10px;border-bottom:1px solid #f3f4f6}

/* LOADING */
.loading{display:flex;align-items:center;justify-content:center;padding:40px;color:var(--c-text3)}
.spinner{width:24px;height:24px;border:3px solid var(--c-border);border-top-color:var(--c-primary);border-radius:50%;animation:spin .6s linear infinite;margin-right:10px}
@keyframes spin{to{transform:rotate(360deg)}}

/* DATE INPUTS */
.date-filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.date-filter input[type=date]{width:155px;padding:8px 12px;border:1.5px solid var(--c-border);border-radius:8px;font-size:13px;outline:none}
.date-filter input[type=date]:focus{border-color:var(--c-primary)}
.date-sep{color:var(--c-text3);font-size:13px}
</style>
</head>
<body>

<!-- Mobile Toggle -->
<button class="mobile-toggle" id="mobileToggle"><i class="fas fa-bars"></i></button>
<div class="sidebar-overlay" id="overlay"></div>

<!-- Sidebar -->
<aside class="sidebar" id="sidebar">
  <div class="sidebar-brand">
    <h1><i class="fas fa-recycle"></i> WMS</h1>
    <p>Waste Management System</p>
  </div>
  <nav>
    <a class="nav-item active" data-page="dashboard"><i class="fas fa-chart-pie"></i>대시보드</a>
    <a class="nav-item" data-page="input"><i class="fas fa-edit"></i>데이터 입력</a>
    <a class="nav-item" data-page="tracking"><i class="fas fa-route"></i>추적 조회</a>
  </nav>
  <div class="sidebar-footer">v1.0 &middot; module-waste</div>
</aside>

<!-- Toast -->
<div class="toast" id="toast"></div>

<!-- Layout -->
<div class="layout">

<!-- ==================== DASHBOARD ==================== -->
<div id="pg-dashboard" class="page active">
  <div class="header">
    <div class="header-left">
      <h2><i class="fas fa-chart-pie" style="color:var(--c-primary);margin-right:6px"></i>대시보드</h2>
      <p>폐기물 처리 현황 종합 모니터링</p>
    </div>
    <div class="date-filter">
      <input type="date" id="sd">
      <span class="date-sep">~</span>
      <input type="date" id="ed">
      <button class="btn btn-primary" onclick="loadDash()"><i class="fas fa-sync-alt"></i> 조회</button>
    </div>
  </div>
  <div class="content">
    <!-- KPI -->
    <div class="kpi-grid" id="kpiGrid">
      <div class="kpi"><div class="kpi-icon" style="background:#d1fae5;color:#059669"><i class="fas fa-weight-hanging"></i></div><div class="kpi-label">총 배출량</div><div class="kpi-value" id="k-wt">-</div><div class="kpi-unit">kg</div></div>
      <div class="kpi"><div class="kpi-icon" style="background:#dbeafe;color:#3b82f6"><i class="fas fa-clipboard-list"></i></div><div class="kpi-label">트래킹 건수</div><div class="kpi-value" id="k-cnt">-</div><div class="kpi-unit">건</div></div>
      <div class="kpi"><div class="kpi-icon" style="background:#ccfbf1;color:#14b8a6"><i class="fas fa-recycle"></i></div><div class="kpi-label">평균 재활용률</div><div class="kpi-value" id="k-recycle">-</div><div class="kpi-unit">%</div></div>
      <div class="kpi"><div class="kpi-icon" style="background:#fef3c7;color:#f59e0b"><i class="fas fa-exclamation-triangle"></i></div><div class="kpi-label">평균 Loss율</div><div class="kpi-value" id="k-loss">-</div><div class="kpi-unit">%</div></div>
      <div class="kpi"><div class="kpi-icon" style="background:#ede9fe;color:#8b5cf6"><i class="fas fa-road"></i></div><div class="kpi-label">총 이동거리</div><div class="kpi-value" id="k-dist">-</div><div class="kpi-unit">km</div></div>
      <div class="kpi"><div class="kpi-icon" style="background:#dcfce7;color:#22c55e"><i class="fas fa-leaf"></i></div><div class="kpi-label">CO2 절감</div><div class="kpi-value" id="k-co2">-</div><div class="kpi-unit">kg CO2</div></div>
    </div>

    <!-- Charts Row 1 -->
    <div class="chart-grid">
      <div class="chart-card"><h3><i class="fas fa-chart-bar" style="color:#10b981"></i>일별 배출 추이</h3><div style="position:relative;height:280px"><canvas id="chDaily"></canvas></div></div>
      <div class="chart-card"><h3><i class="fas fa-chart-doughnut" style="color:#3b82f6"></i>처리 단계별 현황</h3><div style="position:relative;height:280px"><canvas id="chStage"></canvas></div></div>
    </div>

    <!-- Charts Row 2 -->
    <div class="chart-grid">
      <div class="chart-card"><h3><i class="fas fa-chart-pie" style="color:#14b8a6"></i>폐기물 종류별 비중</h3><div style="position:relative;height:280px"><canvas id="chType"></canvas></div></div>
      <div class="chart-card"><h3><i class="fas fa-building" style="color:#8b5cf6"></i>배출처별 처리량</h3><div style="position:relative;height:280px"><canvas id="chCenter"></canvas></div></div>
    </div>

    <!-- CO2 Summary -->
    <div class="card" style="margin-bottom:24px">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px"><i class="fas fa-leaf" style="color:#22c55e"></i>탄소 배출/절감 요약</h3>
      <div class="co2-grid">
        <div class="co2-box" style="background:#fef2f2"><div class="co2-label" style="color:#dc2626">운송 CO2 배출</div><div class="co2-val" style="color:#b91c1c" id="co2e">-</div><div class="co2-unit" style="color:#f87171">kg CO2</div></div>
        <div class="co2-box" style="background:#f0fdf4"><div class="co2-label" style="color:#16a34a">재활용 CO2 절감</div><div class="co2-val" style="color:#15803d" id="co2s">-</div><div class="co2-unit" style="color:#4ade80">kg CO2</div></div>
        <div class="co2-box" style="background:#eff6ff"><div class="co2-label" style="color:#2563eb">순 CO2 절감</div><div class="co2-val" style="color:#1d4ed8" id="co2n">-</div><div class="co2-unit" style="color:#60a5fa">kg CO2</div></div>
      </div>
    </div>

    <!-- Collector Stats -->
    <div class="card">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px"><i class="fas fa-truck" style="color:#3b82f6"></i>수거 업체별 통계</h3>
      <div class="tbl-wrap">
        <table class="collector-tbl">
          <thead><tr><th>업체명</th><th>수거 건수</th><th>수거 중량(kg)</th><th>이동 거리(km)</th></tr></thead>
          <tbody id="collectorBody"><tr><td colspan="4" style="text-align:center;color:var(--c-text3);padding:20px">로딩 중...</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<!-- ==================== DATA INPUT ==================== -->
<div id="pg-input" class="page">
  <div class="header">
    <div class="header-left">
      <h2><i class="fas fa-edit" style="color:var(--c-primary);margin-right:6px"></i>단계별 데이터 입력</h2>
      <p>배출 > 수거/운송 > 압축(KNT) > 재활용 > 생산</p>
    </div>
  </div>
  <div class="content">
    <div class="step-tabs">
      <button class="step-tab on" data-step="1"><i class="fas fa-truck-loading"></i> 1. 배출</button>
      <i class="fas fa-chevron-right step-arrow"></i>
      <button class="step-tab" data-step="2"><i class="fas fa-truck"></i> 2. 수거</button>
      <i class="fas fa-chevron-right step-arrow"></i>
      <button class="step-tab" data-step="3"><i class="fas fa-compress-arrows-alt"></i> 3. 압축</button>
      <i class="fas fa-chevron-right step-arrow"></i>
      <button class="step-tab" data-step="4"><i class="fas fa-recycle"></i> 4. 재활용</button>
      <i class="fas fa-chevron-right step-arrow"></i>
      <button class="step-tab" data-step="5"><i class="fas fa-industry"></i> 5. 생산</button>
    </div>

    <!-- STEP 1 -->
    <div id="fp1" class="form-panel show">
      <div class="card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px"><i class="fas fa-truck-loading" style="color:#10b981"></i>배출 등록</h3>
        <form id="f1" class="form-grid">
          <div class="form-group"><label>배출일 *</label><input type="date" name="dischargeDate" required></div>
          <div class="form-group"><label>폐기물 종류 *</label><select name="wasteType" required><option value="">선택하세요</option><option value="PAPER_WASTE">폐지/파지</option><option value="CARDBOARD">골판지</option><option value="MIXED_PAPER">혼합 폐지</option><option value="NEWSPAPER">신문지</option><option value="OTHER">기타</option></select></div>
          <div class="form-group"><label>배출처 코드 *</label><input name="centerCode" required placeholder="CTR-001"></div>
          <div class="form-group"><label>배출처명 *</label><input name="centerName" required placeholder="서울 물류센터"></div>
          <div class="form-group"><label>담당자</label><input name="dischargeManager" placeholder="홍길동"></div>
          <div class="form-group"><label>배출 중량(kg) *</label><input type="number" step="0.01" name="weightKg" required placeholder="1500.00"></div>
          <div class="form-group full"><label>비고</label><textarea name="remarks" rows="2" placeholder="특이사항을 입력하세요"></textarea></div>
          <div class="full" style="text-align:right"><button type="submit" class="btn btn-primary"><i class="fas fa-save"></i> 배출 등록</button></div>
        </form>
      </div>
    </div>

    <!-- STEP 2 -->
    <div id="fp2" class="form-panel">
      <div class="card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px"><i class="fas fa-truck" style="color:#3b82f6"></i>수거/운송 등록</h3>
        <form id="f2" class="form-grid">
          <div class="form-group"><label>트래킹 ID *</label><input type="number" name="trackingId" required placeholder="숫자 ID"></div>
          <div class="form-group"><label>수거 업체 코드 *</label><input name="collectorCode" required placeholder="COL-001"></div>
          <div class="form-group"><label>수거 업체명 *</label><input name="collectorName" required placeholder="(주)그린수거"></div>
          <div class="form-group"><label>차량 번호</label><input name="vehicleNo" placeholder="12가3456"></div>
          <div class="form-group"><label>운전기사</label><input name="driverName" placeholder="박운전"></div>
          <div class="form-group"><label>수거 시작 *</label><input type="datetime-local" name="collectionStartAt" required></div>
          <div class="form-group"><label>수거 완료</label><input type="datetime-local" name="collectionEndAt"></div>
          <div class="form-group"><label>수거 중량(kg) *</label><input type="number" step="0.01" name="collectedWeightKg" required placeholder="1500.00"></div>
          <div class="form-group"><label>출발지</label><input name="originAddress" placeholder="서울시 강남구"></div>
          <div class="form-group"><label>도착지</label><input name="destinationAddress" placeholder="경기도 화성시"></div>
          <div class="form-group"><label>이동 거리(km)</label><input type="number" step="0.01" name="distanceKm" placeholder="85.5"></div>
          <div class="form-group"><label>비고</label><textarea name="remarks" rows="2"></textarea></div>
          <div class="full" style="text-align:right"><button type="submit" class="btn btn-blue"><i class="fas fa-save"></i> 수거 등록</button></div>
        </form>
      </div>
    </div>

    <!-- STEP 3 -->
    <div id="fp3" class="form-panel">
      <div class="card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px"><i class="fas fa-compress-arrows-alt" style="color:#f59e0b"></i>압축 처리 등록 (KNT)</h3>
        <form id="f3" class="form-grid">
          <div class="form-group"><label>트래킹 ID *</label><input type="number" name="trackingId" required></div>
          <div class="form-group"><label>처리 업체 코드 *</label><input name="processorCode" required placeholder="KNT-001"></div>
          <div class="form-group"><label>처리 업체명 *</label><input name="processorName" required placeholder="KNT 화성"></div>
          <div class="form-group"><label>처리 시작 *</label><input type="datetime-local" name="processStartAt" required></div>
          <div class="form-group"><label>처리 완료</label><input type="datetime-local" name="processEndAt"></div>
          <div class="form-group"><label>입고 중량(kg) *</label><input type="number" step="0.01" name="inputWeightKg" required placeholder="1500.00"></div>
          <div class="form-group"><label>출고 중량(kg)</label><input type="number" step="0.01" name="outputWeightKg" placeholder="1425.00"></div>
          <div class="form-group"><label>베일 수량</label><input type="number" name="baleCount" placeholder="3"></div>
          <div class="form-group"><label>압축 밀도(kg/m3)</label><input type="number" step="0.01" name="compressionDensity" placeholder="450.00"></div>
          <div class="form-group"><label>비고</label><textarea name="remarks" rows="2"></textarea></div>
          <div class="full" style="text-align:right"><button type="submit" class="btn btn-amber"><i class="fas fa-save"></i> 압축 등록</button></div>
        </form>
      </div>
    </div>

    <!-- STEP 4 -->
    <div id="fp4" class="form-panel">
      <div class="card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px"><i class="fas fa-recycle" style="color:#8b5cf6"></i>재활용 등록</h3>
        <form id="f4" class="form-grid">
          <div class="form-group"><label>트래킹 ID *</label><input type="number" name="trackingId" required></div>
          <div class="form-group"><label>재활용 업체 코드 *</label><input name="recyclerCode" required placeholder="RCY-001"></div>
          <div class="form-group"><label>재활용 업체명 *</label><input name="recyclerName" required placeholder="에코리사이클링"></div>
          <div class="form-group"><label>처리 시작 *</label><input type="datetime-local" name="processStartAt" required></div>
          <div class="form-group"><label>처리 완료</label><input type="datetime-local" name="processEndAt"></div>
          <div class="form-group"><label>입고 중량(kg) *</label><input type="number" step="0.01" name="inputWeightKg" required placeholder="1425.00"></div>
          <div class="form-group"><label>산출 중량(kg)</label><input type="number" step="0.01" name="outputWeightKg" placeholder="1282.50"></div>
          <div class="form-group"><label>재활용 방법</label><input name="recyclingMethod" placeholder="파쇄>세척>탈수>건조"></div>
          <div class="form-group full"><label>비고</label><textarea name="remarks" rows="2"></textarea></div>
          <div class="full" style="text-align:right"><button type="submit" class="btn btn-purple"><i class="fas fa-save"></i> 재활용 등록</button></div>
        </form>
      </div>
    </div>

    <!-- STEP 5 -->
    <div id="fp5" class="form-panel">
      <div class="card">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:20px;display:flex;align-items:center;gap:8px"><i class="fas fa-industry" style="color:#ef4444"></i>제품 생산 등록</h3>
        <form id="f5" class="form-grid">
          <div class="form-group"><label>트래킹 ID *</label><input type="number" name="trackingId" required></div>
          <div class="form-group"><label>생산 업체 코드 *</label><input name="producerCode" required placeholder="PRD-001"></div>
          <div class="form-group"><label>생산 업체명 *</label><input name="producerName" required placeholder="한국제지"></div>
          <div class="form-group"><label>제품명 *</label><input name="productName" required placeholder="재생 A4 용지"></div>
          <div class="form-group"><label>제품 코드</label><input name="productCode" placeholder="RP-A4-001"></div>
          <div class="form-group"><label>생산 시작 *</label><input type="datetime-local" name="productionStartAt" required></div>
          <div class="form-group"><label>생산 완료</label><input type="datetime-local" name="productionEndAt"></div>
          <div class="form-group"><label>투입 중량(kg) *</label><input type="number" step="0.01" name="inputWeightKg" required></div>
          <div class="form-group"><label>생산 중량(kg)</label><input type="number" step="0.01" name="outputWeightKg"></div>
          <div class="form-group"><label>생산 수량</label><input type="number" name="productionQty"></div>
          <div class="form-group"><label>납품처</label><input name="deliveryDestination" placeholder="오피스디포 본사"></div>
          <div class="form-group"><label>납품일</label><input type="date" name="deliveryDate"></div>
          <div class="form-group full"><label>비고</label><textarea name="remarks" rows="2"></textarea></div>
          <div class="full" style="text-align:right"><button type="submit" class="btn btn-red"><i class="fas fa-save"></i> 생산 등록</button></div>
        </form>
      </div>
    </div>
  </div>
</div>

<!-- ==================== TRACKING ==================== -->
<div id="pg-tracking" class="page">
  <div class="header">
    <div class="header-left">
      <h2><i class="fas fa-route" style="color:var(--c-primary);margin-right:6px"></i>폐기물 흐름 추적</h2>
      <p>Tracking ID로 배출 > 수거 > 압축 > 재활용 > 생산 전 과정 추적</p>
    </div>
  </div>
  <div class="content">
    <!-- Search -->
    <div class="card" style="margin-bottom:24px">
      <div class="search-bar">
        <div class="form-group"><label>트래킹 ID 또는 번호 검색</label><input id="srcId" placeholder="숫자 ID 입력 후 Enter" onkeydown="if(event.key==='Enter')srcTrack()"></div>
        <button class="btn btn-primary" onclick="srcTrack()" style="margin-bottom:0"><i class="fas fa-search"></i> 조회</button>
        <button class="btn btn-gray" onclick="loadList()" style="margin-bottom:0"><i class="fas fa-list"></i> 전체 목록</button>
      </div>
    </div>

    <!-- Detail -->
    <div id="trkDetail" style="display:none">
      <div class="card" style="margin-bottom:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:16px">
          <h3 style="font-size:17px;font-weight:700" id="td-no">-</h3>
          <span id="td-st"></span>
        </div>
        <div id="timeline" class="timeline-wrap"></div>
      </div>
      <div id="stCards" class="detail-grid"></div>
    </div>

    <!-- List -->
    <div class="card">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:4px"><i class="fas fa-list" style="color:var(--c-primary);margin-right:6px"></i>트래킹 목록</h3>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>ID</th><th>트래킹번호</th><th>종류</th><th>배출처</th><th>중량(kg)</th><th>단계</th><th>상태</th><th style="text-align:center">상세</th></tr></thead>
          <tbody id="trkBody"><tr><td colspan="8" style="text-align:center;color:var(--c-text3);padding:40px"><div class="loading"><div class="spinner"></div> 데이터를 불러오는 중...</div></td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>

</div><!-- layout -->

<script>
/* ===== CONSTANTS ===== */
const W={PAPER_WASTE:'폐지/파지',CARDBOARD:'골판지',MIXED_PAPER:'혼합 폐지',NEWSPAPER:'신문지',OTHER:'기타'};
const SL={DISCHARGE:'배출',COLLECTION:'수거',COMPRESSION:'압축',RECYCLING:'재활용',PRODUCTION:'생산'};
const SO={DISCHARGE:1,COLLECTION:2,COMPRESSION:3,RECYCLING:4,PRODUCTION:5};
const SI={DISCHARGE:'fa-truck-loading',COLLECTION:'fa-truck',COMPRESSION:'fa-compress-arrows-alt',RECYCLING:'fa-recycle',PRODUCTION:'fa-industry'};
const SC_MAP={INITIATED:{bg:'#dbeafe',c:'#1d4ed8',t:'시작됨'},IN_PROGRESS:{bg:'#fef3c7',c:'#92400e',t:'진행 중'},COMPLETED:{bg:'#d1fae5',c:'#065f46',t:'완료'},CANCELLED:{bg:'#fee2e2',c:'#991b1b',t:'취소'}};
const COLORS=['#10b981','#3b82f6','#f59e0b','#8b5cf6','#ef4444','#14b8a6','#f97316','#06b6d4'];
let ch1,ch2,ch3,ch4;

/* ===== HELPERS ===== */
function fmt(v){return v==null||v===''?'0':Number(v).toLocaleString('ko-KR',{maximumFractionDigits:1})}
function fj(form){const o={};new FormData(form).forEach((v,k)=>{if(v==='')return;if(['trackingId','baleCount','productionQty'].includes(k))o[k]=parseInt(v);else if(['weightKg','collectedWeightKg','inputWeightKg','outputWeightKg','distanceKm','compressionDensity'].includes(k))o[k]=parseFloat(v);else o[k]=v});return o}

function toast(msg,ok=true){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.style.background=ok?'linear-gradient(135deg,#059669,#10b981)':'linear-gradient(135deg,#dc2626,#ef4444)';
  t.style.display='block';
  setTimeout(()=>t.style.display='none',3500);
}

/* ===== NAVIGATION ===== */
document.querySelectorAll('.nav-item').forEach(el=>{
  el.addEventListener('click',()=>{
    const p=el.dataset.page;
    document.querySelectorAll('.page').forEach(pg=>pg.classList.remove('active'));
    document.getElementById('pg-'+p).classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    el.classList.add('active');
    if(p==='dashboard')loadDash();
    if(p==='tracking')loadList();
    // close mobile sidebar
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('overlay').classList.remove('open');
  });
});
document.getElementById('mobileToggle').addEventListener('click',()=>{
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('open');
});
document.getElementById('overlay').addEventListener('click',()=>{
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
});

/* ===== STEP TABS ===== */
document.querySelectorAll('.step-tab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    const n=tab.dataset.step;
    document.querySelectorAll('.form-panel').forEach(fp=>fp.classList.remove('show'));
    document.getElementById('fp'+n).classList.add('show');
    document.querySelectorAll('.step-tab').forEach(t=>t.classList.remove('on'));
    tab.classList.add('on');
  });
});

/* ===== DASHBOARD ===== */
document.addEventListener('DOMContentLoaded',()=>{
  const d=new Date(),p=new Date(d);p.setDate(d.getDate()-30);
  document.getElementById('sd').value=p.toISOString().slice(0,10);
  document.getElementById('ed').value=d.toISOString().slice(0,10);
  loadDash();
});

async function loadDash(){
  const s=document.getElementById('sd').value,e=document.getElementById('ed').value;
  try{
    const r=await(await fetch('/waste-api/dashboard?startDate='+s+'&endDate='+e)).json();
    if(r.success)renderDash(r.data);else toast(r.message,false);
  }catch(e){console.error(e);toast('대시보드 데이터 로딩 실패',false)}
}

function renderDash(d){
  document.getElementById('k-wt').textContent=fmt(d.totalWeightKg);
  document.getElementById('k-cnt').textContent=d.totalCount;
  document.getElementById('k-recycle').textContent=(d.avgRecyclingRate||0).toFixed(1);
  document.getElementById('k-loss').textContent=(d.avgLossRate||0).toFixed(1);
  document.getElementById('k-dist').textContent=fmt(d.totalDistanceKm);
  document.getElementById('k-co2').textContent=fmt(d.totalCo2SavingKg);

  const em=d.totalCo2EmissionKg||0,sv=d.totalCo2SavingKg||0;
  document.getElementById('co2e').textContent=fmt(em);
  document.getElementById('co2s').textContent=fmt(sv);
  document.getElementById('co2n').textContent=fmt(sv-em);

  // Collector table
  const cs=d.collectorStats||[];
  const cb=document.getElementById('collectorBody');
  if(cs.length){
    cb.innerHTML=cs.map(r=>'<tr><td style="font-weight:600">'+r.name+'</td><td>'+r.cnt+'건</td><td style="font-weight:600">'+fmt(r.wt)+'</td><td>'+fmt(r.dist)+'</td></tr>').join('');
  }else{
    cb.innerHTML='<tr><td colspan="4" style="text-align:center;color:var(--c-text3);padding:20px">데이터 없음</td></tr>';
  }

  // Charts
  if(ch1)ch1.destroy();if(ch2)ch2.destroy();if(ch3)ch3.destroy();if(ch4)ch4.destroy();

  const ds=d.dailyStats||[];
  ch1=new Chart(document.getElementById('chDaily'),{type:'bar',data:{
    labels:ds.map(x=>{const p=x.dt.split('-');return p[1]+'/'+p[2]}),
    datasets:[
      {label:'배출량(kg)',data:ds.map(x=>x.wt),backgroundColor:'rgba(16,185,129,.65)',borderColor:'#10b981',borderWidth:1,borderRadius:6,barPercentage:.6},
      {label:'건수',data:ds.map(x=>x.cnt),type:'line',borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,.08)',yAxisID:'y1',tension:.4,pointRadius:5,pointBackgroundColor:'#3b82f6',fill:true}
    ]
  },options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{font:{size:12}}}},scales:{y:{beginAtZero:true,title:{display:true,text:'kg',font:{size:11}},grid:{color:'rgba(0,0,0,.04)'}},y1:{beginAtZero:true,position:'right',grid:{drawOnChartArea:false},title:{display:true,text:'건수',font:{size:11}}},x:{grid:{display:false}}}}});

  const ss=d.stageStats||[];
  ch2=new Chart(document.getElementById('chStage'),{type:'doughnut',data:{
    labels:ss.map(x=>SL[x.stage]||x.stage),
    datasets:[{data:ss.map(x=>x.cnt),backgroundColor:COLORS.slice(0,ss.length),borderWidth:3,borderColor:'#fff',hoverOffset:8}]
  },options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{padding:16,font:{size:12}}}},cutout:'60%'}});

  const wt=d.wasteTypeStats||[];
  ch3=new Chart(document.getElementById('chType'),{type:'pie',data:{
    labels:wt.map(x=>W[x.tp]||x.tp),
    datasets:[{data:wt.map(x=>x.wt),backgroundColor:COLORS.slice(0,wt.length),borderWidth:3,borderColor:'#fff',hoverOffset:8}]
  },options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{padding:16,font:{size:12}}}}}});

  const ct=d.centerStats||[];
  ch4=new Chart(document.getElementById('chCenter'),{type:'bar',data:{
    labels:ct.map(x=>x.name),
    datasets:[{label:'처리량(kg)',data:ct.map(x=>x.wt),backgroundColor:COLORS.map(c=>c+'cc'),borderColor:COLORS,borderWidth:1,borderRadius:6,barPercentage:.7}]
  },options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,title:{display:true,text:'kg',font:{size:11}},grid:{color:'rgba(0,0,0,.04)'}},y:{grid:{display:false}}}}});
}

/* ===== FORM SUBMIT ===== */
const API={1:'/waste-api/tracking/discharge',2:'/waste-api/tracking/collection',3:'/waste-api/tracking/compression',4:'/waste-api/tracking/recycling',5:'/waste-api/tracking/production'};
[1,2,3,4,5].forEach(n=>{
  document.getElementById('f'+n).addEventListener('submit',async e=>{
    e.preventDefault();
    const btn=e.target.querySelector('button[type=submit]');
    const origText=btn.innerHTML;
    btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> 처리 중...';
    btn.disabled=true;
    try{
      const r=await(await fetch(API[n],{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fj(e.target))})).json();
      if(r.success){
        toast(r.message+(r.data?.trackingNo?' ('+r.data.trackingNo+')':''));
        e.target.reset();
      }else{
        toast(r.message,false);
      }
    }catch(x){
      toast('오류: '+x.message,false);
    }finally{
      btn.innerHTML=origText;
      btn.disabled=false;
    }
  });
});

/* ===== TRACKING LIST ===== */
async function loadList(){
  document.getElementById('trkDetail').style.display='none';
  const body=document.getElementById('trkBody');
  body.innerHTML='<tr><td colspan="8" style="text-align:center;padding:30px"><div class="loading"><div class="spinner"></div> 불러오는 중...</div></td></tr>';
  try{
    const r=await(await fetch('/waste-api/tracking?size=50')).json();
    if(r.success)renderTbl(r.data.content||[]);
  }catch(e){body.innerHTML='<tr><td colspan="8" style="text-align:center;color:var(--c-text3);padding:40px">데이터 로딩 실패</td></tr>'}
}

async function srcTrack(){
  const v=document.getElementById('srcId').value.trim();
  if(!v)return toast('트래킹 ID를 입력하세요',false);
  try{
    const r=await(await fetch('/waste-api/tracking/'+v)).json();
    if(r.success&&r.data)renderDetail(r.data);else toast('조회 결과가 없습니다',false);
  }catch(e){toast('조회 실패',false)}
}

function renderTbl(rows){
  const b=document.getElementById('trkBody');
  if(!rows.length){b.innerHTML='<tr><td colspan="8" style="text-align:center;color:var(--c-text3);padding:40px"><i class="fas fa-inbox" style="font-size:24px;display:block;margin-bottom:8px"></i>데이터가 없습니다</td></tr>';return}
  b.innerHTML=rows.map(r=>{
    const sc=SC_MAP[r.STATUS]||{bg:'#f3f4f6',c:'#374151',t:r.STATUS};
    const stageNum=SO[r.CURRENT_STAGE]||0;
    return '<tr onclick="viewId('+r.TRACKING_ID+')">'+
      '<td style="color:var(--c-text2)">'+r.TRACKING_ID+'</td>'+
      '<td><span class="mono">'+r.TRACKING_NO+'</span></td>'+
      '<td>'+(W[r.WASTE_TYPE]||r.WASTE_TYPE)+'</td>'+
      '<td>'+r.SOURCE_NAME+'</td>'+
      '<td style="font-weight:700">'+fmt(r.TOTAL_WEIGHT_KG)+'</td>'+
      '<td><span style="font-size:12px">'+(SL[r.CURRENT_STAGE]||r.CURRENT_STAGE)+' <span style="color:var(--c-text3)">('+stageNum+'/5)</span></span></td>'+
      '<td><span class="badge" style="background:'+sc.bg+';color:'+sc.c+'">'+sc.t+'</span></td>'+
      '<td style="text-align:center"><i class="fas fa-eye" style="color:var(--c-primary)"></i></td></tr>'
  }).join('');
}

async function viewId(id){
  document.getElementById('srcId').value=id;
  try{
    const r=await(await fetch('/waste-api/tracking/'+id)).json();
    if(r.success)renderDetail(r.data);
  }catch(e){}
}

function renderDetail(d){
  document.getElementById('trkDetail').style.display='block';
  const t=d.tracking;
  document.getElementById('td-no').textContent=t.TRACKING_NO+' (ID: '+t.TRACKING_ID+')';
  const sc=SC_MAP[t.STATUS]||{bg:'#f3f4f6',c:'#374151',t:t.STATUS};
  document.getElementById('td-st').innerHTML='<span class="badge" style="background:'+sc.bg+';color:'+sc.c+';font-size:13px;padding:5px 16px">'+sc.t+'</span>';

  // Timeline
  const ci=SO[t.CURRENT_STAGE]||1;
  let tl='';
  const stages=['DISCHARGE','COLLECTION','COMPRESSION','RECYCLING','PRODUCTION'];
  stages.forEach((s,i)=>{
    const cls=i<ci-1?'done':i===ci-1?'now':'wait';
    const lcls=i<ci-1?'done':'wait';
    tl+='<div class="tl-step"><div class="tl-dot '+cls+'"><i class="fas '+SI[s]+'"></i></div><div class="tl-label" style="color:'+(cls==='wait'?'var(--c-text3)':'var(--c-text)')+'">'+SL[s]+'</div></div>';
    if(i<4)tl+='<div class="tl-connector '+lcls+'"></div>';
  });
  document.getElementById('timeline').innerHTML=tl;

  // Stage detail cards
  let html='';
  if(d.discharge){const x=d.discharge;html+=makeCard('배출','fa-truck-loading','#10b981',[['배출처',x.CENTER_NAME],['배출일',x.DISCHARGE_DATE],['중량',fmt(x.WEIGHT_KG)+' kg'],['종류',W[x.WASTE_TYPE]||x.WASTE_TYPE],['담당자',x.DISCHARGE_MANAGER||'-']])}
  if(d.collection){const x=d.collection;html+=makeCard('수거/운송','fa-truck','#3b82f6',[['업체',x.COLLECTOR_NAME],['차량',x.VEHICLE_NO||'-'],['중량',fmt(x.COLLECTED_WEIGHT_KG)+' kg'],['거리',x.DISTANCE_KM?fmt(x.DISTANCE_KM)+' km':'-'],['CO2 배출',x.CO2_EMISSION_KG?fmt(x.CO2_EMISSION_KG)+' kg':'-']])}
  if(d.compression){const x=d.compression;html+=makeCard('압축(KNT)','fa-compress-arrows-alt','#f59e0b',[['업체',x.PROCESSOR_NAME],['입고',fmt(x.INPUT_WEIGHT_KG)+' kg'],['출고',x.OUTPUT_WEIGHT_KG?fmt(x.OUTPUT_WEIGHT_KG)+' kg':'-'],['Loss',x.LOSS_WEIGHT_KG?fmt(x.LOSS_WEIGHT_KG)+' kg ('+x.LOSS_RATE+'%)':'-'],['베일',x.BALE_COUNT||'-']])}
  if(d.recycling){const x=d.recycling;html+=makeCard('재활용','fa-recycle','#8b5cf6',[['업체',x.RECYCLER_NAME],['입고',fmt(x.INPUT_WEIGHT_KG)+' kg'],['산출',x.OUTPUT_WEIGHT_KG?fmt(x.OUTPUT_WEIGHT_KG)+' kg':'-'],['재활용률',x.RECYCLING_RATE?x.RECYCLING_RATE+'%':'-'],['CO2 절감',x.CO2_SAVING_KG?fmt(x.CO2_SAVING_KG)+' kg':'-'],['방법',x.RECYCLING_METHOD||'-']])}
  if(d.production){const x=d.production;html+=makeCard('제품생산','fa-industry','#ef4444',[['업체',x.PRODUCER_NAME],['제품',x.PRODUCT_NAME],['투입',fmt(x.INPUT_WEIGHT_KG)+' kg'],['생산',x.OUTPUT_WEIGHT_KG?fmt(x.OUTPUT_WEIGHT_KG)+' kg':'-'],['수량',x.PRODUCTION_QTY||'-'],['납품처',x.DELIVERY_DESTINATION||'-']])}
  document.getElementById('stCards').innerHTML=html;

  // Scroll to detail
  document.getElementById('trkDetail').scrollIntoView({behavior:'smooth',block:'start'});
}

function makeCard(title,icon,color,items){
  let h='<div class="detail-card" style="border-top-color:'+color+'"><h4><i class="fas '+icon+'" style="color:'+color+'"></i>'+title+'</h4>';
  items.forEach(([l,v])=>{h+='<div class="detail-row"><span class="dl">'+l+'</span><span class="dv">'+v+'</span></div>'});
  return h+'</div>';
}
</script>
</body>
</html>`
}

export default app
