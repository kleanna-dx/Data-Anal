package com.company.module.board.controller;

import com.company.core.common.ApiResponse;
import com.company.module.board.dto.BoardCommentDto;
import com.company.module.board.service.BoardCommentService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/board-api")
@RequiredArgsConstructor
public class BoardCommentController {

    private final BoardCommentService boardCommentService;

    /**
     * 게시글별 댓글 목록 조회
     * GET /board-api/posts/{postId}/comments
     */
    @GetMapping("/posts/{postId}/comments")
    public ResponseEntity<ApiResponse<List<BoardCommentDto.Response>>> getComments(
            @PathVariable Long postId) {
        return ResponseEntity.ok(ApiResponse.ok(boardCommentService.getComments(postId)));
    }

    /**
     * 댓글 작성
     * POST /board-api/posts/{postId}/comments
     */
    @PostMapping("/posts/{postId}/comments")
    public ResponseEntity<ApiResponse<BoardCommentDto.Response>> createComment(
            @PathVariable Long postId,
            @RequestBody BoardCommentDto.CreateRequest request) {
        return ResponseEntity
                .status(HttpStatus.CREATED)
                .body(ApiResponse.ok("Comment created", boardCommentService.createComment(postId, request)));
    }

    /**
     * 댓글 수정
     * PUT /board-api/comments/{commentId}
     */
    @PutMapping("/comments/{commentId}")
    public ResponseEntity<ApiResponse<BoardCommentDto.Response>> updateComment(
            @PathVariable Long commentId,
            @RequestBody BoardCommentDto.UpdateRequest request) {
        return ResponseEntity.ok(
                ApiResponse.ok("Comment updated", boardCommentService.updateComment(commentId, request)));
    }

    /**
     * 댓글 삭제
     * DELETE /board-api/comments/{commentId}
     */
    @DeleteMapping("/comments/{commentId}")
    public ResponseEntity<ApiResponse<Void>> deleteComment(@PathVariable Long commentId) {
        boardCommentService.deleteComment(commentId);
        return ResponseEntity.ok(ApiResponse.ok());
    }
}
