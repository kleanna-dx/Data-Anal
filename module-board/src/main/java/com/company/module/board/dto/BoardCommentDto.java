package com.company.module.board.dto;

import com.company.module.board.entity.BoardComment;
import com.company.module.board.entity.BoardPost;
import lombok.*;

import java.time.LocalDateTime;

public class BoardCommentDto {

    @Getter
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class CreateRequest {
        private String content;
        private String author;

        public BoardComment toEntity(BoardPost post) {
            return BoardComment.builder()
                    .boardPost(post)
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
        private String content;
    }

    @Getter
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class Response {
        private Long commentId;
        private Long postId;
        private String content;
        private String author;
        private LocalDateTime createdAt;
        private LocalDateTime updatedAt;

        public static Response from(BoardComment entity) {
            return Response.builder()
                    .commentId(entity.getCommentId())
                    .postId(entity.getBoardPost().getPostId())
                    .content(entity.getContent())
                    .author(entity.getAuthor())
                    .createdAt(entity.getCreatedAt())
                    .updatedAt(entity.getUpdatedAt())
                    .build();
        }
    }
}
