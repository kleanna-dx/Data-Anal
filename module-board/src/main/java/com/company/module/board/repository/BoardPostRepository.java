package com.company.module.board.repository;

import com.company.module.board.entity.BoardPost;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface BoardPostRepository extends JpaRepository<BoardPost, Long> {

    /**
     * 활성 게시글 페이징 조회
     */
    Page<BoardPost> findByUseYnOrderByPostIdDesc(String useYn, Pageable pageable);

    /**
     * 활성 게시글 단건 조회
     */
    Optional<BoardPost> findByPostIdAndUseYn(Long postId, String useYn);

    /**
     * 제목 키워드 검색
     */
    @Query("SELECT p FROM BoardPost p WHERE p.useYn = 'Y' AND p.title LIKE %:keyword% ORDER BY p.postId DESC")
    Page<BoardPost> searchByTitle(@Param("keyword") String keyword, Pageable pageable);
}
