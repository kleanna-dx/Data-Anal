package com.company.module.board.controller;

import com.company.core.common.ApiResponse;
import com.company.module.board.dto.BoardPostDto;
import com.company.module.board.service.BoardPostService;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.web.PageableDefault;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/board-api")
@RequiredArgsConstructor
public class BoardPostController {

    private final BoardPostService boardPostService;

    /**
     * 게시글 목록 조회 (페이징)
     * GET /board-api/posts?page=0&size=10
     */
    @GetMapping("/posts")
    public ResponseEntity<ApiResponse<Page<BoardPostDto.ListResponse>>> getPostList(
            @PageableDefault(size = 10, sort = "postId", direction = Sort.Direction.DESC) Pageable pageable) {
        return ResponseEntity.ok(ApiResponse.ok(boardPostService.getPostList(pageable)));
    }

    /**
     * 게시글 검색
     * GET /board-api/posts/search?keyword=xxx&page=0&size=10
     */
    @GetMapping("/posts/search")
    public ResponseEntity<ApiResponse<Page<BoardPostDto.ListResponse>>> searchPosts(
            @RequestParam String keyword,
            @PageableDefault(size = 10) Pageable pageable) {
        return ResponseEntity.ok(ApiResponse.ok(boardPostService.searchPosts(keyword, pageable)));
    }

    /**
     * 게시글 상세 조회
     * GET /board-api/posts/{postId}
     */
    @GetMapping("/posts/{postId}")
    public ResponseEntity<ApiResponse<BoardPostDto.Response>> getPost(@PathVariable Long postId) {
        return ResponseEntity.ok(ApiResponse.ok(boardPostService.getPost(postId)));
    }

    /**
     * 게시글 작성
     * POST /board-api/posts
     */
    @PostMapping("/posts")
    public ResponseEntity<ApiResponse<BoardPostDto.Response>> createPost(
            @RequestBody BoardPostDto.CreateRequest request) {
        return ResponseEntity
                .status(HttpStatus.CREATED)
                .body(ApiResponse.ok("Post created", boardPostService.createPost(request)));
    }

    /**
     * 게시글 수정
     * PUT /board-api/posts/{postId}
     */
    @PutMapping("/posts/{postId}")
    public ResponseEntity<ApiResponse<BoardPostDto.Response>> updatePost(
            @PathVariable Long postId,
            @RequestBody BoardPostDto.UpdateRequest request) {
        return ResponseEntity.ok(ApiResponse.ok("Post updated", boardPostService.updatePost(postId, request)));
    }

    /**
     * 게시글 삭제
     * DELETE /board-api/posts/{postId}
     */
    @DeleteMapping("/posts/{postId}")
    public ResponseEntity<ApiResponse<Void>> deletePost(@PathVariable Long postId) {
        boardPostService.deletePost(postId);
        return ResponseEntity.ok(ApiResponse.ok());
    }
}
