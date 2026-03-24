package com.company.module.board.dto;

import com.company.module.board.entity.BoardPost;
import lombok.*;

import java.time.LocalDateTime;

public class BoardPostDto {

    @Getter
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class CreateRequest {
        private String title;
        private String content;
        private String author;

        public BoardPost toEntity() {
            return BoardPost.builder()
                    .title(this.title)
                    .content(this.content)
                    .author(this.author)
                    .build();
        }
    }

    @Getter
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class UpdateRequest {
        private String title;
        private String content;
    }

    @Getter
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class Response {
        private Long postId;
        private String title;
        private String content;
        private String author;
        private Long viewCount;
        private long commentCount;
        private LocalDateTime createdAt;
        private LocalDateTime updatedAt;

        public static Response from(BoardPost entity) {
            return Response.builder()
                    .postId(entity.getPostId())
                    .title(entity.getTitle())
                    .content(entity.getContent())
                    .author(entity.getAuthor())
                    .viewCount(entity.getViewCount())
                    .createdAt(entity.getCreatedAt())
                    .updatedAt(entity.getUpdatedAt())
                    .build();
        }

        public static Response from(BoardPost entity, long commentCount) {
            return Response.builder()
                    .postId(entity.getPostId())
                    .title(entity.getTitle())
                    .content(entity.getContent())
                    .author(entity.getAuthor())
                    .viewCount(entity.getViewCount())
                    .commentCount(commentCount)
                    .createdAt(entity.getCreatedAt())
                    .updatedAt(entity.getUpdatedAt())
                    .build();
        }
    }

    @Getter
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class ListResponse {
        private Long postId;
        private String title;
        private String author;
        private Long viewCount;
        private LocalDateTime createdAt;

        public static ListResponse from(BoardPost entity) {
            return ListResponse.builder()
                    .postId(entity.getPostId())
                    .title(entity.getTitle())
                    .author(entity.getAuthor())
                    .viewCount(entity.getViewCount())
                    .createdAt(entity.getCreatedAt())
                    .build();
        }
    }
}
