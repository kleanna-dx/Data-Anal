package com.company.module.board.entity;

import com.company.core.common.BaseEntity;
import jakarta.persistence.*;
import lombok.*;

@Entity
@Table(name = "MOD_BOARD_COMMENT")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
@AllArgsConstructor
@Builder
public class BoardComment extends BaseEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    @Column(name = "COMMENT_ID")
    private Long commentId;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "POST_ID", nullable = false)
    private BoardPost boardPost;

    @Column(name = "CONTENT", nullable = false, columnDefinition = "TEXT")
    private String content;

    @Column(name = "AUTHOR", nullable = false, length = 100)
    private String author;

    @Column(name = "USE_YN", nullable = false, length = 1)
    @Builder.Default
    private String useYn = "Y";

    // === Business Methods ===

    public void updateContent(String content) {
        this.content = content;
    }

    public void softDelete() {
        this.useYn = "N";
    }
}
