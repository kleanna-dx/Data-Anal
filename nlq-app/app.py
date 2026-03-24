"""
Natural Language Query (NLQ) Application - Enhanced with Learning
자연어 질의 → ChatGPT API → SQL 생성 → MariaDB 조회 → 표/그래프 표시

학습 강화 전략:
1. Few-shot Learning: 질문-SQL 쌍 예시를 프롬프트에 포함
2. Data Dictionary: 실제 DB 코드값 ↔ 한글 매핑 사전 (JSON 외부화)
3. User Feedback Learning: 사용자 수정 SQL을 저장 → 프롬프트에 자동 반영
"""
import os
import json
import re
import time
import yaml
import pymysql
import decimal
import uuid
from pathlib import Path
from flask import Flask, request, jsonify, render_template, send_file
from flask_cors import CORS
from openai import OpenAI
from werkzeug.utils import secure_filename

# ─── Config ───────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB limit

# 업로드 파일 저장 경로
UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
ALLOWED_EXTENSIONS = {'xlsx', 'xls', 'csv', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'pdf'}

BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://www.genspark.ai/api/llm_proxy/v1")
MODEL_NAME = "gpt-5-mini"

# 데이터 저장 경로
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
FEEDBACK_FILE = DATA_DIR / "feedback_examples.json"
DICTIONARY_FILE = DATA_DIR / "data_dictionary.json"
EXAMPLES_FILE = DATA_DIR / "few_shot_examples.json"


def _resolve_api_key():
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key:
        config_path = os.path.expanduser("~/.genspark_llm.yaml")
        if os.path.exists(config_path):
            with open(config_path) as f:
                cfg = yaml.safe_load(f)
            key = cfg.get("openai", {}).get("api_key", "")
            if key.startswith("${") and key.endswith("}"):
                key = os.environ.get(key[2:-1], "")
    return key


def get_openai_client():
    return OpenAI(api_key=_resolve_api_key(), base_url=BASE_URL)


DB_CONFIG = {
    "host": "localhost",
    "port": 3306,
    "user": "company",
    "password": "company1234!",
    "database": "company_board",
    "charset": "utf8mb4",
    "cursorclass": pymysql.cursors.DictCursor,
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Data Dictionary 로딩/저장 (JSON 외부화)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def load_dictionary() -> dict:
    """data_dictionary.json에서 Data Dictionary 로딩"""
    if DICTIONARY_FILE.exists():
        try:
            with open(DICTIONARY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {"columns": {}, "amount_columns": {}, "business_rules": []}


def save_dictionary(data: dict):
    """Data Dictionary를 JSON 파일에 저장"""
    with open(DICTIONARY_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 동적 System Prompt 빌드 (JSON에서 Dictionary 읽어서 구성)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SYSTEM_PROMPT_HEADER = """You are a MariaDB SQL expert for a Korean manufacturing company's profitability analysis system.
Your ONLY job: convert Korean natural language questions into a single valid MariaDB SELECT statement.

═══════════════════════════════════════════
DATABASE / TABLE
═══════════════════════════════════════════
DATABASE: company_board
TABLE: MOD_BOARD_PROFIT_ANALYSIS
Total rows: 226,811 (2024년 5월 한 달 데이터, CALMONTH = '202405', CALDAY: 20240501~20240531)

═══════════════════════════════════════════
COLUMN DEFINITION (100 columns)
═══════════════════════════════════════════
-- 기간/조직
SEQ          BIGINT PK AUTO_INCREMENT  -- 일련번호
CALMONTH     VARCHAR(10)   -- 달력연도/월 (값: '202405')
CALDAY       VARCHAR(10)   -- 달력일 (값: '20240501'~'20240531')
CO_AREA      VARCHAR(10)   -- 관리회계 영역 (값: 'A100')
PROFIT_CTR   VARCHAR(20)   -- 손익 센터
DIVISION     VARCHAR(5)    -- 제품군/사업부
PLANT        VARCHAR(10)   -- 플랜트/공장
DISTR_CHAN   VARCHAR(5)    -- 유통 경로
ZDISTCHAN    VARCHAR(5)    -- 내수/수출구분
ZORG_TEAM    VARCHAR(10)   -- 영업팀
SALES_OFF    VARCHAR(10)   -- 사업장

-- 자재/제품
MATL_TYPE    VARCHAR(10)   -- 자재유형
MATL_GROUP   VARCHAR(10)   -- 자재 그룹
PRODH1       VARCHAR(10)   -- 제품계층 레벨1
PRODH2       VARCHAR(10)   -- 제품계층 레벨2
PRODH3       VARCHAR(15)   -- 제품계층 레벨3
PRODH4       VARCHAR(20)   -- 제품계층 레벨4
ZJPCODE      VARCHAR(10)   -- 지종/제품구분
ZBRAND1      VARCHAR(10)   -- 브랜드1
ZBRAND2      VARCHAR(10)   -- 브랜드2

-- 거래 조건
BILL_TYPE    VARCHAR(10)   -- 대금청구유형
INCOTERMS    VARCHAR(5)    -- 인도 조건
CUST_GROUP   VARCHAR(5)    -- 고객 그룹
CUST_GRP1    VARCHAR(5)    -- 고객 그룹 1
COUNTRY      VARCHAR(5)    -- 국가
ZKUNN2       VARCHAR(20)   -- 영업사원
CUSTOMER     VARCHAR(20)   -- 고객 코드

-- 자재 상세
MATERIAL      VARCHAR(30)   -- 자재 코드 (제품코드)
MATERIAL_DESC VARCHAR(100)  -- 자재명 (한글 제품명)

-- 수량 단위
ZUNITBOX     VARCHAR(5)    -- 수량단위(BOX)
ZUNITBAG     VARCHAR(5)    -- 수량단위(BAG)
ZUNITKGEA    VARCHAR(5)    -- 수량단위(KG/EA)
CURRENCY     VARCHAR(5)    -- 통화 ('KRW')

-- 수량 (3개)
ZQTYBOX      DECIMAL(18,3) -- 수량(BOX)
ZQTYBAG      BIGINT        -- 수량(BAG)
ZQTYKGEA     DECIMAL(18,3) -- 수량(KG/EA) - 주요 판매수량
"""


def build_amount_columns_section(dictionary: dict) -> str:
    """금액 컬럼 섹션을 Dictionary에서 동적으로 구성"""
    amt_cols = dictionary.get("amount_columns", {})
    if not amt_cols:
        return ""
    lines = ["\n-- 금액 (64개, 모두 BIGINT, 단위: 원)"]
    # 4개씩 한 줄에
    items = list(amt_cols.items())
    for i in range(0, len(items), 3):
        chunk = items[i:i+3]
        parts = [f"{code}  {label}" for code, label in chunk]
        lines.append("  ".join(parts))
    return "\n".join(lines)


def build_dictionary_section(dictionary: dict) -> str:
    """DATA DICTIONARY 섹션을 JSON에서 동적으로 구성"""
    columns = dictionary.get("columns", {})
    if not columns:
        return ""
    lines = [
        "\n═══════════════════════════════════════════",
        "DATA DICTIONARY (실제 코드값 ↔ 의미)",
        "═══════════════════════════════════════════"
    ]
    for col_name, col_info in columns.items():
        values = col_info.get("values", {})
        if not values:
            lines.append(f"{col_name}: (값 없음)")
            continue
        parts = []
        for code, val_info in values.items():
            label = val_info.get("label", code)
            count = val_info.get("count", 0)
            if count:
                parts.append(f"'{code}'={label}({count:,}건)")
            else:
                parts.append(f"'{code}'={label}")
        lines.append(f"{col_name}: {', '.join(parts)}")
    return "\n".join(lines)


def build_rules_section(dictionary: dict) -> str:
    """BUSINESS RULES 섹션을 JSON에서 동적으로 구성"""
    rules = dictionary.get("business_rules", [])
    if not rules:
        return ""
    lines = [
        "\n═══════════════════════════════════════════",
        "BUSINESS RULES (SQL 생성 규칙)",
        "═══════════════════════════════════════════"
    ]
    for i, rule in enumerate(rules, 1):
        lines.append(f"{i}. {rule}")
    return "\n".join(lines)


def build_system_prompt() -> str:
    """Dictionary JSON에서 동적으로 전체 System Prompt 빌드"""
    dictionary = load_dictionary()
    parts = [
        SYSTEM_PROMPT_HEADER,
        build_amount_columns_section(dictionary),
        build_dictionary_section(dictionary),
        build_rules_section(dictionary),
    ]
    return "\n".join(parts)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Few-shot Examples (내장 + 외부 파일)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DEFAULT_EXAMPLES = [
    {
        "question": "손익센터별 총매출 합계",
        "sql": """SELECT
  CASE WHEN PROFIT_CTR = '0000001000' THEN '제지사업부'
       WHEN PROFIT_CTR = '0000002000' THEN '생활용품사업부'
       ELSE PROFIT_CTR END AS 사업부,
  SUM(ZAMT001) AS 총매출
FROM MOD_BOARD_PROFIT_ANALYSIS
GROUP BY PROFIT_CTR
ORDER BY 총매출 DESC"""
    },
    {
        "question": "플랜트별 매출 상위 5개",
        "sql": """SELECT
  PLANT AS 플랜트,
  SUM(ZAMT001) AS 총매출,
  SUM(ZAMT034) AS 매출원가,
  SUM(ZAMT035) AS 매출총이익
FROM MOD_BOARD_PROFIT_ANALYSIS
WHERE PLANT IS NOT NULL
GROUP BY PLANT
ORDER BY 총매출 DESC
LIMIT 5"""
    },
    {
        "question": "내수 vs 수출 매출 비교",
        "sql": """SELECT
  CASE WHEN ZDISTCHAN = '10' THEN '내수'
       WHEN ZDISTCHAN = '20' THEN '수출'
       ELSE '기타' END AS 구분,
  SUM(ZAMT001) AS 총매출,
  SUM(ZAMT003) AS 순매출,
  SUM(ZQTYKGEA) AS 판매수량_KG
FROM MOD_BOARD_PROFIT_ANALYSIS
WHERE ZDISTCHAN IS NOT NULL
GROUP BY ZDISTCHAN
ORDER BY 총매출 DESC"""
    },
    {
        "question": "일별 총매출 추이",
        "sql": """SELECT
  CALDAY AS 일자,
  SUM(ZAMT001) AS 총매출,
  SUM(ZAMT003) AS 순매출
FROM MOD_BOARD_PROFIT_ANALYSIS
GROUP BY CALDAY
ORDER BY CALDAY ASC"""
    },
    {
        "question": "제품별 매출 TOP 10",
        "sql": """SELECT
  MATERIAL AS 자재코드,
  MATERIAL_DESC AS 제품명,
  SUM(ZAMT001) AS 총매출,
  SUM(ZQTYKGEA) AS 판매수량
FROM MOD_BOARD_PROFIT_ANALYSIS
WHERE MATERIAL IS NOT NULL
GROUP BY MATERIAL, MATERIAL_DESC
ORDER BY 총매출 DESC
LIMIT 10"""
    },
    {
        "question": "브랜드별 판매수량 합계",
        "sql": """SELECT
  ZBRAND1 AS 브랜드코드,
  SUM(ZQTYKGEA) AS 판매수량_KG,
  SUM(ZQTYBOX) AS 판매수량_BOX,
  SUM(ZAMT001) AS 총매출
FROM MOD_BOARD_PROFIT_ANALYSIS
WHERE ZBRAND1 IS NOT NULL AND ZBRAND1 != ''
GROUP BY ZBRAND1
ORDER BY 총매출 DESC"""
    },
    {
        "question": "고객그룹별 매출총이익",
        "sql": """SELECT
  CUST_GROUP AS 고객그룹,
  SUM(ZAMT001) AS 총매출,
  SUM(ZAMT034) AS 매출원가,
  SUM(ZAMT035) AS 매출총이익
FROM MOD_BOARD_PROFIT_ANALYSIS
GROUP BY CUST_GROUP
ORDER BY 매출총이익 DESC"""
    },
    {
        "question": "영업팀별 영업이익 순위",
        "sql": """SELECT
  ZORG_TEAM AS 영업팀,
  SUM(ZAMT001) AS 총매출,
  SUM(ZAMT055) AS 영업이익,
  SUM(ZAMT036) AS 판매관리비
FROM MOD_BOARD_PROFIT_ANALYSIS
WHERE ZORG_TEAM IS NOT NULL AND ZORG_TEAM != ''
GROUP BY ZORG_TEAM
ORDER BY 영업이익 DESC"""
    },
    {
        "question": "국가별 수출 매출",
        "sql": """SELECT
  COUNTRY AS 국가코드,
  SUM(ZAMT001) AS 총매출,
  SUM(ZQTYKGEA) AS 판매수량_KG
FROM MOD_BOARD_PROFIT_ANALYSIS
WHERE ZDISTCHAN = '20' AND COUNTRY IS NOT NULL
GROUP BY COUNTRY
ORDER BY 총매출 DESC"""
    },
    {
        "question": "물티슈 제품 매출 현황",
        "sql": """SELECT
  MATERIAL AS 자재코드,
  MATERIAL_DESC AS 제품명,
  SUM(ZAMT001) AS 총매출,
  SUM(ZQTYKGEA) AS 판매수량
FROM MOD_BOARD_PROFIT_ANALYSIS
WHERE MATERIAL_DESC LIKE '%물티슈%'
GROUP BY MATERIAL, MATERIAL_DESC
ORDER BY 총매출 DESC
LIMIT 20"""
    },
    {
        "question": "사업부별 원가 구성 분석",
        "sql": """SELECT
  CASE WHEN PROFIT_CTR = '0000001000' THEN '제지사업부'
       WHEN PROFIT_CTR = '0000002000' THEN '생활용품사업부'
       ELSE PROFIT_CTR END AS 사업부,
  SUM(ZAMT006) AS 재료비_펄프,
  SUM(ZAMT007) AS 재료비_고지,
  SUM(ZAMT008) AS 재료비_패드,
  SUM(ZAMT012) AS 인건비,
  SUM(ZAMT016) AS 에너지비,
  SUM(ZAMT018) AS 감가상각비,
  SUM(ZAMT034) AS 매출원가계
FROM MOD_BOARD_PROFIT_ANALYSIS
GROUP BY PROFIT_CTR
ORDER BY 매출원가계 DESC"""
    },
    {
        "question": "자재유형별 매출 비교",
        "sql": """SELECT
  CASE WHEN MATL_TYPE = 'FERT' THEN '완제품'
       WHEN MATL_TYPE = 'HAWA' THEN '상품'
       WHEN MATL_TYPE = 'HALB' THEN '반제품'
       ELSE COALESCE(MATL_TYPE, '미분류') END AS 자재유형,
  SUM(ZAMT001) AS 총매출,
  SUM(ZAMT034) AS 매출원가,
  COUNT(*) AS 건수
FROM MOD_BOARD_PROFIT_ANALYSIS
GROUP BY MATL_TYPE
ORDER BY 총매출 DESC"""
    },
]


def load_few_shot_examples() -> list:
    """Few-shot 예시 로딩 (외부 파일 우선, 없으면 기본값)"""
    if EXAMPLES_FILE.exists():
        try:
            with open(EXAMPLES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list) and len(data) > 0:
                return data
        except (json.JSONDecodeError, IOError):
            pass
    return DEFAULT_EXAMPLES


def save_few_shot_examples(examples: list):
    """Few-shot 예시를 JSON 파일에 저장"""
    with open(EXAMPLES_FILE, "w", encoding="utf-8") as f:
        json.dump(examples, f, ensure_ascii=False, indent=2)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# User Feedback Learning
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def load_feedback_examples() -> list:
    """저장된 사용자 피드백(수정된 SQL) 불러오기"""
    if FEEDBACK_FILE.exists():
        try:
            with open(FEEDBACK_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (json.JSONDecodeError, IOError):
            return []
    return []


def save_feedback_example(question: str, original_sql: str, corrected_sql: str):
    """사용자가 수정한 SQL을 피드백으로 저장"""
    examples = load_feedback_examples()
    examples = [e for e in examples if e.get("question") != question]
    examples.append({
        "question": question,
        "original_sql": original_sql,
        "corrected_sql": corrected_sql,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    if len(examples) > 50:
        examples = examples[-50:]
    with open(FEEDBACK_FILE, "w", encoding="utf-8") as f:
        json.dump(examples, f, ensure_ascii=False, indent=2)


def build_few_shot_messages(question: str) -> list:
    """Few-shot 예시를 ChatGPT messages 형식으로 구성"""
    system_prompt = build_system_prompt()
    messages = [{"role": "system", "content": system_prompt}]

    # ① 사용자 피드백 예시 (최근 5개)
    feedback = load_feedback_examples()
    if feedback:
        messages.append({
            "role": "system",
            "content": "아래는 사용자가 직접 수정/확인한 검증된 SQL 예시입니다. 이 패턴을 최우선으로 참고하세요:"
        })
        for ex in feedback[-5:]:
            messages.append({"role": "user", "content": ex["question"]})
            messages.append({"role": "assistant", "content": ex["corrected_sql"]})

    # ② Few-shot 예시 (유사도 높은 것 우선, 최대 5개)
    all_examples = load_few_shot_examples()
    scored = []
    q_lower = question.lower()
    for ex in all_examples:
        score = sum(1 for char in ex["question"] if char in q_lower)
        scored.append((score, ex))
    scored.sort(key=lambda x: -x[0])

    for _, ex in scored[:5]:
        messages.append({"role": "user", "content": ex["question"]})
        messages.append({"role": "assistant", "content": ex["sql"]})

    messages.append({"role": "user", "content": question})
    return messages


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Fallback (API 불가 시 로컬 SQL 생성)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COLUMN_MAP = {
    "총매출": "ZAMT001", "판매장려금": "ZAMT002", "순매출": "ZAMT003",
    "기타매출": "ZAMT004", "매출원가": "ZAMT034", "매출총이익": "ZAMT035",
    "판매관리비": "ZAMT036", "영업이익": "ZAMT055", "경상이익": "ZAMT064",
    "매출": "ZAMT001", "이익": "ZAMT035", "원가": "ZAMT034",
    "마케팅비": "ZAMT047", "광고비": "ZAMT048", "인건비": "ZAMT012",
    "에너지비": "ZAMT016", "감가상각비": "ZAMT018",
    "영업외수익": "ZAMT056", "영업외비용": "ZAMT060",
    "판매수량": "ZQTYKGEA", "수량": "ZQTYKGEA",
    "재료비": "ZAMT006", "펄프": "ZAMT006", "고지": "ZAMT007",
}

GROUP_MAP = {
    "손익센터": ("PROFIT_CTR", "CASE WHEN PROFIT_CTR='0000001000' THEN '제지사업부' WHEN PROFIT_CTR='0000002000' THEN '생활용품사업부' ELSE PROFIT_CTR END"),
    "사업부": ("PROFIT_CTR", "CASE WHEN PROFIT_CTR='0000001000' THEN '제지사업부' WHEN PROFIT_CTR='0000002000' THEN '생활용품사업부' ELSE PROFIT_CTR END"),
    "플랜트": ("PLANT", "PLANT"), "공장": ("PLANT", "PLANT"),
    "유통경로": ("DISTR_CHAN", "DISTR_CHAN"),
    "내수": ("ZDISTCHAN", "CASE WHEN ZDISTCHAN='10' THEN '내수' WHEN ZDISTCHAN='20' THEN '수출' ELSE '기타' END"),
    "수출": ("ZDISTCHAN", "CASE WHEN ZDISTCHAN='10' THEN '내수' WHEN ZDISTCHAN='20' THEN '수출' ELSE '기타' END"),
    "영업팀": ("ZORG_TEAM", "ZORG_TEAM"), "사업장": ("SALES_OFF", "SALES_OFF"),
    "자재유형": ("MATL_TYPE", "CASE WHEN MATL_TYPE='FERT' THEN '완제품' WHEN MATL_TYPE='HAWA' THEN '상품' WHEN MATL_TYPE='HALB' THEN '반제품' ELSE MATL_TYPE END"),
    "브랜드": ("ZBRAND1", "ZBRAND1"), "제품": ("MATERIAL", "MATERIAL"),
    "제품명": ("MATERIAL_DESC", "MATERIAL_DESC"),
    "고객그룹": ("CUST_GROUP", "CUST_GROUP"), "고객": ("CUSTOMER", "CUSTOMER"),
    "국가": ("COUNTRY", "COUNTRY"), "영업사원": ("ZKUNN2", "ZKUNN2"),
    "일별": ("CALDAY", "CALDAY"), "일자별": ("CALDAY", "CALDAY"),
    "날짜별": ("CALDAY", "CALDAY"), "월별": ("CALMONTH", "CALMONTH"),
    "지종": ("ZJPCODE", "ZJPCODE"), "제품군": ("DIVISION", "DIVISION"),
    "제품계층": ("PRODH1", "PRODH1"),
}


def _local_generate_sql(question: str) -> str:
    q = question.lower().replace(" ", "")
    agg_col, agg_alias = "ZAMT001", "총매출"
    for ko, col in COLUMN_MAP.items():
        if ko in q:
            agg_col, agg_alias = col, ko
            break
    group_raw = group_expr = group_alias = None
    for ko, (raw, expr) in GROUP_MAP.items():
        if ko in q:
            group_raw, group_expr, group_alias = raw, expr, ko
            break
    limit = 1000
    m = re.search(r'(?:top|상위|하위)\s*(\d+)', q)
    if m: limit = int(m.group(1))
    order = "ASC" if any(w in q for w in ("하위", "최소", "최저")) else "DESC"
    if group_raw:
        return (f"SELECT {group_expr} AS `{group_alias}`, SUM({agg_col}) AS `{agg_alias}` "
                f"FROM MOD_BOARD_PROFIT_ANALYSIS GROUP BY {group_raw} "
                f"ORDER BY `{agg_alias}` {order} LIMIT {limit}")
    return f"SELECT SUM({agg_col}) AS `{agg_alias}` FROM MOD_BOARD_PROFIT_ANALYSIS"


def _local_suggest_chart(columns, row_count, question):
    num_cols = [c for c in columns if any(k in c for k in
        ["매출","이익","비용","수량","원가","금액","SUM","AVG","COUNT","판매","마케팅","인건"])]
    lbl = columns[0] if columns else ""
    dc = num_cols if num_cols else (columns[1:2] if len(columns) > 1 else [])
    if "추이" in question or "일별" in question or "월별" in question:
        return {"chart_type": "line", "label_column": lbl, "data_columns": dc, "title": question}
    elif row_count <= 2:
        return {"chart_type": "pie" if dc else "table_only", "label_column": lbl, "data_columns": dc[:1], "title": question}
    elif row_count <= 8:
        return {"chart_type": "bar", "label_column": lbl, "data_columns": dc, "title": question}
    elif row_count <= 15:
        return {"chart_type": "horizontalBar", "label_column": lbl, "data_columns": dc, "title": question}
    return {"chart_type": "table_only", "label_column": lbl, "data_columns": dc, "title": question}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Core Functions
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CHART_PROMPT_TPL = """Given: question="{question}", columns={columns}, rows={row_count}.
Return JSON only: {{"chart_type":"bar"|"line"|"pie"|"doughnut"|"horizontalBar"|"table_only","label_column":"<col>","data_columns":["<col>"],"title":"<Korean>"}}
Rules: 2-10 categories→bar/pie, time-series→line, many items→horizontalBar, >20 rows→table_only."""


def get_db_connection():
    return pymysql.connect(**DB_CONFIG)


def natural_language_to_sql(question: str) -> tuple:
    """Few-shot 프롬프트로 자연어→SQL. 실패 시 fallback. Returns (sql, used_gpt)."""
    try:
        client = get_openai_client()
        messages = build_few_shot_messages(question)
        response = client.chat.completions.create(
            model=MODEL_NAME, messages=messages,
            temperature=0, max_tokens=16384,
        )
        sql = response.choices[0].message.content.strip()
        if sql.startswith("```"):
            sql = "\n".join(sql.split("\n")[1:]) if "\n" in sql else sql[3:]
        if sql.endswith("```"):
            sql = sql[:-3]
        sql = sql.strip().rstrip(";")
        return sql, True
    except Exception as e:
        print(f"[NLQ] GPT failed, fallback: {e}")
        return _local_generate_sql(question), False


def execute_query(sql: str):
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall()
            cols = [d[0] for d in cur.description] if cur.description else []
            clean = []
            for row in rows:
                r = {}
                for k, v in row.items():
                    if isinstance(v, decimal.Decimal):
                        r[k] = float(v)
                    elif isinstance(v, bytes):
                        r[k] = v.decode("utf-8", errors="replace")
                    else:
                        r[k] = v
                clean.append(r)
            return cols, clean
    finally:
        conn.close()


def suggest_chart_type(question, columns, row_count, use_gpt=True):
    if not use_gpt:
        return _local_suggest_chart(columns, row_count, question)
    try:
        client = get_openai_client()
        resp = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role": "user", "content": CHART_PROMPT_TPL.format(
                question=question, columns=columns, row_count=row_count)}],
            temperature=0, max_tokens=4096,
        )
        txt = resp.choices[0].message.content.strip()
        if txt.startswith("```"): txt = "\n".join(txt.split("\n")[1:])
        if txt.endswith("```"): txt = txt[:-3]
        return json.loads(txt.strip())
    except Exception:
        return _local_suggest_chart(columns, row_count, question)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Routes - 기존 화면/API
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/admin")
def admin():
    return render_template("admin.html")


@app.route("/api/query", methods=["POST"])
def query():
    data = request.get_json()
    question = data.get("question", "").strip()
    if not question:
        return jsonify({"error": "질문을 입력해주세요."}), 400

    sql = ""
    used_gpt = False
    try:
        sql, used_gpt = natural_language_to_sql(question)

        sql_upper = sql.upper().strip()
        forbidden = ["INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "CREATE"]
        for w in forbidden:
            if re.search(r'\b' + w + r'\b', sql_upper):
                return jsonify({"error": f"허용되지 않는 SQL: {w}", "sql": sql}), 400

        columns, rows = execute_query(sql)
        chart = suggest_chart_type(question, columns, len(rows), use_gpt=used_gpt)

        fb_count = len(load_feedback_examples())

        return jsonify({
            "success": True, "question": question, "sql": sql,
            "columns": columns, "rows": rows, "row_count": len(rows),
            "chart": chart, "engine": "gpt" if used_gpt else "local",
            "feedback_count": fb_count,
        })
    except pymysql.Error as e:
        return jsonify({"error": f"DB 오류: {e}", "sql": sql}), 500
    except Exception as e:
        return jsonify({"error": f"처리 오류: {e}", "sql": sql}), 500


@app.route("/api/direct-sql", methods=["POST"])
def direct_sql():
    data = request.get_json()
    sql = data.get("sql", "").strip()
    if not sql:
        return jsonify({"error": "SQL을 입력해주세요."}), 400
    if not sql.upper().strip().startswith("SELECT"):
        return jsonify({"error": "SELECT 문만 허용됩니다."}), 400
    try:
        columns, rows = execute_query(sql)
        chart = _local_suggest_chart(columns, len(rows), "")
        return jsonify({"success": True, "sql": sql, "columns": columns,
                        "rows": rows, "row_count": len(rows), "chart": chart})
    except pymysql.Error as e:
        return jsonify({"error": f"DB 오류: {e}", "sql": sql}), 500
    except Exception as e:
        return jsonify({"error": f"처리 오류: {e}", "sql": sql}), 500


@app.route("/api/feedback", methods=["POST"])
def feedback():
    data = request.get_json()
    question = data.get("question", "").strip()
    original_sql = data.get("original_sql", "").strip()
    corrected_sql = data.get("corrected_sql", "").strip()
    if not question or not corrected_sql:
        return jsonify({"error": "질문과 수정된 SQL이 필요합니다."}), 400
    if not corrected_sql.upper().strip().startswith("SELECT"):
        return jsonify({"error": "SELECT 문만 저장 가능합니다."}), 400
    save_feedback_example(question, original_sql, corrected_sql)
    count = len(load_feedback_examples())
    return jsonify({"success": True, "message": f"피드백 저장 완료 (총 {count}건)", "count": count})


@app.route("/api/feedback", methods=["GET"])
def get_feedback():
    examples = load_feedback_examples()
    return jsonify({"examples": examples, "count": len(examples)})


@app.route("/api/feedback", methods=["DELETE"])
def delete_feedback():
    data = request.get_json() or {}
    question = data.get("question", "")
    if question:
        examples = load_feedback_examples()
        examples = [e for e in examples if e.get("question") != question]
        with open(FEEDBACK_FILE, "w", encoding="utf-8") as f:
            json.dump(examples, f, ensure_ascii=False, indent=2)
        return jsonify({"success": True, "message": "삭제 완료", "count": len(examples)})
    else:
        with open(FEEDBACK_FILE, "w", encoding="utf-8") as f:
            json.dump([], f)
        return jsonify({"success": True, "message": "전체 초기화", "count": 0})


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Routes - Data Dictionary CRUD API
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.route("/api/dictionary", methods=["GET"])
def get_dictionary():
    """Data Dictionary 전체 조회"""
    dictionary = load_dictionary()
    return jsonify(dictionary)


@app.route("/api/dictionary/column", methods=["POST"])
def add_dictionary_column():
    """Data Dictionary에 컬럼 매핑 추가/수정"""
    data = request.get_json()
    col_name = data.get("column_name", "").strip().upper()
    label = data.get("label", "").strip()
    description = data.get("description", "").strip()
    values = data.get("values", {})

    if not col_name:
        return jsonify({"error": "column_name은 필수입니다."}), 400

    dictionary = load_dictionary()
    dictionary.setdefault("columns", {})
    dictionary["columns"][col_name] = {
        "label": label or col_name,
        "description": description,
        "values": values
    }
    save_dictionary(dictionary)
    return jsonify({"success": True, "message": f"컬럼 '{col_name}' 저장 완료"})


@app.route("/api/dictionary/column/<column_name>", methods=["PUT"])
def update_dictionary_column(column_name):
    """Data Dictionary 특정 컬럼 수정"""
    data = request.get_json()
    dictionary = load_dictionary()
    col_name = column_name.upper()

    if col_name not in dictionary.get("columns", {}):
        return jsonify({"error": f"컬럼 '{col_name}'이 존재하지 않습니다."}), 404

    if "label" in data:
        dictionary["columns"][col_name]["label"] = data["label"]
    if "description" in data:
        dictionary["columns"][col_name]["description"] = data["description"]
    if "values" in data:
        dictionary["columns"][col_name]["values"] = data["values"]

    save_dictionary(dictionary)
    return jsonify({"success": True, "message": f"컬럼 '{col_name}' 수정 완료"})


@app.route("/api/dictionary/column/<column_name>", methods=["DELETE"])
def delete_dictionary_column(column_name):
    """Data Dictionary에서 컬럼 삭제"""
    dictionary = load_dictionary()
    col_name = column_name.upper()

    if col_name in dictionary.get("columns", {}):
        del dictionary["columns"][col_name]
        save_dictionary(dictionary)
        return jsonify({"success": True, "message": f"컬럼 '{col_name}' 삭제 완료"})
    return jsonify({"error": f"컬럼 '{col_name}'이 존재하지 않습니다."}), 404


@app.route("/api/dictionary/column/<column_name>/value", methods=["POST"])
def add_dictionary_value(column_name):
    """특정 컬럼에 코드값 추가/수정"""
    data = request.get_json()
    code = data.get("code", "").strip()
    label = data.get("label", "").strip()
    count = data.get("count", 0)

    if not code:
        return jsonify({"error": "code는 필수입니다."}), 400

    dictionary = load_dictionary()
    col_name = column_name.upper()

    if col_name not in dictionary.get("columns", {}):
        return jsonify({"error": f"컬럼 '{col_name}'이 존재하지 않습니다."}), 404

    dictionary["columns"][col_name].setdefault("values", {})
    dictionary["columns"][col_name]["values"][code] = {
        "label": label or code,
        "count": count
    }
    save_dictionary(dictionary)
    return jsonify({"success": True, "message": f"'{col_name}' 코드값 '{code}' 저장 완료"})


@app.route("/api/dictionary/column/<column_name>/value/<code>", methods=["DELETE"])
def delete_dictionary_value(column_name, code):
    """특정 컬럼의 코드값 삭제"""
    dictionary = load_dictionary()
    col_name = column_name.upper()

    cols = dictionary.get("columns", {})
    if col_name not in cols:
        return jsonify({"error": f"컬럼 '{col_name}'이 존재하지 않습니다."}), 404

    values = cols[col_name].get("values", {})
    if code in values:
        del values[code]
        save_dictionary(dictionary)
        return jsonify({"success": True, "message": f"코드값 '{code}' 삭제 완료"})
    return jsonify({"error": f"코드값 '{code}'이 존재하지 않습니다."}), 404


@app.route("/api/dictionary/amount", methods=["POST"])
def update_amount_columns():
    """금액 컬럼 매핑 추가/수정"""
    data = request.get_json()
    col_code = data.get("column_code", "").strip().upper()
    label = data.get("label", "").strip()

    if not col_code or not label:
        return jsonify({"error": "column_code와 label은 필수입니다."}), 400

    dictionary = load_dictionary()
    dictionary.setdefault("amount_columns", {})
    dictionary["amount_columns"][col_code] = label
    save_dictionary(dictionary)
    return jsonify({"success": True, "message": f"금액 컬럼 '{col_code}' = '{label}' 저장 완료"})


@app.route("/api/dictionary/amount/<col_code>", methods=["DELETE"])
def delete_amount_column(col_code):
    """금액 컬럼 매핑 삭제"""
    dictionary = load_dictionary()
    col_code = col_code.upper()
    if col_code in dictionary.get("amount_columns", {}):
        del dictionary["amount_columns"][col_code]
        save_dictionary(dictionary)
        return jsonify({"success": True, "message": f"금액 컬럼 '{col_code}' 삭제 완료"})
    return jsonify({"error": f"금액 컬럼 '{col_code}'이 존재하지 않습니다."}), 404


@app.route("/api/dictionary/rules", methods=["GET"])
def get_rules():
    """비즈니스 룰 조회"""
    dictionary = load_dictionary()
    return jsonify({"rules": dictionary.get("business_rules", [])})


@app.route("/api/dictionary/rules", methods=["PUT"])
def update_rules():
    """비즈니스 룰 전체 업데이트"""
    data = request.get_json()
    rules = data.get("rules", [])
    dictionary = load_dictionary()
    dictionary["business_rules"] = rules
    save_dictionary(dictionary)
    return jsonify({"success": True, "message": f"비즈니스 룰 {len(rules)}건 저장 완료"})


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Routes - Few-shot Examples CRUD API
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.route("/api/examples", methods=["GET"])
def get_examples():
    """Few-shot 예시 전체 조회"""
    examples = load_few_shot_examples()
    return jsonify({"examples": examples, "count": len(examples)})


@app.route("/api/examples", methods=["POST"])
def add_example():
    """Few-shot 예시 추가"""
    data = request.get_json()
    question = data.get("question", "").strip()
    sql = data.get("sql", "").strip()
    if not question or not sql:
        return jsonify({"error": "question과 sql은 필수입니다."}), 400

    examples = load_few_shot_examples()
    # 중복 질문 교체
    examples = [e for e in examples if e.get("question") != question]
    examples.append({"question": question, "sql": sql})
    save_few_shot_examples(examples)
    return jsonify({"success": True, "count": len(examples), "message": f"예시 추가 완료 (총 {len(examples)}건)"})


@app.route("/api/examples", methods=["DELETE"])
def delete_example():
    """Few-shot 예시 삭제"""
    data = request.get_json() or {}
    question = data.get("question", "")
    if question:
        examples = load_few_shot_examples()
        examples = [e for e in examples if e.get("question") != question]
        save_few_shot_examples(examples)
        return jsonify({"success": True, "count": len(examples), "message": "예시 삭제 완료"})
    else:
        # 전체 초기화 → 기본값으로 복원
        save_few_shot_examples(DEFAULT_EXAMPLES)
        return jsonify({"success": True, "count": len(DEFAULT_EXAMPLES), "message": "기본 예시로 초기화"})


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Routes - System Prompt Preview
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.route("/api/prompt-preview", methods=["GET"])
def prompt_preview():
    """현재 System Prompt 미리보기"""
    prompt = build_system_prompt()
    return jsonify({"prompt": prompt, "length": len(prompt)})


@app.route("/api/schema", methods=["GET"])
def schema():
    conn = get_db_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA='company_board' AND TABLE_NAME='MOD_BOARD_PROFIT_ANALYSIS'
                ORDER BY ORDINAL_POSITION""")
            return jsonify({"columns": cur.fetchall()})
    finally:
        conn.close()


@app.route("/api/health", methods=["GET"])
def health():
    status = {"db": False, "api_key": False}
    try:
        conn = get_db_connection()
        with conn.cursor() as c: c.execute("SELECT 1")
        conn.close()
        status["db"] = True
    except Exception: pass
    key = _resolve_api_key()
    status["api_key"] = bool(key) and len(key) > 10
    status["api_key_preview"] = key[:8] + "..." if key else "(empty)"
    status["base_url"] = BASE_URL
    status["model"] = MODEL_NAME
    status["feedback_count"] = len(load_feedback_examples())
    status["builtin_examples"] = len(load_few_shot_examples())
    return jsonify(status)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Routes - PPT Report
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@app.route("/report")
def report_page():
    return render_template("report.html")


@app.route("/api/report/months", methods=["GET"])
def report_months():
    """PPT 보고서 생성 가능한 월 목록"""
    try:
        from report_generator import get_available_months
        months = get_available_months()
        result = []
        for m in months:
            cm = m['CALMONTH']
            result.append({
                "calmonth": cm,
                "label": f"{cm[:4]}년 {int(cm[4:])}월",
                "count": m['cnt']
            })
        return jsonify({"months": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/report/ppt", methods=["POST"])
def generate_report():
    """PPT 보고서 생성 및 다운로드 (프롬프트 기반)"""
    try:
        # multipart/form-data 지원
        if request.content_type and 'multipart' in request.content_type:
            calmonth = request.form.get("calmonth", "").strip()
            prompt = request.form.get("prompt", "").strip()
            attachment = request.files.get("attachment")
        else:
            data = request.get_json()
            calmonth = data.get("calmonth", "").strip()
            prompt = data.get("prompt", "").strip()
            attachment = None

        if not calmonth or len(calmonth) != 6:
            return jsonify({"error": "올바른 월을 선택해주세요 (예: 202405)"}), 400

        # 첨부파일 처리
        attachment_info = None
        if attachment and attachment.filename:
            ext = attachment.filename.rsplit('.', 1)[-1].lower()
            if ext not in ALLOWED_EXTENSIONS:
                return jsonify({"error": f"허용되지 않는 파일 형식: .{ext}"}), 400
            fname = f"{uuid.uuid4().hex}_{secure_filename(attachment.filename)}"
            fpath = UPLOAD_DIR / fname
            attachment.save(str(fpath))
            attachment_info = {
                "path": str(fpath),
                "original_name": attachment.filename,
                "ext": ext,
            }

        from report_generator import generate_ppt_with_prompt
        ppt_buffer = generate_ppt_with_prompt(calmonth, prompt=prompt, attachment_info=attachment_info)

        year = calmonth[:4]
        month = calmonth[4:]
        filename = f"수익성분석_보고서_{year}년_{int(month)}월.pptx"

        # 임시 파일 정리
        if attachment_info and os.path.exists(attachment_info['path']):
            try:
                os.remove(attachment_info['path'])
            except:
                pass

        return send_file(
            ppt_buffer,
            mimetype='application/vnd.openxmlformats-officedocument.presentationml.presentation',
            as_attachment=True,
            download_name=filename
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": f"보고서 생성 오류: {str(e)}"}), 500


@app.route("/api/report/upload-preview", methods=["POST"])
def upload_preview():
    """첨부파일 업로드 → 미리보기 데이터 반환"""
    try:
        attachment = request.files.get("file")
        if not attachment or not attachment.filename:
            return jsonify({"error": "파일이 없습니다."}), 400

        ext = attachment.filename.rsplit('.', 1)[-1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            return jsonify({"error": f"허용되지 않는 파일 형식: .{ext}"}), 400

        result = {"filename": attachment.filename, "ext": ext, "type": "unknown"}

        # 이미지 파일
        if ext in ('png', 'jpg', 'jpeg', 'gif', 'bmp'):
            import base64
            data = attachment.read()
            b64 = base64.b64encode(data).decode('utf-8')
            mime = f"image/{'jpeg' if ext in ('jpg','jpeg') else ext}"
            result["type"] = "image"
            result["data_url"] = f"data:{mime};base64,{b64}"
            result["size"] = len(data)

        # 엑셀 파일
        elif ext in ('xlsx', 'xls'):
            import pandas as pd
            import io
            data = attachment.read()
            try:
                df = pd.read_excel(io.BytesIO(data), engine='openpyxl' if ext == 'xlsx' else 'xlrd')
                result["type"] = "excel"
                result["columns"] = list(df.columns)
                result["row_count"] = len(df)
                result["size"] = len(data)
                # 상위 10행 미리보기
                preview_df = df.head(10)
                result["rows"] = []
                for _, row in preview_df.iterrows():
                    r = {}
                    for col in df.columns:
                        v = row[col]
                        if pd.isna(v):
                            r[str(col)] = None
                        elif isinstance(v, (int, float)):
                            r[str(col)] = v
                        else:
                            r[str(col)] = str(v)
                    result["rows"].append(r)
            except Exception as e:
                result["type"] = "excel_error"
                result["error"] = str(e)

        # CSV 파일
        elif ext == 'csv':
            import pandas as pd
            import io
            data = attachment.read()
            try:
                df = pd.read_csv(io.BytesIO(data))
                result["type"] = "csv"
                result["columns"] = list(df.columns)
                result["row_count"] = len(df)
                result["size"] = len(data)
                preview_df = df.head(10)
                result["rows"] = []
                for _, row in preview_df.iterrows():
                    r = {}
                    for col in df.columns:
                        v = row[col]
                        if pd.isna(v):
                            r[str(col)] = None
                        elif isinstance(v, (int, float)):
                            r[str(col)] = v
                        else:
                            r[str(col)] = str(v)
                    result["rows"].append(r)
            except Exception as e:
                result["type"] = "csv_error"
                result["error"] = str(e)

        # PDF 파일
        elif ext == 'pdf':
            result["type"] = "pdf"
            result["size"] = len(attachment.read())

        return jsonify({"success": True, "preview": result})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/report/preview", methods=["POST"])
def report_preview():
    """PPT 보고서 미리보기 데이터 (JSON)"""
    try:
        data = request.get_json()
        calmonth = data.get("calmonth", "").strip()
        if not calmonth:
            return jsonify({"error": "월을 선택해주세요."}), 400

        from report_generator import fetch_report_data, _dec, _fmt
        report_data = fetch_report_data(calmonth)

        # JSON-serializable로 변환
        def to_json(obj):
            if isinstance(obj, decimal.Decimal):
                return float(obj)
            if isinstance(obj, dict):
                return {k: to_json(v) for k, v in obj.items()}
            if isinstance(obj, list):
                return [to_json(i) for i in obj]
            return obj

        preview = {
            "calmonth": calmonth,
            "total_rows": report_data['total_rows'],
            "total": to_json(report_data['total']),
            "by_division": to_json(report_data['by_division']),
            "by_plant": to_json(report_data['by_plant']),
            "by_channel": to_json(report_data['by_channel']),
            "top_products": to_json(report_data['top_products'][:5]),
            "prev_month": to_json(report_data['prev_month']),
        }
        return jsonify({"success": True, "data": preview})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
