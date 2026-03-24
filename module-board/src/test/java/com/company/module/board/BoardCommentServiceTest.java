package com.company.module.board;

import com.company.module.board.dto.BoardCommentDto;
import com.company.module.board.entity.BoardComment;
import com.company.module.board.entity.BoardPost;
import com.company.module.board.repository.BoardCommentRepository;
import com.company.module.board.repository.BoardPostRepository;
import com.company.module.board.service.BoardCommentService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.BDDMockito.given;

@ExtendWith(MockitoExtension.class)
class BoardCommentServiceTest {

    @InjectMocks
    private BoardCommentService boardCommentService;

    @Mock
    private BoardCommentRepository boardCommentRepository;

    @Mock
    private BoardPostRepository boardPostRepository;

    @Test
    @DisplayName("댓글 목록 조회 - 성공")
    void getComments_success() {
        // given
        BoardPost post = BoardPost.builder().postId(1L).title("Post").content("C").author("a").build();
        BoardComment comment = BoardComment.builder()
                .commentId(1L)
                .boardPost(post)
                .content("Test Comment")
                .author("tester")
                .build();
        given(boardCommentRepository.findByBoardPost_PostIdAndUseYnOrderByCommentIdAsc(1L, "Y"))
                .willReturn(List.of(comment));

        // when
        List<BoardCommentDto.Response> result = boardCommentService.getComments(1L);

        // then
        assertThat(result).hasSize(1);
        assertThat(result.get(0).getContent()).isEqualTo("Test Comment");
    }

    @Test
    @DisplayName("댓글 작성 - 게시글 없음")
    void createComment_postNotFound() {
        // given
        given(boardPostRepository.findByPostIdAndUseYn(999L, "Y")).willReturn(Optional.empty());
        BoardCommentDto.CreateRequest request = BoardCommentDto.CreateRequest.builder()
                .content("Comment")
                .author("tester")
                .build();

        // when & then
        assertThatThrownBy(() -> boardCommentService.createComment(999L, request))
                .isInstanceOf(com.company.core.exception.BusinessException.class)
                .hasMessageContaining("Post not found");
    }

    @Test
    @DisplayName("댓글 삭제 - Soft Delete 성공")
    void deleteComment_success() {
        // given
        BoardPost post = BoardPost.builder().postId(1L).title("P").content("C").author("a").build();
        BoardComment comment = BoardComment.builder()
                .commentId(1L)
                .boardPost(post)
                .content("To Delete")
                .author("tester")
                .build();
        given(boardCommentRepository.findByCommentIdAndUseYn(1L, "Y")).willReturn(Optional.of(comment));

        // when
        boardCommentService.deleteComment(1L);

        // then
        assertThat(comment.getUseYn()).isEqualTo("N");
    }
}
