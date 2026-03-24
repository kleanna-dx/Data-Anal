-- ============================================
-- module-board DDL Script
-- DB: company_board (MariaDB)
-- Table Prefix: MOD_BOARD_
-- ============================================

-- 1. 데이터베이스 생성
CREATE DATABASE IF NOT EXISTS company_board
    DEFAULT CHARACTER SET utf8mb4
    DEFAULT COLLATE utf8mb4_unicode_ci;

USE company_board;

-- 2. 게시글 테이블
CREATE TABLE IF NOT EXISTS MOD_BOARD_POST (
    POST_ID     BIGINT          NOT NULL AUTO_INCREMENT COMMENT '게시글 ID',
    TITLE       VARCHAR(200)    NOT NULL                COMMENT '제목',
    CONTENT     TEXT                                    COMMENT '내용',
    AUTHOR      VARCHAR(100)    NOT NULL                COMMENT '작성자',
    VIEW_COUNT  BIGINT          NOT NULL DEFAULT 0      COMMENT '조회수',
    USE_YN      CHAR(1)         NOT NULL DEFAULT 'Y'    COMMENT '사용여부',
    CREATED_AT  DATETIME(6)     NOT NULL                COMMENT '생성일시',
    UPDATED_AT  DATETIME(6)                             COMMENT '수정일시',
    PRIMARY KEY (POST_ID),
    INDEX IDX_MOD_BOARD_POST_USE_YN (USE_YN),
    INDEX IDX_MOD_BOARD_POST_AUTHOR (AUTHOR),
    INDEX IDX_MOD_BOARD_POST_CREATED (CREATED_AT)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='게시판 게시글';

-- 3. 댓글 테이블
CREATE TABLE IF NOT EXISTS MOD_BOARD_COMMENT (
    COMMENT_ID  BIGINT          NOT NULL AUTO_INCREMENT COMMENT '댓글 ID',
    POST_ID     BIGINT          NOT NULL                COMMENT '게시글 ID',
    CONTENT     TEXT            NOT NULL                COMMENT '내용',
    AUTHOR      VARCHAR(100)    NOT NULL                COMMENT '작성자',
    USE_YN      CHAR(1)         NOT NULL DEFAULT 'Y'    COMMENT '사용여부',
    CREATED_AT  DATETIME(6)     NOT NULL                COMMENT '생성일시',
    UPDATED_AT  DATETIME(6)                             COMMENT '수정일시',
    PRIMARY KEY (COMMENT_ID),
    INDEX IDX_MOD_BOARD_COMMENT_POST (POST_ID),
    INDEX IDX_MOD_BOARD_COMMENT_USE_YN (USE_YN),
    CONSTRAINT FK_MOD_BOARD_COMMENT_POST
        FOREIGN KEY (POST_ID) REFERENCES MOD_BOARD_POST (POST_ID)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='게시판 댓글';

-- 4. 샘플 데이터
INSERT INTO MOD_BOARD_POST (TITLE, CONTENT, AUTHOR, VIEW_COUNT, USE_YN, CREATED_AT, UPDATED_AT)
VALUES
    ('First Post', 'Hello, this is the first board post.', 'admin', 10, 'Y', NOW(), NOW()),
    ('Second Post', 'This is a sample content for the second post.', 'user1', 5, 'Y', NOW(), NOW()),
    ('Third Post', 'Testing board module functionality.', 'user2', 0, 'Y', NOW(), NOW());

INSERT INTO MOD_BOARD_COMMENT (POST_ID, CONTENT, AUTHOR, USE_YN, CREATED_AT, UPDATED_AT)
VALUES
    (1, 'Great first post!', 'user1', 'Y', NOW(), NOW()),
    (1, 'Welcome to the board.', 'user2', 'Y', NOW(), NOW()),
    (2, 'Nice content!', 'admin', 'Y', NOW(), NOW());
