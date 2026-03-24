package com.company.module.board.repository;

import com.company.module.board.entity.BoardComment;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;

@Repository
public interface BoardCommentRepository extends JpaRepository<BoardComment, Long> {

    /**
     * 게시글별 활성 댓글 조회
     */
    List<BoardComment> findByBoardPost_PostIdAndUseYnOrderByCommentIdAsc(Long postId, String useYn);

    /**
     * 활성 댓글 단건 조회
     */
    Optional<BoardComment> findByCommentIdAndUseYn(Long commentId, String useYn);

    /**
     * 게시글별 활성 댓글 수 조회
     */
    long countByBoardPost_PostIdAndUseYn(Long postId, String useYn);
}
