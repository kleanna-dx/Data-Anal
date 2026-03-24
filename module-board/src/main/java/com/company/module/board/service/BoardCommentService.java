package com.company.module.board.service;

import com.company.core.exception.BusinessException;
import com.company.module.board.dto.BoardCommentDto;
import com.company.module.board.entity.BoardComment;
import com.company.module.board.entity.BoardPost;
import com.company.module.board.repository.BoardCommentRepository;
import com.company.module.board.repository.BoardPostRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class BoardCommentService {

    private final BoardCommentRepository boardCommentRepository;
    private final BoardPostRepository boardPostRepository;

    /**
     * 게시글별 댓글 목록 조회
     */
    @Transactional(readOnly = true)
    public List<BoardCommentDto.Response> getComments(Long postId) {
        return boardCommentRepository
                .findByBoardPost_PostIdAndUseYnOrderByCommentIdAsc(postId, "Y")
                .stream()
                .map(BoardCommentDto.Response::from)
                .collect(Collectors.toList());
    }

    /**
     * 댓글 작성
     */
    @Transactional
    public BoardCommentDto.Response createComment(Long postId, BoardCommentDto.CreateRequest request) {
        BoardPost post = boardPostRepository.findByPostIdAndUseYn(postId, "Y")
                .orElseThrow(() -> new BusinessException(
                        "BOARD_POST_NOT_FOUND",
                        "Post not found or deleted: " + postId,
                        404
                ));

        BoardComment comment = request.toEntity(post);
        BoardComment savedComment = boardCommentRepository.save(comment);
        log.info("Board comment created: commentId={}, postId={}", savedComment.getCommentId(), postId);
        return BoardCommentDto.Response.from(savedComment);
    }

    /**
     * 댓글 수정
     */
    @Transactional
    public BoardCommentDto.Response updateComment(Long commentId, BoardCommentDto.UpdateRequest request) {
        BoardComment comment = findActiveCommentOrThrow(commentId);
        comment.updateContent(request.getContent());
        log.info("Board comment updated: commentId={}", commentId);
        return BoardCommentDto.Response.from(comment);
    }

    /**
     * 댓글 삭제 (Soft Delete)
     */
    @Transactional
    public void deleteComment(Long commentId) {
        BoardComment comment = findActiveCommentOrThrow(commentId);
        comment.softDelete();
        log.info("Board comment soft-deleted: commentId={}", commentId);
    }

    private BoardComment findActiveCommentOrThrow(Long commentId) {
        return boardCommentRepository.findByCommentIdAndUseYn(commentId, "Y")
                .orElseThrow(() -> new BusinessException(
                        "BOARD_COMMENT_NOT_FOUND",
                        "Comment not found or deleted: " + commentId,
                        404
                ));
    }
}
