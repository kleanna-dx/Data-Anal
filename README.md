# WMS - Waste Management System

## Project Overview
- **Name**: WMS (폐기물 관리 시스템)
- **Goal**: 폐기물의 발생(배출)부터 제품 생산까지 전 과정을 단일 Tracking ID로 추적하는 웹 기반 시스템
- **Tech Stack**: Hono + TypeScript + Cloudflare D1 (SQLite) + Chart.js + FontAwesome
- **Architecture**: SPA (Single Page Application) - 서버사이드 렌더링 HTML

## 5단계 프로세스
| 단계 | 명칭 | 테이블 | 핵심 데이터 |
|------|------|--------|------------|
| 1 | 배출 | MOD_WASTE_DISCHARGE | 배출처, 중량, 폐기물 종류 |
| 2 | 수거/운송 | MOD_WASTE_COLLECTION | 수거업체, 차량, 거리, CO2 배출 |
| 3 | 압축(KNT) | MOD_WASTE_COMPRESSION | 입/출고 중량, Loss율, 베일 수 |
| 4 | 재활용 | MOD_WASTE_RECYCLING | 재활용률, CO2 절감, 방법 |
| 5 | 생산 | MOD_WASTE_PRODUCTION | 제품명, 수량, 납품처 |

마스터 테이블: **MOD_WASTE_TRACKING** (단일 Tracking ID로 전 단계 연결)

## 현재 완성된 기능

### 대시보드
- 6개 KPI 카드 (총 배출량, 트래킹 건수, 재활용률, Loss율, 이동거리, CO2 절감)
- 일별 배출 추이 (Bar + Line 복합 차트)
- 처리 단계별 현황 (도넛 차트)
- 폐기물 종류별 비중 (파이 차트)
- 배출처별 처리량 (가로 Bar 차트)
- 탄소 배출/절감 요약 (운송 CO2 vs 재활용 CO2 vs 순 절감)
- 수거 업체별 통계 테이블
- 날짜 범위 필터링

### 데이터 입력
- 5단계 탭 UI (배출 > 수거 > 압축 > 재활용 > 생산)
- 각 단계별 전용 입력 폼 (필수/선택 필드 구분)
- 서밋 시 로딩 스피너 + 토스트 알림
- 단계 순서 검증 (1단계부터 순서대로만 진행 가능)

### 추적 조회
- 트래킹 ID 검색
- 전체 트래킹 목록 테이블
- 5단계 타임라인 시각화 (done/now/wait 상태)
- 단계별 상세 카드 (배출/수거/압축/재활용/생산 정보)

## API 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| GET | `/waste-api/dashboard` | 대시보드 통합 데이터 (startDate, endDate 파라미터) |
| GET | `/waste-api/tracking` | 트래킹 목록 (page, size 파라미터) |
| GET | `/waste-api/tracking/:id` | 트래킹 상세 (5단계 전체 데이터) |
| POST | `/waste-api/tracking/discharge` | 1단계 배출 등록 |
| POST | `/waste-api/tracking/collection` | 2단계 수거/운송 등록 |
| POST | `/waste-api/tracking/compression` | 3단계 압축 등록 |
| POST | `/waste-api/tracking/recycling` | 4단계 재활용 등록 |
| POST | `/waste-api/tracking/production` | 5단계 생산 등록 |

## 계산 로직
- **CO2 배출** = 이동거리(km) x 0.21 kg/km (중형 트럭 기준)
- **CO2 절감** = 재활용 산출량(kg) x 2.3 kg/kg (종이 기준)
- **Loss율** = (입고중량 - 출고중량) / 입고중량 x 100
- **재활용률** = 산출중량 / 입고중량 x 100

## 샘플 데이터
- 6건의 트래킹 데이터 (2건 완료, 3건 진행 중, 1건 시작)
- 6개 배출처 (서울/부산/대구/대전/인천/광주 물류센터)
- 3개 수거업체 ((주)그린수거, (주)클린운송, (주)에코수거)

## 로컬 개발
```bash
npm install
npm run build
npx wrangler d1 migrations apply waste-management --local
npx wrangler d1 execute waste-management --local --file=./seed.sql
npx wrangler pages dev dist --d1=waste-management --local --ip 0.0.0.0 --port 3000
```

## 프로젝트 구조
```
webapp/
├── src/index.tsx          # Hono 앱 (API + SPA HTML)
├── migrations/
│   └── 0001_create_tables.sql  # DDL (6개 테이블)
├── seed.sql               # 샘플 데이터 (6건)
├── ecosystem.config.cjs   # PM2 설정
├── wrangler.jsonc          # Cloudflare 설정
├── vite.config.ts          # Vite 빌드 설정
├── package.json
└── tsconfig.json
```

## Spring Boot module-waste 연동
이 웹앱은 기존 Spring Boot `company-platform` 프로젝트의 `module-waste` 모듈을 웹 서비스로 구현한 것입니다:
- 패키지 네임스페이스: `com.company.module.waste`
- API prefix: `/waste-api/**`
- DB 테이블 prefix: `MOD_WASTE_`
- 동일한 5단계 프로세스 및 데이터 모델 유지

## Deployment
- **Platform**: Cloudflare Pages
- **Database**: Cloudflare D1 (SQLite)
- **Last Updated**: 2026-04-08
