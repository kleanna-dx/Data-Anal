-- ESG/GHG Protocol 기반 CO2 Scope 분류 지원을 위한 스키마 변경
-- Scope 1: 직접 배출 (수거차량 이동연소) — MOD_WASTE_COLLECTION.CO2_EMISSION_KG 기존 사용
-- Scope 2: 간접 배출 (구매 전력) — MOD_WASTE_COMPRESSION에 CO2_EMISSION_KG 추가
-- Scope 3: 기타 간접 배출 (재활용 회피 배출) — MOD_WASTE_RECYCLING.CO2_SAVING_KG 기존 사용

-- 압축 처리 테이블에 Scope 2 전력 CO2 배출량 컬럼 추가
ALTER TABLE MOD_WASTE_COMPRESSION ADD COLUMN CO2_EMISSION_KG REAL;

-- 재활용 테이블에 폐기물 종류 컬럼 추가 (종류별 Scope 3 회피계수 적용)
ALTER TABLE MOD_WASTE_RECYCLING ADD COLUMN WASTE_TYPE TEXT;
