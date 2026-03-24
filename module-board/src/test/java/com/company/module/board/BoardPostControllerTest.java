package com.company.module.board;

import com.company.module.board.controller.BoardPostController;
import com.company.module.board.dto.BoardPostDto;
import com.company.module.board.service.BoardPostService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.bean.MockBean;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.http.MediaType;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;

import java.time.LocalDateTime;
import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.given;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultHandlers.print;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

@WebMvcTest(BoardPostController.class)
class BoardPostControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @MockBean
    private BoardPostService boardPostService;

    @Test
    @DisplayName("GET /board-api/posts - 게시글 목록 조회")
    @WithMockUser
    void getPostList() throws Exception {
        // given
        BoardPostDto.ListResponse item = BoardPostDto.ListResponse.builder()
                .postId(1L)
                .title("Test")
                .author("tester")
                .viewCount(0L)
                .createdAt(LocalDateTime.now())
                .build();
        Page<BoardPostDto.ListResponse> page = new PageImpl<>(List.of(item));
        given(boardPostService.getPostList(any())).willReturn(page);

        // when & then
        mockMvc.perform(get("/board-api/posts")
                        .param("page", "0")
                        .param("size", "10"))
                .andDo(print())
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.content[0].title").value("Test"));
    }

    @Test
    @DisplayName("POST /board-api/posts - 게시글 작성")
    @WithMockUser
    void createPost() throws Exception {
        // given
        BoardPostDto.CreateRequest request = BoardPostDto.CreateRequest.builder()
                .title("New Post")
                .content("Content")
                .author("tester")
                .build();
        BoardPostDto.Response response = BoardPostDto.Response.builder()
                .postId(1L)
                .title("New Post")
                .content("Content")
                .author("tester")
                .viewCount(0L)
                .createdAt(LocalDateTime.now())
                .build();
        given(boardPostService.createPost(any())).willReturn(response);

        // when & then
        mockMvc.perform(post("/board-api/posts")
                        .with(csrf())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andDo(print())
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.data.postId").value(1));
    }
}
