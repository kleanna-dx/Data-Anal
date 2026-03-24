package com.company.module.board;

import com.company.module.board.dto.BoardPostDto;
import com.company.module.board.entity.BoardPost;
import com.company.module.board.repository.BoardPostRepository;
import com.company.module.board.service.BoardPostService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.verify;

@ExtendWith(MockitoExtension.class)
class BoardPostServiceTest {

    @InjectMocks
    private BoardPostService boardPostService;

    @Mock
    private BoardPostRepository boardPostRepository;

    @Mock
    private com.company.module.board.repository.BoardCommentRepository boardCommentRepository;

    @Test
    @DisplayName("게시글 목록 조회 - 성공")
    void getPostList_success() {
        // given
        Pageable pageable = PageRequest.of(0, 10);
        BoardPost post = BoardPost.builder()
                .postId(1L)
                .title("Test Title")
                .content("Test Content")
                .author("tester")
                .build();
        Page<BoardPost> page = new PageImpl<>(List.of(post));
        given(boardPostRepository.findByUseYnOrderByPostIdDesc("Y", pageable)).willReturn(page);

        // when
        Page<BoardPostDto.ListResponse> result = boardPostService.getPostList(pageable);

        // then
        assertThat(result.getContent()).hasSize(1);
        assertThat(result.getContent().get(0).getTitle()).isEqualTo("Test Title");
    }

    @Test
    @DisplayName("게시글 작성 - 성공")
    void createPost_success() {
        // given
        BoardPostDto.CreateRequest request = BoardPostDto.CreateRequest.builder()
                .title("New Post")
                .content("New Content")
                .author("tester")
                .build();
        BoardPost savedPost = BoardPost.builder()
                .postId(1L)
                .title("New Post")
                .content("New Content")
                .author("tester")
                .build();
        given(boardPostRepository.save(any(BoardPost.class))).willReturn(savedPost);

        // when
        BoardPostDto.Response result = boardPostService.createPost(request);

        // then
        assertThat(result.getPostId()).isEqualTo(1L);
        assertThat(result.getTitle()).isEqualTo("New Post");
        assertThat(result.getAuthor()).isEqualTo("tester");
    }

    @Test
    @DisplayName("게시글 상세 조회 - 존재하지 않는 게시글")
    void getPost_notFound() {
        // given
        given(boardPostRepository.findByPostIdAndUseYn(999L, "Y")).willReturn(Optional.empty());

        // when & then
        assertThatThrownBy(() -> boardPostService.getPost(999L))
                .isInstanceOf(com.company.core.exception.BusinessException.class)
                .hasMessageContaining("Post not found");
    }

    @Test
    @DisplayName("게시글 삭제 - Soft Delete 성공")
    void deletePost_success() {
        // given
        BoardPost post = BoardPost.builder()
                .postId(1L)
                .title("To Delete")
                .content("Content")
                .author("tester")
                .build();
        given(boardPostRepository.findByPostIdAndUseYn(1L, "Y")).willReturn(Optional.of(post));

        // when
        boardPostService.deletePost(1L);

        // then
        assertThat(post.getUseYn()).isEqualTo("N");
    }
}
