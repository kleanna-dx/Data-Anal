package com.company.module.board.service;

import com.company.core.exception.BusinessException;
import com.company.module.board.dto.BoardPostDto;
import com.company.module.board.entity.BoardPost;
import com.company.module.board.repository.BoardCommentRepository;
import com.company.module.board.repository.BoardPostRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
@RequiredArgsConstructor
public class BoardPostService {

    private final BoardPostRepository boardPostRepository;
    private final BoardCommentRepository boardCommentRepository;

    /**
     * 게시글 목록 조회 (페이징)
     */
    @Transactional(readOnly = true)
    public Page<BoardPostDto.ListResponse> getPostList(Pageable pageable) {
        return boardPostRepository.findByUseYnOrderByPostIdDesc("Y", pageable)
                .map(BoardPostDto.ListResponse::from);
    }

    /**
     * 게시글 검색
     */
    @Transactional(readOnly = true)
    public Page<BoardPostDto.ListResponse> searchPosts(String keyword, Pageable pageable) {
        return boardPostRepository.searchByTitle(keyword, pageable)
                .map(BoardPostDto.ListResponse::from);
    }

    /**
     * 게시글 상세 조회 (조회수 증가)
     */
    @Transactional
    public BoardPostDto.Response getPost(Long postId) {
        BoardPost post = findActivePostOrThrow(postId);
        post.incrementViewCount();

        long commentCount = boardCommentRepository
                .countByBoardPost_PostIdAndUseYn(postId, "Y");

        return BoardPostDto.Response.from(post, commentCount);
    }

    /**
     * 게시글 작성
     */
    @Transactional
    public BoardPostDto.Response createPost(BoardPostDto.CreateRequest request) {
        BoardPost post = request.toEntity();
        BoardPost savedPost = boardPostRepository.save(post);
        log.info("Board post created: postId={}, title={}", savedPost.getPostId(), savedPost.getTitle());
        return BoardPostDto.Response.from(savedPost);
    }

    /**
     * 게시글 수정
     */
    @Transactional
    public BoardPostDto.Response updatePost(Long postId, BoardPostDto.UpdateRequest request) {
        BoardPost post = findActivePostOrThrow(postId);
        post.updatePost(request.getTitle(), request.getContent());
        log.info("Board post updated: postId={}", postId);
        return BoardPostDto.Response.from(post);
    }

    /**
     * 게시글 삭제 (Soft Delete)
     */
    @Transactional
    public void deletePost(Long postId) {
        BoardPost post = findActivePostOrThrow(postId);
        post.softDelete();
        log.info("Board post soft-deleted: postId={}", postId);
    }

    /**
     * 활성 게시글 조회 (공통)
     */
    private BoardPost findActivePostOrThrow(Long postId) {
        return boardPostRepository.findByPostIdAndUseYn(postId, "Y")
                .orElseThrow(() -> new BusinessException(
                        "BOARD_POST_NOT_FOUND",
                        "Post not found or deleted: " + postId,
                        404
                ));
    }
}
