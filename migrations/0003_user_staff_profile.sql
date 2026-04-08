-- ============================================
-- 사용자 담당자 프로필 컬럼 추가
-- ============================================

-- 담당자 유형: ADMIN(관리자), CENTER(배출 담당), COLLECTOR(수거 기사), PROCESSOR(압축 처리), RECYCLER(재활용 처리), PRODUCER(생산 담당)
ALTER TABLE MOD_WASTE_USER ADD COLUMN STAFF_TYPE TEXT DEFAULT 'ADMIN';

-- 소속 업체/센터 코드 (예: CTR-001, COL-001, KNT-001 등)
ALTER TABLE MOD_WASTE_USER ADD COLUMN COMPANY_CODE TEXT;

-- 소속 업체/센터 명칭 (자동조회용 캐시)
ALTER TABLE MOD_WASTE_USER ADD COLUMN COMPANY_NAME TEXT;

-- 차량 번호 (수거 기사용)
ALTER TABLE MOD_WASTE_USER ADD COLUMN VEHICLE_NO TEXT;

-- 담당자 메모
ALTER TABLE MOD_WASTE_USER ADD COLUMN STAFF_REMARKS TEXT;
